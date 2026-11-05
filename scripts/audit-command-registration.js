/** Standalone, dependency-free command inventory for this repository. */
import fs from 'node:fs/promises';
import path from 'node:path';

async function filesUnder(dir, out = []) {
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (item.name !== 'modules') await filesUnder(p, out);
    } else if (item.name.endsWith('.js')) out.push(p);
  }
  return out.sort();
}

const files = await filesUnder('src/commands');
const entries = [];
for (const file of files) {
  let src = await fs.readFile(file, 'utf8');
  if (!src.includes('.setName(') && file.endsWith('/Verification/autoverify.js')) {
    src = await fs.readFile('src/commands/Verification/modules/autoVerify.js', 'utf8');
  }
  const name = src.match(/\.setName\(\s*['"]([^'"]+)/)?.[1]
    ?? src.match(/createCompactCommandGroup\(['"]([^'"]+)/)?.[1];
  if (!name) throw new Error(`No static command name found in ${file}`);
  entries.push({ name, file });
}
const uniqueNames = new Set(entries.map(e => e.name));
if (uniqueNames.size !== entries.length) throw new Error('Duplicate slash command names in the source tree');
const legacy = new Set(['gcreate', 'gend', 'gdelete', 'greroll']);
const compact = process.env.MTA_COMPACT_GIVEAWAYS === 'true';
const groups = [
  { flag: 'MTA_COMPACT_TOOLS', root: 'tools', names: new Set([
    'baseconvert', 'calculate', 'countdown', 'embedbuilder', 'generatepassword',
    'hexcolor', 'poll', 'randomuser', 'shorten', 'time', 'unixtime',
  ]) },
  { flag: 'MTA_COMPACT_FUN', root: 'fun', names: new Set(['fight', 'flip', 'roll']) },
  { flag: 'MTA_COMPACT_UTILITY', root: 'utility', names: new Set([
    'avatar', 'firstmsg', 'serverinfo', 'userinfo', 'weather',
  ]) },
];
const exposed = entries.filter(entry => {
  if (compact ? legacy.has(entry.name) : entry.name === 'giveaway') return false;
  for (const group of groups) {
    const enabled = process.env[group.flag] === 'true';
    if (enabled ? group.names.has(entry.name) : entry.name === group.root) return false;
  }
  return true;
});
console.log(`Source command modules: ${entries.length}`);
console.log(`Global slash commands with selected groups: ${exposed.length}/100`);
for (const group of groups) console.log(`  ${group.root}: ${process.env[group.flag] === 'true' ? 'ON' : 'OFF'}`);
console.log(`Free global command slots: ${100 - exposed.length}`);
console.log('Loaded legacy giveaway modules remain available to prefix handlers.');
if (exposed.length > 100) process.exitCode = 1;
