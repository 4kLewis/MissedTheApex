/** Safe additive installer: modifies ONLY src/app.js and refuses ambiguous files. */
import { readFile, writeFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const filename = 'src/app.js';
const importLine = "import { startF1ChampionshipTracker } from './services/f1ChampionshipService.js';";
const anchorImport = "import cron from 'node-cron';";
const anchorCall = 'this.setupCronJobs();';

function assertOnce(text, part) {
  const count = text.split(part).length - 1;
  if (count !== 1) throw new Error(`Expected exactly one ${JSON.stringify(part)}, found ${count}. No changes made.`);
}
try {
  for (const f of ['src/services/f1ChampionshipCore.js', 'src/services/f1ChampionshipService.js', 'src/commands/F1/championship.js']) await access(f);
  const original = await readFile(filename, 'utf8');
  if (original.includes('startF1ChampionshipTracker(') || original.includes(importLine)) {
    throw new Error('Championship integration already exists. No changes made.');
  }
  assertOnce(original, anchorImport);
  assertOnce(original, anchorCall);
  // Never overwrite an app.js that already has uncommitted changes.
  const check = spawnSync('git', ['diff', '--quiet', '--', filename], { stdio: 'ignore' });
  if (check.status !== 0) throw new Error('src/app.js has uncommitted edits. Commit or stash them first; no changes made.');
  const result = original.replace(anchorImport, `${anchorImport}\n${importLine}`)
    .replace(anchorCall, `${anchorCall}\n      startF1ChampionshipTracker(this);`);
  if (!result.includes(importLine) || !result.includes('startF1ChampionshipTracker(this);')) throw new Error('Installer preflight failed');
  await writeFile(filename, result, 'utf8');
  console.log('PASS: Added 1 import and 1 startup call to src/app.js. No existing folders or files were replaced.');
  console.log('Review with: git diff -- src/app.js');
} catch (error) {
  console.error('STOP:', error.message);
  process.exitCode = 1;
}
