# MissedTheApex — Combined Phase 1 + FIA Preview Reliability Fix

Based on **the uploaded `MissedTheApex-main.zip` snapshot** from 5 November 2026. Contains all Phase 1 optimisation changes, plus fixes and diagnostics for the FIA preview feature. **Do not replace the entire repo; copy these files into matching paths on a new branch.** Review changes if your repo has moved since the snapshot.

## What's changed specifically for FIA document previews

1. The uploaded Dockerfile uses Node 20, but `pdfjs-dist@6.5.438` declares Node >=22.13.0. The combined Dockerfile uses **Node 22 (Debian bookworm-slim)**, installs certificates and fallback fonts, and avoids Alpine musl for native canvas compatibility.
2. `fiaPdfPreview.js` fails clearly with the current Node version, and distinguishes network/HTTP errors, an invalid HTML response, and redirects to disallowed hosts.
3. `fiaDocumentsService.js` logs whether preview mode is on and how many pages it requests **once each startup**. On a new document it logs one of `Created`, `PREVIEW_DISABLED`, `PREVIEW_FAILED`, or `PREVIEW_UPLOAD_FAILED`, and still sends the original PDF link on failure.
4. `scripts/test-fia-live-preview.js` tests the **real archive → PDF download → rendering** chain and writes a local image. It does not call Discord or PostgreSQL.

None of these changes automatically republishes existing FIA posts. Deduplication and the 3-minute scheduler are unchanged.

## Important: FIA reproduction rights

The original feature is opt-in. The FIA website terms restrict reproduction of FIA materials. Keep `FIA_PDF_PREVIEWS_ENABLED` off until you confirm permission for posting previews in Discord. The offline and live diagnostic scripts write locally and never post to a server. Reference: https://www.fia.com/sites/default/files/termsandconditionsfiawebsite.pdf

## Safe installation — Codespaces

```bash
git status
git switch -c optimise-phase1-fia
```

Extract this ZIP. Copy the **matching files and folders** (such as `Dockerfile`, `package*.json`, `src/services/*.js`, `src/events/*`, `scripts/*` and the `test` fixture) into your Codespace, preserving the paths. Do NOT delete the rest of your project. This package includes the earlier Phase 1 patch; do not install the old patch separately.

If your original project has other `.gitignore` additions after the uploaded snapshot, merge the four preview filename lines instead of overwriting it.

### Check the bot & preview source

```bash
node --version
node --check src/services/fiaDocumentsService.js
node --check src/services/fiaPdfPreview.js
node --check scripts/test-fia-live-preview.js
node scripts/test-fia-preview.js
npm run audit:commands
node scripts/test-password-generator.js
```

The offline test should print `PASS`. If you already have dependencies installed, no additional `npm install` is required. The package's lock file retains your `pdfjs-dist` and `@napi-rs/canvas` dependencies.

### Test a *real* published PDF locally (no Discord posting)

```bash
node scripts/test-fia-live-preview.js --pages 1
```

This fetches the FIA document listing and attempts to render its first listed PDF. If you want to test the exact document that failed, copy the link from the embed and run:

```bash
node scripts/test-fia-live-preview.js --url "https://www.fia.com/.../document.pdf" --pages 4
```

Replace the example URL with the genuine official `.pdf` link; use quotes. Test output is written to `fia-preview-live-test.png` (or `.jpg`) **in the Codespace only**, with no message sent to Discord. The Git ignore entries prevent committing test images. If the direct URL returns a permission error, pay attention to the reported HTTP status and final host.

### Commit and push for review (rather than straight to production)

```bash
git add Dockerfile package.json package-lock.json .gitignore \
  src/events/interactionCreate.js \
  src/handlers/loaders/commandLoader.js \
  src/commands/Giveaway/giveaway.js \
  src/commands/Tools/generatepassword.js \
  src/services/giveawayService.js \
  src/services/fiaDocumentsService.js \
  src/services/fiaPdfPreview.js \
  src/utils/giveaways.js \
  src/utils/passwordGenerator.js \
  scripts/audit-command-registration.js \
  scripts/test-password-generator.js \
  scripts/test-fia-preview.js \
  scripts/test-fia-live-preview.js \
  test/sample.pdf
git status
git commit -m "Optimise MissedTheApex and diagnose FIA preview failures"
git push -u origin optimise-phase1-fia
```

Open a Pull Request into `main`. Review the file diff and merge when checks pass. Railway should redeploy **after merge**, if connected to main. Remember that the previous opt-in Phase 1 `/giveaway` command consolidation is still off unless `MTA_COMPACT_GIVEAWAYS=true` is explicitly enabled. It is safest to keep it off initially.

### Railway checks

Open **Bot service → Variables**. Verify `FIA_DOCUMENTS_CHANNEL_ID` is set. For image posting, `FIA_PDF_PREVIEWS_ENABLED=true` requires permission to reproduce FIA PDF pages; `FIA_PDF_PREVIEW_PAGES=4` selects four pages. No further variables are necessary. Do **not** set the options on the database service.

Look for these log lines after start or after a newly published document:

- `[FIA Docs] PDF previews: ENABLED; pages=4; Node=v22...` → configured correctly
- `[FIA Docs] PDF previews: DISABLED...` / `PREVIEW_DISABLED` → setting not active
- `Created 4-page PDF preview for Doc ...` → generated image
- `PREVIEW_FAILED ... PDF download failed (HTTP 403)` → FIA blocked the download from Railway
- `PREVIEW_FAILED ... requires Node.js` → container still running Node 20 / Dockerfile ignored
- `PREVIEW_FAILED ... returned text/html` → obtained a web page rather than the PDF
- `PREVIEW_UPLOAD_FAILED` → Discord rejected attachment (check `Attach Files` and attachment size)

A PDF rendering success **in Codespaces** does not guarantee it succeeds in Railway. If logs still show a failure, **copy the error text before changing anything else**. The new messages are designed to isolate the actual cause.

Existing document messages won't be edited or re-posted. New documents try preview rendering only if enabled. As before, if an image fails, the document link is still sent.

## Previous Phase 1 improvements (also included)

- Avoid silent command registration truncation; 99 global commands retained by default.
- Prevent duplicate handling of F1 team selector interactions.
- Update Node engine declarations.
- Fix password category enforcement; use cryptographic randomness for giveaway draws.
- Add command inventory and password tests.
- Optional `/giveaway create|end|delete|reroll` grouping (`MTA_COMPACT_GIVEAWAYS=true`) reduces 99 global slash commands to 96 after testing. Prefix aliases remain.

Review `AUDIT.md` and `COMMAND-INVENTORY.csv` for detailed findings and remaining improvements. As before, there have been **no live Discord, Railway or FIA fetch tests from this workspace**. The JavaScript files have been syntax checked. Use Codespaces and Railway logs for the real end-to-end validation.

## Rollback

Revert the combined PR commit. Existing PostgreSQL data is untouched. To immediately disable only preview images, set `FIA_PDF_PREVIEWS_ENABLED=false` in Railway and redeploy; FIA links remain available. To disable opt-in giveaway grouping, unset `MTA_COMPACT_GIVEAWAYS` and redeploy.
