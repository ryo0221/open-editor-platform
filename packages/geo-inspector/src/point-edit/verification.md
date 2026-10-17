# Point/scalar edit domain — author verification

2026-10-12. [Scope/API/ownership](README.md). Author evidence only; independent edit review and
shared installed adoption remain pending. No Geo save, full UC completion or M4 claim.

## Pins and environment

- Domain base #113 `b384f1a7ac8691f7dedef127d3e1ff60b6d7abf0`; shared API/runtime #111
  `d4da53d9615aba484ed79748d75688e442611bec`, unchanged.
- **Tested source `8c36dd92bb63f4e1d2fa3a50730b800a8b70f541`.** Final follow-up changes only
  this evidence and current-acceptance documentation, not runtime/test/config bytes.
- Parent accepted #114 `89a047313c244e18e2f284fa7ee7e13c2294e022` installed readonly map gate.
  Use that as the next shared adoption base; its readonly evidence does not certify edits.
- Debian 13, Node 24.19.0, npm 11.9.0, Chromium 151.0.7922.173, Playwright 1.63.0.
  Desktop 1280×900 / narrow 390×844, production Vite package-local domain fixture `/edit.html`.
  Actual ReferenceRegistry + existing controlled controller + local Core session/Inputs, synthetic
  permissions/recovery policy, no Storage/Resources provider. Factory is injected by test adapter.

## Commands and results at tested source

| Command from repository root                                                                                     | Result                                                                                  |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `npm run lint`                                                                                                   | PASS, root                                                                              |
| `npm run typecheck`                                                                                              | PASS, root strict TS                                                                    |
| `./node_modules/.bin/vitest run packages/geo-core/src packages/geo-inspector/src packages/extension-runtime/src` | PASS, 240 / 14 files: Geo core59 + inspector/map/edit26 + runtime155                    |
| `./node_modules/.bin/vite build --config packages/geo-inspector/vite.config.ts`                                  | PASS, existing local build plus domain edit fixture; not installed consumer integration |
| `./node_modules/.bin/playwright test --config packages/geo-inspector/playwright.config.ts`                       | PASS, edit12 + existing readonly24 = 36 cases                                           |
| `npm run check:files` / `git diff --check`                                                                       | PASS                                                                                    |

Logs `/tmp/geo-edit-final-{lint,type,unit,build,browser,policy}.log`. Screenshots
`/tmp/geo-inspector-evidence/edit-desktop.png` and `edit-narrow.png` visually inspected for
labels/selected target/field values/map correspondence, focus/controls and no horizontal overflow.
No browser page/console errors or external requests; assertions fail on these conditions.
Generated artifacts remain outside Git. No performance measurements or new dependencies.

## Functional mapping

| UC / FR / AC subset          | Evidence and result                                                                                                                                                                                                                                     | Limits                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| UC1/3, FR02/03/07, AC03      | PASS: selected stable layer/feature/field IDs; Point longitude+latitude and one scalar commit as one Geo batch; prepare hash/content/history unchanged; one revision and one Undo restore both, Redo restores both; other features/fields/IDs untouched | No create/delete, polygon editing or full attribute-table UX                                               |
| FR07, AC03/07                | PASS: UI and non-UI use domain preparation + same existing controller stale/grant/Input boundary; no raw Surface session or second history; validated no-op preserves revision and Redo, committed callback clears buffer                               | No shared/multi-artifact edits or product workflow                                                         |
| FR02/10, AC02/04/11          | PASS: empty/blank/NaN/Infinity/invalid numeric/range errors refuse atomically; resulting Point layer must retain same local-range validity in UI/non-UI; oversized edited scalar refuses before commit using full controlled-view data bounds           | Bounds use pinned draft.2 limits; no production capacity/accuracy promise                                  |
| FR03, AC03/04                | PASS: null/Line target refuses without conversion; source-bearing document edits/history refuse; string/number/boolean/null scalar semantics and unrelated field preservation                                                                           | Multi/Polygon target code uses same Point-only guard; no source-backed full editing/save claim             |
| FR06/07, AC07                | PASS: dirty target/field switches refuse; composition blocks Apply/Cancel/Undo; empty composition end still pins target until explicit Apply/Cancel; retired input/composition callbacks cannot edit a different newly selected feature                 | Synthetic composition events, not native OS IME certification                                              |
| FR07/10, AC03/07/12          | PASS: invalid/stale apply preserves buffer; explicit Cancel is native no-op; stale deleted target can be explicitly abandoned then another target starts from its own original values                                                                   | External/live-follow not added; Host must reopen scopes for unrelated source replacement                   |
| FR10, AC11/12                | PASS: missing edit or Inputs gives readonly fields/history; post-open edit loss revokes entire scope and removes DOM; fresh readonly open/replacement isolates old callbacks; retired drain has no failed cleanup                                       | Local authority harness, not production authentication/installed editor gate                               |
| FR02/06/10, AC02/04/07/11/12 | PASS: readonly definition/map regression24, including actual allowed/denied BFCache observations and separate synthetic restore                                                                                                                         | BFCache evidence is the existing readonly gate, not editable pending-buffer navigation/recovery acceptance |
| FR08/09, AC08/09/10          | NOT RUN: native persistence/retained versions/outputs/source closure. No save request, storage backend or Save UI exists                                                                                                                                | Next separately approved saving slice only after edit gate                                                 |

## Development failures and fixes

