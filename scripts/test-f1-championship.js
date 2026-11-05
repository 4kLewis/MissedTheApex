/** Safe offline unit tests. No tokens, network requests, database writes or Discord posts. */
import assert from 'node:assert/strict';
import {
  buildSnapshot, standingsHash, sameStandings, isAllowedFiaPdf,
  selectRace, racePhase, boardText,
} from '../src/services/f1ChampionshipCore.js';

const now = Date.parse('2026-11-08T18:00:00Z');
const race = {
  session_key: 2026001,
  date_start: '2026-11-08T17:00:00Z',
  date_end: '2026-11-08T19:00:00Z',
  session_name: 'Race', meeting_name: 'São Paulo Grand Prix',
};
const sprint = { ...race, session_key: 2026002, session_name: 'Sprint' };
assert.equal(selectRace([sprint, race], now).session_key, 2026001);
assert.equal(racePhase(race, now), 'LIVE / PROVISIONAL');
assert.equal(racePhase(race, Date.parse('2026-11-08T20:00:00Z')), 'POST-RACE / PROVISIONAL');
assert.equal(selectRace([race], Date.parse('2026-11-15T20:00:00Z')), null);
const input = {
  driversRows: Array.from({length: 22}, (_, i) => ({ driver_number: i+1, points_current: 350-i, points_start: 340-i, position_current: i+1 })),
  teamsRows: Array.from({length: 11}, (_, i) => ({ team_name: `Team ${i+1}`, points_current: 600-i*10, points_start: 580-i*10, position_current: i+1 })),
  driverMetadata: Array.from({length: 22}, (_, i) => ({driver_number:i+1, full_name:`Driver ${i+1}`, team_name:`Team ${Math.floor(i/2)+1}`,team_colour:'ED1131'})),
  session: race, at: now,
};
const first = buildSnapshot(input);
assert.equal(first.drivers.length, 22);
assert.equal(first.teams.length, 11);
assert.match(boardText(first.drivers), /Driver 1/);
assert.ok(sameStandings(first, structuredClone(first)));
const changed = structuredClone(first);
changed.drivers[0].points += 1;
assert.notEqual(standingsHash(first), standingsHash(changed));
assert.equal(isAllowedFiaPdf('https://www.fia.com/system/files/documents/2026_brazil_-_championship_points.pdf'), true);
assert.equal(isAllowedFiaPdf('https://example.com/2026_-_championship_points.pdf'), false);
assert.equal(isAllowedFiaPdf('https://fia.com.evil.test/2026_-_championship_points.pdf'), false);
assert.equal(isAllowedFiaPdf('http://fia.com/2026_-_championship_points.pdf'), false);
assert.throws(() => buildSnapshot({...input, driversRows: input.driversRows.slice(0,4)}), /Incomplete/);
assert.throws(() => buildSnapshot({...input, driversRows: input.driversRows.map((v,i)=>i===0?{...v,points_current:undefined}:v).slice(0,15)}), /Incomplete/);
console.log('PASS: race-only selection, phase labels, data validation, driver/team standings, changed-points detection, FIA link restrictions.');
console.log('No network, Discord, PostgreSQL or Railway requests were made.');
