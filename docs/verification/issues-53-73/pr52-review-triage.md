# PR #52 / #40 comment triage and completion (2026-10-12)

## Current three-comment follow-up: input, legacy read and shared typography

The review at `a8eeee6d4986167e02182f6913b9221bf4e2d2fa` adds three ordinary-use
findings. The maintainer requested all three corrections while retaining the
existing exclusions. No new capability, schema migration or snapshot history is added.

| Comment                                                                                    | Trigger and correction                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4244257323 P1 | Adding a preset Slide layout while editing bypassed flush and replaced content prepared before input acceptance. Blank/preset additions now share one flush boundary, prepare from refreshed canonical content, append through the existing command, and navigate only after Host acceptance. Composing, invalid or refused input retains the buffer and page.                                        |
| 4244257326 P1 | Earlier Data commands could save columns with a null Graph label. Read/apply validation accepts that legacy state; projection uses its existing first-column fallback. Drafts and immutable versions are not rewritten. Dangling non-null IDs remain invalid; first-column creation still initializes the label atomically.                                                                           |
| 4244257330 P2 | Shared Canvas engine documents omitted object-level inherited marks, and serialization omitted false overrides. Effective typography now comes from each domain's drawing projection and is used for engine construction, optimistic projection, authority application and Inspector replacement. Local/shared inline display renders booleans through marks, preserving visibly unstyled selections. |

### Regression scope

Fourteen added units fail on the preceding implementation and pass with these
changes. Twelve exercise three native Canvas domains and four boolean marks through
real independent SharedEditorSession actors: inherited construction, optimistic/confirmed
content, peer application, selected false overrides, checkpoint resume and selective
Undo/Redo retaining a peer append. One verifies legacy Data draft/version reading,
unchanged version hashes and rejection of missing non-null label IDs. One common
SVG regression verifies per-run decorations without a parent decoration that would
prevent false overrides from removing them. Existing
Graph projection tests now assert legacy fallback alongside first-column/Undo behavior.

Ten added desktop/mobile Chromium cases exercise an independent rejecting Slide
Host, direct IndexedDB legacy Data loading with immutable versions and reload, and
real peer browser contexts for Slide/Design/Whiteboard formatting. They assert
computed inline CSS as well as native runs, remote Undo/Redo, peer append and reload.
The common SVG renderer also applies decorations only to the resolved runs; both
ordinary Canvas display and SVG output retain the same partial removal. Actual
rendered parent/run attributes are checked by the three-domain browser cases.
Synthetic composition events cover the pending-input boundary; native OS IME is not
claimed. Unit selective Undo after a peer append covers the compatible mark-only
case; same-block later-writer conflicts remain an existing declared limitation.

Initial browser fixtures incorrectly toggled an already-open layout menu and omitted
the reference Host's annotations array from a directly stored record. Their setup is
corrected. The first shared browser fixture expected Undo after a same-block peer edit
to always succeed; the existing authority correctly refused that conflicting batch.
It now checks Undo/Redo before the peer append and verifies retained formatting after
that append/reload. A second fixture assumption grouped all four toolbar clicks into
one Undo; the engine's submission window permits separate operations. The fixture
isolates the final strike operation and checks its exact Undo/Redo, while all four
marks retain independent unit coverage. Mobile opens the existing artifact menu for
its Undo/Redo buttons. Browser-error checks and timeouts are not weakened.
Screenshot inspection found the separate parent SVG underline; a valid baseline
unit fails before the common renderer correction. The initial expanded audit run
was stopped after 17 passing cases to include this correction before final checks.

