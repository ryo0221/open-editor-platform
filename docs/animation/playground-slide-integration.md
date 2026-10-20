# Animation: Playground and Slide connection

> Current schema 2 capabilities are documented in [Animation 2D](production-2d-design.md).
> The following is the historical schema 1 connection contract and its original verification.

Scope selected for #278 item 4, referencing the larger #74 epic. The existing
rectangle/group schema 1, 240,000 ticks/second, native commands, controlled Surface
and rectangle Player remain canonical. This is connection work, not completion of
#74's text/image/mask/path/nested/Design-conversion or shared-editing milestones.

## Declared behavior and boundaries

Layer subtree duplication/deletion and its confirmation/identity rules are described
in [layer actions](layer-actions.md).

- Playground adds a local Animation kind with native creation, existing timeline,
  transform/easing/keyframe editing, EditorSession history, EditorInputs preparation,
  ordinary version save, restore and native import/export. It admits schema 1 only;
  no implicit migration of prototype sources or rewriting old committed versions.
- The public local Surface receives the Host's existing session, authority, input,
  command/history and persistence callbacks. It creates no second history/store.
  Player state stays private and is disposed on switch/unmount.
- Slide owns an explicit animation object. It retains an exact saved source
  artifact/version/content hash and the complete asset-free native snapshot, a
  composition ID, label, poster tick and manual/on-enter playback condition. It
  remains playable without the source catalog. Source edits do not change it;
  selecting a different saved version is explicit, previewed and one destination
  transaction. Bounds/placement belong to Slide; keyframes belong to Animation.
- Initial fit is contain. Editor/thumbnail show a deterministic poster; explicit
  preview and presentation use the same Player as the editor and independent Host.
  Presentation entry resets to the poster, automatic playback respects reduced
  motion, and hidden/unmount cleanup stops clocks. Source navigation returns to
  the same Slide object selection.
- Source snapshots use SHA-256 of artifact-core canonical JSON. Refusal limits:
  at most 2 MiB per retained snapshot, 16 animation objects / 8 MiB retained snapshot
  bytes per deck, in addition to the existing Animation validation limits. These
  are admission bounds, not performance acceptance.
- Shared Animation editing, shared Slide animation objects, reusable/template
  authoring of animation-bearing scopes, public inputs, React UI registration and
  Office/static animated-deck exports are unsupported in this connection gate.
  These paths must refuse explicitly rather than drop motion or source bytes.

## Acceptance plan

| Conditions                        | Required evidence                                                                                                                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N01–N14 / C01 local subset        | create, edit two properties/keyframes, Undo/Redo, dirty/invalid/IME buffers, save/reload/native roundtrip, immutable hashes and read-only refusal               |
| C03 independent embedding         | production Host without Playground state/CSS, same Surface and Player, narrow viewport and cleanup                                                              |
| C06 retained source subset        | v1 saved source → Slide, source v2 does not change v1, explicit preview/adopt/Undo, missing source retains playback, corrupted hash/schema/tick rejected        |
| C07 native                        | complete snapshot roundtrip and version hashes; unsupported external exports refuse                                                                             |
| A03 / A09 / A12 applicable subset | same source/tick poster and Player scene, placement/resize/source unchanged, playback does not change content/history, reduced motion and leave/reentry cleanup |
| S01–S06                           | unsupported; shared admission refuses, no local fallback                                                                                                        |

## Verification: 2026-10-18 UTC

Application source: `a95b2098842321b6d53f3936bc6b8d5afc2e1e57`;
final browser test source: `9f2c0280cd6076101a7dea42ba8d896d04825165`
(only the reload readiness helper changed). Lockfile SHA-256:
`ce0997e2eab0ad4aa1cdf107896baf4e9f4b3426bc50dd7cc90972c05f2b844b`.
Node 24.19.0, npm 11.9.0, TypeScript 5.9.2, Vite 6.4.1, React 19.1.1,
Playwright 1.63.0 and Linux Chromium 151.0.7922.173 were used.

| Gate                       | Result and evidence                                                                                                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fresh install              | PASS: `npm ci --cache /tmp/editor-animation-npm-cache`, 460 packages; `/tmp/editor-animation-install-final.log`. No third-party version changes.                                                                                                                                     |
| Static checks / production | PASS: full lint, strict TypeScript and all four `npm run build` targets (Playground, React UI Host, artifact Host, separate Animation Host with relative base). Logs: `/tmp/editor-animation-final-guard-lint.log`, `/tmp/editor-animation-final-guard-build.log`.                   |
| Unit suite                 | PASS: 2,663 tests / 262 files; 9 existing optional tests skipped. Includes the separate Office cohort of 8 tests. Final log: `/tmp/editor-animation-final-units.log`.                                                                                                                |
| Tooling / file policy      | PASS: 90 tooling tests; 2,320 files within policy. Logs: `/tmp/editor-animation-tooling.log`, `/tmp/editor-animation-final-files.log`.                                                                                                                                               |
| Connection production E2E  | PASS: 3 scenarios × desktop/mobile = 6 distinct cases, no retries; console/page errors remain failures. Final log: `/tmp/editor-animation-confirmed-browser.log`; traces/screenshots: `/tmp/editor-animation-confirmed-results/`.                                                    |
| Existing production E2E    | PASS: 4 cases covering independent public surfaces/read-only (QA-18), existing seven surfaces at 390/768 px (QA-17), and Design/component/auto-layout/frame PNG (H2). Log: `/tmp/editor-animation-regressions.log`; artifacts: `/tmp/editor-animation-regression-results/`.          |
| Local public snapshot      | PASS at application source above: export 1,868 files, manifest/residual check 1,869 files, snapshot `49381450108d9eb2cabfe42992f563530ed74633f81bf8e9281aa2ddca885a4c`. Logs: `/tmp/editor-animation-public-export.log`, `/tmp/editor-animation-public-check.log`. Local check only. |

