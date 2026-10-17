# Video metadata timeline: domain handoff only

Base #118 HEAD `bc89c7030064c73481f187acdc074c0488b497a8`, public type pin
`c5c833d6a634530372fbd2d9928934b9cbce9944`. Exact protocol
`1.0.0-experiment.schema-edit.1`; old readonly entry/token and native v0 unchanged.
No schema-edit runtime implementation is supplied by this domain change.

## Shared-owner wiring required

Add public package subpath `./edit` -> `./src/edit.ts` in video-metadata's manifest
under #76 ownership; packaging/declaration/lock and both installed Hosts remain there.
Runtime imports use video-core, extension-contract and artifact-core public entries.
#76 MUST add `"@editor-platform/artifact-core": "*"` as a direct dependency in
video-metadata package.json and update the workspace lock entry as necessary, alongside
the public edit export. This existing workspace dependency supplies canonicalJson;
root workspace resolution is not proof of installed-package dependency closure.
Do not ship the edit entry until this wiring is complete. No external dependency is
introduced. Test-only ports additionally use existing public editor-core. Do not export or install the test Host as a runtime.

Public domain entry exports:

- `videoTimelineExtension(packageHash, {createController, onError, mounted?})` returns
  `SchemaEditDefinition<VideoContent>`. Inject the actual SchemaEditControllerFactory;
  no cast into draft.2 and no default local-session/controller fallback.
- `prepareVideoTimelineEdit(snapshot, edit)` validates the real Core command's result
  and yields a prepared command or null for a validated canonical no-op.
- `submitVideoTimelineEdit(editor, snapshot, edit)` is the shared UI/non-UI submission
  helper. The controller owns authoritative revision/grant/input checks.
- `videoTimelineFixture(lockedAudio?)` returns structurally valid synthetic metadata,
  with actual v0 sources/streams/windows. Declared IDs/hash/length are fixture data,
  not proof of acquired or probed media. 25fps/48kHz is the tested timing combination.

Surface owns only its DOM, selection, frame cursor and one aggregate independent-trim
input group. It never owns a Session/history, media resources or storage. Numeric trim
fields use exact rational seconds; split uses an integer sequence frame. Move/split/
delete use linked cohorts and Core-supplied source semantics. Split allocates collision-
checked right IDs/group from current native identifiers. Tracks are fixed, with locked
fixtures for refusal; no new track command. Pending/invalid/composing/stale input stays
private until accepted, and selection changes require Apply/Cancel. No-op returns null
so the shared controller can preserve revision/Redo.

Save delegates to controller.save and displays the exact captured revision/hash and
committed receipt or aborted-before-write/indeterminate outcome. Reopening acknowledged
native JSON is Host-owned; there is no invented Surface reopen/storage API. Reopening
starts a new Core session, not persisted Undo history. Scope retirement removes only
owned DOM and ignores late save display; controller/runtime owns save coordination.

## Exact domain evidence

Code tested `dc3db2f318141274a49839c8c88abf84f1b43799`, clean tree. PASS102 tests:
54 existing Video Core/media +21 existing readonly metadata +27 new edit tests.
New tests include26 actual Chromium cases (13 scenarios at1280/390px), minified
browser bundle, valid fixture/source preservation, UI and non-UI command execution,
linked move/split/right IDs/group/delete, independent trim, Undo/Redo, no-op Redo,
invalid/composing/stale input, locked/readonly/missing-Inputs refusal, captured-save
revision/hash, later edits preserving old capture, supplied receipt outcomes, native
JSON reopen into new session, late save after revoke and retired-button refusal.
Both screenshots inspected; no browser console/page errors or horizontal overflow.

Initial composition-handler property assignment failed both composition cases and
TypeScript; real composition listeners fixed it before this code pin. Temporary
harness global type alias errors were also fixed. Synthetic composition events do
not prove real IME/device acceptance.

The tests use one real Core EditorSession behind deliberately supplied TEST controller
and save ports. They verify domain consumption, not new admission/grant implementation,
shared SaveCoordinator exclusion, receipt durability or genuine two-Host integration.
The hash is computed with existing contentHash; no substitute native model is used.

Root typecheck/lint and file/diff checks PASS. Final root build result is reported in
PR evidence. Media decoding/export/byte storage, portable retention, Animation clips,
migration, resolver/retention, performance, full suite, other browsers/real touch/IME,
actual new runtime/packaging/installed Hosts remain NOT RUN. Codec #115 is not adopted.

Local logs `/tmp/video-timeline-final-*.log`, screenshots
`/tmp/video-timeline-{1280,390}.png`; generated evidence is not committed or uploaded.

## Review correction: property-order-independent no-op

Tested code `321c442a0e64389929f2a110d33edea1ef5ad62e`; following commit is
documentation only. Preparation compares existing artifact-core public canonicalJson
results instead of JSON.stringify. No native document normalization/write, Core or
shared API change. Reopened native JSON reverses every object property order, including
`{timescale, value}` rationals. After move/Undo seeds Redo at revision2, both non-UI
move(0) and UI unchanged Apply independent trim preserve revision, execution count,
content and Redo; actual Redo still applies the original one-frame move.

FAIL before fix: both added Chromium cases reproduced spurious revision advancement.
PASS after fix at the exact code pin:104 focused tests (54 Core/media +21 readonly
metadata +29 edit, including28 Chromium cases at1280/390px); root typecheck, lint,
both Vite builds, file policy and diff check. Logs `/tmp/video-canonical-*.log`.
NOT RUN: installed-package dependency closure until #76 adds the required direct
dependency/export wiring; real schema-edit runtime, shared SaveCoordinator, both
installed Hosts, full suite and media/performance acceptance remain outside this gate.
