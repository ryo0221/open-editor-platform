# Design headless operations (#294 / #295)

2026-10-19 JST. Base main `076d0159802856334b256b3d51b00c55bed8536d`.
Initial verified code/tests: `dd0c13cc51eba9685b95e71c5a61e2f04b87f07a`.
The following documentation commit records that pin and initial gate outcomes.
The PR #296 review corrections and their separate verification are recorded below.
Design extension, schema 1/2 unchanged. Design and acceptance scope:
[headless contract](../../design-headless-contract.md).

## Implementation and boundaries

- Native insertion accepts optional ID/bounds/parent/index. `elementId` is fixed
  at command creation; repeated preview/apply uses the same identity. Legacy
  `insertElement(type, sourceString)` and `insertInstance(componentId)` remain.
- Typed JSON intents compile to the same native command factories and one
  existing transaction. Parsing is bounded and rejects executable values,
  getters/hooks, sparse arrays, reserved/unknown fields and invalid operations.
- Native write commands validate resulting Design content. Element/component/
  part patches validate actual targets and values, reference scope, geometry,
  layout and new prototype destinations. Missing/invalid writes cannot consume
  history or partially commit. Retained broken prototype links remain readable
  and diagnosable after frame deletion; unrelated edits preserve them.
- Pure preview exposes ordinary base/content/proposal plus a serialized intent
  proposal. Apply recompiles it and checks content/result hashes, optional local
  revision (including ABA) and current writable callback inside execution.
  Host/authority authentication, artifact/session selection, publication and
  durable storage remain outside Editor.
- The existing native Design codec accepts the prepared command. Unit coverage
  checks its JSON wire, revoked/stale authority rejection and selective Undo
  preserving a peer's independent field. No new collaboration runtime or claim
  of production auth/durability is added.

## Verification environment and results

Managed Linux, Node 24.19.0, unchanged npm lockfile and verified fixed Office fonts.
Production Chromium 151.0.7922.173, desktop 1440×900 and mobile 390×844
(Chromium emulation; existing responsive regression also covers 768px).
New independent Host uses public packages and its own markup, with a production
ESM bundle; ordinary Playground remains a separate regression target.

| Check | Current result |
| --- | --- |
| New headless model + native shared adapter | 33 PASS across two files, including all override patch entrypoints |
| Full unit suite | 2,695 PASS / nine existing optional skips across 260 files (2,687 + isolated eight-case Slide import corpus) |
| Typecheck/lint | PASS |
| Three production builds | PASS: Playground, React UI and Artifact Host |
| File policy / tooling | 2,317 files checked / 90 tooling cases PASS |
| Production desktop/mobile | 32 PASS: eight new / 24 existing regressions; zero browser errors |

New unit cases cover explicit/generated IDs, ordering, bounds/parent failures,
input ownership, every intent family, invalid target/value/type patches, atomic
failure with retained Redo, portable preview/adoption, result tampering,
stale/ABA/revocation and a React/CSS-free Node bundle. Existing tests cover
geometry/layout, vectors, prototypes and shared metadata.
The cyclic-override case exercises dedicated override, ordinary update, bulk
properties and JSON update, with a coincident outer ID to verify component-local
reference scope. A valid component-local parent remains accepted.

New browser scenarios cover preview/cancel without native/history changes,
stable IDs and matching applied output, one Undo/Redo, ordinary Inspector edits,
save/reload, stale/ABA, late read-only access and partial batch rejection.
Final desktop/mobile preview screenshots were visually inspected: the proposal
renders separately while the native canvas/history remain unchanged, controls
are readable and mobile controls fit without page-level horizontal overflow.

Reproduction commands from the repository root:

```sh
npx vitest run packages/design/src/headless.test.ts packages/collaboration-adapters/src/design-headless.test.ts
npm test
npm run typecheck
npm run lint
npm run build
npm run check:files
npm run test:tooling
npx playwright test --config playwright.design-headless.production.config.ts
```