Connection scenarios exercise ordinary creation, base/keyframe edits, common
Undo/Redo, invalid and synthetic composing buffers blocking save, save/reload,
restore, version/hash preservation, actual native export/import and rejection
without partial artifact creation. The separate production Host imports the
ordinary Host's exported native bytes, uses the same public Surface/Player,
checks read-only and compares a fixed-tick scene. The mobile viewport is 390×844.

The Slide scenario retains source v1 while v2 changes, explicitly previews/adopts
v2, checks Undo/Redo and unchanged bounds, navigates back to the same object,
saves/reloads, compares presentation with the evaluator at tick 240,000, checks
reduced motion, and imports into a fresh browser context with no source catalog.
Unsupported template/reuse controls are unavailable. Unit checks additionally
cover stale/rejected/read-only controller commands, post-disposal refusal, owned
snapshots, corrupt contracts/hash/ticks, count limits, copy identity and hard
refusal by shared/template/PPTX/static SVG paths. Screen captures of the ordinary,
independent and Slide mobile views were inspected. Repeat runs of a scenario are
not additional distinct cases.

Reproduction commands (production files must be built first):

```sh
npm ci --cache /tmp/editor-animation-npm-cache
npm run lint
npm run typecheck
npm test
npm run build
npm run test:tooling
npm run check:files
E2E_SUITE=animation-connection npx playwright test --output /tmp/editor-animation-confirmed-results
E2E_SUITE=production npx playwright test tests/e2e/issue2-embedding.spec.ts tests/e2e/issue2-mobile.spec.ts tests/e2e/issue2-canvas.spec.ts --grep 'QA-18|QA-17|H2 design' --workers 1 --output /tmp/editor-animation-regression-results
```

Failures retained outside Git: the first install could not write the default npm
cache (`/tmp/editor-animation-install.log`); the temporary cache install passed.
Early strict checks found integration/fixture union narrowing and a lint error;
these were corrected before the final checks. The first browser run had 4 PASS /
2 FAIL because the independent Host requested a missing favicon; its explicit
data favicon fixed the actual console error. The final guard repeat then had
1 PASS / 1 FAIL because an immediate `isVisible()` after reload took the mobile
menu path before desktop rendering completed. The helper now awaits either the
requested tool or its overflow menu. The full final six-case run passed without
changing the timeout, retries or error assertions. Earlier logs/artifacts remain
under `/tmp/editor-animation-browser.log`,
`/tmp/editor-animation-connection-results/`,
`/tmp/editor-animation-final-guard-browser.log` and
`/tmp/editor-animation-final-guard-results/`.

NOT RUN: the entire browser suite, Firefox/WebKit, physical mobile devices,
native OS IME, a new performance gate or the full #74 acceptance matrix. Synthetic
composition events and viewport emulation do not certify those environments.
Text/image/path/mask/nested compositions, Design conversion, public inputs,
registered React UI runtime/export, shared editing and animation-preserving
external formats remain unsupported. Their positive acceptance scenarios are
N/A for this declared subset; rejection checks do not certify implementation.
No performance measurement, Actions dispatch, public synchronization or deployment
was performed.

## PR #287 review corrections: 2026-10-18 UTC

Corrections are in `bb50a3717c95a1bf4c8e26841ca9895bb92f10c6` and
`2a0efba341d89e916e397c85f7ffe3e720d1075f`:

- `placeSlideAnimation`, `replaceSlideAnimation` and `SlideAnimationSource` now
  live in the pure Slide model and are public through
  `@editor-platform/slide/model`. The React module owns dialogs and presentation
  only. A real Node bundle test follows that public entrypoint and rejects React,
  React DOM, UI packages, TSX and CSS dependencies; domain command tests use the
  same public entrypoint.
- While ordinary Animation inputs are dirty or composing, common desktop/mobile
  Undo/Redo buttons are disabled. The common Host history function also checks the
  current input snapshot, protecting shortcuts and history-context callers. Users
  apply or cancel inputs before native history moves; valid, invalid and synthetic
  composing drafts remain usable without a stale revision.
- Candidate errors remain beside the source selector. An invalid first source
  cannot be placed, but another valid source can be previewed and placed without
  closing the dialog. Changing candidates clears an earlier apply error and keeps
  the exact source key.
