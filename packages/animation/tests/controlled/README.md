Current Timeline/easing integration: scope and exact verification. The original handoff below is historical; the current #125 package already exports the controlled Surface.

# Controlled Animation domain handoff

Base #103 `221aefe9c517eb48fba23d026b17b7e3fffab392`; exact type pin
`e1d7990c9ef2305bbccb5cd1c054bf74c44c2603`. Uses the handed-off
`@editor-platform/animation/controlled-contract` and
`controlled-surface@0-experiment` facade without changes. #98 is not adopted.

Domain entry: `src/controlled.tsx` exports `AnimationControlledSurface(props)`.
The #76 owner must add the public `./controlled` export. This branch changes no
manifest, lock, shared controller/contract, ordinary Host, or standalone index.tsx.
No new dependencies. Native schema/time/easing meanings are unchanged.

Surface owns only selection/forms/UI state, one aggregate input group and the
presentation container. It never creates EditorSession/Player, stores content,
downloads JSON or disposes a Player. Adapter owns attachment's returned detach,
Player lifecycle and canonical mutation pause/capture. Surface subscribes through
controller and playback ports; scope change/revoke unmounts its presentation and
unregisters its group. Source content is rendered from the controller view.

Drafts retain a captured scope/revision and raw transform/key strings; object
identity refresh never clears them. Key tick/value merge into one track edit;
transform and track commands chain expected working snapshots and return one
transaction. Prepare never executes or clears dirty fields. Only committed clears
successful/no-op drafts automatically. Explicit Cancel discards private input;
it does not undo native content. IME, incomplete/invalid numbers, stale revision,
missing targets and duplicate/out-of-range ticks block preparation atomically.
Pure no-op returns null, preserving Redo. Playback/selection/composition changes,
Undo/Redo and unrelated commands are blocked while pending. Save forwards to Host,
which owns flush/capture/outcome handling. A valid no-op still receives committed.

This first #94-derived UI supports rectangle creation, layer/property/key selection,
base transform and selected-key edits, clean add/delete key, playback/seek and Host
Undo/Redo/save. Easing/drag from #98 are not included. No private history, storage
backend, product-specific feature or authenticated authority is added. Initial
missing edit/Inputs yields readonly fields and no input registration.

## Domain-only tests

`host.ts` is a test-only stub implementing the pinned interface with one actual
EditorSession and actual Core/Player. It is not the #76 runtime, registry, volatile
storage protocol conformance suite or independent third-party Host demonstration.
Two consumers, Host reopen/captured bytes, late acquisition/drain and full lifecycle
acceptance remain #76 integration work. Save outcome tests verify Surface display
of explicit stub results, not real persistence guarantees. Physical iOS not tested.

Build: `npx vite build --config packages/animation/tests/controlled/vite.config.ts`
Browser: `E2E_SUITE=animation-controlled npx playwright test`
Unit: `npx vitest run packages/animation/src/controlled-buffer.test.ts`

The dedicated `.controlled.ts` test suffix avoids the existing standalone suite's
recursive `*.spec.ts` discovery. Browser fixtures import the new module locally
only because public export wiring belongs to #76. Screenshots/output remain under
`/tmp/animation-controlled-results`; they are not user deliverables.

Initial test-only timeout came from filling a field with its unchanged value:
React correctly emitted no change and Apply remained disabled. The no-op test now
clears and retypes to establish an actual draft before applying. No production
behavior was changed to satisfy that test.

Exact final validation is recorded below after the implementation commit.

## Exact verification record

Tested implementation: `1affabcece5193cbf8a969f9bbf9de65cf686a4d`.

| Check                                                                 | Result                                                                              |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Lint / typecheck / file-size guard                                    | PASS                                                                                |
| Full unit suite                                                       | PASS, 1494 tests / 148 files                                                        |
| Tooling tests                                                         | PASS, 25                                                                            |
| Root normal and React preview production builds                       | PASS                                                                                |
| Controlled production fixture / standalone production fixture         | PASS                                                                                |
| Controlled browser flows                                              | PASS, 4 cases × desktop/mobile = 8                                                  |
| Existing standalone #94 browser regressions                           | PASS, 5 cases × desktop/mobile = 10                                                 |
| Controlled desktop/mobile screenshots, no document overflow           | PASS, inspected                                                                     |
| Browser console/page errors in controlled flows                       | PASS, none                                                                          |
| npm ci --ignore-scripts                                               | PASS, 462 packages using unchanged #103 manifests/lock before implementation commit |
| Actual #76 controller / two independent Hosts / public package export | NOT RUN, owned by #76                                                               |
| Full unrelated Host E2E / physical iOS Safari                         | NOT RUN                                                                             |
| Actions / performance measurement                                     | NOT RUN, intentionally paused                                                       |

Before push all seven workflow files were confirmed workflow_dispatch-only;
CI/file-size/Office remain disabled_manually. Branch run list was empty after
push. No main merge, release, deploy, license change or product integration.
Draft PR #106 is stacked on #103's branch. Subsequent HEAD is evidence-only;
use the implementation SHA above for reproducing runtime validation.

## Empty cancelled-IME draft correction

Reproduced against `a58a5dc88782f95696d2795a71560d83c6146282`: an IME start/end
without change left an empty draft holding the old target/revision. Switching
layer or composition then editing changed the previous layer (old y became 205
instead of remaining 140). A intervening canonical command instead caused a false
stale refusal. All three desktop reproduction cases FAILed before correction.

The limited fix clears a draft on compositionend only if it has neither raw dirty
fields nor any active composition, and reseeds begin() from the current target and
revision whenever no actual draft exists. Dirty values and another active IME keep
their original baseline. No shared contract, API, native schema or history changes.

- Runtime fix `f4cb15a2516c63928a94960b07ec4309bc0b0cb6`: PASS full unit suite
  1494/148 files, controlled production build and all 16 controlled browser tests.
  Initial typecheck FAIL was in the new multi-target test fixture's broad union;
  narrowed to the actual schema-1 type in the next test-only commit.
- Final tested `583fd7d9b15d7bc1a77214e8094c4bc3e4c800b8`: runtime unchanged;
  PASS lint/typecheck/file guard, focused atomic-input unit3, rebuilt controlled
  production fixture, all 16 controlled E2Es (8 cases × desktop/mobile).
- New coverage: cancelled IME → different layer → edit/apply; different composition;
  intervening non-UI command → normal edit; simultaneous dirty input plus another
  active composition retained until correctly completed. Previous identity-refresh,
  atomic flush, invalid/stale/IME/refusal, no-op/Redo, readonly/revoke tests remain PASS.
- Broader root builds/unrelated Host E2Es and physical IME hardware were NOT RERUN.
  Browser composition events test the reported React handler path. Earlier exact
  verification remains separately scoped. Actions/performance remain NOT RUN.
