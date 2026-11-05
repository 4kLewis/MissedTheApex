import axios from 'axios';
import * as cheerio from 'cheerio';
import { EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { fetchAndRenderFiaPdfPreview } from './fiaPdfPreview.js';
import { logger } from '../utils/logger.js';

// Official public FIA archive (2026). Set FIA_DOCUMENTS_URL for future seasons.
const DEFAULT_ARCHIVE =
  'https://api.fia.com/documents/championships/fia-formula-one-world-championship-14/season/season-2026-2072';
const MAX_PER_CHECK = 8;
let checking = false;
let previewConfigLogged = false;

function previewsEnabled() {
  return String(process.env.FIA_PDF_PREVIEWS_ENABLED || '').trim().toLowerCase() === 'true';
}

function logPreviewConfigOnce() {
  if (previewConfigLogged) return;
  previewConfigLogged = true;
  const enabled = previewsEnabled();
  const pages = Math.max(1, Math.min(4, Number(process.env.FIA_PDF_PREVIEW_PAGES) || 4));
  logger.info(`[FIA Docs] PDF previews: ${enabled ? 'ENABLED' : 'DISABLED'}; pages=${pages}; Node=${process.version}; ` +
    (enabled ? 'new documents will attempt image rendering' : 'set FIA_PDF_PREVIEWS_ENABLED=true only if authorised to reproduce previews'));
}

function sourceUrl() {
  const value = process.env.FIA_DOCUMENTS_URL || DEFAULT_ARCHIVE;
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['fia.com', 'www.fia.com', 'api.fia.com'].includes(url.hostname)) {
    throw new Error('FIA_DOCUMENTS_URL must be an HTTPS URL on an FIA domain');
  }
  return url.toString();
}

function eventNameFromPdf(pdfUrl) {
  const filename = decodeURIComponent(new URL(pdfUrl).pathname.split('/').at(-1) || '');
  const match = filename.match(/^(20\d{2})_(.+?)_-_/i);
  if (!match) return `FIA Formula One ${process.env.FIA_DOCUMENTS_SEASON || '2026'}`;
  return `${match[1]} ${match[2].replaceAll('_', ' ').replace(/\b\w/g, char => char.toUpperCase())}`;
}

// This parses the FIA's public document-listing HTML, not a documented API.
// The FIA can change its markup, so fail closed if it stops matching.
export function parseFiaDocuments(html, archiveUrl) {
  const $ = cheerio.load(html);
  const docs = new Map();

  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    if (!href) return;

    let absolute;
    try {
      absolute = new URL(href, archiveUrl);
    } catch {
      return;
    }
    if (absolute.protocol !== 'https:' ||
        !['fia.com', 'www.fia.com', 'api.fia.com'].includes(absolute.hostname) ||
        !absolute.pathname.toLowerCase().endsWith('.pdf')) return;

    // On some Drupal templates the label is on the containing list item.
    let label = $(element).text().replace(/\s+/g, ' ').trim();
    if (!/\bDoc\s*\d+\s*[-–—:]/i.test(label)) {
      label = $(element).closest('li').text().replace(/\s+/g, ' ').trim();
    }
    const match = label.match(/\bDoc\s*(\d+)\s*[-–—:]\s*(.*?)(?=\s+Published on\b|$)/i);
    if (!match) return;

    const published = label.match(/\bPublished on\s+(.+)$/i)?.[1]?.trim() || null;
    const doc = {
      number: Number(match[1]),
      title: match[2].trim().slice(0, 230),
      published: published?.slice(0, 80) || null,
      url: absolute.toString(),
      event: eventNameFromPdf(absolute.toString()),
    };
    if (doc.title && !docs.has(doc.url)) docs.set(doc.url, doc);
  });

  return [...docs.values()];
}

export async function fetchFiaDocuments() {
  const archive = sourceUrl();
  const { data } = await axios.get(archive, {
    timeout: 15_000,
    responseType: 'text',
    headers: { 'User-Agent': 'MissedTheApex-FIA-Documents/1.0 (Discord document-link notifications)' },
    maxRedirects: 3,
  });
  const docs = parseFiaDocuments(data, archive);
  if (!docs.length) throw new Error('FIA archive returned no recognizable document links; HTML may have changed.');
  return { archive, docs };
}