The browser config selects eight new cases (four per viewport) and 24 existing
regressions: prototype desktop/mobile, ordinary registered React, independent
embedding, canvas/text input and responsive panels. Browser console errors and
uncaught exceptions fail cases. The new independent Host uses a production ESM
bundle. Existing older embedding fixtures still emit their build-time IIFE
`import.meta` warning; the production Vite builds retain their chunk-size warning.
Neither is a browser console error. No full-browser-suite or performance result
is claimed.

## Acceptance conditions

| Conditions | Result / scope |
| --- | --- |
| N01 purpose/native model | PASS for this extension: existing Design kind/schema, public Node entrypoint and Host ownership documented |
| N02/N04 validation/atomic commands | PASS: stable IDs, pure ownership, typed/invalid patches and atomic failure in unit/production browser checks |
| N03/N05 private view/history | PASS for proposal/history changes: pure preview/cancel, one-step Undo/Redo, stale/ABA retained branches. Existing immutable version lifecycle is unchanged |
| N06/N07 independent/ordinary Host | PASS: independent public Host edit/save/reload and existing ordinary Design/React integration regressions |
| N08/N11 IDs/selection/keyboard/mobile | PASS: stable-ID selection, Inspector keyboard commit and responsive production flows, inspected screenshots |
| N09/N12 authority/untrusted data | Parser, stale, ABA, read-only and native authority unit PASS |
| N10 persistence | PASS for this extension: native JSON/portable proposal roundtrip, independent save/reload and existing normal Host import/save/reload. Immutable Artifact lifecycle remains existing Host behavior |
| N13/N14 reproducibility/documentation | PASS: all listed functional gates, pinned source, contracts/README/status and retained initial failures |
| C03 proposals/headless | PASS: bounded typed JSON, matching preview/apply, stale/ABA/revocation, cancel/failure unchanged and one Undo |
| C04 shared | Bounded native command adapter regression PASS; no independent shared intent session or new shared capability acceptance |
| C01/C02 text/annotations | PASS for existing unit/rich-canvas/prototype comment regressions only. Native OS IME is NOT RUN |
| C05/C06/C08 templates/reuse/React | PASS for existing full-unit and ordinary Design/React browser regressions only; no new authoring/bridge capability |
| C07/C09 new formats/large storage | N/A: no new format, fetching or durable-storage feature |
| C10/performance/release | NOT RUN: physical devices, other engines, new performance acceptance. Actions dispatch, trials, public sync and deployment remain paused |

## Earlier attempts and evidence limits

- Initial Design regression: 146 PASS / 2 FAIL. One capture path rejected root
  `undefined`, breaking the existing clear/inherit API; the implementation was
  corrected. The legacy empty-metadata test also supplied a nonexistent Home
  frame; its fixture now contains Home while retaining its equality/Undo checks,
  matching newly validated explicit prototype writes. Next focused run: 148 PASS.
- Initial new headless cases: 23 PASS / 5 FAIL. Early nonfinite rejection happened
  before the test helper captured its command; the helper now includes command
  preparation and still checks unchanged content/revision/Undo/Redo. The prototype
  intent used the reserved JSON key `prototype`; its public field is now
  `settings`, preserving strict reserved-key rejection. The negative case table
  was also corrected to pass whole batches to Vitest rather than spread arguments.
- Later focused suite: 180 PASS, including 30 new headless model cases and two
  new native authority cases. Initial full suite: 2,694 PASS / 9 existing optional
  skips. The added cyclic-override case increased the full count to 2,695.
- Initial browser run: 30 PASS / 2 FAIL. Both failures were the new ordinary
  Inspector scenario, which looked up the inserted ID as a layer display name.
  The fixture now gives the layer an explicit name, the test uses that name and
  separately verifies selection contains the stable ID. Next run: 32 PASS.
- Final review preserved legacy `insertElement('image', '')` behavior and added
  the cyclic override rejection. Review then found ordinary `overrides` patches
  needed the same effective hierarchy check as the dedicated override operation;
  references are now checked against component parts, including the positive
  valid-parent case. The 33 new model/authority cases PASS after this correction.