- Viewer range controls consume their adjustment keys. Escape bubbles to Slide,
  and page-navigation keys on the Play button reach the presentation. A background
  overflow menu closes without consuming Escape or stealing focus from outside
  its own controls; Escape inside that menu still restores focus to its trigger.

The first review browser run was **11 PASS / 1 FAIL**: the mobile range Escape
exposed the background menu's capture listener. The listener was corrected;
the scenario and browser-error gates were retained. Log/artifacts:
`/tmp/editor-animation-review-browser.log`,
`/tmp/editor-animation-review-results/`. An early tooling-test lint failure
(`process` without an explicit Node import) was corrected; no lint rule was relaxed.
The full unit suite at `bb50a371` passed **2,663 / 262 files, 9 optional skips**
(`/tmp/editor-animation-review-full-units.log`); the later menu change is a UI event
boundary covered by the final production browser scenarios.

At `2a0efba3`, full lint and all four strict production build targets passed
(`/tmp/editor-animation-review-menu-lint.log`,
`/tmp/editor-animation-review-menu-build.log`). The final connection run passed
**12 cases**: the original three plus three review scenarios, each at desktop and
390×844 mobile. The new cases cover valid/invalid/composing history guards,
switching invalid → valid → invalid → valid candidates and placing the correct
saved hash, range key isolation, page navigation from Play, Escape after slider
and Play interaction, and menu focus restoration. No retries, timeout increases or
weakened browser-error assertions were used. Log/artifacts:
`/tmp/editor-animation-review-final-browser.log`,
`/tmp/editor-animation-review-final-results/`. The invalid-candidate desktop/mobile
screenshots were inspected.

The same production source also passed the **4 existing regression cases**
(QA-18, QA-17 at 390/768 px, H2 Design PNG) after the menu change. Log/artifacts:
`/tmp/editor-animation-review-regressions.log`,
`/tmp/editor-animation-review-regression-results/`. This is 16 distinct browser
cases in the final review gate; earlier attempts are not added to that count.

Tooling passed **91 tests**, including the new headless model bundle gate
(`/tmp/editor-animation-review-tooling.log`); that gate was also rerun after the
explicit Node import fix (`/tmp/editor-animation-review-headless.log`). File policy
passed **2,321 files** (`/tmp/editor-animation-review-files.log`). Third-party
dependencies, lockfile, supported capabilities and the NOT RUN environments above
are unchanged.

## Additional scoped review: 2026-10-18 JST

Source `11626d470abc35bf6ffa213b79e20dedd0980525` addresses the six additional
connection findings:

- The local session determines its Animation domain at construction. Subsequent
  commands validate Animation output only for that domain. A deterministic unit
  check verifies that Document/Slide/Design/Whiteboard commands do not invoke the
  Animation reader and that Animation output still rejects another domain. This
  fixes an added traversal; no performance measurements or budgets were added.
- Both the Library sidebar action and the reusable-library render boundary use
  `nativeReuseSupported` for animation-bearing decks. Animation artifacts also
  hide the unavailable Comments action. Annotation UI is outside this connection
  subset; this does not remove annotation bytes retained in native artifacts.
- `SlideSurface.animationSources === undefined` means the Host has no Animation
  lifecycle integration: placement and saved-version selection are unavailable.
  An explicitly empty array declares integration with no saved versions and keeps
  the empty-catalog explanation. Ordinary local Playground declares the catalog;
  its shared session and existing independent Slide Hosts do not.
- `VisualInspector.imageEditing` defaults to true. Slide disables image-only
  fields for any selection containing Animation, including mixed image/Animation
  selections. The poster remains a rendering primitive; label, poster time and
  playback settings belong to the Animation inspector, and geometry remains a
  Slide edit. Ordinary image controls remain available for image-only selections.
- The public local `AnimationSurface` takes `AnimationContentV1`, its matching
  `EditorSession<AnimationContentV1>` and v1 commands. The facade validates command
  output before forwarding it to the Host. Strict type assertions reject a
  prototype/union session; a runtime test verifies refusal without content,
  revision or history changes. The prototype/controlled experiments keep their
  separate contracts.

An initial new unit assertion incorrectly required identity from the session's
copying `content` getter. It was corrected to compare content and unchanged
revision/history; the focused rerun passed 5 tests across 3 files. Logs:
`/tmp/editor-animation-scope-focused.log`,
`/tmp/editor-animation-scope-focused-final.log`.

At this source, full lint and all four strict production build targets passed
(`/tmp/editor-animation-scope-lint.log`, `/tmp/editor-animation-scope-build.log`).
The full unit suite passed **2,665 tests / 262 files, 9 optional skips**
(`/tmp/editor-animation-scope-units.log`). The public model's headless bundle gate
and file policy also passed (**2,321 files**; logs
`/tmp/editor-animation-scope-headless.log`, `/tmp/editor-animation-scope-files.log`).

