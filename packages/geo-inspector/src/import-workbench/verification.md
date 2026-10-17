# Local import UI — author verification

Initial evidence below is historical; the review correction at the end supersedes its
cancellation/staging and retired-handler coverage.

2026-10-12. Tested source `08b02c0e122cb4c56008a8fb292905325e484132`. Following evidence commit
only adds this report. Stacked on #129 domain HEAD `157118a1d905fbbd2c0ddf47d051a79e5c3f2d2b`;
#129 independent review/installed adoption is managed by parent/#76. Shared runtime remains the
accepted #111 source on this branch. This UI does not incorporate #123/#125 code; their accepted
source-free save status is recorded, and is not a source-backed save claim.

Local real File input, manually specified field types and CSV axes feed the existing importer.
Only explicit commit invokes its prepared native command through the actual existing controller.
Test Host retains immutable original byte copies in memory; no Save grant or durable storage.
The preview registry/pins do not stand in for production source retention. All fixtures synthetic.

| Command                                                                                                          | Result                                                 |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `npm run lint`                                                                                                   | PASS root                                              |
| `npm run typecheck`                                                                                              | PASS root                                              |
| `./node_modules/.bin/vitest run packages/geo-core/src packages/geo-inspector/src packages/extension-runtime/src` | PASS 301 cases / 15 files                              |
| `./node_modules/.bin/vite build --config packages/geo-inspector/vite.config.ts`                                  | PASS existing entries plus local import workbench      |
| `./node_modules/.bin/playwright test --config packages/geo-inspector/playwright.config.ts`                       | PASS54: existing42 + six import cases × desktop/narrow |
| `npm run check:files` / `git diff --check`                                                                       | PASS                                                   |

Logs `/tmp/geo-import-ui-{lint,type,unit,build,browser}-final.log`, `/tmp/geo-import-ui-policy.log`.
Same Debian13/Node24.19.0/npm11.9.0 and existing Chromium/Playwright config as #129.
Desktop1280×900 / narrow390×844. Narrow screenshot inspected for mapping controls, explicit
commit/cancel, excluded rows and retained-source limitation. `/tmp/geo-inspector-evidence/import-*.png`.
Tests fail on page/console errors or requests outside the local test origin. No external data fetch.

| Functional case              | UC / FR / AC subset             | Evidence                                                                                                                                                                                                             |
| ---------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CSV200→198                   | UC1 / FR01/03/07 / AC01/03      | Native hash unchanged before commit; two errors block default commit; explicit partial consent records excluded199/200;198features + source retained; map/table same stable ID; one Undo/Redo restores exact native. |
| Reverse axis/null/duplicates | UC1 / FR01/03 / AC02/04         | Explicit lat→lon mapping yields correct CRS84 coordinates; null geometry and scalar retained; duplicate source IDs warn without coalescing internal IDs.                                                             |
| GeoJSON mixed content        | UC1/3 / FR01/03/10 / AC02/04/11 | Explicit property mapping; Point and LineString preserved; numeric/string external IDs remain distinct; false/null/empty strings retained and malicious HTML stays text.                                             |
| Mapping/cancel/revoke        | FR01/07/10 / AC07/12            | Mapping changes invalidate preview; Cancel permits new preparation and discards late result; revoke removes UI and prevents late native commit.                                                                      |
| Mapping error/stale          | FR01/07 / AC02/03               | Unmapped column error leaves native untouched; Undo after preview makes it stale, confirm refuses instead of applying to new revision.                                                                               |
| Complete-view capacity       | FR01/10 / AC02/11               | A65000-character scalar can preview but full controlled-view admission refuses before native/history/resource adoption. Shared budget unchanged.                                                                     |

Initial failures: first browser run timed out locating nested select labels; stopped after repeated
same cause, added explicit accessible names. A premature second run refused an already-used local
port and did not execute tests. Subsequent 200-row preview runs exposed the test budget counting
both candidate and accepted-feature arrays. Fixed test-only envelope counter400 and parser201
records, not shared limits; focused10 then expanded12 passed. Final complete54 passed. Logs
`/tmp/geo-import-ui-browser-{first,second,third,fourth,fifth,sixth}.log` preserve the sequence.

