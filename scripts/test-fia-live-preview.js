/**
 * Read-only, opt-in live FIA PDF downloader+renderer test.
 * Run in Codespaces: node scripts/test-fia-live-preview.js
 * It never connects to Discord or changes PostgreSQL.
 * This may create a preview on disk solely for local diagnostic inspection.
 */
import { writeFile } from 'node:fs/promises';
import { fetchFiaDocuments } from '../src/services/fiaDocumentsService.js';
import { fetchAndRenderFiaPdfPreview } from '../src/services/fiaPdfPreview.js';

const args = process.argv.slice(2);
function option(flag) {
  const at = args.indexOf(flag);
  if (at === -1) return null;
  if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`Missing value after ${flag}`);
  return args[at + 1];
}

try {
  const directUrl = option('--url');
  const docNumber = option('--doc');
  const eventFilter = (option('--event') || '').toLowerCase();
  const pageText = option('--pages') || '1';
  const pages = Number(pageText);
  if (!Number.isInteger(pages) || pages < 1 || pages > 4) throw new Error('--pages must be between 1 and 4');
  let url = directUrl;
  if (!url) {
    console.log('Fetching the FIA public document listing...');
    const { docs } = await fetchFiaDocuments();
    const matching = docs.filter(d =>
      (docNumber === null || d.number === Number(docNumber)) &&
      (!eventFilter || d.event.toLowerCase().includes(eventFilter))
    );
    if (!matching.length) throw new Error('No FIA documents matched the supplied number/event. Try without --doc or --event.');
    const chosen = matching[0];
    console.log(`Selected: ${chosen.event} / Doc ${chosen.number} / ${chosen.title}`);
    url = chosen.url;
  }
  console.log(`Node runtime: ${process.version}`);
  console.log(`PDF host: ${new URL(url).hostname}; requesting ${pages} page(s)`);
  const result = await fetchAndRenderFiaPdfPreview(url, pages);
  const filename = `fia-preview-live-test.${result.extension}`;
  await writeFile(filename, result.data);
  console.log(`PASS: downloaded and rendered ${result.pages} page(s) into ${filename} (${result.data.length} bytes)`);
  console.log('This is local only. No Discord messages were sent and no database changes were made.');
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  if (error.cause?.message) console.error(`Underlying cause: ${error.cause.message}`);
  process.exitCode = 1;
}