The first browser run was **15 PASS / 1 FAIL**: after inspecting the Library
sidebar, the desktop test left its drawer open and its backdrop correctly blocked
the next export-menu click. Test-only commit
`4bfe027615302570cdef37ef10f48ac3a61113ff` closes the drawer in both viewports and
awaits its hidden state before continuing. The application source above is
unchanged. The failure screenshot/trace were inspected; raw evidence remains at
`/tmp/editor-animation-scope-browser.log` and `/tmp/editor-animation-scope-results/`.

The complete final connection run passed **16 desktop/mobile cases** (8 scenarios
in each viewport) without retries or changed timeouts/error gates. The added
coverage checks the hidden Comments/reuse-library actions, independent Host
capability absence versus an explicitly empty local catalog, Animation geometry
without image controls, ordinary image alt/fit/replace/crop controls, and mixed
image/Animation selection without image-only patches. Retained Animation bytes
remain equal after placement resizing and image edits. Log/artifacts:
`/tmp/editor-animation-scope-final-browser.log`,
`/tmp/editor-animation-scope-final-results/`.

The existing **4 production regressions** also passed (QA-18, QA-17 at 390/768 px,
H2 Design PNG), giving **20 distinct browser cases** in this final gate. Log and
artifacts: `/tmp/editor-animation-scope-final-regressions.log`,
`/tmp/editor-animation-scope-final-regression-results/`. The additional findings
were all connection regressions within the declared subset; no #74 capability was
added and the unsupported/NOT RUN scope above still applies.

## Further scoped review

Application source `828c2c924eace02877b54c937d44c5c15a7b7808` addresses the next
four connection findings:

- Ordinary Animation's intentional read-only toggle flushes valid inputs before
  changing editability and refuses invalid/composing inputs. The checkbox intent
  is captured before synchronous commits in both local reference Hosts. Artifact
  switching then sees a committed value or a still-registered pending input.
- Generic `makeSlideObject` / `insertObject` take `SlideInsertType`, excluding
  Animation. They reject untyped Animation calls and discriminant/source patches;
  `placeSlideAnimation` remains the dedicated complete retained-source command.
  Type and direct-session tests verify refusal without revision/history changes.
- PPTX refusal forwards the validated export basis. Local draft, confirmed
  revision and saved-version identity/hash remain in the blocking report, with
  distinct plan hashes. Refusal cannot be waived as export consent.
- The SVG-only artifact Host admits static Slide decks only, validates all
  retained versions, guards direct SVG export and uses the same gate for saved
  previews. Animation on the first page, a later page or only in a past version is
  rejected by that Host. Ordinary Playground's retained playback remains the
  supported consumer; this does not add animated/static-loss export capabilities.

Full lint, strict four-target production builds, the headless model bundle gate
and file policy passed (2,321 files). Full units passed **2,667 / 262 files, with
9 optional skips**. Logs: `/tmp/editor-animation-round3-lint.log`,
`/tmp/editor-animation-round3-build-final.log`,
`/tmp/editor-animation-round3-headless.log`,
`/tmp/editor-animation-round3-files.log`, `/tmp/editor-animation-round3-units.log`.
An early type-check caught a new test omitting the export adapter's AbortSignal;
the test now passes that required argument.

The first browser attempt was **18 PASS / 2 FAIL**. The new read-only scenario
assumed selection persisted across arbitrary artifact switches, but reopening
selects the root group. Test commit `e4edca6d0bc0bddf2eba87a95d8a1c993833c13e`
selects the original rectangle by its stable ID before checking its preserved
value. Application source and the value assertion are unchanged. The SVG-only
Host's refusal screenshot was inspected. Earlier evidence:
`/tmp/editor-animation-round3-browser.log`, `/tmp/editor-animation-round3-results/`.

The final connection run passed **20 desktop/mobile cases** (10 scenarios per
viewport), including valid read-only flush/switch/return, invalid and composing
transition refusal, and native imports of actual saved animated decks into the
separate production SVG-only Host. That Host keeps its artifact list and then
accepts static saved decks with SVG previews after each refusal. Existing browser
error gates, retries and timeouts are unchanged. Log/artifacts:
`/tmp/editor-animation-round3-final-browser.log`,
`/tmp/editor-animation-round3-final-results/`.

The existing four production regressions also passed (QA-18, QA-17 at 390/768 px,
H2 Design PNG), for **24 distinct cases** in the final browser gate. Log/artifacts:
`/tmp/editor-animation-round3-final-regressions.log`,
`/tmp/editor-animation-round3-final-regression-results/`. Supported capabilities,
dependency versions, and the NOT RUN environments above are unchanged.

## Placement and Compare review

At application/test source `172d401d5921d3ebbb639e40f97f0f5718a54985`, the three
additional scoped findings are addressed:

- Slide uses the same retained-reuse predicate in native validation, the placement
  command and the toolbar. A local deck with an instance, closure or artifact mode
  shows a disabled placement button and its reason before opening a picker.
  Empty reuse envelopes remain supported; this does not add mixed reuse/Animation.
- Playground checks v1 schema/timebase at the top level before entering the full
  Animation reader. The render-time projection and other classification callers
  no longer clone/traverse unrelated native domains as Animation. A reader-spy
  regression covers every ordinary non-Animation kind and still requires full
  validation for valid and malformed Animation candidates. This is a deterministic
  call-boundary check, not a performance measurement or acceptance claim.
