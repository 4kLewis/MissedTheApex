/**
 * MissedTheApex championship emoji cache fix.
 * Uses a guarded single-file edit. No API requests or Discord posts during installation.
 * Usage: node scripts/fix-championship-emoji-cache.js --check | --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const check = process.argv.includes('--check');
const apply = process.argv.includes('--apply');
if (check === apply) {
  console.error('Use exactly one of --check or --apply.');
  process.exit(2);
}
const target = path.resolve('src/services/f1ChampionshipService.js');
const backup = path.resolve('.git/mta-championship-emoji-cache-backup.js');
const marker = '// Championship emoji refresh: fetch server emojis before comparing board signatures.';
const oldLine = '    const cachedChannel = bot.channels.cache?.get(channelId);';
const signature = "    const signature = `${hash}|${phase}|${state.fiaDocUrl || ''}|${state.verified?.hash || ''}|board-visuals-v1|${snapshot.raceCountry || ''}|${snapshot.drivers.map(d => d.carNumber || '').join(',')}|${teamEmojiStamp(cachedChannel?.guild)}`;";

const insert = `    ${marker}
    let cachedChannel = bot.channels.cache?.get(channelId) || null;
    if (!cachedChannel?.guild && lastChampionshipEmojiGuild) {
      cachedChannel = { guild: lastChampionshipEmojiGuild };
    }
    // Explicitly fetch server emojis rather than depending on the gateway cache.
    // Refresh at most once per ten minutes while publishing is enabled.
    if (process.env.F1_CHAMPIONSHIP_DRY_RUN === 'false' && Date.now() - lastChampionshipEmojiFetch >= 10 * 60_000) {
      lastChampionshipEmojiFetch = Date.now();
      try {
        const liveChannel = await bot.channels.fetch(channelId);
        if (liveChannel?.guild) {
          lastChampionshipEmojiGuild = liveChannel.guild;
          cachedChannel = liveChannel;
        }
        const guild = cachedChannel?.guild;
        if (guild?.emojis?.fetch) {
          await guild.emojis.fetch();
          const available = [...guild.emojis.cache.values()]
            .filter(emoji => emoji?.name)
            .map(emoji => emoji.name)
            .sort();
          logger.info('[F1 Championship] Team emoji refresh: ' + available.length + ' server emojis; names: ' + (available.join(', ') || '(none)'));
        } else {
          logger.warn('[F1 Championship] Cannot fetch server emojis for the championship channel.');
        }
      } catch (error) {
        logger.warn('[F1 Championship] Emoji fetch failed: ' + safeHostError(error));
      }
    }`;

try {
  if (!fs.existsSync(target)) throw new Error('Championship service file not found.');
  let source = fs.readFileSync(target, 'utf8');
  if (source.includes(marker)) {
    console.log('ALREADY INSTALLED: no changes made.');
    process.exit(0);
  }
  if (!source.includes("from './f1ChampionshipAppearance.js'")) {
    throw new Error('Championship Visuals integration is missing or different. No changes made.');
  }
  for (const [name, needle] of [
    ['emoji cache line', oldLine],
    ['signature', signature],
    ['global variable', 'let lastPublishedPoll = 0;'],
  ]) {
    if (source.split(needle).length !== 2) {
      throw new Error('Expected exactly one ' + name + ' anchor. No changes made.');
    }
  }
  if (check) {
    console.log('PASS: expected championship service version found; fix can be applied.');
    process.exit(0);
  }
  if (!fs.existsSync('.git')) throw new Error('Not in Git repository root.');
  fs.copyFileSync(target, backup);
  source = source.replace('let lastPublishedPoll = 0;', 'let lastPublishedPoll = 0;\nlet lastChampionshipEmojiFetch = 0;\nlet lastChampionshipEmojiGuild = null;');
  source = source.replace(oldLine, insert);
  fs.writeFileSync(target, source);
  try {
    execFileSync('node', ['--check', target], { stdio: 'pipe' });
  } catch (err) {
    fs.copyFileSync(backup, target);
    throw new Error('Syntax check failed and original file was restored: ' + String(err.stderr || err));
  }
  console.log('SUCCESS: team emoji refresh added. Backup saved inside .git.');
} catch (error) {
  console.error('STOP:', error.message);
  process.exitCode = 1;
}
