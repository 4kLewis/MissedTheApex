/**
 * MissedTheApex Championship Tracker v1
 * OpenF1 beta standings, two edited Discord boards, persisted state, manual FIA review.
 * No writes to existing FIA, news or moderation storage keys.
 */
import cron from 'node-cron';
import { EmbedBuilder } from 'discord.js';
import { logger } from '../utils/logger.js';
import { fetchFiaDocuments } from './fiaDocumentsService.js';
import { buildSnapshot, standingsHash, selectRace, racePhase, boardText, isAllowedFiaPdf } from './f1ChampionshipCore.js';

const API = 'https://api.openf1.org';
const PREFIX = 'cache:f1championship:v1';
const DEFAULT_YEAR = 2026;
const DISCOVERY_INTERVAL = 20 * 60_000;
const METADATA_CACHE_MS = 2 * 60 * 60_000;
const POSTRACE_POLL_MS = 20 * 60_000;
const API_TIMEOUT_MS = 15000;

let busy = false;
let cachedSessions = null;
let sessionsAt = 0;
let cachedDrivers = new Map();
let cachedToken = null;
let tokenExpires = 0;
let cooldownUntil = 0;
let lastPostRacePoll = 0;
let lastFiaLookup = 0;

const channelKey = channelId => `${PREFIX}:${channelId}:latest`;
const boardKey = (channelId, sessionKey) => `${PREFIX}:${channelId}:${sessionKey}`;
const configuredYear = () => {
  const year = Number(process.env.F1_CHAMPIONSHIP_SEASON || DEFAULT_YEAR);
  if (!Number.isInteger(year) || year < 2023 || year > 2100) throw new Error('Invalid F1_CHAMPIONSHIP_SEASON');
  return year;
};
const safeHostError = error => String(error?.message || error).slice(0, 300);

async function getToken() {
  if (cachedToken && Date.now() < tokenExpires - 60000) return cachedToken;
  const username = process.env.OPENF1_USERNAME;
  const password = process.env.OPENF1_PASSWORD;
  if (!username || !password) throw new Error('OPENF1_USERNAME and OPENF1_PASSWORD must be set in Railway');
  const result = await fetch(`${API}/token`, {
    method: 'POST', signal: AbortSignal.timeout(API_TIMEOUT_MS),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }),
  });
  if (!result.ok) throw new Error(`OpenF1 token request HTTP ${result.status}`);
  const body = await result.json();
  if (!body.access_token) throw new Error('OpenF1 did not issue an access token');
  const duration = Math.max(300, Number(body.expires_in) || 3600);
  cachedToken = body.access_token;
  tokenExpires = Date.now() + duration * 1000;
  return cachedToken;
}

async function openF1(path, retry = true) {
  if (Date.now() < cooldownUntil) throw new Error(`OpenF1 rate-limited until ${new Date(cooldownUntil).toISOString()}`);
  const token = await getToken();
  const response = await fetch(`${API}/v1/${path}`, {
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
    headers: { accept: 'application/json', authorization: `Bearer ${token}` },
  });
  if (response.status === 401 && retry) {
    cachedToken = null;
    tokenExpires = 0;
    return openF1(path, false);
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after');
    const seconds = /^\d+$/.test(retryAfter || '') ? Number(retryAfter) : null;
    const asDate = retryAfter ? Date.parse(retryAfter) : NaN;
    const requested = seconds !== null ? seconds * 1000 : Number.isFinite(asDate) ? asDate - Date.now() : 0;
    cooldownUntil = Date.now() + Math.max(15 * 60_000, requested);
    throw new Error('OpenF1 HTTP 429: pausing requests');
  }
  if (!response.ok) throw new Error(`OpenF1 HTTP ${response.status} on /${path.split('?')[0]}`);
  const json = await response.json();
  if (!Array.isArray(json)) throw new Error('Unexpected OpenF1 response (expected JSON array)');
  return json;
}

async function findRace(get = openF1, now = Date.now()) {
  if (!cachedSessions || now - sessionsAt > DISCOVERY_INTERVAL) {
    cachedSessions = await get(`sessions?year=${configuredYear()}`);
    sessionsAt = now;
  }
  return selectRace(cachedSessions, now);
}

function matchingFiaDoc(doc, session) {
  if (!/championship\s+points/i.test(doc.title || '')) return false;
  if (!isAllowedFiaPdf(doc.url)) return false;
  const norm = text => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const event = norm(doc.event);
  const words = [session.meeting_name, session.location, session.country_name]
    .map(norm).filter(s => s && s.length >= 5 && !['grand prix', 'race'].includes(s));
  return words.some(word => event.includes(word));
}