- Slide Compare describes the retained source artifact/version/full content hash,
  composition, label, poster tick, fit, trigger, loop and evaluator/player/format
  contracts. Model cases distinguish pin, later-motion, poster and playback edits
  while checking equal poster output where applicable. The new browser scenario
  imports two real saved Animation versions with identical posters, explicitly
  adopts the later version, changes playback settings, saves both destination
  versions and checks their ordinary Compare view and immutable earlier bytes.

The initial strict check caught a new browser fixture omitting the static-object
factory's required index. That fixture was corrected before the final source pin;
the failure remains in `/tmp/editor-animation-round4-types.log`.

At that source, full lint and strict four-target production build passed. Full
units passed **2,670 / 262 files, with 9 optional skips** (2,662 plus the separate
eight-case Office corpus); tooling passed **91**, including the headless Slide
model boundary, and file policy passed **2,321 files**. Logs:
`/tmp/editor-animation-round4-lint.log`, `/tmp/editor-animation-round4-build.log`,
`/tmp/editor-animation-round4-units.log`, `/tmp/editor-animation-round4-tooling.log`,
`/tmp/editor-animation-round4-files.log`.

Production Chromium connection checks passed **24 desktop/mobile cases** (12 per
viewport), including the three real reuse-state variants and same-poster Compare.
Both new scenarios' desktop/mobile screenshots were inspected. Browser error
gates, timeouts and retry settings were unchanged. Log/artifacts:
`/tmp/editor-animation-round4-browser.log`, `/tmp/editor-animation-round4-results/`.

The four existing production regressions also passed (QA-18, QA-17 at 390/768 px,
H2 Design PNG), for **28 distinct cases** in this final browser gate. Log/artifacts:
`/tmp/editor-animation-round4-regressions.log`,
`/tmp/editor-animation-round4-regression-results/`. Supported capability limits,
dependency versions and the NOT RUN environments above remain unchanged.

## Generic updates and independent Host review: 2026-10-19 JST

At application/test source `f050f924`, the two additional findings are corrected:

- `updateObject` excludes `type` and `animation` from its public patch type and
  rejects either key at execution. The adjacent multi-object `patchObjects` path
  has the same protection, using the same guard as generic insertion. Plain
  EditorSession regressions cover static and Animation targets, complete valid
  embeds, discriminant conversion and explicit undefined; failures preserve
  content, revision and Undo. Geometry/style edits still work and Undo preserves
  the retained embed. Playback settings continue through `replaceSlideAnimation`.
- The independent Host reads native contents, retained version hashes and the
  prospective Player embed before installing imported state. Imports without
  saved versions also check whether the first saved Player could be constructed.
  Save checks the new saved embed before installing/persisting it. Permission and
  revision checks remain after asynchronous import preparation. A refusal uses
  the existing error UI and keeps the previous artifact/session usable.

The initial focused model run passed **9 tests / 2 files**. New Host tests cover the exact
200-character metadata boundary, empty/whitespace/oversized labels, invalid source
IDs, unsaved imports and retained native/hash/domain checks. The initial strict
check identified generic inference in `patchVisualStyle` after narrowing the
patch; specifying its preserved `SlideObject` result type corrected it. That
failure remains in `/tmp/editor-animation-round5-types.log`.

At `f050f924`, full lint, strict four-target production builds, tooling **91**
(including the headless Slide model gate) and file policy **2,323 files** passed.
Full units passed **2,675 / 263 files, with 9 optional skips** (2,667 plus the
separate eight-case Office corpus). Logs: `/tmp/editor-animation-round5-lint.log`,
`/tmp/editor-animation-round5-build.log`, `/tmp/editor-animation-round5-tooling.log`,
`/tmp/editor-animation-round5-files.log`, `/tmp/editor-animation-round5-units.log`.

The first connection browser run was **25 PASS / 1 FAIL**. The new mobile metadata
test stopped waiting for its eleventh rapid native export's download event after
ten successful downloads; the trace and failure screenshot show the editor still
usable and no import error left after reimport. Test-only commit `1b2dc580` separates
the eight metadata inputs into independent cases. Each case keeps its native artifact
comparisons after refusal and valid reimport, storage checks, bad saved reload,
recovery edit/save and Player assertion, with five real downloads per case. The
application, browser permissions, error gates, retries and timeouts are unchanged.
Failure evidence: `/tmp/editor-animation-round5-browser.log`,
`/tmp/editor-animation-round5-results/`.

The test-only source also passed strict typecheck and lint for the changed spec:
`/tmp/editor-animation-round5-final-types.log`,
`/tmp/editor-animation-round5-final-test-lint.log`. Production application builds
remain the unchanged `f050f924` builds above.

The final production Chromium connection run passed **40 desktop/mobile cases**
(20 per viewport: the existing 12 scenarios and eight isolated metadata inputs).
Every metadata case retains actual native export equality after rejection and
valid reimport, saved storage, saved-reload refusal/recovery, editing, a second
save with the earlier version unchanged and saved Player rendering. The refusal
UI and preserved editor were inspected in desktop/mobile screenshots. Logs/artifacts:
`/tmp/editor-animation-round5-final-browser.log`,
`/tmp/editor-animation-round5-final-results/`.

