/**
 * One-time, idempotent app.js patcher for MissedTheApex.
 * Run from repo root: node scripts/install-f1-news.js
 * It edits ONLY src/app.js, creates a local .bak copy, and refuses to patch if
 * the expected method is not present.
 */
import fs from 'node:fs';

const filename = 'src/app.js';
const importLine = "import { checkF1News } from './services/f1NewsService.js';";
const snippet = `
    // Trusted F1 News - check every five minutes
    if (process.env.F1_NEWS_ENABLED === 'true') {
      cron.schedule(
        '*/5 * * * *',
        runSafeTask('f1_news_check', () => checkF1News(this))
      );
      void checkF1News(this).catch(err =>
        logger.error('[F1 News] Initial check failed:', err)
      );
    }
`;

if (!fs.existsSync(filename)) throw new Error('src/app.js not found; run from repository root');
let code = fs.readFileSync(filename, 'utf8');
const original = code;

// Add import once, alongside imports already used by this bot.
if (!code.includes(importLine)) {
  const anchor = "import { checkFiaDocuments } from './services/fiaDocumentsService.js';";
  const fallback = "import cron from 'node-cron';";
  if (code.includes(anchor)) {
    code = code.replace(anchor, `${anchor}\n${importLine}`);
  } else if (code.includes(fallback)) {
    code = code.replace(fallback, `${fallback}\n${importLine}`);
  } else {
    throw new Error('Could not locate existing imports; no changes written');
  }
}

// Find the full setupCronJobs method by its known successor, rather than
// guessing closing brace line numbers.
if (!code.includes("runSafeTask('f1_news_check'")) {
  const start = code.indexOf('setupCronJobs() {');
  if (start < 0) throw new Error('setupCronJobs() method not found; no changes written');
  const next = code.indexOf('async updateAllCounters()', start);
  if (next < 0) throw new Error('Could not locate method boundary; no changes written');
  const before = code.slice(0, start);
  const method = code.slice(start, next);
  const after = code.slice(next);
  const closing = method.lastIndexOf('}');
  if (closing < 0 || method.slice(closing + 1).trim()) {
    throw new Error('Unexpected method layout; no changes written');
  }
  code = before + method.slice(0, closing) + snippet + method.slice(closing) + after;
}

if (code === original) {
  console.log('Already installed. No changes to src/app.js.');
} else {
  const backup = `${filename}.before-f1-news.bak`;
  if (!fs.existsSync(backup)) fs.copyFileSync(filename, backup);
  fs.writeFileSync(filename, code);
  console.log(`F1 News import and cron task added to ${filename}`);
  console.log(`Backup created (if needed): ${backup}`);
  console.log('Next: node --check src/app.js');
}