function makeEmbed(snapshot, type, state, now) {
  const phase = racePhase(state.session, now);
  const confirmed = state.verified?.hash === standingsHash(snapshot);
  const status = confirmed ? 'FIA CROSS-CHECKED BY SERVER ADMIN' :
    state.fiaDocUrl ? 'FIA DOCUMENT AVAILABLE · AWAITING REVIEW' : phase;
  const standings = type === 'drivers' ? snapshot.drivers : snapshot.teams;
  const embed = new EmbedBuilder()
    .setColor(confirmed ? 0x228E68 : phase.startsWith('LIVE') ? 0xF1A722 : 0x387FDB)
    .setTitle(`${type === 'drivers' ? '🏆 Drivers' : '🏁 Constructors'} Championship · ${configuredYear()}`)
    .setDescription(`**${snapshot.event}**\n**${status}**\n\n${boardText(standings)}`)
    .setFooter({ text: `MissedTheApex · OpenF1 beta data · ${confirmed ? 'Manually compared with FIA by server admin' : 'Provisional: NOT an official classification'}` })
    .setTimestamp(new Date(snapshot.at));
  if (state.fiaDocUrl) embed.addFields({ name: 'FIA Championship Points document', value: `[Read official PDF](${state.fiaDocUrl})` });
  return embed;
}

async function sendOrEdit(channel, messageId, embed) {
  if (messageId) {
    try {
      const message = await channel.messages.fetch(messageId);
      await message.edit({ embeds: [embed], allowedMentions: { parse: [] } });
      return message.id;
    } catch (error) {
      // Only re-post if the old message is gone. A permission/network failure must not spam.
      if (error.code !== 10008) throw error;
    }
  }
  const message = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  return message.id;
}

function isDBReady(bot) {
  return bot.db && !bot.db.getStatus?.().isDegraded && typeof bot.db.get === 'function' && typeof bot.db.set === 'function';
}

/** Poll a known race only. The optional injected `get` enables offline integration testing. */
export async function checkF1Championship(bot, { get = openF1, now = Date.now(), allowFia = true } = {}) {
  if (process.env.F1_CHAMPIONSHIP_ENABLED !== 'true' || busy || !bot.isReady()) return 'disabled-or-busy';
  if (!isDBReady(bot)) { logger.warn('[F1 Championship] PostgreSQL unavailable; paused.'); return 'db-unavailable'; }
  const channelId = process.env.F1_CHAMPIONSHIP_CHANNEL_ID;
  if (!/^\d{15,23}$/.test(channelId || '')) { logger.warn('[F1 Championship] Invalid F1_CHAMPIONSHIP_CHANNEL_ID'); return 'no-channel'; }
  busy = true;
  try {
    const session = await findRace(get, now);
    if (!session) { logger.debug('[F1 Championship] No current or recent race session.'); return 'no-race'; }
    const postRace = racePhase(session, now).startsWith('POST');
    if (postRace && now - lastPostRacePoll < POSTRACE_POLL_MS) return 'postrace-cooldown';
    if (postRace) lastPostRacePoll = now;
    const key = Number(session.session_key);
    if (!Number.isInteger(key)) throw new Error('OpenF1 returned invalid session key');
    const old = await bot.db.get(boardKey(channelId, key), null);
    if (old && (old.snapshot?.sessionKey !== key || !old.session)) throw new Error('Stored championship state is invalid; refusing to overwrite');
    const driversRows = await get(`championship_drivers?session_key=${key}`);
    const teamsRows = await get(`championship_teams?session_key=${key}`);
    let driverMetadata = cachedDrivers.get(key);
    if (!driverMetadata || now - driverMetadata.at > METADATA_CACHE_MS) {
      driverMetadata = { at: now, data: await get(`drivers?session_key=${key}`) };
      cachedDrivers.set(key, driverMetadata);
    }
    const snapshot = buildSnapshot({ driversRows, teamsRows, driverMetadata: driverMetadata.data, session, at: now });
    const hash = standingsHash(snapshot);
    const state = old || { session, messages: {}, fiaDocUrl: null, verified: null, snapshot: null, hash: null, displaySignature: null };
    state.session = session;
    state.snapshot = snapshot;
    state.hash = hash;
    if (state.verified && state.verified.hash !== hash) {
      logger.warn('[F1 Championship] Standings changed after manual FIA review; reverting to provisional.');
      state.verified = null;
    }
    // FIA is official evidence, not automated proof of a numeric match.
    if (allowFia && postRace && process.env.F1_CHAMPIONSHIP_FIA_LOOKUP === 'true' && now - lastFiaLookup > 20 * 60000) {
      lastFiaLookup = now;
      try {
        const { docs } = await fetchFiaDocuments();
        const match = docs.find(doc => matchingFiaDoc(doc, session));
        if (match && state.fiaDocUrl !== match.url) state.fiaDocUrl = match.url;
      } catch (error) { logger.warn(`[F1 Championship] FIA lookup unavailable: ${safeHostError(error)}`); }
    }
    const phase = racePhase(session, now);
    const signature = `${hash}|${phase}|${state.fiaDocUrl || ''}|${state.verified?.hash || ''}`;
    if (process.env.F1_CHAMPIONSHIP_DRY_RUN !== 'false') {
      logger.info(`[F1 Championship] DRY RUN: ${snapshot.event}, ${snapshot.drivers.length} drivers, ${snapshot.teams.length} teams, phase=${phase}. No Discord posts.`);
      return 'dry-run';
    }
    if (old?.displaySignature === signature && old.messages?.drivers && old.messages?.teams) return 'unchanged';
    const channel = await bot.channels.fetch(channelId);
    if (!channel || typeof channel.send !== 'function' || !channel.messages?.fetch) throw new Error('Championship channel cannot send or edit messages');
    state.messages.drivers = await sendOrEdit(channel, state.messages.drivers, makeEmbed(snapshot, 'drivers', state, now));
    // Persist first ID before sending second board, reducing duplicates on errors.
    await bot.db.set(boardKey(channelId, key), state);
    state.messages.teams = await sendOrEdit(channel, state.messages.teams, makeEmbed(snapshot, 'teams', state, now));
    state.displaySignature = signature;
    await bot.db.set(boardKey(channelId, key), state);
    await bot.db.set(channelKey(channelId), key);
    logger.info(`[F1 Championship] Updated both boards for ${snapshot.event} (${phase}).`);
    return 'updated';
  } catch (error) {
    logger.warn(`[F1 Championship] Check failed safely: ${safeHostError(error)}`);
    return 'error';
  } finally { busy = false; }
}

