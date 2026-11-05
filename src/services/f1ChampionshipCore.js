/** Pure, offline-testable championship data helpers. No Discord or network code. */
import { createHash } from 'node:crypto';

export const STATE_VERSION = 1;
export const MIN_DRIVERS = 15;
export const MIN_TEAMS = 8;

export function safePoints(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 && num <= 5000 ? num : null;
}
export function safePosition(value) {
  const num = Number(value);
  return Number.isInteger(num) && num >= 1 && num <= 50 ? num : null;
}
function cleanName(name, fallback) {
  return String(name || fallback).replace(/[\r\n`]/g, ' ').trim().slice(0, 45);
}
function hexColour(value) {
  const hex = String(value || '').replace('#', '').toUpperCase();
  return /^[0-9A-F]{6}$/.test(hex) ? `#${hex}` : null;
}
export function buildSnapshot({ driversRows, teamsRows, driverMetadata = [], session, at = Date.now() }) {
  if (!session || !Number.isInteger(Number(session.session_key))) throw new Error('Missing race session');
  if (!Array.isArray(driversRows) || !Array.isArray(teamsRows)) throw new Error('OpenF1 championship payload is not an array');
  const meta = new Map(driverMetadata.map(d => [Number(d.driver_number), d]));
  const driverMap = new Map();
  for (const row of driversRows) {
    const id = Number(row?.driver_number);
    const points = safePoints(row?.points_current);
    const start = safePoints(row?.points_start);
    const pos = safePosition(row?.position_current);
    if (!Number.isInteger(id) || id < 1 || id > 999 || points === null || start === null || pos === null) continue;
    const d = meta.get(id) || {};
    driverMap.set(id, {
      id, name: cleanName(d.full_name || d.broadcast_name || d.name_acronym, `Car ${id}`),
      team: cleanName(d.team_name, 'Team unknown'), colour: hexColour(d.team_colour),
      position: pos, points, start,
    });
  }
  const teamMap = new Map();
  for (const row of teamsRows) {
    const name = cleanName(row?.team_name, '');
    const points = safePoints(row?.points_current);
    const start = safePoints(row?.points_start);
    const pos = safePosition(row?.position_current);
    if (!name || points === null || start === null || pos === null) continue;
    teamMap.set(name.toLowerCase(), { id: name, name, position: pos, points, start });
  }
  const drivers = [...driverMap.values()].sort((a, b) => a.position - b.position || b.points - a.points);
  const teams = [...teamMap.values()].sort((a, b) => a.position - b.position || b.points - a.points);
  if (drivers.length < MIN_DRIVERS || teams.length < MIN_TEAMS) {
    throw new Error(`Incomplete OpenF1 beta standings (${drivers.length} drivers, ${teams.length} teams); keeping previous board`);
  }
  return { version: STATE_VERSION, sessionKey: Number(session.session_key),
    event: cleanName(session.meeting_name || session.country_name || session.location, 'Grand Prix'),
    sessionEnd: session.date_end || null, at, drivers, teams };
}
export function standingsHash(snapshot) {
  const data = [snapshot.sessionKey,
    snapshot.drivers.map(d => [d.id, d.position, d.points]),
    snapshot.teams.map(t => [t.name, t.position, t.points])];
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}
export function sameStandings(a, b) {
  return a?.sessionKey === b?.sessionKey && standingsHash(a) === standingsHash(b);
}
export function isAllowedFiaPdf(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return u.protocol === 'https:' && (host === 'fia.com' || host.endsWith('.fia.com')) &&
      /\.pdf$/i.test(u.pathname) && /championship.*points|points.*championship/i.test(decodeURIComponent(u.pathname));
  } catch { return false; }
}
export function selectRace(sessions, now = Date.now()) {
  if (!Array.isArray(sessions)) return null;
  return sessions.filter(s => {
    if (String(s?.session_name || '').toLowerCase() !== 'race') return false; // Never use Sprint/Practice.
    const start = Date.parse(s.date_start);
    const end = Date.parse(s.date_end) || (start + 3 * 60 * 60 * 1000);
    return Number.isFinite(start) && now >= start - 30 * 60000 && now <= end + 72 * 3600000;
  }).sort((a,b) => Date.parse(b.date_start) - Date.parse(a.date_start))[0] || null;
}
export function racePhase(session, now = Date.now()) {
  const end = Date.parse(session.date_end) || Date.parse(session.date_start) + 3 * 3600000;
  return now <= end + 30 * 60000 ? 'LIVE / PROVISIONAL' : 'POST-RACE / PROVISIONAL';
}
export function boardText(rows) {
  return rows.map(row => {
    const change = row.points - row.start;
    const changeText = `${change >= 0 ? '+' : ''}${change}`;
    return `\`${String(row.position).padStart(2)}\` **${row.name.replace(/[*_~>|]/g, '')}** — **${row.points}** pts (${changeText} race)`;
  }).join('\n').slice(0, 3900);
}


/** Normalize Jolpica's latest COMPLETED round into the same rows as OpenF1.
 * This is a published standings snapshot, not a live projection or FIA certification.
 */
export function buildPublishedStandings({ driverPayload, teamPayload, eventName = '', year, at = Date.now() }) {
  const dtable = driverPayload?.MRData?.StandingsTable;
  const ttable = teamPayload?.MRData?.StandingsTable;
  const dl = dtable?.StandingsLists?.[0];
  const tl = ttable?.StandingsLists?.[0];
  const round = Number(dl?.round);
  if (!Number.isInteger(round) || round < 1 || round > 30 ||
      Number(tl?.round) !== round || Number(dl?.season) !== year || Number(tl?.season) !== year) {
    throw new Error('Jolpica season/round mismatch; retaining previous published standings');
  }
  if (!Array.isArray(dl.DriverStandings) || !Array.isArray(tl.ConstructorStandings)) {
    throw new Error('Jolpica response has no completed championship standings');
  }
  const drivers = dl.DriverStandings.map((r, index) => {
    const position = safePosition(r.position);
    const points = safePoints(r.points);
    const id = String(r.Driver?.driverId || r.Driver?.permanentNumber || '').slice(0, 70);
    if (!id || position === null || points === null) return null;
    const name = cleanName([r.Driver?.givenName, r.Driver?.familyName].filter(Boolean).join(' '), `Driver ${index + 1}`);
    return { id, name, team: cleanName(r.Constructors?.at(-1)?.name, 'Team unknown'),
      colour: null, position, points, start: points };
  }).filter(Boolean).sort((a,b) => a.position-b.position);
  const teams = tl.ConstructorStandings.map(r => {
    const position = safePosition(r.position);
    const points = safePoints(r.points);
    const id = String(r.Constructor?.constructorId || '').slice(0, 70);
    if (!id || position === null || points === null) return null;
    return { id, name: cleanName(r.Constructor?.name, id), position, points, start: points };
  }).filter(Boolean).sort((a,b) => a.position-b.position);
  if (drivers.length < MIN_DRIVERS || teams.length < MIN_TEAMS ||
      new Set(drivers.map(d=>d.id)).size !== drivers.length ||
      new Set(teams.map(t=>t.id)).size !== teams.length) {
    throw new Error(`Incomplete/duplicate Jolpica standings (${drivers.length} drivers, ${teams.length} teams)`);
  }
  return {
    version: STATE_VERSION, source: 'jolpica', round, year,
    // Distinct from OpenF1 session IDs, stable for the round.
    sessionKey: -(year * 100 + round),
    event: cleanName(eventName, `After Round ${round}`),
    sessionEnd: null, at, drivers, teams,
  };
}
