/**
 * MissedTheApex F1 News (v1)
 * Trusted RSS feeds, Discord headline/link alerts, persistent duplicate tracking.
 * Uses the SAME PostgreSQL-backed client.db.get/set interface as FIA documents.
 * npm install rss-parser
 */
import Parser from 'rss-parser';
import { load } from 'cheerio';
import { createHash } from 'node:crypto';
import { EmbedBuilder } from 'discord.js';
import { logger } from '../utils/logger.js';

const parser = new Parser({
  // Not every publisher includes these. We also check Open Graph image metadata
  // for a newly discovered article when an RSS image isn't available.
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
    ],
  },
});
const HISTORY_KEY = 'cache:f1news:v1:seen';
const ACTIVE_KEY = 'cache:f1news:v1:activated';
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ARTICLE_AGE_MS = 36 * 60 * 60 * 1000;
const MAX_POSTS_PER_CHECK = 8;
const RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000; // At least one hour after HTTP 429
let checking = false;

// A publisher can supply Retry-After as seconds or an HTTP date.
function retryAfterMilliseconds(value) {
  if (!value) return 0;
  const seconds = /^\s*\d+\s*$/.test(value) ? Number(value.trim()) : NaN;
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

class RateLimitError extends Error {
  constructor(source, retryAfter) {
    super(`HTTP 429 - ${source.name} has requested a cooldown`);
    this.name = 'RateLimitError';
    this.retryAfterMs = Math.max(RATE_LIMIT_COOLDOWN_MS, retryAfterMilliseconds(retryAfter));
  }
}


// Explicit allowlist. These sites publish news and analysis; their RSS headlines
// are NOT automatically verified facts or FIA confirmations.
export const F1_NEWS_SOURCES = [
  { id: 'bbc', name: 'BBC Sport',
    rss: 'https://feeds.bbci.co.uk/sport/formula1/rss.xml',
    domains: ['bbc.co.uk', 'bbc.com'], onlyF1: true },
  { id: 'autosport', name: 'Autosport',
    rss: 'https://www.autosport.com/rss/f1/news/',
    domains: ['autosport.com'], onlyF1: true },
  { id: 'motorsport', name: 'Motorsport.com',
    rss: 'https://www.motorsport.com/rss/f1/news/',
    domains: ['motorsport.com'], onlyF1: true },
  { id: 'racefans', name: 'RaceFans',
    rss: 'https://www.racefans.net/feed/',
    domains: ['racefans.net'], onlyF1: false },
  { id: 'the-race', name: 'The Race',
    rss: 'https://the-race.com/feed/',
    domains: ['the-race.com'], onlyF1: false },
];

const sha256 = text => createHash('sha256').update(text).digest('hex');
const titleKey = s => sha256(s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim());

function normaliseUrl(value, source) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.toLowerCase();
    if (!source.domains.some(domain => host === domain || host.endsWith(`.${domain}`))) return null;
    // Some RSS publishers still emit http article URLs. Upgrade approved hosts.
    url.protocol = 'https:';
    url.hostname = host.replace(/^www\./, '');
    url.hash = '';
    for (const k of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_|ref$)/i.test(k)) url.searchParams.delete(k);
    }
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return null;
  }
}

function isF1(item, source) {
  if (source.onlyF1) return true;
  const categories = (item.categories || []).map(String).join(' ');
  if (/\b(formula\s*(?:1|one)|f1)\b/i.test(categories)) return true;
  if (/\/(formula-1|f1|formula-one)(?:\/|$)/i.test(item.link || '')) return true;
  // Broad feeds also include other series. Keywords are an intentional
  // imperfect fallback; review false positives and missed stories over time.
  return /\b(f1|formula\s*(?:1|one)|grand prix|gp|verstappen|hamilton|leclerc|norris|piastri|russell|antonelli|alonso|sainz|gasly|ocon|hadjar|lawson|bortoleto|h[uü]lkenberg|colapinto|perez|bottas|ferrari|mclaren|mercedes|red bull|haas|alpine|aston martin|racing bulls|cadillac|williams|sauber|audi)\b/i.test(item.title || '');
}

