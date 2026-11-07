import assert from 'node:assert/strict';
import { teamEmoji, teamEmojiStamp, teamKey } from '../src/services/f1ChampionshipAppearance.js';

const guild = { emojis: { cache: new Map([
  ['1', { name: 'ferrari', id: '123456789012345678', animated: false }],
  ['2', { name: 'team_mclaren', id: '223456789012345678', animated: false }],
  ['3', { name: 'redbull', id: '323456789012345678', animated: false }],
]) } };
assert.equal(teamKey('Scuderia Ferrari'), 'ferrari');
assert.equal(teamKey('McLaren'), 'mclaren');
assert.equal(teamKey('Oracle Red Bull Racing'), 'redbull');
assert.equal(teamEmoji('Ferrari', guild), '<:ferrari:123456789012345678>');
assert.equal(teamEmoji('McLaren', guild), '<:team_mclaren:223456789012345678>');
assert.equal(teamEmoji('Oracle Red Bull Racing', guild), '<:redbull:323456789012345678>');
assert.notEqual(teamEmoji('Ferrari', null), '<:ferrari:123456789012345678>');
assert.match(teamEmojiStamp(guild), /ferrari/);
console.log('PASS: recognised team names and correctly formatted Discord custom emoji codes.');
console.log('This is an offline test. Live emoji uploads are checked through Railway logs after deployment.');
