# Local Point readonly slice — author evidence

2026-10-12. User approved the sequence at 11:21 UTC: local background-free Point view →
Point/scalar editing → source-free local saving. Only the **first** slice is implemented.
Independent PM review and the new-bytes #76 installed gate are pending. No M0/M4 completion.
Current acceptance matrix preserves all original UC/FR/AC.

## Exact source and unchanged ownership

- Base: accepted #111 `d4da53d9615aba484ed79748d75688e442611bec`, containing #110 installed
  readonly consumers and accepted lifecycle. No Core/domain branches or new shared API.
- **Tested source: `9622d6936e5efa1dfc3ac71eb08d505c90f67a98`.** Subsequent commit adds only this report.
- Main checked: `5a32d355ac107258a604e5a4d7a45d03f3b9efdb`; no main update/adoption claim.
- #112 acceptance document retained from `abf6dcd8134939bc1847eb65d43e8b81ced16f7d`, with
  authorization, first-slice status and remaining gates updated; no original requirement removed.
- Exact diff guard confirms unchanged geo-core, artifact/editor Core, shared runtime/contracts,
  extension-sample/Animation adapter, Animation/Video, apps/scripts/workflows, root manifest/lock
  and Geo package manifests. Only Geo Surface, package-local fixtures/tests and Geo docs changed.

## Design and numeric boundary

DOM/SVG only, no new dependencies or map engine. Each layer independently computes the native
Point extent. Both spans must be ≤5°, and all Point latitudes must have absolute value <70°.
A violating Point blocks the **whole Point layer display**; longitude span >180° also diagnoses
dateline/wide extent. These are explicit provisional display rules, not accuracy, geodetic,
production budget or future persisted compatibility guarantees. Non-Point/null are retained
in full and diagnosed individually. An empty/blocked frame never silently draws a subset.

The local degree frame is centered, east-right/north-up, with equal angular scale and a 0.1°
minimum presentation extent for singleton/coincident points. No wrapping, clipping, coordinate
rounding, native transform, pixel-distance measurement or geographic accuracy is claimed.
Coincident IDs remain separate selectable targets. Map/list selection is a private layer/feature
ID pair; native data, fields, source pins, hash, revision and history remain unchanged.
Source-free fixture has three Points (two coincident), null and LineString; unsupported fixtures
cover dateline, high latitude, wide extent and Multi/Polygon. Existing inert-text/source-metadata
fixture is retained only as regression evidence, not fetched or attested source bytes.

## Commands and environment

Debian 13, Node 24.19.0/npm 11.9.0, Chromium 151.0.7922.173, Playwright 1.63.0.
Production Vite preview of package-local public source-entry Host; desktop 1280×900 and
narrow 390×844. Synthetic read policy and ManualClock, no storage/resource backend.

| Command from repository root                                                                                     | Result                                                              |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `npm ci --ignore-scripts --cache /tmp/geo-npm-cache --no-audit --no-fund`                                        | PASS, 465 packages; no manifest/lock changes                        |
| `npm run lint` / `npm run typecheck`                                                                             | PASS, root checks                                                   |
| `./node_modules/.bin/vitest run packages/geo-core/src packages/geo-inspector/src packages/extension-runtime/src` | PASS, 229 tests / 13 files (59 Geo core, 15 inspector, 155 runtime) |
| `./node_modules/.bin/vite build --config packages/geo-inspector/vite.config.ts`                                  | PASS, independent production bundle                                 |
| `./node_modules/.bin/playwright test --config packages/geo-inspector/playwright.config.ts`                       | PASS, 12 cases × two viewports = 24                                 |
| `npm run check:files` / `git diff --check`                                                                       | PASS                                                                |

Logs `/tmp/geo-point-final-{lint,type,unit,build,browser,policy}.log`. Screenshots
`/tmp/geo-inspector-evidence/point-map-{desktop,narrow}.png` visually inspected at tested source:
no horizontal overflow, selected map/list identity visible, explicit limitations/diagnostics,
keyboard focus visible. Narrow map markers are small; the native list provides an alternative
selection target. No touchscreen/screen-reader certification. Evidence/build stay outside Git.
No observed functional failures in these runs. Node's NO_COLOR warning is not a browser error;
console/page errors and unexpected external requests fail the browser cases.

## Functional evidence and limits

| UC / FR / AC subset    | Verified at tested source                                                                                                                                                                               | Remaining                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| UC1 / FR03 / AC03      | map button and list button select the same stable ID; actual Tab traversal + Enter/Space; coincident IDs retained; null selection clears map highlight                                                  | Selection is private, no new Host event contract, no editing or full attribute-table integration |
| UC1,3 / FR02 / AC04    | exact 5° accepted / representable excess refused; ±70° excluded / ±69.999° accepted; dateline never wrapped; null/Line/Multi/Polygon kept with reasons                                                  | Dateline/polar/non-Point rendering, topology and geometry editing NOT RUN/unsupported            |
| All / FR06,07 / AC07   | selection/details/focus preserve native JSON, hash, revision, Undo/Redo; singleton centered without native rounding; array order not identity                                                           | camera, saved views, input/IME/edit transactions are later scope                                 |
| UC1,2 / FR01,10 / AC02 | existing real Basic limits 65536 UTF-8 bytes / 4096 nodes / depth24 regression PASS; oversize browser refusal retains native and renders no partial map                                                 | no budget relaxation or claim that larger import/join fixtures fit Basic                         |
| All / FR10 / AC11      | source-free new fixture, no basemap/network requests, inert scalar text; only artifact:read + required lifecycle                                                                                        | offline editing/saving and source closure not implemented                                        |
| All / FR10 / AC12      | stale map event blocked before selection, ready/pending revoke, late replacement, delayed/failed drain, detached callbacks inert                                                                        | Geo saving/in-flight write/production permission not part of readonly gate                       |
| All / FR10 / AC12      | **Actual BFCache**: allowed and denied back/forward restoration observed (persisted=true ≥2 per viewport), fresh instance, denied read stays denied. Separate synthetic denied lifecycle case also PASS | package-local Host evidence; both shared installed consumers require #76 rerun on new map bytes  |
| UC1,2 / FR01,05,08     | unchanged core/import/join and runtime regression suites PASS                                                                                                                                           | UC1/2 E2E, style/legend, persisted versions, PNG/CSV/GeoJSON export remain open                  |

## #76 handoff and next gate

Request to shared owner: adopt this exact Geo source after readonly review, rebuild existing
readonly-domain pack profile, admit the new archive hash, and rerun both installed consumers
(Reference/independent × desktop/narrow), lifecycle/BFCache and relevant baseline regressions.
Use source-free Point/unsupported fixtures for the new display checks. No new manifest entry,
package dependency, root wiring, generic controller/selection API or Core kind branch is
requested. Existing manifest version is unchanged here; owner chooses/pins archive/version
policy, never reuses the previous inspector package hash as evidence for new bytes.

NOT RUN: new installed archives/dual shared Host gate, full repository unit/build/E2E,
real devices/screen readers/Firefox/WebKit, Point/scalar editing, save/reload, source resource
closure/durability, immutable output receipt, all M2/M3 and performance. Prior #110 readonly
and #111 Animation evidence remains valid only for those exact accepted slices. No shared
root/license/CI change, Actions dispatch, performance run, main push/merge, release/publication.
Point/scalar editing starts only after this readonly gate review; saving follows its own gate.