The four existing production regressions also passed (QA-18, QA-17 at 390/768 px,
H2 Design PNG), giving **44 distinct cases** in the final browser gate. Logs/artifacts:
`/tmp/editor-animation-round5-final-regressions.log`,
`/tmp/editor-animation-round5-final-regression-results/`. Earlier attempts are not
additional cases. Supported capability limits, dependencies and the NOT RUN
environments above remain unchanged.

## Integration with current main: 2026-10-19 JST

Locally verified merge `8530623f` integrates actual main `076d0159` (PR #292) with Animation
head `673b1d3e`. The two content conflicts were the introductory additions in
README and status; both the Animation and Design Host records are retained.
The shared UI auto-merge retains Animation's target-aware Escape handling and
main's configurable compact toolbar threshold. No manual application changes
were needed for the merge.

The CLI push could not authenticate. The connected GitHub API published the same
merge as `c3477a78cbdabd1a0a2d3b0b15bd32f277100f02`, preserving both parents and
the exact tested tree `1be94caf45ac7ec64986c742271200bcb408e314`. Tree equality is
checked before advancing the PR branch; the publication changes commit metadata,
not the verified application or tests.

The earlier no-conflict check used the PR API's stale base SHA `6061cd44`.
Fetching the live main branch exposed the five incoming commits and the two
actual conflicts. Merge verification now uses the fetched branch ref and checks
the current remote main ref before reporting GitHub mergeability.

At `8530623f`, full lint, strict four-target production builds, tooling **91**
(including the headless Slide model boundary), and file policy **2,328 files**
passed. Full units passed **2,678 / 263 files, with 9 optional skips** (2,670 plus
the separate eight-case Office corpus). Logs:
`/tmp/editor-animation-merge-main-lint.log`, `/tmp/editor-animation-merge-main-build.log`,
`/tmp/editor-animation-merge-main-tooling.log`, `/tmp/editor-animation-merge-main-files.log`,
`/tmp/editor-animation-merge-main-units.log`.

Production Design Host, token/style and legacy regressions passed **18 cases**:
ten desktop/mobile Host integration cases, four ordinary token/style cases and
the existing QA-18 / QA-17 at 390/768 px / H2 Design PNG cases. The configurable
toolbar's desktop/mobile screenshots were inspected. Log/artifacts:
`/tmp/editor-animation-merge-main-host-browser.log`,
`/tmp/editor-animation-merge-main-host-results/`.

The production Animation connection run also passed **40 desktop/mobile cases**,
including Slide playback and Escape controls after the shared UI merge, for
**58 distinct browser cases** in this integration gate. Log/artifacts:
`/tmp/editor-animation-merge-main-browser.log`, `/tmp/editor-animation-merge-main-results/`.
There were no failing verification attempts after the conflicts were resolved.
Browser error gates, timeouts and retries, dependency versions, capability limits
and the NOT RUN environments above remain unchanged.

## PR #287 boundary review corrections: 2026-10-18 UTC

Implementation `b979f053` and test-only corrections `71af27cc` / `856c1f13` address
the four remaining review findings. The connected GitHub API published the same
source/test tree as `6714759e81a9784d922dfd72450ad2cfd8fd2f17`; its tree
`50d5eda36d356fb861f7213f5f48866fd32cad31` exactly matches local `856c1f13`.

- Public `pasteObjects`, duplicate arrangement and `duplicateSlide` validate the
  resulting Animation-bearing deck before returning a command result. Headless
  plain-session tests cover the 16-object and 8 MiB aggregate limits, reuse
  collisions, malformed hashes and contradictory pins for the same source version.
  Rejection preserves native content, revision and Undo; supported copies retain
  exact source snapshots with new object IDs and reversible Undo/Redo.
- Independent Host import rechecks the current input coordinator after asynchronous
  preparation, alongside the existing session/revision/permission checks. Newly
  dirty or composing inputs refuse the import without replacing the Surface.
  Browser tests pause actual WebCrypto hashing, enter valid Base, invalid Key and
  synthetic IME Key input, then release the hash. They check refusal, exact private
  input and saved-storage preservation, Apply/save recovery, immutable earlier
  versions and a subsequent successful import of the other artifact.
- Shared admission checks the current draft and every retained version, both in
  the menu and before credentials/network access in `connect`. A static draft
  with an older animated version keeps both local history entries and sends no
  session-creation request. A static-only saved deck still opens collaboratively
  and retains its content and saved version, including import ID remapping.
- Source navigation requires an admitted local session and no load error. A source
  rejected at startup for a bad version hash shows the existing missing-source
  explanation; the destination, selection and retained Player remain usable.
  The broken source's stored bytes are retained for recovery.

At implementation `b979f053`, full lint, strict four-target production builds,
tooling **91** and file policy **2,328 files** passed. Full units passed
**2,682 / 263 files, with 9 optional skips** (2,674 plus the separate eight-case
Office corpus). Logs: `/tmp/editor-animation-round6-final-lint.log`,
`/tmp/editor-animation-round6-final-build.log`, `/tmp/editor-animation-round6-tooling.log`,
`/tmp/editor-animation-round6-files.log`, `/tmp/editor-animation-round6-units.log`.
The final test-only source also passes strict typecheck and spec lint:
`/tmp/editor-animation-round6-history-types.log`,
`/tmp/editor-animation-round6-history-test-lint.log`. The production applications
are unchanged by those two test-only commits.

The final production Chromium connection gate covers **50 distinct desktop/mobile
cases**: **48 PASS** in the full run at `71af27cc`, plus the corrected history
scenario's **2 PASS** at `856c1f13`. This includes all 40 earlier cases and the ten
new cases; earlier attempts are not additional cases. Desktop/mobile input refusal,
source refusal and retained-history screenshots were inspected. Logs/artifacts:
`/tmp/editor-animation-round6-final-browser.log`,
`/tmp/editor-animation-round6-final-results/`,
`/tmp/editor-animation-round6-history-browser.log`,
`/tmp/editor-animation-round6-history-results/`.

Production shared Slide regression EI-Q02/Q09/Q12 (independent peers, proposal,
Undo, save and export) and the four existing QA-18 / QA-17 at 390/768 px / H2
Design PNG regressions also passed, for **55 distinct browser cases** in this
review gate. Log/artifacts: `/tmp/editor-animation-round6-regressions.log`,
`/tmp/editor-animation-round6-regression-results/`.

Earlier failed attempts are retained. The first targeted units had three test
harness failures (identity comparison of a caller-owned session snapshot and a
missing explicit object ID); strict checks also exposed over-specific helper
typing and Playwright's recursive serialization type. After correction, the new
large-snapshot unit exceeded its initial five-second default; it now has its own
30-second execution limit for the real near-8 MiB fixture. Other test timeouts
and browser retries/error gates are unchanged. Evidence:
`/tmp/editor-animation-round6-target-units.log`,
`/tmp/editor-animation-round6-types.log`, `/tmp/editor-animation-round6-build.log`,
`/tmp/editor-animation-round6-final-target-units.log`.

The first browser attempt was **8 PASS / 2 FAIL** because the new history test
expected an imported artifact to keep its original ID/provenance. `71af27cc`
checks the actual import remapping while preserving exact draft/history bytes.
The full run then had **48 PASS / 2 FAIL** because that test looked for the history
menu tab after its helper had closed the menu. `856c1f13` checks the visible history
heading and both retained entries instead. The targeted two-case rerun passes,
including the later real static-only shared connection. Failure screenshots and
trace were inspected and retained in `/tmp/editor-animation-round6-new-results/`
and `/tmp/editor-animation-round6-final-results/`; first log:
`/tmp/editor-animation-round6-new-browser.log`. Neither correction changes an
application, relaxes a browser error check or raises a browser timeout.

The first Git Data tree upload was rejected by automatic review because destination
ownership/export authority had not been established. Read-only checks confirmed
authenticated user `ryo0221` owns the explicitly requested private repository,
has admin/push permission, and PR #287's head belongs to that same repository.
The identical-destination retry was approved and its tree equality checked.
The capability limits and NOT RUN environments above remain unchanged.

The later documentation upload of README, status and this guide was initially
blocked: automatic review rejected sending the complete three-file payload without
explicit permission, including a retry after GitHub's existing blob IDs matched
the local baseline. The owner then explicitly authorized adding those three files
to the existing PR; this documentation update follows that approval. Source/test commit `6714759e` is
published, all four findings have replies and are resolved, and its own local-only
public snapshot passes manifest/residual checks for **1,875 files**. Evidence:
`/tmp/editor-animation-round6-published-public.log`,
`/tmp/editor-animation-round6-published-snapshot/`. No alternate upload route was
attempted during the block.

## PR #287 target and durable-history corrections: 2026-10-19 JST

Local implementation/test commit `d78ef1c6` addresses four review threads (two
reported the same image-patch defect). Its identical published source/test tree is
`82c4ca25e88d5cbc7d0ed1e45e135592800965a4`, tree
`3e3ed27d0764ac76f129e1d8326bc374a8b98c5a`.

- `updateObject` and `patchObjects` reject image source, crop, retained reference
  and non-`fit` image settings when the selected target is Animation. Plain-session
  tests cover each field through single and mixed selection, preserving content,
  revision and an existing Redo branch on rejection. Image-only edits, Animation
  geometry/style edits, clearing optional fields and Undo/Redo remain supported.
  The check reads those small properties without traversing retained snapshots.
- Independent Host save writes native JSON to localStorage before installing the
  new artifact/ref. Injected `QuotaExceededError` and `SecurityError` cover first
  and later saves on desktop/mobile. Failed first saves leave zero versions and
  no saved Player; failed later saves retain the previous stored version/Player
  while keeping the newer draft. The actual saved Player still renders x=175
  after the failed x=275 save. Recovery appends exactly one version with the
  correct parent, preserves the first version and roundtrips through saved reload.
- Import/reload now uses public `loadHostArtifact` with the v1 domain adapter.
  This reuses the shared envelope, metadata, retained-identity, parent-cycle,
  draft-base, all-version hash and 16 MiB native-file checks. Saved/prospective
  Player metadata checks remain after native admission. The only dependency/lock
  change is the existing workspace `@editor-platform/editor-host: *`; no external
  package version changes or duplicate history validator were added.
  Nine negative unit cases cover duplicate/blank IDs, missing parent/base fields,
  missing retained targets and self/two-version cycles. Valid unsaved, branching,
  reordered and restored-base histories retain their bytes and parent semantics.
  Five new browser history inputs also exercise failed import and saved reload,
  native/storage equality, valid reimport and editing/save/Player recovery.

At `d78ef1c6`, strict typecheck, full lint, all four production builds, tooling
**91** and file policy **2,328 files** passed. Focused units passed **23**, and
full units passed **2,693 / 263 files, with 9 optional skips** (2,685 plus the
separate eight-case Office corpus). Logs:
`/tmp/editor-animation-round7-target-units.log`, `/tmp/editor-animation-round7-types.log`,
`/tmp/editor-animation-round7-lint.log`, `/tmp/editor-animation-round7-build.log`,
`/tmp/editor-animation-round7-tooling.log`, `/tmp/editor-animation-round7-files.log`,
`/tmp/editor-animation-round7-units.log`.

Production Chromium connection checks passed **64 desktop/mobile cases** in one
run, with no retries. This includes the previous 50 cases, ten new malformed-history
cases and four new storage-failure cases. Existing metadata tests now check their
own bad saved input on reload as well as import; empty native IDs report the common
Host refusal. All retain exact native/storage checks and recovery assertions.
Desktop/mobile storage-failure and missing-base screenshots were inspected.
Log/artifacts: `/tmp/editor-animation-round7-browser.log`,
`/tmp/editor-animation-round7-results/`. There were no failing verification
attempts in this round. Existing browser error gates, timeouts and retries,
capability limits, paused work and NOT RUN environments above remain unchanged.

The four existing production regressions (QA-18 independent embeds, QA-17 at
390/768 px, H2 Design PNG) also passed, for **68 distinct browser cases** in this
round. Log/artifacts: `/tmp/editor-animation-round7-regressions.log`,
`/tmp/editor-animation-round7-regression-results/`.

## Using the connection

1. Library の Editor を **Animation** にして作成する。**Add rectangle**、Base transform、
   **Apply inputs**、**Add key at playhead**、Key value/easing で編集する。Undo/Redo と
   **Save version** は通常の上部ツールバーを使う。再生・seek は内容や履歴を変更しない。
2. 版を保存してから Slide を作り、**アニメーションを配置** で保存版と composition の
   プレビューを確認して配置する。狭い画面では **More editor tools** から開く。
3. 選択した object の Inspector で preview、poster tick、再生開始、loop を編集する。
   **元の Animation を開く** → 編集・版保存 → **埋め込み先に戻る** で同じ選択へ戻れる。
   **保存した別の版を選ぶ** から明示採用するまで、Slide の保持版は変わらない。
4. Slide の版を比較すると、ポスターに加えて元 artifact・version・hash・composition、
   poster tick、再生開始・loop と保持契約が表示される。ポスターが同じ版でも動作の差を
   source hash や設定で確認できる。

The existing Slide envelope remains readable; the new explicit `animation` object
type is recognized by the updated reader. Older readers reject an unknown object
type rather than interpreting it as an image. Animation prototype sources are not
implicitly admitted or migrated. The consumer pin is independent of DefinitionRef
and ReuseInstance. Integrity hashes do not establish source authorization.

The public APIs are `createRectangleAnimation`, `createAnimationEmbed`,
`inspectAnimationEmbed`, and `prepareRectangleAnimationV1Sync` in animation-core;
`rectangleAnimationPoster` in animation-player/poster; `AnimationSurface` in
animation/local and `AnimationViewer` in animation/viewer; and
`placeSlideAnimation` / `replaceSlideAnimation` in Slide. The synchronous prepared
token uses the same bounded v1 validator, canonical SHA-256 and evaluator as async
preparation. It is process-local and never stored in native JSON.

The local Surface receives the caller's session, inputs, permission and execution
callbacks. The caller must keep these bound to the same artifact, reject read-only
commands and validate domain output. The normal Host and independent reference Host
do so. Player acquisition/abort/disposal belongs to the adapter. The independent
Host is a localStorage reference, not authenticated or server-durable storage.

Reuse-bearing decks cannot also acquire Animation objects in this gate. Placement is
disabled with a visible reason for retained instances, closures or artifact mode;
an empty reuse envelope still permits placement. The command enforces the same rule.
Static
SVG/PNG/PDF export of animated pages and PPTX of animation-bearing decks refuse;
native JSON retains motion. The ordinary Host's existing **16 MB import limit**
also applies to the complete artifact and all saved versions; per-snapshot limits
do not promise roundtrip for arbitrarily large histories. No GIF/video export or
implicit static-loss consent is provided.