- One final browser launch was stopped with SIGINT while the final production
  rebuild was still running; it is not a completed verification result. The
  aborted log is retained separately and the final run starts after build exit.
- Final pinned source passes 2,695 units / nine existing optional skips, the
  three production builds and all 32 production browser cases. No unresolved
  functional failure remains in the declared local headless scope. This does
  not recertify every existing Editor capability or establish shared S01–S06,
  physical-device/native-IME, performance or release acceptance.

Raw evidence is local to the managed workspace and is not embedded in this
repository. Reproduce using the commands above; these `/tmp` paths are not public
download links:

- `/tmp/editor-platform-headless-initial-unit.log`, `headless-new-unit.log`,
  `headless-e2e.log`: first failures (all have the `editor-platform-` prefix).
- `/tmp/editor-platform-headless-focused-final.log`: earlier 180-case regression.
- `/tmp/editor-platform-headless-override-review.log`: final new 33-case run.
- `/tmp/editor-platform-headless-{typecheck,lint,build,unit,e2e}-final.log`:
  final source gates. `headless-files-final.log` and `headless-tooling-final.log`
  retain the file/tooling results with the same prefix.
- `/tmp/editor-platform-headless-e2e-verified.log` and
  `/tmp/editor-platform-headless-e2e-pre-override-review.log`: earlier 32-case passes.
- `/tmp/editor-platform-headless-e2e-aborted.log`: stopped launch before final build completion.
- `/tmp/editor-platform-design-headless-initial-results`: initial browser failures.
- `/tmp/editor-platform-design-headless-results`: final desktop/mobile screenshots
  and Playwright results. Both `headless-preview.png` images were visually inspected.

Generated fonts/builds/ZIPs/screenshots stay outside Git. No Actions dispatch,
product trial, public synchronization or deployment was performed.

## PR #296 review corrections (2026-10-19 JST)

The review identified four gaps beyond the initial assertions. These corrections
supersede the original acceptance for the affected patch paths; the original
failed runs and passing baseline above remain historical evidence.

- `discussion_r4308173812`: submitted nested native structures now reject
  undeclared keys, including layout/constraints/crop/typography, run/style,
  vector/viewBox/provenance and embedded-reference/source/target/snapshot/
  dependency envelopes. Existing strict Web/React/interaction validators remain
  in use. Declared dictionaries and foreign-domain content retain their schemas;
  unrelated legacy fields are not rewritten on read.
- `discussion_r4308173814`: generic patches cannot change element type or add,
  replace or clear a React identity/import/slot assignment. Registered React
  commands own those operations. Existing ordinary props/bindings edits still
  work without changing the retained registration.
- `discussion_r4308173818`: parent patches run the native destination subtree
  and ancestor lock/hidden checks in their actual element/component scope, and
  reject ancestor cycles before layout. Native update/properties and both JSON
  equivalents share this validation.
- `discussion_r4308173822`: the synthetic projection of a component template
  skips the element-level instance reference requirement, because schema 1/2
  templates do not retain componentId. Actual instance elements still require
  their component. Saved template-only instance definitions remain editable by
  native commands, override and serialized preview/apply, including Undo and reload.

Seven new unit cases reproduce all four findings: the initial run was 31 PASS /
7 FAIL. The next run was 37 PASS / 1 FAIL because a reference fixture used async
`contentHash` as JSON data; the fixture now uses the existing synchronous
`reuseHash`. The following model/native-authority run passes all 40 cases.
The nested-field table includes a valid control for every rejected structure,
and failure checks preserve an existing Redo branch. Four destination cases cover
locked/hidden parents and their ancestors; valid unlocked moves still pass.

One new browser scenario per viewport checks nested-field/React/locked-parent
batch rejection with no content/history changes, followed by instance-template
editing, save/reload, another edit and Undo. Existing ordinary React editing and
independent output builds remain selected regressions.

Review code/tests: `c3c60d220751023a2e68ba2bbaea8f8ec6d3e0d1`.
The following documentation commit records this source pin and outcomes.

