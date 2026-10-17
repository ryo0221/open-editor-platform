# Save preparation author evidence

The original evidence below is historical. The mixed-document review correction at the end
supersedes the Point-only profile and GS09 rejection evidence.

2026-10-12. [Requirements, matrix and #76 handoff](README.md). Preparation only, not installed
save acceptance. Base #116 `7892f1c4707371a4c58895fb81d20f20d3dbc195`; tested source
`294217d1cdb6df6eba30857f49a98fb28187a463`. Subsequent commit adds only this report.

Environment: Debian13, Node24.19.0, npm11.9.0; existing Chromium/Playwright fixture configuration.
No package install, dependency, shared API or storage implementation added. Existing test-only
FakeStorage is volatile. All data is synthetic. No secret locations, real addresses or source bytes.

| Command                                                                                                          | Author result                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint`                                                                                                   | PASS, root                                                                                                                                  |
| `npm run typecheck`                                                                                              | PASS, root                                                                                                                                  |
| `./node_modules/.bin/vitest run packages/geo-core/src packages/geo-inspector/src packages/extension-runtime/src` | PASS, 319 tests / 16 files; includes 18 new cases GS01–11                                                                                   |
| `./node_modules/.bin/vite build --config packages/geo-inspector/vite.config.ts`                                  | PASS at `ee2df8ba6b39b1de462cc0f9f8d65469f482963a`; later changes add only GS11 test/docs, no bundled runtime/config change                 |
| `./node_modules/.bin/playwright test --config packages/geo-inspector/playwright.config.ts`                       | PASS at `ee2df8ba6b39b1de462cc0f9f8d65469f482963a`, 38 existing edit/readonly regression cases; no Save UI/browser persistence test claimed |
| `npm run check:files` / `git diff --check`                                                                       | PASS                                                                                                                                        |

Logs `/tmp/geo-save-prep-{unit,lint,type}-final.log`, `/tmp/geo-save-prep-{build,browser,policy}.log`.
Unit expectations and the README matrix map cases to UC1, FR01/03/07/08/10 and subsets of
AC02/03/07/08/11/12. These are partial domain checks, not full AC acceptance. Save does not
add history; the valid input flush does. Invalid/composing input stays pending without write.
No-write after a valid flush leaves its accepted edit unsaved and Undo-able. Canonical values
and stable IDs survive JSON round-trip, with hash comparison before opening a fresh test session.
Old capture completion, deadline/reconciliation and revoke-before/after-write use existing runtime.

Initial preparation failures retained: `/tmp/geo-save-prep-first.log` had two test failures from
incorrect test usage of PointInputBuffer (`getSnapshot` instead of `draft`, and composition
arguments). Initial typecheck additionally found an incorrect unavailable-slot literal in the
harness. Corrected only the test harness: use actual unavailable resource slot and existing buffer
methods. Second focused run passed16; final expanded preparation passed18. No runtime patch.

NOT RUN: installed #117 adoption; actual local adapter JSON persistence/restart; trusted artifact
envelope/retained versions; new Save UI and receipt-size headroom; native OS IME; full root
unit/build/E2E; multiple independent installed Hosts; source bytes/closure/GC/migration; performance.
Runtime generic save regression passing is not proof of an actual Geo storage backend.

Ownership diff from base contains only this new Geo preparation directory. Accepted Point-edit
code, package/root manifests and locks, all shared Core/runtime/contracts/Host/apps/scripts/workflows,
and parallel Animation/Video remain unchanged. No CI action, push, merge, publication or release.

Blocker: GitHub credentials returned HTTP401 and fetch could not authenticate. Latest main/#117
could not be verified and a new Draft PR could not be created. Local environment worked; changes
are committed on `prep/geo-native-save`. Remote adoption must first verify current main, accepted
#117 pin and owners. There is no independent review/GO for this preparation yet.

Publication follow-up: the original HTTP401 blocker above was historical. A subsequent standard
fetch succeeded and confirmed main `5a32d355ac107258a604e5a4d7a45d03f3b9efdb`; REST confirmed
#117 open/Draft/unmerged at `3c7b523f05312165de05532e8e93192aff6d4a73`. The GraphQL lookup had
HTTP504, so a normal REST read was used; no credential changes. Independent #117 acceptance was
not inferred from this metadata. The follow-up only clarifies docs, including the deliberately
narrower trial profile versus the mixed edit fixture and mandatory receipt-inclusive budget gate.
No runtime or test bytes changed, and no new functional test execution is claimed by this update.

## Mixed-document review correction

Tested source `406ee78848add45c95e88845def5e4cafadd1c8f`. A following commit changes only this
report. The original Point-only predicate and synthetic Point filtering were removed. The default
save fixture now retains null and LineString features, so existing save/history/failure tests also
run against a mixed document. No product code, public API or shared runtime changed.

GS12 has two positive cases: the exact accepted mixed editFixture and an extended fixture with
MultiPoint, MultiLineString, Polygon and MultiPolygon. Both use the actual SaveCoordinator capture
hash, committed FakeStorage content, JSON round-trip and a fresh test session. Full document
comparison includes all geometry, layer/feature/row/field IDs, values and feature counts. Null rows
remain present. Non-Point edit still refuses with GeoPointOnly. No topology or new editing claim.

GS09 source rejection now serializes a valid source-bearing candidate with its own correct hash
and requires GeoSourceFreeProfileRequired. Separate hash-mismatch test uses valid mixed source-free
content and requires CaptureHashMismatch. Schema, axis, duplicate ID and byte-limit cases also
require their specific errors; null geometry is now positive coverage, not a negative case.

PASS at corrected source: root lint, root typecheck, 320 related unit tests / 16 files (19 save
preparation cases). Commands unchanged from the table above; logs
`/tmp/geo-save-mixed-{lint,type,unit}.log`. Focused first run passed all19 without a new failure.
File policy and diff checks PASS. Build/browser were not rerun for this test/harness/docs-only
correction; prior existing UI evidence stays at its recorded source and is not Save UI evidence.

Still NOT RUN: real Host atomic reopen, pending input preservation on switch/refusal, real storage
persistence/restart, trusted envelope, installed Save, receipt-inclusive controlled-view capacity.
An untouched parallel test session after parser rejection is not an atomic Host reopen test.
Shared WriteRequest capacity cleanup is under #76 review and is neither modified nor certified
here. External sources remain refused. No CI enable/dispatch, performance work, merge or release.
