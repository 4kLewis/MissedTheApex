# MissedTheApex Source Audit — 5 November 2026

Based solely on the uploaded `MissedTheApex-main.zip` snapshot. This is static code review, not a live Railway test.

## Verified overview

- 99 top-level slash-command definitions (in 99 command modules), all uniquely named. See `COMMAND-INVENTORY.csv`.
- 280 JavaScript files under `src/`, `scripts/` and root passed Node.js v22.16 syntax checks in the original snapshot.
- Slash-command registration currently truncates lists above 100 (silently losing commands). The patch changes that to fail registration loudly without overwriting the previously registered list.
- `f1TeamSelectorService.js` installs a second `interactionCreate` listener. The central interaction handler would independently treat its colon-containing `mta:f1-team-select:v1` custom ID as unknown and may try to acknowledge an already handled interaction. The patch lets the standalone listener own this selector.
- `Dockerfile` uses Node 20 while the pinned `pdfjs-dist@6.5.438` package declares Node >=22.13.0. The patch aligns image to Node 22 and updates the package engines field.
- The public health server retains an in-memory IP request-count Map without eviction for inactive addresses; potential slow memory growth.
- `rateLimiter.js` retains entries indefinitely unless cleared (potential slow memory growth).
- `messageCreate.js` reads counting-game and guild config state for ordinary messages and can benefit from caching, provided invalidation is correct.
- `app.js` re-registers 99 global commands on every startup; content-aware registration can reduce unnecessary Discord REST traffic.
- The `/generatepassword` command used `Math.random()` for forced character-category insertion and could overwrite an earlier forced category. Patch uses cryptographic randomness and guarantees required categories.
- Both giveaway winner shuffle paths used `Math.random()`. Patch uses `crypto.randomInt()` for unbiased, cryptographically generated winner selection.
- No evidence of live errors is proven by syntax-only checks; review deployment logs and use a staging environment for behavior tests.

## Categories in source

- Economy: 19
- Moderation: 16
- Tools: 11
- Utility: 8
- Core: 7
- Leveling: 6
- Music: 5
- Fun: 4
- Giveaway: 4
- Ticket: 4
- Welcome: 4
- Verification: 3
- Community: 2
- Birthday: 1
- JoinToCreate: 1
- Logging: 1
- Reaction_roles: 1
- Search: 1
- ServerStats: 1

## Prioritised consolidation opportunities (not all implemented)

1. Giveaways: 4 top-level (`gcreate`, `gend`, `gdelete`, `greroll`) become `/giveaway create|end|delete|reroll`; **3 slots recovered**. Included in this patch, opt-in.
2. Music: existing `/music` already has many subcommands. Fold `play`, `join`, `nowplaying`, `queue` in after testing; up to **4 slots recovered** (if all four are retired as global commands).
3. Tickets: keep `/ticket` and fold `/claim`, `/close`, `/priority`; up to **3 slots**.
4. Levels: 6 top-level commands into 1-2 logical groups; **4-5 slots**.
5. Moderation: 16 commands into a handful of groups, but needs a role/permission and audit-log migration plan; do this last.
6. Economy: 19 commands could be consolidated, but avoid 19 unwieldy subcommands and preserve economy balance / purchase permissions.

## Important caution

Deleting slash commands or moving them into subcommands affects client autocomplete, custom guild command disabled flags, command access and user documentation. Do not bulk-rename these until they have a regression test, especially moderation, economy and tickets.

## Validation performed on patch

- Static code check for all JavaScript files with `node --check`.
- 400 password generation tests across four option combinations passed with Node native assertion library.
- Source inventory, 99 exposed commands with `MTA_COMPACT_GIVEAWAYS` off; 96 with it on.
- No live interaction with Discord, PostgreSQL, Railway or package download has been run in this environment.

## FIA Preview fix added to combined patch

- **Confirmed dependency mismatch:** uploaded Dockerfile uses Node 20; `pdfjs-dist` lockfile requires Node >=22.13.0. Combined Dockerfile is Node 22 bookworm-slim with fallback fonts.
- **Operational uncertainty:** without Railway `[FIA Docs]` logs and variable values we cannot establish if the specific missing preview was disabled, a network failure, a renderer error, or an attachment permission issue. New diagnostics identify this.
- **End-to-end test added:** `node scripts/test-fia-live-preview.js --pages 1` attempts an official PDF fetch and renders locally; it does not send to Discord or write PostgreSQL.
- **Rights:** do not enable published page previews without appropriate permission.