| Review gate | Result |
| --- | --- |
| New model/native authority tests | 40 PASS (38 model / two authority), seven new unit cases |
| Full units | 2,702 PASS / nine existing optional skips across 260 files |
| Lint / typecheck / three production builds | PASS |
| File policy / tooling | 2,317 files PASS / 90 tests PASS |
| Production desktop/mobile | 34 PASS (ten headless / 24 regressions), zero browser errors |

Both final preview screenshots were visually inspected at desktop/mobile widths;
the proposal remains separate from unchanged native content/history and controls
remain reachable without page-level horizontal overflow. The new review scenario
passes on both viewports, including save/reload and Undo of the template update.
N02/N04/N05/N09/N12 and C03 pass for these corrected paths; existing ordinary
React regressions also pass. No unresolved functional failure remains in the
reviewed scope. All physical-device/native-IME/shared/performance/release limits
above remain in force.

Review raw logs use
`/tmp/editor-platform-headless-review-*.log`, including `before`, `after` and
`focused`, with final `typecheck-final`, `lint-final`, `unit-final`, `build-final`,
`e2e-final`, `files` and `tooling` suffixes. They are local evidence, not public
download links. The reproduction commands/config above apply unchanged.
Initial pre-review screenshots/results were retained separately at
`/tmp/editor-platform-design-headless-pre-review-results`; the selected config
places the review run's screenshots/results in
`/tmp/editor-platform-design-headless-results`.

## Merge integration with main (2026-10-19 JST)

The first GitHub merge request returned HTTP 405 (conflicts). Main had advanced
to `03c52ecbac6699766ccf196f7358490ae03aec31` after PR #287. A normal merge retained
both documentation sections in README/status; these were the only conflicts.
The public-export policy combined automatically. No Design implementation or
review test was changed: those paths match `2d29dd65` exactly.

Integration source: `8d0efabb38cd502b6443495efce783493e9c4955`. The following
documentation commit records the outcomes for that combined tree. This preserves
the independent implementation and review pins above.

The main lockfile was installed with `npm ci --cache
/tmp/editor-platform-merge-npm-cache`. The first install using the default cache
failed with ENOENT for `/home/agent/.npm/_cacache`; the retry with a writable cache
passed. The lockfile was not edited beyond the incoming main version.

| Integration gate | Result |
| --- | --- |
| Full units | 2,733 PASS / nine existing optional skips across 265 files (2,725 + eight-case Office corpus) |
| Lint / typecheck / production builds | PASS, all four entries including the incoming Animation Host |
| File policy / tooling | 2,339 files PASS / 91 tests PASS |
| Design production desktop/mobile | 34 PASS, zero browser errors; both preview screenshots inspected |
| Selected Animation production desktop/mobile | Four PASS, zero browser errors |

Both Design preview screenshots, the desktop independent Animation Player and
mobile Slide presentation were visually inspected. The controls and retained
content render correctly in these selected flows. All integration gates above
pass at the pinned source; the only failed attempt in this integration round was
the initial npm cache setup, recorded separately above.

Commands use the same cache option; raw logs are
`/tmp/editor-platform-headless-merge-{install,install-retry,typecheck,lint,unit,build,files,tooling,e2e,animation}.log`.
The Design production run uses the existing 34-case config, with output at
`/tmp/editor-platform-headless-merge-results`. Four selected Animation connection
regressions check the ordinary edit/history/native path and retained Slide
version adoption on desktop/mobile, with separate output at
`/tmp/editor-platform-headless-merge-animation-results`:

```sh
npx --cache /tmp/editor-platform-merge-npm-cache playwright test --config playwright.design-headless.production.config.ts --output /tmp/editor-platform-headless-merge-results
npx --cache /tmp/editor-platform-merge-npm-cache playwright test --config playwright.animation-connection.config.ts --grep 'ordinary Animation history|Slide retains and explicitly adopts' --output /tmp/editor-platform-headless-merge-animation-results
```

These selected regressions do not recertify all Animation, shared, physical-device,
native-IME, performance or release capabilities. The earlier scope limits remain.