export async function getChampionshipState(bot) {
  const channelId = process.env.F1_CHAMPIONSHIP_CHANNEL_ID;
  if (!isDBReady(bot) || !channelId) return null;
  const sessionKey = await bot.db.get(channelKey(channelId), null);
  if (!sessionKey) return null;
  return bot.db.get(boardKey(channelId, sessionKey), null);
}

/** Called only by an admin after manually comparing both standings to the FIA PDF. */
export async function markFiaReviewed(bot, pdfUrl, adminId) {
  if (!isAllowedFiaPdf(pdfUrl)) throw new Error('Enter an official FIA HTTPS Championship Points PDF link');
  const channelId = process.env.F1_CHAMPIONSHIP_CHANNEL_ID;
  const sessionKey = await bot.db.get(channelKey(channelId), null);
  if (!sessionKey) throw new Error('No championship board has been published yet');
  const stateKey = boardKey(channelId, sessionKey);
  const state = await bot.db.get(stateKey, null);
  if (!state?.snapshot) throw new Error('No standings snapshot to review');
  if (racePhase(state.session).startsWith('LIVE')) throw new Error('Race not finished; cannot manually confirm yet');
  const hash = standingsHash(state.snapshot);
  state.fiaDocUrl = pdfUrl;
  state.verified = { hash, by: String(adminId), at: Date.now(), url: pdfUrl };
  state.displaySignature = null;
  await bot.db.set(stateKey, state);
  const channel = await bot.channels.fetch(channelId);
  if (!channel?.messages?.fetch) throw new Error('Channel not available for editing');
  state.messages.drivers = await sendOrEdit(channel, state.messages.drivers, makeEmbed(state.snapshot, 'drivers', state, Date.now()));
  await bot.db.set(stateKey, state);
  state.messages.teams = await sendOrEdit(channel, state.messages.teams, makeEmbed(state.snapshot, 'teams', state, Date.now()));
  state.displaySignature = `${hash}|${racePhase(state.session)}|${state.fiaDocUrl}|${hash}`;
  await bot.db.set(stateKey, state);
  return state;
}

export function startF1ChampionshipTracker(bot) {
  if (process.env.F1_CHAMPIONSHIP_ENABLED !== 'true') {
    logger.info('[F1 Championship] Disabled (set F1_CHAMPIONSHIP_ENABLED=true to start).');
    return;
  }
  // One replica only. This sets up no extra commands/event handlers and no DB migrations.
  cron.schedule('*/2 * * * *', () => void checkF1Championship(bot).catch(err => logger.error('[F1 Championship]', err)));
  void checkF1Championship(bot).catch(err => logger.error('[F1 Championship] Startup check failed:', err));
  logger.info('[F1 Championship] Scheduled 2-minute checks. Dry run enabled unless F1_CHAMPIONSHIP_DRY_RUN=false.');
}
