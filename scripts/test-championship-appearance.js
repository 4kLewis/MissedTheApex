/** Offline check: no network, database, Discord messages or Railway calls. */
import assert from 'node:assert/strict';
import { teamEmoji, teamKey, teamEmojiStamp, raceFlagUrl, championshipBoardRows } from '../src/services/f1ChampionshipAppearance.js';
import { buildPublishedStandings, buildSnapshot } from '../src/services/f1ChampionshipCore.js';

const guild = { emojis: { cache: new Map([
  ['x', { name: 'ferrari', id: '123456789012345678', animated: false }],
  ['y', { name: 'team_mclaren', id: '223456789012345678', animated: false }],
]) } };
assert.equal(teamKey('Oracle Red Bull Racing'), 'redbull');
assert.equal(teamKey('Visa Cash App Racing Bulls'), 'racingbulls');
assert.equal(teamKey('Audi Revolut F1 Team'), 'audi');
assert.equal(teamEmoji('Ferrari', guild), '<:ferrari:123456789012345678>');
assert.equal(teamEmoji('McLaren', guild), '<:team_mclaren:223456789012345678>');
assert.equal(teamEmoji('Ferrari', null), '🔴');
assert.ok(teamEmojiStamp(guild).includes('ferrari'));
assert.equal(raceFlagUrl('Singapore'), 'https://flagcdn.com/w80/sg.png');
assert.equal(raceFlagUrl('Brazil'), 'https://flagcdn.com/w80/br.png');
assert.equal(raceFlagUrl('United Arab Emirates'), 'https://flagcdn.com/w80/ae.png');
assert.equal(raceFlagUrl('Uncertain Venue'), null);

const driverPayload = { MRData: { StandingsTable: { StandingsLists: [{ season: '2026', round: '19',
  DriverStandings: Array.from({ length: 22 }, (_, i) => ({
    position: String(i + 1), points: String(350 - i * 9),
    Driver: { driverId: `d${i}`, permanentNumber: String(i + 1), givenName: i === 0 ? 'Example' : 'Other', familyName: 'Driver' },
    Constructors: [{ name: i === 0 ? 'Ferrari' : 'McLaren' }],
  })),
}] } } };
const teamPayload = { MRData: { StandingsTable: { StandingsLists: [{ season: '2026', round: '19',
  ConstructorStandings: Array.from({ length: 11 }, (_, i) => ({
    position: String(i + 1), points: String(700 - i * 20), Constructor: { constructorId: `t${i}`, name: i === 0 ? 'Ferrari' : 'McLaren' },
  })),
}] } } };
const published = buildPublishedStandings({ driverPayload, teamPayload, year: 2026, raceCountry: 'Mexico' });
assert.equal(published.raceCountry, 'Mexico');
assert.equal(published.drivers[0].carNumber, 1);
assert.match(championshipBoardRows(published.drivers, 'drivers', { guild }), /<:ferrari:123456789012345678> `#1` \*\*Example Driver\*\*/);
assert.match(championshipBoardRows(published.teams, 'teams', { guild }), /<:ferrari:123456789012345678> \*\*Ferrari\*\*/);

const session = { session_key: 12345, session_name: 'Race', country_name: 'Brazil', meeting_name: 'São Paulo Grand Prix' };
const live = buildSnapshot({
  session, at: Date.now(),
  driversRows: Array.from({ length: 22 }, (_, i) => ({ driver_number: i + 1, points_current: 100 + i, points_start: 99 + i, position_current: i + 1 })),
  teamsRows: Array.from({ length: 11 }, (_, i) => ({ team_name: i === 0 ? 'Ferrari' : `Team ${i}`, points_current: 100 + i, points_start: 99 + i, position_current: i + 1 })),
  driverMetadata: Array.from({ length: 22 }, (_, i) => ({ driver_number: i + 1, full_name: `Driver ${i + 1}`, team_name: i === 0 ? 'Ferrari' : 'McLaren' })),
});
assert.equal(live.raceCountry, 'Brazil');
assert.match(championshipBoardRows(live.drivers, 'drivers', { guild, live: true }), /<:ferrari:123456789012345678> `#1` \*\*Driver 1\*\* — \*\*100\*\* pts \(\+1 race\)/);
console.log('PASS: team emojis, coloured fallback, car numbers, country PNG flags, published/live standings.');
console.log('No API, Railway, database or Discord calls were made.');
