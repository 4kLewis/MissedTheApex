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
  const name = src.match(/\.setName\(\s*['"]([^'"]+)/)?.[1];
  if (!name) throw new Error(`No static command name found in ${file}`);
  entries.push({ name, file });
}
const uniqueNames = new Set(entries.map(e => e.name));
if (uniqueNames.size !== entries.length) throw new Error('Duplicate slash command names in the source tree');
const legacy = new Set(['gcreate', 'gend', 'gdelete', 'greroll']);
const compact = process.env.MTA_COMPACT_GIVEAWAYS === 'true';
const exposed = entries.filter(e => compact ? !legacy.has(e.name) : e.name !== 'giveaway');
console.log(`Source command modules: ${entries.length}`);
console.log(`Global slash commands with compact giveaways ${compact ? 'ON' : 'OFF'}: ${exposed.length}/100`);
console.log(`Free global command slots: ${100 - exposed.length}`);
console.log('Loaded legacy giveaway modules remain available to prefix handlers.');
if (exposed.length > 100) process.exitCode = 1;