Native checks pass **1,162 units / 129 files**, **25 tooling tests**, lint, strict
TypeScript and both production builds/four font hashes. The full unit run is repeated
after the SVG correction; the intermediate 1,161-case pass is not its final result.
Final production Chromium passes **105/105 audit/review cases in one run** (76 desktop
and 29 mobile, including ten added regressions). Related QA-18 independent embedding
and R02/R07 rich authoring pass **2/2**, totaling **107 distinct browser cases**.
Desktop and 390px screenshots are inspected, including the visible partial decoration
removal. Changed-file formatting, diff checks and the **1,083-file guard** pass.
Source-only export contains 804 source files plus the manifest (**805 files**) at
implementation commit `44a6340e8c5add189773f5e27e40ef2c68d01627`; manifest/residual checks
pass. The final documentation HEAD is exported/checked again before push, without
public repository synchronization. Logs and screenshots stay under `/tmp/pr52-extra-*`
and the ignored Playwright output directory.

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run test:tooling
npm run check:files
npx playwright test --config playwright.audit.production.config.ts --workers=1
npx playwright test tests/e2e/issue2-embedding.spec.ts tests/e2e/reuse-common.spec.ts --config playwright.production.config.ts --project=desktop --grep='QA-18|R02/R07' --workers=1
npm run public:export -- --ref HEAD --out work/pr52-extra-public
npm run public:check -- work/pr52-extra-public
```

Vitest/tooling/Playwright use Node 20.20.2; lint/strict TypeScript/build use Node 24.
The existing Hug reapplication and two rare condition kinds remain held (four
unresolved threads). Performance/Actions/public synchronization remain outside scope.

## Preceding output follow-up and Data reference design

The review at `a20481d` adds four supported-use findings. The maintainer also
explicitly requested the date-window template error found in the preceding
checkpoint and asked for corrections at shared design boundaries.

| Comment                                                                                    | Trigger and correction                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4243898759 P2 | Graph edge label fields retain numeric/boolean scalars, including `0` and `false`. Null and blank strings retain the type-label fallback.                                                                                                                             |
| 4243898761 P1 | Chart SVG/PNG read a single refreshed Data/view snapshot after the export guard and recompute filtered rows from it. Pending native values and private accent settings appear in the actual output; refusal/composition stops download.                               |
| 4243898766 P2 | PDF indexing failure shows its real error without also claiming that the original is scanned or lacks extractable text. Successful blank indexing still shows the OCR notice.                                                                                         |
| 4243898770 P2 | A native image's HTML meaning is `img`. Both selectors use the same native contract; the publication command rejects incompatible parts, and strict conversion diagnoses mismatches in existing/imported content. Images cannot silently become text/fill primitives. |

### Reference ownership and compatibility

Data has its own typed native reference adapter. Entity IDs come only from columns,
rows, views, filters and widgets. Column bindings in formulas, views, widgets and
Graph labels, row bindings in relation values/defaults/filters and Graph placement
keys, and column-keyed value/width dictionaries are remapped by their schema roles.
Dates, search/filter text, widget titles and ordinary cell/default/option strings
remain literal values even when equal to a native ID. A column named `id`, `from`,
`to`, `formula` or `parentId` cannot change the interpretation of its cell value.

Native validation/ID collection uses the same Data entity enumeration. It retains
duplicate-entity, missing-field, typed value and formula validation without treating
`timeline.from`/`to` as connector endpoints. This repairs the earlier
`Missing from: 2026-11-01` failure at template save, pack import/creation and linked
view insertion/update. It does not add a date-format exception to a generic walker.
Other domain models retain their existing adapters. Reuse instance/address mappings
remain separate from immutable retained definitions and public input values.

No native/template schema migration or published hash rewrite is introduced. The
original source and catalog definition stay unchanged; creation gets fresh identities
and linked view operations preserve destination records/schema. Revision adoption
uses the existing Data operation/authority path and selective Undo. Chart output
uses the existing synchronous Host export guard. Design's image restriction is an
output contract, not a rejection of legacy native files during load; existing
mismatches remain editable and get a blocking addressed conversion diagnostic.

A cross-Surface inspection also found the same render-time capture error in Slide,
Whiteboard and Design graphical output. Each now captures its own refreshed native
content and scope after the guard; Design also captures current padding/scale/
background and extension diagnostics, Slide captures current/selected pages, and
Whiteboard captures Section selection/title. The existing domain SVG/page builders
and rasterizers remain the output path. This applies the same post-flush capture
rule as Data and Document without adding a universal content model or Host API.

### Regression evidence and checks

The native regression covers template save/pack import/creation, literal-value/ID
collisions, Graph placement/label bindings, missing-field/duplicate-entity rejection,
linked date-view insertion/adoption/selective Undo, and image semantics at both pure
publication and strict conversion boundaries. Initial fixture issues (the catalog's
`templateVersion` field, the converter fixture's `home` root and the native duplicate
validation stage) were corrected without weakening the production validators.

Before rebuilding the main app, the desktop date-template, image selector and PDF
notice reproductions all fail: `Missing from: 2026-11-01`, incompatible image tag
choices, and simultaneous indexing-error/OCR notices. The independent Data/Graph
fixtures already use corrected source and pass in that mixed five-case run. A
separate three-case production baseline fails for Slide/Whiteboard/Design SVGs
containing the previous text. These are baseline failures, not claimed regressions
of the final implementation.

The first 89-case output run passes 88 and fails one fixture: mobile View accent is
in the Data navigator, not the Inspector. The fixture now opens the correct panel.
The expanded 95-case run exposes four false failures (desktop/mobile Slide and
Whiteboard): the fresh text is present but split across wrapping `tspan` elements.
The assertion now reads actual SVG text content, retaining the latest-text condition.
Graph fixture screenshots show one typed edge at a time to avoid overlapping parallel
labels, and advance the Host source stamp when switching cases. No timeout or
browser-error assertion is relaxed.

Final native checks pass **1,148 units / 128 files**, **25 tooling tests**, lint,
strict TypeScript, both production builds/four font hashes and the **1,081-file
guard**; changed-file format/diff checks pass. Production Chromium covers **95
distinct audit/review cases (71 desktop + 24 mobile, twelve added cases)**. The
expanded run passes **91/95**; all four remaining SVG-text fixture assertions pass
after correction in the **10/10** focused run, which also rechecks all six Canvas
cases, both Graph-label fixtures and related QA-18/R02-R07. Thus **97 distinct
browser cases** pass across these runs. Actual SVG text/native content, chart
rows/colors, PNG bytes/pixels, pending-composition refusal, Design padding and
real 501-page/blank PDF indexing are checked; representative images are inspected.

Commands use Node 20.20.2 for Vitest/tooling/Playwright and the configured Node 24
for lint/TypeScript/build. Browser configs are `playwright.audit.production.config.ts`
and `playwright.production.config.ts`; the focused grep is
`captures freshly flushed graphic|typed scalar edge labels|QA-18|R02/R07` over
`pr52-remaining`, `audit-mobile`, `issue2-embedding` and `reuse-common` specs.
Logs/output stay under `/tmp/pr52-date-*`, outside Git. At implementation commit
`756c5bad80f56382fdbb716cd9b8830dbcd945aa`, source-only export includes 802 source
files and the manifest, **803 files** total; manifest/residual checks pass. The
snapshot is generated under ignored `work/pr52-date-public`, with no public
repository synchronization. Export/check is repeated from the final documentation
HEAD before push.

Native OS IME, other engines/real devices, production persistence, actual Office
consumers and paused performance/Actions/public synchronization remain unrun.
The three previously excluded condition kinds remain held (four unresolved threads).

## Preceding four ordinary-use findings: input/capture boundaries and native publication

The review at `b9140c0b45623cfc79c7f1e73df3d998bbe7d02c` adds four findings.
The maintainer requested necessary ordinary-use corrections with rare conditions
excluded; all four have supported ordinary triggers. The
maintainer's boundary plan
is incorporated without introducing a new transaction system or public Host API.

| Comment                                                                                    | Ordinary trigger and correction                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4242262543 P1 | Document Surface MD/HTML/PDF export reads one refreshed snapshot after its input/export guard succeeds. Focused image settings now appear in each actual download; refusal stops output. The main Host text-export path remains separate and uses confirmed/canonical capture.                                                                                                                                  |
| 4242262549 P1 | Template/reusable authoring first flushes inputs, checks shared pending/rejected/preview conditions, and reads the current canonical record and selection. The dialog owns a cloned starting source and IDs for both preview and saving, so later peer edits cannot silently change its source. Authoring stays synchronous and stops while confirmation is pending.                                            |
| 4242262559 P1 | Graph normal submit and Host flush share connection preparation: source stamp, current selection target, editability, required type/endpoints and existing domain checks. Selection-stale or version-stale drafts remain available and no connection is applied. The existing combined attribute/connection batch and trusted Host submission guard remain in place.                                            |
| 4242262555 P2 | A separate native-command correction (`8980fc9`) checks generated primitive public fields against their HTML tag and refuses image/original React/nested-instance slot targets. A plain Design Surface can no longer save those incompatible settings without the optional Design-React diagnostics. Native IDs/history/publication immutability are preserved; other conversion/build diagnostics still apply. |

The App's existing Host text export, CSV and Office capture share the current-record
reader. Office/private-composition guards are retained. Host text export checks its
artifact/session/input-registry identity and new pending input after confirmation;
it does not require an unchanged old revision because its own flush can advance it.
Native version save still uses the existing Session save path, and offline Detach
still uses checkpoint/suspend rather than a new confirmed-only rule.

EditorInputs retains its existing prepare-all/commit-in-order behavior. Partial
commit refusal stops the outer action, preserves already accepted changes and keeps
failed/unexecuted drafts. It does not roll back accepted native commands; retry skips
clean accepted inputs. This is verified separately from source capture.

Known constraints stay unchanged: Hug same-preset reapplication, external route
removal during an endpoint drag (two duplicate threads), and caller/replay-supplied
duplicate component IDs. No zero-comment completion or unrelated scope expansion
is claimed. Counts below belong to earlier checkpoints.

### Regression preparation

Before correction, all three P1 desktop reproductions fail for the reported behavior:
the Surface downloads the old alt text, invalid Form input opens authoring, and Host
Graph save changes the connection after selection moves. All three initial native
publication negative cases also fail because the incompatible command is accepted.
The added positive native publication case checks compatible fields, IDs and Undo/Redo.

The first expanded twelve-case browser run passes four and fails eight during fixture
preparation: the independent Document Host did not supply `selectedId` for its image
outline selection (`focusAddress` handles text ranges); narrow layouts need their outline
opened explicitly; and the broad
audit Data fixture's date-window view reaches an unrelated template-remapping error
(`Missing from: 2026-11-01`). At that checkpoint the authoring boundary fixture used the ordinary
default typed Data schema with a required Name field. Its invalid/composing/accepted
input and actual saved-content assertions remain. No timeout or browser-error
assertion is relaxed, and no correction to that unrelated date-window behavior is
claimed in that scope. The current follow-up fixes this shared Data boundary and
restores the date-window audit fixture with its required Name input.

The twelve-case retry passes nine. The independent Document image selection still
needed `selectedId` (not just text-range `focusAddress`), and the shared peer check
initially equated a locally confirmed status with receipt of the peer's newer
revision. The fixture now waits for the actual peer value in the owning Form before
checking the retained authoring source. The four-case retry passes both shared
authoring cases; both partial-refusal Document cases then expose the fixture's
missing `EditorExportGuardContext`. That public Host guard is now supplied, and the
two Document cases pass, including no download on refusal and no second native
commit of the already accepted edit. These preparations do not change the production
guard or weaken any assertion.

The completed focused checks cover desktop/mobile Surface MD/HTML/PDF output,
invalid and synthetic-IME refusal, accepted template/reusable preview and actual
catalog persistence, separate Graph selection-stale and version-stale input,
ordinary submit versus Host save, native Undo, read-only refusal, two-actor shared
authoring with delayed confirmation and an unchanged captured source after peer
edits, and additional private input during Host text-export confirmation. P2 also
has native negative/positive tests and ordinary slot retagging UI refusal. Input
registry partial acceptance/retry is verified in both a native unit case and the
independent Document Host.

All output assets/logs stay outside Git. Composition is synthetic DOM input; native
OS IME, other engines, real devices/screen readers and production durability are
NOT RUN. Explicit shared-session replacement during asynchronous
capture is guarded in code but not separately browser-tested here. Existing shared
authority unit coverage is retained; new browser tests exercise Host refusal and
delayed confirmation rather than adding a production permission system. Actions,
performance measurements and public repository sync remain paused.

Full native regression passes **1,142 cases / 127 files in one run**, including four
new publication cases and one partial-commit/retry case. The relevant Design,
Design-React and Editor core subset also passes **192 cases / 16 files**. Tooling
passes **25 cases**, and the file guard checks **1,077 files with no failure**.
Both production builds and the four fixed-font SHA-256 checks pass. Units/tooling/
Chromium use Node 20.20.2; lint/typecheck/build/format use Node 24.19.0.

The final production audit/review run passes **83/83 cases in one run (65 desktop +
18 mobile)**, including all twelve added cases and the P2 slot-retagging assertions
in the existing publication cases. Lint and strict TypeScript pass on the final
source/fixtures. Representative partial-commit Document, shared authoring and Graph
readonly/stale-input screenshots are inspected, including mobile layouts. Console
errors and uncaught browser exceptions remain failures. Existing Poppler embedded
font warnings appear in the PDF checks again, whose render/extraction assertions pass.

Related production desktop checks additionally pass **2/2**: QA-18's seven public
Surfaces/read-only/history/panel embedding and R02/R07's ordinary rich reusable
authoring, form history, library archive and restoration. Screenshot inspection
then identified missing viewport metadata and unbounded diagnostic `pre` text in
the independent boundary fixture. Its HTML now declares device width and scrolls
the diagnostic output, so the affected Document/Graph mobile cases use a 390px
layout viewport rather than mobile browser default scaling. Production source is
unchanged by this fixture adjustment.
All four affected desktop/mobile cases pass again with that final fixture, and the
390px Document/Graph screenshots are re-inspected. There are **85 distinct passing
production browser cases** across the 83-case audit/review run plus two related
cases; the four viewport checks are overlapping rechecks, not four additional
distinct cases. Changed-file formatting and diff checks pass.

```sh
npx vitest run packages/design/src/component-publication.test.ts
npx playwright test --config playwright.audit.production.config.ts --project=desktop --workers 1 --grep 'PR #52 boundary' --output /tmp/pr52-boundary-before
npx vitest run packages/design packages/design-react-core packages/editor-core
npx playwright test --config playwright.audit.production.config.ts --workers 1 --grep 'PR #52 boundary' --output /tmp/pr52-boundary-after
npx playwright test --config playwright.audit.production.config.ts --workers 1 --grep 'PR #52 boundary' --output /tmp/pr52-boundary-retry
npx playwright test --config playwright.audit.production.config.ts --workers 1 --grep 'PR #52 boundary.*(Document Surface|shared template)' --output /tmp/pr52-boundary-retry-2
npx playwright test --config playwright.audit.production.config.ts --workers 1 --grep 'PR #52 boundary.*Document Surface' --output /tmp/pr52-boundary-document-final
npm test
npm run test:tooling
npm run lint
npm run typecheck
npm run build
npm run check:files
npx playwright test --config playwright.audit.production.config.ts --workers 1 --output /tmp/pr52-boundary-browser-final
npx playwright test tests/e2e/reuse-common.spec.ts tests/e2e/issue2-embedding.spec.ts --config playwright.production.config.ts --project=desktop --workers 1 --grep 'R02/R07|QA-18' --output /tmp/pr52-boundary-related-final
npx playwright test --config playwright.audit.production.config.ts --workers 1 --grep 'PR #52 boundary.*(Document Surface|Graph Host)' --output /tmp/pr52-boundary-viewport-final
```

Source-only public export on implementation commit
`baaa9b19dc902e29ee93913a8ad0eae5f86a1b30` and its manifest/residual check pass:
**798 source files + manifest = 799 files**. This includes the two added native-unit
and browser-helper source files through the existing source-only policy. No public
repository sync or publication is included.

```sh
npm run public:export -- --ref HEAD --out work/pr52-boundary-public
npm run public:check -- work/pr52-boundary-public
```

## Preceding four comments: selected three-finding scope

The maintainer statically assessed the four comments at
`275b4dadcc0a52a4729561276b04ca67270a54a7` and selected **two priority findings and
one recommended finding**. This follow-up is limited to those three, with browser
regression separate from that static assessment. The two input failures lose private,
uncommitted buffers; neither finding describes destruction of immutable saved versions.

| Comment                                                                                    | Selected operation and correction                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4242048307 P1 | Starting collaboration flushes registered inputs synchronously and passes the current canonical record to the existing shared Host. Invalid/composing input stops navigation; immutable versions remain unchanged.                                                                                                                                                      |
| 4242048309 P2 | Independent Host Surface switch and shared Detach use a parent-owned registry before unmount. Local native sessions/history survive a Surface round trip within the Host lifetime. Shared Detach flushes into the existing session and checkpoints pending operations before suspension; Attach resumes them. Invalid/composing or refused input blocks the transition. |
| 4242048312 P2 | Publication's initial and reconciled slot selection use the same eligible non-image list as the selector. Image-first components with one eligible part can add a slot; tag changes move an ineligible selection to the first remaining candidate, and no candidates disable addition. Existing native publication command/IDs/Undo remain canonical.                   |

Known constraints retained under the maintainer's scope:

- 4242048314: reapplying the currently selected preset size to a Hug frame does not trigger the fixed-size transition. Another preset or explicit fixed-size inputs remain available; this does not lose input. No correction/resolution is claimed.
- The two previously excluded unusual conditions below remain unmodified: external Graph route removal during an active endpoint drag (two duplicate threads), and API/replay-supplied duplicate component IDs (one thread).

No further scope expansion or zero-comment acceptance is implied. The following
sections record earlier checkpoints and their own check counts.

### Regression preparation and limits

Eight browser cases exercise the selected three findings on desktop and mobile:
shared start rejects invalid/composing Form input, seeds the accepted focused buffer
and preserves the saved version across reload; local Surface switching rejects invalid,
composing and Host-refused input, retains native IDs/content and Undo/Redo on return;
shared Detach rejects invalid/composing input and resumes an offline accepted edit
from the existing checkpoint through Attach/reload without adding a saved version;
image-first publication checks a sole eligible part, tag-change reconciliation, no
candidate, native slot IDs, Undo/Redo and reopened settings.

The initial eight-case run passed four (Detach and slot, both platforms). Shared-start
preparation incorrectly expected the field to retain focus after the menu's Escape
focus restoration; the fixture now focuses it explicitly before invoking the ordinary
Host action. Surface-switch input refusal exposed selection notifications overwriting
the Host event message during focus recovery. The Host now displays the transition
error separately from selection events. No validation assertion, timeout or browser
error check was removed or relaxed. Composition uses synthetic DOM events; native OS
IME, real devices/screen readers and other browser engines remain NOT RUN.

The production audit/review run passed **69/71 cases**. Its two remaining failures
(desktop/mobile Surface switch) read a literal `values.name` although the default
Data factory allocates a native column ID. The field was already retained in the grid.
The fixture now looks up that column's actual ID; the focused retry passed **2/2**,
including native Undo/Redo and Host refusal. This verifies **71 distinct production
Chromium cases (59 desktop + 12 mobile)**, including the eight added cases, across
the full run and retry. It is not a single all-pass run or the entire Platform E2E
matrix. Representative shared-start, retained local Form and publication screenshots
were inspected, including narrow mobile layouts. Browser console/page errors remain
test failures. Existing Poppler embedded-font warnings recurred in PDF checks whose
render/extraction assertions passed.

```sh
npx playwright test --config playwright.audit.production.config.ts --workers 1 --grep 'PR #52 scoped' --output /tmp/pr52-scoped-browser-initial
npx playwright test --config playwright.audit.production.config.ts --workers 1 --output /tmp/pr52-scoped-browser-final
npx playwright test --config playwright.audit.production.config.ts --workers 1 --grep 'PR #52 scoped.*independent Surface' --output /tmp/pr52-scoped-switch-final
npx playwright test tests/e2e/issue2-embedding.spec.ts --config playwright.production.config.ts --project=desktop --workers 1 --output /tmp/pr52-scoped-embedding-final
```

Existing independent-Host QA-18 additionally passes **1/1** on production desktop
Chromium: all seven public Surfaces, edits, native history, read-only enforcement,
Host panel controls, narrow embedding and absence of Playground CSS. The first
invocation supplied a positional file after the variadic `--project` option, so
Playwright rejected it before running tests; the corrected invocation above passed.
Local lint, strict TypeScript, both production builds, **25 tooling cases** and the
file guard (**1,075 checked files; no failure**) pass. All four fixed-font SHA-256
checks pass. Units/tooling/Chromium use Node 20.20.2; lint/typecheck/build/format use
Node 24.19.0. Actual Office, production durability and consumer trials remain NOT
RUN; Actions, performance measurements and public repository synchronization remain
paused. Generated assets and raw logs stay outside Git.

Full native regression passes **1,137 cases / 126 files in one run**. Changed-file
formatting and diff checks also pass. No new unit cases are claimed for the Host/UI
changes; their new behavior is covered by the browser cases above.

```sh
npm test
npm run test:tooling
npm run lint
npm run typecheck
npm run build
npm run check:files
```

Source-only public export on implementation commit
`32b2fcfb6e8db49831bf5cd0e4233e6c3bfbbd9b` and its manifest/residual checks pass:
**796 source files + manifest = 797 files**. No public repository sync or publication
is included.

```sh
npm run public:export -- --ref HEAD --out work/pr52-selected-public
npm run public:check -- work/pr52-selected-public
```

## Preceding comments: eight ordinary-use fixes, rare cases excluded

The maintainer requested the new comments be addressed excluding rare cases.
The review at `12ffb06fd2dabdfd9390d8dc76d6a65ad3c9c6dc` contains **11 threads / 10
distinct findings**. Eight distinct findings occur during ordinary supported use
and are corrected. Two findings (three threads, including one duplicate) are
excluded under that scope and remain unresolved on GitHub. No new unresolved
thread was present on merged #40 at this assessment.

| Comment                                                                                    | Ordinary trigger and correction                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4241566008 P1 | Host Markdown/HTML export with invalid or composing Document inputs. Flush EditorInputs, stop on refusal, wait for shared acknowledgements and capture the latest canonical local or confirmed shared Document.               |
| 4241566019 P1 | Leave a shared session with an unapplied Form draft. Flush registered inputs, await shared confirmation, and refuse pending/rejected edits before closing. Invalid/composing drafts stay mounted.                             |
| 4241567746 P1 | Add/delete Slide while editing Canvas text. Flush before the transition and change selection/active slide only after acceptance. The insertion command appends to current content, retaining text accepted by that flush.     |
| 4241567754 P2 | A blurred invalid/rejected CommitInput receives a canonical update. Keep its dirty/error draft, continue clean-field reconciliation and clear errors after correction/acceptance or explicit Escape.                          |
| 4241567756 P2 | A CSV row is wider than its header or the first headerless row. Diagnose every extra value with source row/column/raw value and block batch confirmation.                                                                     |
| 4241567758 P2 | CSV automatic/explicit mapping targets a read-only field. Report a blocking mapping diagnostic before confirmation and preserve the target's default. Remapping to an editable target permits the existing guarded insertion. |
| 4241567769 P2 | Select a current annotation while the Host is retrieving an outdated source. Every annotation selection invalidates the prior request and clears its dialog/notice; late results cannot override the new selection.           |
| 4241567773 P2 | Ctrl/⌘Z on an independent Host Canvas. Supply EditorHistoryContext with the same private/native/shared callbacks as Host buttons and keep the writable guard at the callback boundary.                                        |

Excluded findings:

| Comment                                                                                                                                                                                             | Required unusual condition and disposition                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4241566016 P1 and duplicate 4241567761 P2 | An external content/visibility update removes the selected Graph route during an active endpoint pointer drag. The route preview can dereference a missing route. This requires a concurrent update within the short gesture; native Graph shared editing is not a declared capability. No correction or resolution is claimed for either thread. |
| 4241567775 P2                                                                                                          | A caller supplies an existing component ID or reapplies the same deterministic create command to content already containing that component. Ordinary Make component allocates a fresh ID for each invocation. Duplicate-ID validation for such API/replay input remains unmodified.                                                               |

### Verification of this new scope

Full native regression: **1,137 cases / 126 files PASS in one run**, including two
new CSV cases. Tooling **25 PASS**, lint, strict TypeScript, both production builds,
changed-file formatting, diff checks and file guard (**1,075 checked files; no
failure**) passed. Production Chromium's final scoped audit/review run passed
**all 63 cases in one run (55 desktop + 8 mobile)**, including the ten added cases.
Browser console/page errors remain test failures. This is the audit/review subset,
not every Platform E2E configuration. Earlier counts below describe the preceding
implementation only.

The ten added browser cases check invalid/composing Document inputs against both
Host text formats, freshly flushed local HTML/Markdown and confirmed shared text
from two actors, shared Form exit with invalid/composing/accepted drafts on desktop
and mobile, Slide add/delete with IME and Host refusal plus retained canonical text,
blurred numeric/rejected CommitInput across canonical updates, current annotation
navigation while a retained source resolver is pending, independent Canvas keyboard
history, CSV extra values with and without headers, and read-only mappings corrected
to an editable field with Undo. The delayed resolver is held by the independent
Host fixture; the production ReviewSurface and public APIs are exercised.

The initial ten-case run passed six and failed four fixture preparations: the
independent Host's esbuild bundle needed Vite's PDF worker URL convention, and a
one-pixel image click did not select the Document block. The fixture now uses ESM
and the actual built PDF worker asset; the outline selects the image. Three of the
four-case retry passed. The remaining fixture click blurred an invalid field,
inserted its error and moved the button before pointer-up, so it never triggered
the intended canonical update. Focusing that Host button and pressing Enter makes
the external update explicit and the focused regression **1/1 PASS**. No validation
assertion, browser-error check or timeout was removed or relaxed.

Representative retained-input, Slide, Review and narrow Host screenshots were inspected. Units,
tooling and Chromium use Node 20.20.2; lint/TypeScript/build/format use Node 24.19.0.
All four fixed-font SHA-256 checks pass. Composition is synthetic DOM input and
focus-preserving actions dispatch the ordinary Host button's click. Native OS IME,
real devices/screen readers, other engines, actual Office, production durability
and consumer trials remain NOT RUN. Actions, performance and public repository
sync/publication remain paused. Generated artifacts and raw logs stay outside Git.
The existing Poppler embedded-font warnings appeared in the earlier audit PDF
cases again; their extraction/render assertions passed.

```sh
npm test
npm run test:tooling
npm run lint
npm run typecheck
npm run build
npm run check:files
npx playwright test --config playwright.audit.production.config.ts --workers 1 --grep 'PR #52 new' --output /tmp/pr52-new-browser-initial
npx playwright test --config playwright.audit.production.config.ts --workers 1 --grep 'PR #52 new: (blurred|slide add|current annotation|Host Markdown)' --output /tmp/pr52-new-browser-retry
npx playwright test --config playwright.audit.production.config.ts --workers 1 --grep 'PR #52 new: blurred' --output /tmp/pr52-new-retained-input-final
npx playwright test --config playwright.audit.production.config.ts --workers 1 --output /tmp/pr52-new-browser-final
```

Source-only public export on implementation commit
`9cfc49bb0714513616985061736fcbcac5b795e8` and the manifest/residual check pass:
**796 source files + manifest = 797 files**. The independent regression Host is
included through the existing tests policy. The final documentation commit is
exported/checked again with the same source-only policy; no public sync occurs.

```sh
npm run public:export -- --ref HEAD --out work/pr52-new-comments-public
npm run public:check -- work/pr52-new-comments-public
npm run public:export -- --ref HEAD --out work/pr52-new-comments-final-public
npm run public:check -- work/pr52-new-comments-final-public
```

## Completion of deferred findings and new review

After the initial assessment below, the maintainer requested continued fixes.
This completion addresses the four deferred findings and the three new review
threads at `d8d32c6`. The assessment/check counts below remain historical.

| Comment                                                                                    | Correction                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4236091580    | Initialize the label atomically when the first column is added. A null label is valid only without columns. Moves preserve label metadata, row values and positions; column removal and Undo retain valid settings.                                                                                                                                                                 |
| 4239922677    | Use the same legacy revision normalization for saved source lookup, anchor state and the Surface's resolved-source check, on both old/new sides. Saved versions and annotations are not rewritten.                                                                                                                                                                                  |
| 4239922678    | Remap one File address belonging to the current artifact even when replacement changed the source ID. Retain other addresses, foreign references, comments and annotation metadata; reject missing source anchors without changing the artifact.                                                                                                                                    |
| 4239922680    | Expose per-page search truncation metadata and label the count as partial with an explicit 10,000-match/page navigation limit. Continue indexing later pages. Narrowing the query clears the notice; original PDF bytes are retained.                                                                                                                                               |
| 4241459146 P1 | Make decimals part of the FieldSettings parent draft instead of a separately registered child buffer. Empty/out-of-range/fractional values and composition block the parent transaction. Dashboard widget titles also update their parent's draft directly. This preserves all-buffer preflight; the generic registry is not changed to submit partial commands in multiple passes. |
| 4241459153 P1 | After flushing input and applying the existing pending/rejection guard, capture confirmed shared Data instead of the stale local library record. Both local and remote confirmed edits are included in Host CSV.                                                                                                                                                                    |
| 4241459156    | Disable child fitting for absolute/no-layout frames and reject it at the pure command boundary. The existing fixed-size option remains available and preserves child geometry with Undo. Row/column fitting is unchanged.                                                                                                                                                           |

The Data schema version is unchanged. Previously invalid null-with-columns graph
metadata is rejected at validation/import/session boundaries; no silent migration
or immutable-version rewrite is introduced. PDF extraction and matching keep the
existing limits; this is a correctness/diagnostic fix, without new performance work.

### Completion verification

Full native regression: **1,135 cases / 126 files PASS in one run**, including nine
added native cases. The earlier focused run also passed all **24 cases / 3 files**.
Tooling **25 PASS**, lint, strict TypeScript, both production builds, changed-file
formatting, file guard (**1,074 checked files; no failure**) and diff checks passed.

Production Chromium passed all **53 cases in one run** (**46 desktop + 7 mobile**),
including ten added browser cases. Coverage includes focused field decimal save,
blank/out-of-range/fractional/composing refusal with retained input, widget titles
in the parent version-save transaction, local/remote confirmed shared CSV, both
sides of legacy Review source retrieval, File remap/save/reload with three retained
anchors, partial dense-PDF search plus narrowed-query navigation and unchanged
original bytes, absolute fixed-size choice/Undo, and first-column label persistence
before and after Graph movement/save/reload. The other 43 cases recheck the previous
audit/review behavior; this is the scoped audit configuration, not all Platform E2E.

The initial nine-case browser run passed six and failed three fixture assertions:
Review comparisons assumed import kept its original artifact ID, and File selection
used an incorrect accessible name. Comparing the actual imported baseline and
selecting `File line 1` made the focused three-case retry pass without implementation
changes. The complete 53-case run then passed. Initial strict TS also caught test
types that were narrower than DesignContent and annotation data incorrectly added
to Artifact's base type; the fixtures were corrected before successful validation.

Representative screenshots were inspected. The PDF notice initially crowded the
toolbar, so its explanation was moved into the Viewer body after the 53-case run;
the short count still says `(partial)`. Both production builds and the focused
PDF notice regression **1/1 PASS** after that final markup change, and its screenshot
shows the explanation without covering toolbar controls. The other implementation
changes were unchanged from the 53-case run. The absolute preset dialog correctly shows
disabled fitting with an enabled fixed-size choice.

Units/tooling/browser use Node 20.20.2; lint/TypeScript/build/format use Node 24.19.0.
Fonts pass all four fixed SHA-256 checks. Poppler's existing embedded-font warning
also appeared in the older audit PDF tests, which passed extraction/render checks.
Composition checks use synthetic DOM events; focus-preserving save invokes the
ordinary Host button's click event. Native OS IME, real devices/screen readers,
other engines, actual Office, production durability and consumer trials remain
NOT RUN. Actions and performance work remain paused.

```sh
npm test
npm run test:tooling
npm run lint
npm run build
npm run check:files
npx playwright test --config playwright.audit.production.config.ts --workers 1 --output /tmp/pr52-remaining-browser-final
npx playwright test --config playwright.audit.production.config.ts --workers 1 --grep 'PR #52 remaining: dense PDF search' --output /tmp/pr52-remaining-pdf-final
```

Source-only public export and manifest/residual checks passed on implementation
commit `b6249aa62ee3ad3543e950340921ec6df9a9dd64`: **795 source files + manifest =
796 files**. The new regression spec is included through the existing policy.
No public repository sync or publication occurred. Generated PDFs, screenshots,
traces, fonts, builds and raw logs remain outside Git. A default-sandbox final file
guard attempt refused its Git subprocess with EPERM; the supported additional
network permission is used for the same check, as for the earlier decoder/tooling
checks. No test/configuration/size limit is bypassed.

```sh
npm run public:export -- --ref HEAD --out work/pr52-review-completion-public
npm run public:check -- work/pr52-review-completion-public
```

## Initial ordinary-use / urgency assessment

The maintainer requested ordinary-use fixes for #52 and only urgent remaining work
from merged #40. This assessment uses #52 head `447889a` and its six new review
threads, and compares all six unresolved #40 threads with that newer tree.
Unresolved GitHub state alone does not establish that a defect remains in code.

## #52: all six findings occur in ordinary use

| Comment                                                                                    | Ordinary trigger                                                                                                | Correction                                                                                                                                                            |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4240153843 P1 | Editing a shared Data Form then saving a version could lose the unapplied input on reload.                      | Synchronously flush EditorInputs before shared save, abort on validation/composition/refusal, and retain the error independently of later selection events.           |
| 4240153846 P2 | Tabs in ordinary code blocks prevented the whole PDF export.                                                    | Normalize control whitespace to spaces in the invisible PDF text layer for validation, measurement and encoding. Native text and raster rendering keep their content. |
| 4240153851 P2 | Filtering records could produce an unexplained route detour or overlap warning.                                 | Route around visible node boxes; validation still uses the full graph.                                                                                                |
| 4240153852 P2 | Grouping, hiding and overlapping stickies could attach a connector to an invisible or underlying node.          | Preview and endpoint commit share reverse visible paint-order hit testing, including hidden ancestor propagation.                                                     |
| 4240153856 P2 | Correcting the encoding after choosing a text replacement could still commit incorrectly decoded text.          | Re-decode retained original bytes. Failed decoding clears the prepared replacement and requests reselection; in-flight reads use current encoding.                    |
| 4240153860 P2 | Editing both schema and connection JSON could clear the other buffer's error and save its previous valid value. | Keep separate validation errors. UI save and Host flush reject invalid input; corrected input migrates with Undo.                                                     |

At this initial checkpoint three rare cases were explicitly unmodified: old Review annotations
without revision IDs after replacement, imported multi-anchor File remapping with
foreign references, and over 10,000 PDF query matches on one page. None of the six
new findings requires those unusual prerequisites. The completion above later
corrects all three.

## #40: one remaining reference-integrity fix

| Comment                                                                                 | Assessment at #52 head                                                                                                                                             | Disposition                                                                                                                                           |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4236091570 | Readonly keyboard moves already check the selected node type.                                                                                                      | Already fixed in #52; no new implementation.                                                                                                          |
| 4236091575 | Enum parsing already handles declared empty/whitespace options before generic blanks with a distinct placeholder; existing units cover both.                       | Already fixed in #52; no new implementation.                                                                                                          |
| 4236091578 | Added random edge IDs were immediately replaced by projection, silently orphaning stable Host/proposal references.                                                 | Urgent integrity fix within the reference Host: require the canonical derived ID at the adapter boundary and supply the same factory to GraphSurface. |
| 4236091580 | A zero-column Graph view can retain a null label ID after its first column is added; moving a node can persist the displayed fallback. Record values are retained. | Deferred at this checkpoint, then corrected in the completion above.                                                                                  |
| 4236091583 | Trusted formula-to-value schema transitions are already accepted, with existing unit coverage for conversion and forged-command refusal.                           | Already fixed in #52; no new implementation.                                                                                                          |
| 4236091586 | Import already disables while the independent Host loads or saves/commits.                                                                                         | Already fixed in #52; no new implementation.                                                                                                          |

The canonical-ID correction affects the fictional reference Definition adapter and
its independent Host. Native Graph and Data Graph keep their own factories. Actual
framework/product integration is not claimed. Units check atomic refusal, unchanged
revision, proposal preview/adoption and Undo/Redo for ordinary and 512-character
source IDs. Browser coverage disconnects/reconnects, then checks Undo/Redo and reload.

## Initial checkpoint verification

Lint, strict TypeScript, production build, formatting and file guard passed.
Tooling **25 cases passed**, including the updated public export policy. Units
confirmed **1,126 distinct cases / 126 files**: the full run passed 1,124 and timed
out on two existing Document export boundary cases; all 16 cases in that suite
passed on an isolated rerun with the same 5-second timeout. No timeout or budget
was raised and no implementation was changed for those failures.

Production Chromium confirmed **43 distinct browser cases** (37 desktop + 6 mobile).
The complete audit/review run passed 40 and failed three test locators/navigation
paths; a focused rerun passed the remaining shared Form desktop/mobile and mobile
encoding cases. The implementation was unchanged between those runs. Nine added
cases cover this follow-up; the other 34 recheck the previous audit/review behavior.
These are scoped local results, not the entire Platform E2E suite.

Actual PDF download was extracted with Poppler and rendered to PNG; Japanese text,
tab-separated words and the raster page were checked. Poppler prints an embedded
font warning on both the existing audit PDF and this new PDF; extraction and the
rendered page succeeded. Filtered Graph, Whiteboard target and shared Form narrow
viewport screenshots were inspected. Browser fixtures fail on console and
page errors. Added desktop cases cover all seven fixes; narrow viewport cases cover
shared Form save and encoding replacement. Shared save uses focus plus Enter and
composition uses synthetic DOM events, so native OS IME and mobile pointer save
reachability are not established.

Commands (Node 20.20.2 for the final unit/tooling/browser commands, Chromium,
1440×900 desktop and 390×844 viewport; build/lint used Node 24.19.0):

```sh
npm run lint
npm run build
npm test
npm test -- packages/document-export/src/plan.test.ts
npm run test:tooling
npm run check:files
npx playwright test --config playwright.audit.production.config.ts --workers 1
npx playwright test --config playwright.audit.production.config.ts --workers 1 --grep 'PR #52 shared Form|PR #52 mobile (shared Form|replacement encoding)' --output /tmp/pr52-browser-retry-results
```

Source-only public export and manifest/residual checks passed on the committed
implementation `9da9c91320cac58f55be1f46a98c46e177db5231`: **794 source files +
manifest = 795 files**. The public policy includes this report and the README/status
overlays describe the same scope. No public repository sync or publication occurred.

```sh
npm run public:export -- --ref HEAD --out work/pr52-review-triage-public
npm run public:check -- work/pr52-review-triage-public
```

Initial setup used an incorrect proposal method, two incorrect UI labels and a
non-public type import; these were corrected. A duplicate-alert locator was
narrowed and mobile File replacement now opens the ordinary overflow toolbar.
The shared Form run exposed error-status overwrite by selection, corrected in the
Host. A sandbox run refused decoder subprocesses with EPERM; the supported
additional network permission allowed the same decoder checks. The subsequent
full unit run passed 1,124 cases and timed out on two unrelated 5-second Document
export boundary fixtures during concurrent build/testing; their isolated rerun is
reported separately below.

Actions remain manual-only; performance work and #22 acceptance remain held.
Fonts, PDFs, PNGs, ZIPs, traces and raw logs stay outside Git. Native OS IME,
real devices/screen readers, other engines, actual Office, production durability
and consumer trials remain NOT RUN.
