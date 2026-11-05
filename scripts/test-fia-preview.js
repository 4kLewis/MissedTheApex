/** Offline rendering test: uses a fictional PDF fixture, never accesses FIA. */
import { readFile, writeFile } from 'node:fs/promises';
import { renderFiaPdfPreview } from '../src/services/fiaPdfPreview.js';

try {
  const pdf = await readFile(new URL('../test/sample.pdf', import.meta.url));
  const result = await renderFiaPdfPreview(pdf, 4);
  const filename = `fia-preview-test.${result.extension}`;
  await writeFile(filename, result.data);
  console.log(`PASS: created ${filename} (${result.pages} pages, ${result.data.length} bytes).`);
  console.log('No Discord message was sent. Open the image to inspect it.');
} catch (error) {
  console.error('Preview rendering test failed:', error);
  process.exitCode = 1;
}