NOT RUN: installed consumer adoption of this UI, source-backed editing, actual original bytes
closure/retention/save/reopen, retained versions/GC, exports/PNG/receipt, automatic column inference,
full root unit/build/E2E, native OS IME/device/screen-reader certification, performance. Current
installed #123100-feature/64KiB capacity is not enlarged by the200-row domain test. No new source
schema/CRS/renderer adopted; topology warnings are not certificates of geometry validity.

#76 handoff: install reviewed #129 table then this workbench through existing public entry wiring;
provide real source pin/resource staging/retention and complete-view preflight, preserve revoked
callbacks and stale revision guards, and rerun these cases in both installed Hosts. Keep accepted
#123/#125 source-free paths; no stripping source refs to enable them for imports. User decision on
self-contained source closure vs separate resources
and capacity/retained versions precedes source-backed persistence. No root manifests/lock/shared
Core/runtime/Host or Animation/Video changed. No CI enable/dispatch, main merge/release/performance.

## Independent review correction: source reservations and retired Remove handlers

Before runtime HEAD `3c90e4664b6c85f3a81f8c9ad32fd0977e382cd0` plus regression probes only:
`playwright test --config packages/geo-inspector/playwright.config.ts import-review.spec.ts --project desktop`
failed both tests. `/tmp/geo-import-review-before.log` records:

- Holding A's manifest digest, cancelling A, preparing B successfully, then releasing A caused B
  commit to refuse `TestHostSourceMismatch` instead of `Imported 1`. Cancelled work damaged a
  current valid preview through the shared Map-size-derived staging identity.
- Saving the Remove1 callback, removing that field, preparing a valid remaining-field preview and
  invoking the retired callback changed status from `Preview ready` to `Preview required...`.
  Its index was -1, so splice removed the remaining mapping instead of doing nothing.

Corrected tested source **`9ce7f9e001c2eb54e7f4a18bda613ec84c2dfbd2`**. Follow-up adds only this
report. Source staging now reserves monotonic identity and capacity before any await, checks its
exact entry after each await, and releases that entry on abort/failure. A private per-preparation
AbortSignal and idempotent lease release connect UI invalidation/disposal to Host stage lifetime.
On successful native adoption the preparation lease is released while original byte retention
stays separately Host-owned for Undo/Redo. Admission of retained originals has its own test bound.
No shared runtime/Storage/Save or source-free Save contract changed.

Remove handlers have removed/closed/index guards, detach onclick on removal, and retire remaining
handlers on dispose. Captured function references are inert after removal, even if called twice.

| Corrected evidence                                  | Result / scope                                                 |
| --------------------------------------------------- | -------------------------------------------------------------- |
| Root `npm run lint` / `npm run typecheck`           | PASS                                                           |
| Related unit command from original table            | PASS307 /16files, including six controlled-defer staging tests |
| Package Vite build command from original table      | PASS                                                           |
| Full package Playwright command from original table | PASS58: previous54 + two review regressions on both viewports  |
| `npm run check:files` / `git diff --check`          | PASS                                                           |

Logs `/tmp/geo-import-review-{lint,type,unit,build,browser}-final.log` and
`/tmp/geo-import-review-policy.log`. Focused staging6 and browser16 passed before the final suite.
The initial added callback test used MouseEvent where current TS onclick expects PointerEvent;
that test-only typing error was corrected before final typecheck (initial log retained).

UC1 / FR01/03/07/10 / AC01/03/07/11/12 subsets: controlled A/B digest order now commits B's exact
value and source; cancelled pending stage releases capacity before B reservation; commit releases
preparation but retains one adopted original. Unit probes cover full pending capacity, failure in
both hash phases, abort after ready, repeated old release, scope disposal and no late publication.
Retired Remove preserves the valid preview, remaining field ID/value and native content after
revoke; DOM handler detachment is checked. Existing file mapping failure also leaves stage count0.

The reported environment disconnect did not block this workspace: command execution and local
files remained available. Regression probe and fix commits were preserved locally before final
verification; no environment migration or credential changes. All previous NOT RUN items remain,
including installed source-backed adoption, real closure/retention/save/export and M1/M4 completion.
