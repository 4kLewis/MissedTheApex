// Read-only preview; never uses Discord or your Railway database.
import { previewF1News } from '../src/services/f1NewsService.js';
console.log('MissedTheApex F1 news – testing trusted RSS feeds (no Discord posts)');
const results = await previewF1News();
for (const r of results) {
  if (r.error) console.error(`FAIL ${r.source}: ${r.error}`);
  else {
    console.log(`OK   ${r.source}: ${r.found} F1 articles`);
    for (const title of r.examples) console.log(`     - ${title}`);
  }
}
if (!results.some(x => x.found > 0)) process.exitCode = 1;
