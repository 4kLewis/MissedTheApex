/** Offline end-to-end smoke test with mock providers, DB and Discord. */
import assert from 'node:assert/strict';
import { buildPublishedStandings } from '../src/services/f1ChampionshipCore.js';
import { checkF1Championship, markFiaReviewed } from '../src/services/f1ChampionshipService.js';

const YEAR = 2026;
const round = '19';
const driverPayload = {MRData:{StandingsTable:{StandingsLists:[{season:'2026',round,DriverStandings:Array.from({length:22},(_,i)=>({position:String(i+1),points:String(360-i*10),Driver:{driverId:`driver${i}`,givenName:`Person${i}`,familyName:'Driver'},Constructors:[{name:`Team ${Math.floor(i/2)}`}]}))}]}}};
const teamPayload = {MRData:{StandingsTable:{StandingsLists:[{season:'2026',round,ConstructorStandings:Array.from({length:11},(_,i)=>({position:String(i+1),points:String(550-i*20),Constructor:{constructorId:`team${i}`,name:`Team ${i}`}}))}]}}};
const published = buildPublishedStandings({driverPayload, teamPayload, year:YEAR, eventName:'Mexico City Grand Prix'});
assert.equal(published.drivers.length,22);
assert.equal(published.teams.length,11);
assert.equal(published.round,19);
assert.equal(published.drivers[0].points,360);
assert.throws(()=> buildPublishedStandings({driverPayload,teamPayload:{MRData:{StandingsTable:{StandingsLists:[{...teamPayload.MRData.StandingsTable.StandingsLists[0],round:'18'}]}}},year:YEAR}), /mismatch/);

process.env.F1_CHAMPIONSHIP_ENABLED='true';
process.env.F1_CHAMPIONSHIP_DRY_RUN='false';
process.env.F1_CHAMPIONSHIP_CHANNEL_ID='123456789012345678';
process.env.F1_CHAMPIONSHIP_SEASON='2026';
process.env.F1_CHAMPIONSHIP_FIA_LOOKUP='false';

const dbData = new Map();
const messages = new Map();
const totals = {send:0, edit:0};
const channel = {
  send: async msg => {
    const id=String(++totals.send);
    const m={ id, embeds:msg.embeds, edit:async content=>{totals.edit++;m.embeds=content.embeds;return m;} };
    messages.set(id,m);
    return m;
  },
  messages:{ fetch: async id => { const m=messages.get(id);if(!m) throw Object.assign(new Error('Unknown message'),{code:10008});return m;} },
};
const bot = {isReady:()=>true, db: {getStatus:()=>({isDegraded:false}),get:async(k,def)=>dbData.has(k)?structuredClone(dbData.get(k)):def,set:async(k,v)=>{dbData.set(k,structuredClone(v));}},channels:{fetch:async()=>channel}};
const fakeJolpica = async path => path.endsWith('driverstandings.json') ? driverPayload :
  path.endsWith('constructorstandings.json') ? teamPayload :
  {MRData:{RaceTable:{Races:[{round:'19',raceName:'Mexico City Grand Prix'}]}}};
const date = Date.parse('2026-11-05T20:00:00Z');
const noRace = async () => [];
assert.equal(await checkF1Championship(bot,{get:noRace,jget:fakeJolpica,now:date,force:true,allowFia:false}),'updated');
assert.equal(totals.send,2);
assert.match(messages.get('1').embeds[0].data.description,/CURRENT PUBLISHED STANDINGS/);
assert.match(messages.get('1').embeds[0].data.description,/360/);
assert.equal(await checkF1Championship(bot,{get:noRace,jget:fakeJolpica,now:date+60_000,force:true,allowFia:false}),'unchanged');
assert.equal(totals.send,2);
assert.equal(totals.edit,0);
const reviewed = await markFiaReviewed(bot, 'https://www.fia.com/system/files/documents/2026_mexico_-_championship_points.pdf', 'test-admin');
assert.ok(reviewed.verified?.hash, 'Published-round standings can be manually cross-checked after the race');
assert.equal(totals.send, 2);

// Race begins several days later. Boards should be EDITED, not duplicated.
const race={session_key:12345,session_name:'Race',date_start:'2026-11-08T17:00:00Z',date_end:'2026-11-08T19:00:00Z',meeting_name:'São Paulo Grand Prix'};
const fakeOpenF1 = async path => {
  if(path.startsWith('sessions?')) return [race];
  if(path.startsWith('championship_drivers?')) return Array.from({length:22},(_,i)=>({driver_number:i+1,points_current:370-i*10,points_start:360-i*10,position_current:i+1}));
  if(path.startsWith('championship_teams?')) return Array.from({length:11},(_,i)=>({team_name:`Team ${i}`,points_current:560-i*20,points_start:550-i*20,position_current:i+1}));
  if(path.startsWith('drivers?')) return Array.from({length:22},(_,i)=>({driver_number:i+1,full_name:`Driver ${i}`,team_name:`Team ${Math.floor(i/2)}`,team_colour:'FFFFFF'}));
  throw new Error(`Unexpected OpenF1 path: ${path}`);
};
assert.equal(await checkF1Championship(bot,{get:fakeOpenF1,jget:fakeJolpica,now:Date.parse('2026-11-08T18:00:00Z'),force:true,allowFia:false}),'updated');
assert.equal(totals.send,2,'No new message should be sent on race weekend');
assert.equal(totals.edit,4);
assert.doesNotMatch(messages.get('1').embeds[0].data.description,/CROSS-CHECKED/);
assert.match(messages.get('1').embeds[0].data.description,/LIVE \/ PROVISIONAL/);

console.log('PASS: published-round snapshot, source mismatch rejection, immediate 2-board creation, no duplicate posts, manual FIA review, and live transition via editing the same messages.');
console.log('No real API, Discord, Railway or database requests were made.');
