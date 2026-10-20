# #267 / #275 / #276 targeted verification

Date: 2026-10-18 UTC. Base: `b643cd4c2877e2bbbe828dc1d74d77aa4d0ea1ed`.
Environment: Linux x64, Node 24.19.0, npm 11.9.0, Chromium 151.0.7922.173,
Playwright 1.63.0. Browser checks use production builds at 1440×1000 and 390×844.

## #267: developer React ZIP verifier

The verifier bounds the file read to 8 MiB, inspects all central-directory entries
without expansion, then streams local entries in 256-byte compressed chunks. It
limits individual output to 2 MiB, aggregate output to 16 MiB and entries to 256.
Actual output is checked against both declared sizes and limits, including forged
local/central sizes. Path, case collision, local/central identity and all source
dependency checks finish before filesystem extraction.

Accepted files are TS/TSX (including declarations), CSS, JSON, Markdown and the
listed passive image/font extensions in `scripts/lib/host-react-archive.mjs`.
JS/JSX/MJS/CJS/MTS/CTS are rejected. All TS/TSX/declarations and CSS are checked
for Editor runtime dependencies; decoded TypeScript string literals are checked
too. The standalone bundler also rejects source imports outside the ZIP except
React/React DOM. This remains a developer verifier for the ProductPage fixture,
not a general archive upload service.

`scripts/tests/host-react-archive.test.mjs` covers compressed, per-file, aggregate,
entry-count and forged-size limits, unsupported executable sources accompanied by
declarations, TS/declaration/CSS dependencies, escaped imports and case collisions.
The existing CLI path traversal and stale-file regressions pass. The actual ZIP
downloaded from the reference Host passes strict TypeScript, independent production
bundling and opaque sandbox rendering with zero browser errors.

## #275: Unicode CSV import and visible failures

**NOT REPRODUCED:** the filename-only failure on current private main. Before
changing App, `カフェ売上.csv` already imported correctly on desktop/mobile.
The original report concerned public `97ea905` with relative Vite base; that
deployed snapshot and a human-operated browser were not retested here.

**Reproduced and corrected:** an import failure left the Library overlay open,
hiding the reason on a narrow viewport. The catch path now closes Library and
shows the existing error banner. Existing content remains available for retry.

Regression checks use the exact reported CSV via both a File payload and an actual
Japanese-named file on disk. They verify the artifact name, column types, all row
values, native export/reload, visible failed-import reason and successful retry.
No filename transliteration or ASCII restriction was added. Current-source closure
evidence is supplied; this does not claim that the historical failure's cause was
identified or that the public deployment changed.

## #276: editing referenced Data

Before correction the new desktop regression received `Chart` when expecting Grid.
Navigation now changes only the source's private view projection to Grid. It keeps
the rest of that view's preferences, native named views, saved versions and Undo.
Both fixed/follow tests start from a saved Chart view, open Grid, compare unchanged
native content, edit a cell, Undo/Redo, save and return to the same Slide. Fixed
keeps the old chart; follow displays the new saved label. Destination Undo still
removes the placement independently of source history.

## Actual checks

- PASS: `npm run lint`, `npm run typecheck`, `npm run check:files`, `npm run build`.
- PASS: `npm test`: **2,650 passed, 9 existing optional skips, 256 files** (the
  ordinary runner's main cohort plus isolated Slide import corpus).
- PASS: `npm run test:tooling`: **84 passed**, including archive and existing CLI checks.
- PASS: `EDITOR_REFERENCE_PRODUCTION=1 npx playwright test --config playwright.priority.config.ts`:
  **10 passed**, five each desktop/mobile; browser errors are fatal.
- PASS: `npx vite build --base ./ --outDir /tmp/editor-priority-relative-dist --emptyOutDir`,
  then that build's preview with the same config and `-g 'Unicode CSV|failed import'`:
  **6 passed**, desktop/mobile payload and filesystem uploads, reload and visible retry.
- PASS: `EDITOR_REFERENCE_PRODUCTION=1 npx playwright test --config playwright.references.config.ts -g 'returns to the exact Slide page|review source navigation|review source access'`:
  **28 passed**, existing desktop/mobile page returns, domain navigation and revoked access.
- PASS: `npx playwright test --config playwright.host.config.ts -g 'native Design edits generate'`:
  **2 passed**, desktop/mobile real ZIP output, save/reuse/reload.
- PASS: `node scripts/verify-host-react-output.mjs <desktop-react-output.zip>`:
  actual Host ZIP compiles, bundles and renders in an opaque sandbox.

Screenshots of the Unicode import, visible mobile error, Grid source editing and
standalone React output were inspected. Raw logs, screenshots and ZIPs remain in
`/tmp/editor-priority-*` and ignored `work/issue-33-36/`, outside Git.

Initial browser checks retain their failures: the Library backdrop remained and
source projection was Chart. Early mobile test attempts also encountered hidden
toolbar controls; the final tests use the actual overflow menus and visible cell.
Interrupted attempts are not PASS. An initial file-policy invocation encountered
sandbox `spawnSync git EPERM`; it passed with the normal network-enabled executor.

The full browser suite, other browser engines, manual OS/file-picker interaction
and the original public deployment were NOT RUN. GitHub
Actions, performance work, public synchronization and deployment were not run.
