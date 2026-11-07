/**
 * MissedTheApex Championship Tracker v1
 * OpenF1 beta standings, two edited Discord boards, persisted state, manual FIA review.
 * No writes to existing FIA, news or moderation storage keys.
 */
import cron from 'node-cron';
import { EmbedBuilder } from 'discord.js';
import { logger } from '../utils/logger.js';
import { fetchFiaDocuments } from './fiaDocumentsService.js';
import { buildSnapshot, standingsHash, selectRace, racePhase, boardText, isAllowedFiaPdf, buildPublishedStandings } from './f1ChampionshipCore.js';
import { championshipBoardRows, raceFlagUrl, teamEmojiStamp } from './f1ChampionshipAppearance.js';

const API = 'https://api.openf1.org';
const JOLPICA = 'https://api.jolpi.ca/ergast/f1';
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
let lastPublishedPoll = 0;
const PUBLISHED_POLL_MS = 30 * 60_000;

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

async function jolpica(path) {
  const response = await fetch(`${JOLPICA}/${path}`, {
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
    headers: { accept: 'application/json', 'user-agent': 'MissedTheApex-standings/2.0' },
  });
  if (!response.ok) throw new Error(`Jolpica HTTP ${response.status} on /${path.split('?')[0]}`);
  return response.json();
}