function labelFor(item) {
  const categories = (item.categories || []).map(String).join(' ');
  const text = `${item.title || ''} ${categories}`;
  if (/\b(opinion|editorial|column|commentary|verdict|winners and losers)\b/i.test(text)) return 'OPINION';
  if (/\b(rumou?r|unconfirmed|reportedly)\b/i.test(text)) return 'UNCONFIRMED REPORT';
  if (/\b(analysis|explained|technical|deep dive|what we learned)\b/i.test(text)) return 'ANALYSIS';
  return 'REPORTING';
}

// Discord embeds an image by URL; we do not download or rehost image files.
// An HTTPS image link is not guaranteed to work: some publishers block embeds.
function safeImageUrl(value, baseUrl) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim(), baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2048) return null;
    if (/\.svg(?:$|[?#])/i.test(url.pathname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function feedImage(item, articleUrl) {
  const candidates = [];
  if (item.enclosure?.url && /^image\//i.test(item.enclosure.type || '')) {
    candidates.push(item.enclosure.url);
  }
  // rss-parser may omit XML attributes on media:* fields, depending on feed.
  // That is why the separate Open Graph fallback is important.
  for (const entry of [item.mediaContent, item.mediaThumbnail]) {
    for (const media of Array.isArray(entry) ? entry : entry ? [entry] : []) {
      const attrs = media?.$ || media;
      const kind = String(attrs?.type || attrs?.medium || '').toLowerCase();
      if (attrs?.url && (kind === '' || kind === 'image' || kind.startsWith('image/'))) {
        candidates.push(attrs.url);
      }
      for (const thumb of Array.isArray(media?.['media:thumbnail'])
        ? media['media:thumbnail'] : media?.['media:thumbnail'] ? [media['media:thumbnail']] : []) {
        if (thumb?.$?.url || thumb?.url) candidates.push(thumb?.$?.url || thumb?.url);
      }
    }
  }
  // Some feeds place the article thumbnail in their HTML description.
  // Only consider reasonably sized images, not tracking pixels or icons.
  const html = item['content:encoded'] || item.content || '';
  if (typeof html === 'string' && html.includes('<img')) {
    const $ = load(html);
    const img = $('figure img').first().length ? $('figure img').first() : $('img').first();
    if (img.length && Number(img.attr('width') || 250) >= 120 && Number(img.attr('height') || 150) >= 80) {
      candidates.push(img.attr('data-src'), img.attr('src'));
    }
  }
  return candidates.map(value => safeImageUrl(value, articleUrl)).find(Boolean) || null;
}

function approvedPublisherUrl(value, source) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password ||
        !source.domains.some(domain => host === domain || host.endsWith(`.${domain}`))) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

// Read only a small amount of HTML. RSS checks remain separate; this happens
// only when we are about to post a new article without an RSS image.
async function readLimitedHtml(response, limit = 1_500_000) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return '';
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function articleOpenGraphImage(article) {
  // Redirects are followed only if the next URL is still on the publisher's
  // allowlisted domains. This avoids requesting arbitrary URLs from RSS data.
  let url = article.url;
  for (let i = 0; i < 3; i++) {
    const approved = approvedPublisherUrl(url, article.source);
    if (!approved) return null;
    const response = await fetch(approved, {
      redirect: 'manual',
      signal: AbortSignal.timeout(7000),
      headers: {
        'user-agent': 'MissedTheApex-F1News/1.1 (article preview metadata)',
        accept: 'text/html,application/xhtml+xml',
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) return null;
      url = new URL(location, approved).href;
      continue;
    }
    if (!response.ok) return null; // Including 403/429: no retries or bypasses
    const type = response.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml\+xml/i.test(type)) return null;
    const html = await readLimitedHtml(response);
    if (!html) return null;
    const $ = load(html);
    const image = $('meta[property="og:image:secure_url"]').first().attr('content')
      || $('meta[property="og:image"]').first().attr('content')
      || $('meta[name="twitter:image"]').first().attr('content')
      || $('meta[name="twitter:image:src"]').first().attr('content');
    return safeImageUrl(image, approved);
  }
  return null;
}

// Optional, non-posting Codespaces test for an individual article.
export async function previewArticleImage(articleUrl) {
  const source = F1_NEWS_SOURCES.find(candidate => normaliseUrl(articleUrl, candidate));
  if (!source) throw new Error('Article must be on an approved publisher domain');
  return { source: source.name, imageUrl: await articleOpenGraphImage({ url: articleUrl, source }) };
}

async function readSource(source) {
  const response = await fetch(source.rss, {
    signal: AbortSignal.timeout(15000),
    headers: {
      'user-agent': 'MissedTheApex-F1News/1.0 (Discord RSS notifications)',
      accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    },
  });
  if (response.status === 429) {
    throw new RateLimitError(source, response.headers.get('retry-after'));
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const xml = await response.text();
  if (xml.length > 3_000_000) throw new Error('Unexpectedly large feed');
  const feed = await parser.parseString(xml);
  if (!feed.items?.length) throw new Error('RSS returned no items');

  return feed.items.map(item => {
    const url = normaliseUrl(item.link, source);
    const title = String(item.title || '').replace(/\s+/g, ' ').trim().slice(0, 256);
    if (!url || !title || !isF1(item, source)) return null;
    const raw = item.isoDate || item.pubDate;
    const date = raw ? new Date(raw) : null;
    return {
      url, title, source, id: sha256(url), headline: titleKey(title),
      label: labelFor(item),
      imageUrl: feedImage(item, url),
      date: date && !Number.isNaN(date.getTime()) ? date : null,
    };
  }).filter(Boolean);
}

// Run this from the included read-only test script before touching Railway.
export async function previewF1News() {
  const result = [];
  for (const source of F1_NEWS_SOURCES) {
    try {
      const articles = await readSource(source);
      result.push({ source: source.name, found: articles.length, examples: articles.slice(0, 2).map(a => a.title) });
    } catch (error) {
      result.push({ source: source.name, error: error.message });
    }
  }
  return result;
}

function makeEmbed(article) {
  const colour = article.label === 'OPINION' ? 0x9461BF :
    article.label === 'ANALYSIS' ? 0x2675D9 : 0xD43B35;
  const embed = new EmbedBuilder()
    .setColor(colour)
    .setAuthor({ name: `${article.source.name} • ${article.label}` })
    .setTitle(article.title)
    .setURL(article.url)
    .setDescription('Read the full story using the headline link above.')
    .setFooter({ text: 'MissedTheApex News • Publisher reports are not official FIA confirmation' });
  if (article.imageUrl) embed.setImage(article.imageUrl);
  if (article.date) embed.setTimestamp(article.date);
  return embed;
}

export async function checkF1News(bot) {
  if (process.env.F1_NEWS_ENABLED !== 'true' || checking || !bot.isReady()) return;
  if (!process.env.F1_NEWS_CHANNEL_ID) {
    logger.warn('[F1 News] Missing F1_NEWS_CHANNEL_ID');
    return;
  }
  // Identical readiness guard to the existing FIA documents feature.
  if (!bot.db || bot.db.getStatus?.().isDegraded) {
    logger.warn('[F1 News] Persistent database unavailable. Alerts paused to avoid duplicates.');
    return;
  }

  checking = true;
  try {
    const channel = await bot.channels.fetch(process.env.F1_NEWS_CHANNEL_ID);
    if (!channel?.isTextBased() || typeof channel.send !== 'function') {
      throw new Error('F1_NEWS_CHANNEL_ID is not a sendable Discord text channel');
    }

    const old = await bot.db.get(HISTORY_KEY, null);
    if (old !== null && !Array.isArray(old)) throw new Error('Invalid news history: refusing to post duplicates');
    const now = Date.now();
    const history = (old || []).filter(x => x && typeof x.id === 'string' && typeof x.headline === 'string' && Number(x.at) > now - RETENTION_MS);
    const urls = new Set(history.map(x => x.id));
    const headlines = new Set(history.map(x => x.headline));
    const remember = a => {
      if (urls.has(a.id)) return;
      urls.add(a.id);
      headlines.add(a.headline);
      history.push({ id: a.id, headline: a.headline, at: Date.now() });
    };
    const persist = () => bot.db.set(HISTORY_KEY, history.slice(-3000));

    let online = 0;
    const pending = [];
    for (const source of F1_NEWS_SOURCES) {
      const cooldownKey = `cache:f1news:v1:cooldown:${source.id}`;
      try {
        // Store cooldowns in PostgreSQL, not memory, so Railway restarts do
        // not cause fresh requests while the publisher is rate-limiting us.
        const cooldownUntil = Number(await bot.db.get(cooldownKey, 0)) || 0;
        if (cooldownUntil > Date.now()) continue;

        const articles = await readSource(source);
        // A successful fetch clears any previously expired cooldown.
        if (cooldownUntil !== 0) await bot.db.set(cooldownKey, 0);
        online++;
        const seedKey = `cache:f1news:v1:source:${source.id}`;
        const seeded = await bot.db.get(seedKey, null);
        if (seeded === null) {
          for (const article of articles) remember(article);
          await persist();
          await bot.db.set(seedKey, true);
          logger.info(`[F1 News] Seeded ${articles.length} existing ${source.name} articles (no backlog posted).`);
        } else if (seeded !== true) {
          throw new Error(`Unexpected source state for ${source.name}`);
        } else {
          pending.push(...articles);
        }
      } catch (error) {
        if (error instanceof RateLimitError) {
          const until = Date.now() + error.retryAfterMs;
          try {
            await bot.db.set(cooldownKey, until);
            logger.warn(`[F1 News] ${source.name}: HTTP 429. Pausing requests until ${new Date(until).toISOString()}.`);
          } catch (dbError) {
            logger.error(`[F1 News] Could not save ${source.name} cooldown:`, dbError);
          }
        } else {
          logger.warn(`[F1 News] ${source.name}: ${error.message}`);
        }
      }
    }

    if (online === 0) throw new Error('All news feeds failed. Check Railway networking or RSS URLs.');
    if (await bot.db.get(ACTIVE_KEY, null) === null) {
      // A real post tests bot permissions without flooding the channel.
      await channel.send({
        content: `✅ **MissedTheApex F1 News is active.** Watching ${online}/${F1_NEWS_SOURCES.length} trusted publishers. Existing headlines have been recorded; only newly discovered articles will be posted.`,
        allowedMentions: { parse: [] },
      });
      await bot.db.set(ACTIVE_KEY, true);
    }

    pending.sort((a, b) => (a.date?.getTime() || 0) - (b.date?.getTime() || 0));
    let posted = 0;
    let duplicates = 0;
    for (const article of pending) {
      if (posted >= MAX_POSTS_PER_CHECK) break;
      if (article.date && article.date.getTime() < now - MAX_ARTICLE_AGE_MS) continue;
      if (urls.has(article.id) || headlines.has(article.headline)) {
        if (!urls.has(article.id)) {
          remember(article);
          await persist();
        }
        duplicates++;
        continue;
      }
      // Fetch the publisher's social-preview image only for a new post;
      // never revisit articles already seen in PostgreSQL.
      if (!article.imageUrl) {
        try {
          article.imageUrl = await articleOpenGraphImage(article);
        } catch (error) {
          logger.info(`[F1 News] Image not available from ${article.source.name}: ${error.message}`);
        }
      }
      // Send before recording success. A crash between both operations may
      // very occasionally duplicate a post on restart; see SETUP.md.
      await channel.send({ embeds: [makeEmbed(article)], allowedMentions: { parse: [] } });
      remember(article);
      await persist();
      posted++;
    }
    logger.info(`[F1 News] Finished: sources ${online}/${F1_NEWS_SOURCES.length}, posted ${posted}, duplicates ${duplicates}.`);
  } catch (error) {
    logger.error('[F1 News] Check failed:', error);
  } finally {
    checking = false;
  }
}
