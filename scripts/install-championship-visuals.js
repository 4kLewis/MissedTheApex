/**
 * Conservative installer: changes only two championship files, never directories.
 * Usage: node scripts/install-championship-visuals.js --check | --apply
 * Refuses to proceed if the expected v2 code has changed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.env.MTA_PROJECT_ROOT || process.cwd();
const check = process.argv.includes('--check');
const apply = process.argv.includes('--apply');
if (check === apply) {
  console.error('Specify exactly one: --check or --apply');
  process.exit(2);
}

const files = {
  core: 'src/services/f1ChampionshipCore.js',
  service: 'src/services/f1ChampionshipService.js',
};
const abs = p => path.join(root, p);
const src = Object.fromEntries(Object.entries(files).map(([k, p]) => [k, fs.readFileSync(abs(p), 'utf8')]));

function once(text, needle, replacement, title) {
  const count = text.split(needle).length - 1;
  if (count !== 1) throw new Error(`Expected one ${title} insertion point; found ${count}. Source was not changed.`);
  return text.replace(needle, replacement);
}
function replaceAllExpected(text, needle, replacement, countExpected, title) {
  const count = text.split(needle).length - 1;
  if (count !== countExpected) throw new Error(`Expected ${countExpected} ${title} occurrences, found ${count}. Source was not changed.`);
  return text.split(needle).join(replacement);
}

const embed = `function makeEmbed(snapshot, type, state, now, guild = null) {
  const published = snapshot.source === 'jolpica';
  const phase = published ? \`CURRENT PUBLISHED STANDINGS · ROUND \${snapshot.round}\` : racePhase(state.session, now);
  const confirmed = state.verified?.hash === standingsHash(snapshot);
  const status = confirmed ? 'FIA CROSS-CHECKED BY SERVER ADMIN' :
    state.fiaDocUrl ? \`\${phase} · FIA PDF AVAILABLE FOR REVIEW\` : phase;
  const standings = type === 'drivers' ? snapshot.drivers : snapshot.teams;
  const text = championshipBoardRows(standings, type, { guild, live: !published });
  const embed = new EmbedBuilder()
    .setColor(confirmed ? 0x228E68 : !published && phase.startsWith('LIVE') ? 0xF1A722 : 0x387FDB)
    .setTitle(\`\${type === 'drivers' ? '🏆 Drivers' : '🏁 Constructors'} Championship · \${configuredYear()}\`)
    .setDescription(\`**\${snapshot.event}**\\n**\${status}**\\n\\n\${text}\`)
    .setFooter({ text: \`MissedTheApex · \${published ? 'Jolpica season standings' : 'OpenF1 beta live projections'} · \${confirmed ? 'Manually compared to FIA by admin' : 'Unofficial / not FIA-certified'}\` })
    .setTimestamp(new Date(snapshot.at));
  // Top-right PNG; hide it entirely if the host country is unknown.
  const flag = raceFlagUrl(snapshot.raceCountry);
  if (flag) embed.setThumbnail(flag);
  if (state.fiaDocUrl) embed.addFields({ name: 'FIA Championship Points', value: \`[Read official PDF](\${state.fiaDocUrl})\` });
  return embed;
}
`;

function upgradeCore(text) {
  if (text.includes('raceCountry') || text.includes('carNumber')) throw new Error('Core already contains championship visuals or is a different version. No changes made.');
  text = once(text,
    `    sessionEnd: session.date_end || null, at, drivers, teams };`,
    `    sessionEnd: session.date_end || null, raceCountry: cleanName(session.country_name, ''), at, drivers, teams };`,
    'live race country');
  text = once(text,
    `export function buildPublishedStandings({ driverPayload, teamPayload, eventName = '', year, at = Date.now() }) {`,
    `export function buildPublishedStandings({ driverPayload, teamPayload, eventName = '', raceCountry = '', year, at = Date.now() }) {`,
    'published input');
  text = once(text,
    `      colour: null, position, points, start: points };`,
    `      carNumber: /^\\d{1,3}$/.test(String(r.Driver?.permanentNumber || '')) && Number(r.Driver.permanentNumber) > 0 ? Number(r.Driver.permanentNumber) : null,\n      colour: null, position, points, start: points };`,
    'published car number');
  text = once(text,
    `    event: cleanName(eventName, \`After Round \${round}\`),`,
    `    event: cleanName(eventName, \`After Round \${round}\`), raceCountry: cleanName(raceCountry, ''),`,
    'published race country');
  return text;
}

function upgradeService(text) {
  if (text.includes('f1ChampionshipAppearance.js') || text.includes('board-visuals-v1')) {
    throw new Error('Championship visuals already appear installed. No changes made.');
  }
  if (!text.includes('fetchPublished(')) throw new Error('Always-on championship v2 not found. Install v2 first.');
  text = once(text,
    `import { buildSnapshot, standingsHash, selectRace, racePhase, boardText, isAllowedFiaPdf, buildPublishedStandings } from './f1ChampionshipCore.js';`,
    `import { buildSnapshot, standingsHash, selectRace, racePhase, boardText, isAllowedFiaPdf, buildPublishedStandings } from './f1ChampionshipCore.js';\nimport { championshipBoardRows, raceFlagUrl, teamEmojiStamp } from './f1ChampionshipAppearance.js';`,
    'appearance import');
  text = once(text, `  let eventName = '';`, `  let eventName = '';\n  let raceCountry = '';`, 'race metadata');
  text = once(text,
    `    if (race && Number(race.round) === round) eventName = \`\${race.raceName} · Round \${round}\`;`,
    `    if (race && Number(race.round) === round) {\n      eventName = \`\${race.raceName} · Round \${round}\`;\n      raceCountry = String(race.Circuit?.Location?.country || '').trim();\n    }`,
    'last completed race country');
  text = once(text, `    eventName, year, at: now });`, `    eventName, raceCountry, year, at: now });`, 'metadata handoff');
  const start = text.indexOf('function makeEmbed(');
  const end = text.indexOf('\nasync function sendOrEdit(', start);
  if (start < 0 || end < 0 || text.slice(start, end).length < 200) throw new Error('Cannot locate exact embed function boundaries. No changes made.');
  text = text.slice(0, start) + embed + text.slice(end);
  text = once(text,
    "    const signature = `${hash}|${phase}|${state.fiaDocUrl || ''}|${state.verified?.hash || ''}`;",
    "    const cachedChannel = bot.channels.cache?.get(channelId);\n    const signature = `${hash}|${phase}|${state.fiaDocUrl || ''}|${state.verified?.hash || ''}|board-visuals-v1|${snapshot.raceCountry || ''}|${snapshot.drivers.map(d => d.carNumber || '').join(',')}|${teamEmojiStamp(cachedChannel?.guild)}`;",
    'board refresh signature');
  text = replaceAllExpected(text, "makeEmbed(snapshot, 'drivers', state, now)", "makeEmbed(snapshot, 'drivers', state, now, channel.guild)", 1, 'driver update');
  text = replaceAllExpected(text, "makeEmbed(snapshot, 'teams', state, now)", "makeEmbed(snapshot, 'teams', state, now, channel.guild)", 1, 'team update');
  text = replaceAllExpected(text, "makeEmbed(state.snapshot, 'drivers', state, Date.now())", "makeEmbed(state.snapshot, 'drivers', state, Date.now(), channel.guild)", 1, 'FIA driver review');
  text = replaceAllExpected(text, "makeEmbed(state.snapshot, 'teams', state, Date.now())", "makeEmbed(state.snapshot, 'teams', state, Date.now(), channel.guild)", 1, 'FIA constructor review');
  text = once(text,
    '  state.displaySignature = `${hash}|${racePhase(state.session)}|${state.fiaDocUrl}|${hash}`;',
    "  const reviewPhase = state.snapshot.source === 'jolpica' ? `PUBLISHED ROUND ${state.snapshot.round}` : racePhase(state.session);\n  state.displaySignature = `${hash}|${reviewPhase}|${state.fiaDocUrl || ''}|${hash}|board-visuals-v1|${state.snapshot.raceCountry || ''}|${state.snapshot.drivers.map(d => d.carNumber || '').join(',')}|${teamEmojiStamp(channel.guild)}`;",
    'reviewed board signature');
  return text;
}

try {
  const changed = { core: upgradeCore(src.core), service: upgradeService(src.service) };
  if (!fs.existsSync(abs('src/services/f1ChampionshipAppearance.js')))
    throw new Error('Missing src/services/f1ChampionshipAppearance.js. Copy helper file from ZIP first.');
  console.log('PASS: v2 source matches the expected structure. No existing files overwritten yet.');
  if (check) process.exit(0);
  // Backups go into .git and cannot be included in a normal git add.
  const backups = abs('.git/mta-championship-visuals-backup');
  fs.mkdirSync(backups, { recursive: true });
  for (const [key, name] of Object.entries(files)) fs.copyFileSync(abs(name), path.join(backups, path.basename(name)));
  try {
    for (const [key, name] of Object.entries(files)) fs.writeFileSync(abs(name), changed[key]);
    for (const name of Object.values(files)) execFileSync('node', ['--check', abs(name)], { stdio: 'pipe' });
    execFileSync('node', ['--check', abs('src/services/f1ChampionshipAppearance.js')], { stdio: 'pipe' });
    console.log('SUCCESS: Drivers numbers, team emojis and recent-race PNG flag enabled.');
    console.log('Original files backed up at .git/mta-championship-visuals-backup/');
  } catch (error) {
    for (const name of Object.values(files)) fs.copyFileSync(path.join(backups, path.basename(name)), abs(name));
    throw error;
  }
} catch (error) {
  console.error('STOP:', error.message);
  process.exitCode = 1;
}