async function fetchPublished(year, { jget = jolpica, now = Date.now() } = {}) {
  const [drivers, teams] = await Promise.all([
    jget(`${year}/driverstandings.json`),
    jget(`${year}/constructorstandings.json`),
  ]);
  // Naming the last round is optional. Failure must not hide the standings.
  let eventName = '';
  let raceCountry = '';
  try {
    const last = await jget(`${year}/last/results.json?limit=1`);
    const race = last?.MRData?.RaceTable?.Races?.[0];
    const round = Number(drivers?.MRData?.StandingsTable?.StandingsLists?.[0]?.round);
    if (race && Number(race.round) === round) {
      eventName = `${race.raceName} · Round ${round}`;
      raceCountry = String(race.Circuit?.Location?.country || '').trim();
    }
  } catch (error) {
    logger.debug(`[F1 Championship] Last-race name unavailable: ${safeHostError(error)}`);
  }
  return buildPublishedStandings({ driverPayload: drivers, teamPayload: teams,
    eventName, raceCountry, year, at: now });
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

function makeEmbed(snapshot, type, state, now, guild = null) {
  const published = snapshot.source === 'jolpica';
  const phase = published ? `CURRENT PUBLISHED STANDINGS · ROUND ${snapshot.round}` : racePhase(state.session, now);
  const confirmed = state.verified?.hash === standingsHash(snapshot);
  const status = confirmed ? 'FIA CROSS-CHECKED BY SERVER ADMIN' :
    state.fiaDocUrl ? `${phase} · FIA PDF AVAILABLE FOR REVIEW` : phase;
  const standings = type === 'drivers' ? snapshot.drivers : snapshot.teams;
  const text = championshipBoardRows(standings, type, { guild, live: !published });
  const embed = new EmbedBuilder()
    .setColor(confirmed ? 0x228E68 : !published && phase.startsWith('LIVE') ? 0xF1A722 : 0x387FDB)
    .setTitle(`${type === 'drivers' ? '🏆 Drivers' : '🏁 Constructors'} Championship · ${configuredYear()}`)
    .setDescription(`**${snapshot.event}**\n**${status}**\n\n${text}`)
    .setFooter({ text: `MissedTheApex · ${published ? 'Jolpica season standings' : 'OpenF1 beta live projections'} · ${confirmed ? 'Manually compared to FIA by admin' : 'Unofficial / not FIA-certified'}` })
    .setTimestamp(new Date(snapshot.at));
  // Top-right PNG; hide it entirely if the host country is unknown.
  const flag = raceFlagUrl(snapshot.raceCountry);
  if (flag) embed.setThumbnail(flag);
  if (state.fiaDocUrl) embed.addFields({ name: 'FIA Championship Points', value: `[Read official PDF](${state.fiaDocUrl})` });
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

/** Display latest COMPLETED round immediately, switching to OpenF1 once a race starts.
 * All versions use the same two Discord message IDs across race weekends.
 */
export async function checkF1Championship(bot, { get = openF1, jget = jolpica,
  now = Date.now(), allowFia = true, force = false } = {}) {
  if (process.env.F1_CHAMPIONSHIP_ENABLED !== 'true' || busy || !bot.isReady()) return 'disabled-or-busy';
  if (!isDBReady(bot)) { logger.warn('[F1 Championship] PostgreSQL unavailable; paused.'); return 'db-unavailable'; }
  const channelId = process.env.F1_CHAMPIONSHIP_CHANNEL_ID;
  if (!/^\d{15,23}$/.test(channelId || '')) { logger.warn('[F1 Championship] Invalid F1_CHAMPIONSHIP_CHANNEL_ID'); return 'no-channel'; }
  busy = true;
  try {
    const year = configuredYear();
    let session = null;
    try { session = await findRace(get, now); }
    catch (error) { logger.warn(`[F1 Championship] OpenF1 race discovery unavailable; using latest published standings: ${safeHostError(error)}`); }
    // Before the race actually starts, use completed-round standings, not projected points.
    const raceStarted = session && now >= Date.parse(session.date_start);
    const postRace = raceStarted && racePhase(session, now).startsWith('POST');
    const useOpenF1 = raceStarted;
    let snapshot;
    if (useOpenF1) {
      if (!force && postRace && now - lastPostRacePoll < POSTRACE_POLL_MS) return 'postrace-cooldown';
      if (postRace) lastPostRacePoll = now;
      const key = Number(session.session_key);
      if (!Number.isInteger(key)) throw new Error('OpenF1 returned invalid race session key');
      const driversRows = await get(`championship_drivers?session_key=${key}`);
      const teamsRows = await get(`championship_teams?session_key=${key}`);
      let driverMetadata = cachedDrivers.get(key);
      if (!driverMetadata || now - driverMetadata.at > METADATA_CACHE_MS) {
        driverMetadata = { at: now, data: await get(`drivers?session_key=${key}`) };
        cachedDrivers.set(key, driverMetadata);
      }
      snapshot = buildSnapshot({ driversRows, teamsRows, driverMetadata: driverMetadata.data, session, at: now });
      snapshot.source = 'openf1';
    } else {
      if (!force && lastPublishedPoll && now - lastPublishedPoll < PUBLISHED_POLL_MS) return 'published-cooldown';
      snapshot = await fetchPublished(year, { jget, now });
      lastPublishedPoll = now;
      session = {
        session_key: snapshot.sessionKey, meeting_name: snapshot.event,
        session_name: 'Race', date_start: '2000-01-01T00:00:00Z',
        // Historical placeholder: manual FIA review must never mistake it for a live race.
        date_end: '2000-01-01T02:00:00Z',
      };
    }
    const key = snapshot.sessionKey;
    const storedKey = await bot.db.get(channelKey(channelId), null);
    const old = await bot.db.get(boardKey(channelId, key), null);
    if (old && (old.snapshot?.sessionKey !== key || !old.session)) throw new Error('Stored championship state invalid');
    // Migrate the two existing board message IDs across rounds, so the channel stays tidy.
    const previous = !old && storedKey && Number(storedKey) !== key
      ? await bot.db.get(boardKey(channelId, storedKey), null) : null;
    const state = old || {
      session, messages: { ...(previous?.messages || {}) },
      fiaDocUrl: null, verified: null, snapshot: null, hash: null, displaySignature: null,
    };
    state.session = session;
    state.snapshot = snapshot;
    const hash = standingsHash(snapshot);
    state.hash = hash;
    if (state.verified && state.verified.hash !== hash) {
      state.verified = null;
      logger.warn('[F1 Championship] Standings changed since FIA review; reverted to provisional.');
    }
    if (allowFia && postRace && process.env.F1_CHAMPIONSHIP_FIA_LOOKUP === 'true'
        && now - lastFiaLookup > 20 * 60000) {
      lastFiaLookup = now;
      try {
        const { docs } = await fetchFiaDocuments();
        const match = docs.find(doc => matchingFiaDoc(doc, session));
        if (match && match.url !== state.fiaDocUrl) state.fiaDocUrl = match.url;
      } catch (error) { logger.warn(`[F1 Championship] FIA lookup unavailable: ${safeHostError(error)}`); }
    }
    const phase = snapshot.source === 'jolpica' ? `PUBLISHED ROUND ${snapshot.round}` : racePhase(session, now);
    const cachedChannel = bot.channels.cache?.get(channelId);
    const signature = `${hash}|${phase}|${state.fiaDocUrl || ''}|${state.verified?.hash || ''}|board-visuals-v1|${snapshot.raceCountry || ''}|${snapshot.drivers.map(d => d.carNumber || '').join(',')}|${teamEmojiStamp(cachedChannel?.guild)}`;
    if (process.env.F1_CHAMPIONSHIP_DRY_RUN !== 'false') {
      logger.info(`[F1 Championship] DRY RUN: ${snapshot.event}, ${snapshot.drivers.length} drivers, ${snapshot.teams.length} teams, ${phase}; no Discord posts.`);
      return 'dry-run';
    }
    if (old?.displaySignature === signature && old.messages?.drivers && old.messages?.teams) return 'unchanged';
    const channel = await bot.channels.fetch(channelId);
    if (!channel || typeof channel.send !== 'function' || !channel.messages?.fetch) throw new Error('Championship channel is not sendable');
    state.messages.drivers = await sendOrEdit(channel, state.messages.drivers, makeEmbed(snapshot, 'drivers', state, now, channel.guild));
    // Persist the ID immediately to prevent extra messages after a partial failure.
    await bot.db.set(boardKey(channelId, key), state);
    state.messages.teams = await sendOrEdit(channel, state.messages.teams, makeEmbed(snapshot, 'teams', state, now, channel.guild));
    state.displaySignature = signature;
    await bot.db.set(boardKey(channelId, key), state);
    await bot.db.set(channelKey(channelId), key);
    logger.info(`[F1 Championship] Published two standings boards: ${snapshot.event} (${phase}).`);
    return 'updated';
  } catch (error) {
    logger.warn(`[F1 Championship] Update failed safely: ${safeHostError(error)}`);
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
  state.messages.drivers = await sendOrEdit(channel, state.messages.drivers, makeEmbed(state.snapshot, 'drivers', state, Date.now(), channel.guild));
  await bot.db.set(stateKey, state);
  state.messages.teams = await sendOrEdit(channel, state.messages.teams, makeEmbed(state.snapshot, 'teams', state, Date.now(), channel.guild));
  const reviewPhase = state.snapshot.source === 'jolpica' ? `PUBLISHED ROUND ${state.snapshot.round}` : racePhase(state.session);
  state.displaySignature = `${hash}|${reviewPhase}|${state.fiaDocUrl || ''}|${hash}|board-visuals-v1|${state.snapshot.raceCountry || ''}|${state.snapshot.drivers.map(d => d.carNumber || '').join(',')}|${teamEmojiStamp(channel.guild)}`;
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