Initial browser run `/tmp/geo-edit-browser1.log`: four cases failed (readonly reopening/revoke
on two viewports) with uncaught `ScopeRevoked`. Surface teardown attempted to unregister an
Input boundary after the scope had already aborted. The fix skips that second unregister on
revocation, leaving aborted registration to existing runtime teardown; normal mounted cleanup
still unregisters. Focused rerun `/tmp/geo-edit-browser2.log` passed all four cases; final full
36-case run above also passes, with explicit drained/failed=[] assertions.

A subsequent code review found explicit Cancel could remain blocked if a stale target/field
had been deleted. Cancellation now clears only that abandoned buffer/target, does not retarget
its value, and leaves canonical state unchanged. Added unit regression passed at the final pin.
No remaining observed functional failure in this domain scope. Prior passing implementation
`f09a94a1569a0b3e07d070fc8bde65483291d7bf` is superseded by the tested source above.

## Ownership and remaining gates

Exact diff guard: readonly definition/Surface/public index, all manifests/root lock, geo-core,
Core/runtime/contracts, shared Host/scripts/apps, Animation/Video/adapter and workflows unchanged.
Geo-only source modules, fixtures/tests, package-local Vite test entry and docs changed. No new
public package export, installed consumer, export format or common API is part of this PR.

#76 next: after domain review, adopt from accepted #114 using the existing contract/runtime,
decide the editable entry/package wiring and scoped test/Host recovery policy, then provide a
separate installed edit gate. Do not silently add edit grants to the accepted readonly inspector.
No common-contract shortage was found. Existing controller is injected, not forked or emulated.

NOT RUN: installed editable archives/dual independent Hosts, editable BFCache/pending recovery,
real OS IME/device/screen readers/other engines, full repository build/unit/E2E, source-backed
editing, local save/reload, durable storage/production authority, output receipts and M2/M3/M4.
No CI enable/dispatch, main merge/release/publication, license change or performance work.

## Independent review correction — descriptor boundary and raw input budgets

The original author evidence above is historical. It did not cover the input-accessor defect
identified by independent review. This section supersedes its input-boundary acceptance claim.

At old PR HEAD `6d17b7b7011535b4d2213084e10b80c57507b357`, the changing `featureId` getter
regression failed: two getter calls, result `applied`, point-1 metric remained 10, point-2 metric
became 99, and Undo became available. Log: `/tmp/geo-draft-before.log`. A successful Core guard
on the already-normalized command did not protect the preceding domain preparation reads.

The domain now captures exact own enumerable data descriptors for the complete draft, target
and revision before semantic reads, trimming, number parsing, spreading or serialization. It
rejects accessor/hidden/unknown/symbol fields, inherited hooks, nonordinary prototypes and sparse
arrays. Captured records are owned and frozen. The semantic target and emitted command use the
same captured values. The guard follows the existing geo-core plain-data policy; it is not a
sandbox for Proxy traps or modified JavaScript intrinsics. No Core/runtime change was needed.

Provisional input-work profile, applied before numeric parsing: each coordinate string has at
most 128 UTF-16 code units; scalar text at most 4096; the complete captured draft JSON at most
8192 UTF-8 bytes (including metadata and JSON escaping). This is a local experiment, not an
approved production capacity/performance contract. Oversized input is rejected and retained,
never truncated. Existing native/controlled-view budgets remain separate and unchanged.

**Corrected tested source: `3e808d2e8c1be833110940db56e8bf3339e9b6ff`.** The subsequent
verification commit changes this document only. Environment and accepted shared/base pins above
remain unchanged. The execution environment was available throughout; no environment blocker.

| Verification at corrected source | Result |
| --- | --- |
| `npm run lint` | PASS, root |
| `npm run typecheck` | PASS, root |
| `./node_modules/.bin/vitest run packages/geo-core/src packages/geo-inspector/src packages/extension-runtime/src` | PASS, 301 tests / 15 files |
| `./node_modules/.bin/vite build --config packages/geo-inspector/vite.config.ts` | PASS, package-local domain fixture |
| `./node_modules/.bin/playwright test --config packages/geo-inspector/playwright.config.ts` | PASS, edit14 + readonly24 = 38 cases |
| `npm run check:files` / `git diff --check` | PASS |

Logs: `/tmp/geo-draft-final-{lint,type,unit,build,browser,policy}.log`. Generated evidence is local,
not committed. Updated narrow screenshot inspected: provisional limit text wraps, inputs and
stable target remain legible, without horizontal overflow. Browser assertions cover both sizes.

| UC / FR / AC subset | Corrected evidence |
| --- | --- |
| UC1/3, FR02/03/07/10, AC02/03/11 | PASS: original changing-getter probe refused with zero getter calls; root/target/revision shape and descriptor attacks refuse in prepare and execute; native hash/content/revision and seeded Undo/Redo state unchanged |
| FR03/07/10, AC03/07/11 | PASS: rejected input descriptors, target and revision unchanged; frozen valid input accepted; caller mutation after preparation cannot retarget the captured command |
| FR01/10, AC02/11 | PASS: exact/over character and UTF-8 byte boundaries; million-character numeric and scalar strings refused before parsing; no native/history mutation; bounded scalar still independently refuses existing controlled-view capacity overflow |
| UC1/3, FR02/03/07, AC03/07 | PASS: normal Apply/Cancel/Undo/Redo and readonly regression suite; on both viewports oversized numeric/multibyte scalar input stays in buffer, preserves target/hash/revision/history, and explicit Cancel restores original fields |

No remaining observed failure in this correction; independent acceptance is still pending.
All NOT RUN items and shared adoption gates above remain NOT RUN. No save, installed editable
integration, performance measurement, CI reactivation, merge or release is claimed.