function makeEmbed(doc) {
  const isStewarding = /summons|infringement|decision|stewards/i.test(doc.title);
  const embed = new EmbedBuilder()
    .setColor(isStewarding ? 0xDC3545 : 0x2872D9)
    .setTitle(`FIA Doc ${doc.number} — ${doc.title}`.slice(0, 256))
    .setURL(doc.url)
    .setDescription(`**${doc.event}**\n[View original FIA PDF](${doc.url})`)
    .setFooter({ text: 'MissedTheApex • FIA document alerts • Unofficial' });
  if (doc.published) embed.addFields({ name: 'Listed publication time', value: doc.published });
  return embed;
}

/**
 * Poll the FIA and post new document LINKS. First run seeds its list, so it
 * doesn't dump historic race-weekend documents into the server.
 * Configure only one Railway replica to avoid cross-process duplicate checks.
 */
export async function checkFiaDocuments(client) {
  if (checking) return;
  const channelId = process.env.FIA_DOCUMENTS_CHANNEL_ID;
  if (!channelId || !client.isReady()) return;
  if (!client.db || client.db.getStatus?.().isDegraded) {
    logger.warn('[FIA Docs] PostgreSQL is unavailable; alerts paused to avoid duplicates.');
    return;
  }

  logPreviewConfigOnce();
  checking = true;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || typeof channel.send !== 'function') {
      throw new Error(`FIA_DOCUMENTS_CHANNEL_ID (${channelId}) is not a sendable text channel`);
    }

    const { archive, docs } = await fetchFiaDocuments();
    const season = process.env.FIA_DOCUMENTS_SEASON || '2026';
    const storageKey = `cache:fia:document_urls:${season}`;
    const existing = await client.db.get(storageKey, null);

    if (existing === null) {
      // No backlog flood on first deployment. New documents will be sent on later checks.
      await client.db.set(storageKey, docs.map(d => d.url));
      logger.info(`[FIA Docs] Seeded ${docs.length} documents for ${season}.`);
      await channel.send({
        content: `✅ **MissedTheApex FIA alerts enabled.** Tracking ${docs.length} existing documents for ${season}. New releases will appear here automatically.\nSource: ${archive}`,
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (!Array.isArray(existing)) {
      throw new Error('Unexpected FIA document cache value; refusing to post duplicates.');
    }

    const seen = new Set(existing);
    const pending = docs.filter(doc => !seen.has(doc.url)).reverse().slice(0, MAX_PER_CHECK);
    for (const doc of pending) {
      const embed = makeEmbed(doc);
      const message = { embeds: [embed], allowedMentions: { parse: [] } };
      if (previewsEnabled()) {
        try {
          const maxPages = Math.max(1, Math.min(4, Number(process.env.FIA_PDF_PREVIEW_PAGES) || 4));
          const preview = await fetchAndRenderFiaPdfPreview(doc.url, maxPages);
          const name = `fia-doc-${doc.number}-preview.${preview.extension}`;
          embed.setImage(`attachment://${name}`);
          message.files = [new AttachmentBuilder(preview.data, { name })];
          logger.info(`[FIA Docs] Created ${preview.pages}-page PDF preview for Doc ${doc.number}.`);
        } catch (error) {
          // Keep the existing FIA link notification, even if PDF rendering fails.
          logger.warn(`[FIA Docs] PREVIEW_FAILED Doc ${doc.number} (${doc.event}): ${error.message}. Sending link-only alert.`);
          if (error.stack) logger.debug(`[FIA Docs] Preview stack: ${error.stack}`);
        }
      } else {
        logger.info(`[FIA Docs] PREVIEW_DISABLED Doc ${doc.number}; sending the original PDF link.`);
      }
      try {
        await channel.send(message);
      } catch (sendError) {
        if (!message.files?.length) throw sendError;
        logger.warn(`[FIA Docs] PREVIEW_UPLOAD_FAILED Doc ${doc.number}: ${sendError.message}. Retrying link-only (check Attach Files permission).`);
        embed.setImage(null);
        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
      }
      seen.add(doc.url);
      await client.db.set(storageKey, [...seen]);
      logger.info(`[FIA Docs] Posted: ${doc.event} / Doc ${doc.number} / ${doc.title}`);
    }
  } catch (error) {
    logger.error('[FIA Docs] Check failed:', error);
  } finally {
    checking = false;
  }
}
