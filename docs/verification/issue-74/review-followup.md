# PR #303 review corrections

Review basis: `adb1c1837480652f13fafb5e58b6e91bb4655cc1`, 2026-10-20 JST.
This supplements [baseline verification](README.md); earlier successful counts
apply to their recorded source, not automatically to this correction.

| Review                                  | Correction and regression                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saving guard (legacy review 4315419790) | Normal Host propagates saving into the current Surface and rejects Animation commands/history at its live boundary. Compatibility controller exposes an optional live saving getter and refuses prepared commands. Production test holds the actual digest and verifies disabled duplicate/delete/add and unchanged captured native bytes.                                          |
| Snapshot receipt (4315419814)           | The original layer-action record now identifies completed source `8451d962` and full final manifest `c28f9a41…`. The current baseline record also identifies source `adb1c183` and completed manifest `e85150ab…`. Neither describes a future run as completed.                                                                                                                     |
| Locked descendants (4316839618)         | Final-content guard checks destination ancestry for inserted/reparented nodes against original locks. Forged authority operations prepared against an unlocked source are rejected atomically against the locked authority, including new child and existing-node reparenting.                                                                                                      |
| Stale mount rejection (4316839639)      | Each effect owns its mounted Player; cleanup/catch dispose only that instance and clear the shared ref only by identity. Production regression rejects the older deferred font preparation after a newer Player is ready, then seeks and plays the newer instance.                                                                                                                  |
| Runtime closure pin (4316839649)        | Vite and independent Node export compute the same complete bundled trusted-component dependency hash. Wrapper implementation identity includes this pin. Tooling mutates viewer, transport, validator and resource/player modules independently and verifies changed hashes; identical builds reproduce the same hash. Independent export uses the same production React condition. |
| React capacity (4316839660)             | Registration accepts up to 3 MiB UTF-8 retained native JSON, subject also to the unchanged React UI 4 MiB document cap. Tests cover base64-expanded 1.6 MiB and 2 MiB resources and explicit oversize refusal. Preview captures before switching so a rejection stays a diagnostic. This is an explicit smaller registered subset than native embedding.                            |
| PNG allocation (4316839677)             | PNG output refuses above 16 Mi pixels before image/resource work or canvas allocation. A maximum-dimension valid composition rejects with a stub document proving no browser allocation; the same composition can export SVG.                                                                                                                                                       |

The capability guide documents the registered-React and PNG limits. No generic
React UI budget is raised, and the current Editor/Player and immutable legacy
versions retain their existing contracts. No PR #301 Design/native/template
changes are part of these corrections.

## Validation

Implementation/test source: `1f473d513413766895421ed9f4b3b423713c5d6f`.
The receipt commit changes this record only.

| Gate                                                   | Result                                                                                                              | Log                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Focused native/authority/registration/controller tests | PASS: 45                                                                                                            | `/tmp/pr303-review-targeted1.log`                                                                 |
| All units                                              | PASS: 2,908 / 280 files; existing 9 optional skips (2,900 main + 8 isolated corpus)                                 | `/tmp/pr303-review-units1.log`                                                                    |
| Tooling                                                | PASS: 109, including four dependency mutations and dev invalidation                                                 | `/tmp/pr303-review-tooling2.log`                                                                  |
| Lint / strict TypeScript / file policy                 | PASS; 2,434 files, zero failures                                                                                    | `/tmp/pr303-review-lint3.log`, `/tmp/pr303-review-typecheck2.log`, `/tmp/pr303-review-files2.log` |
| Four production builds                                 | PASS                                                                                                                | `/tmp/pr303-review-build2.log`                                                                    |
| New 2D production, including stale-resource rejection  | PASS: 12 desktop/mobile                                                                                             | `/tmp/pr303-review-2d1.log`                                                                       |
| Layer actions and delayed ordinary save                | PASS: 10 desktop/mobile                                                                                             | `/tmp/pr303-review-layers1.log`                                                                   |
| Existing Animation/Slide connection                    | PASS: 64 desktop/mobile                                                                                             | `/tmp/pr303-review-connection1.log`                                                               |
| Existing Design / independent Host / mobile regression | PASS: 4                                                                                                             | `/tmp/pr303-review-design1.log`                                                                   |
| Local public snapshot export / fresh check             | PASS: 1,972 files + manifest, npm dev/optional audit and 3 OSV queries per invocation, manifest/residual validation | `/tmp/pr303-review-public-export1.log`, `/tmp/pr303-review-public-check1.log`                     |

The production total is 90 (12 + 10 + 64 + 4), with console/page errors failing
tests and no retries. Japanese static output, independent React output and the
retained 2D Slide view were visually inspected. The final dev-invalidation helper
was covered by tooling; rebuilding reproduced the exact tested production Host
bundle, SHA-256 `a4738f3cca844e8a7c46f0caed58d2c4145e73cc43f77e73277bb02f10373ee3`
(`/tmp/pr303-review-bundle-equality.log`). Runtime pin overrides are build-test
inputs only, not user-native execution. Generated bundles/fonts/images/logs stay
outside Git. Physical devices/native OS IME/other engines/performance remain NOT RUN.

Completed code snapshot: source `1f473d513413766895421ed9f4b3b423713c5d6f`,
`work/issue74-2d/review-code`, manifest SHA-256
`7146a40c7d8fbb459db4f6ea6f97c24ca26e697a69970e9b31ab5cfed9df4e4b`.
The final documentation receipt is separately exported/checked; its final manifest
belongs to that receipt source and is reported in the PR. This recorded code
snapshot and baseline receipts are completed immutable artifacts, not promises of
later verification. No public repository is synchronized.

PR #301 head remains `a8cbdc265eefa5661fa47ff734f99748e90e72fb`.
A full merge-tree against the common main base completed without conflict at
`b6bd086c51800aa8a00c32875d2025ddff1ae691`; combined runtime behavior is not
certified by a merge-only check.

## Execution notes

An initial lint found the Node helper's missing explicit `URL` import. It was
corrected before the final checks. No failed gate is bypassed.

## Review of `a4c9083c`: dependency locks, keys and container size

The next review reported three findings (4319635382, 4319635387 and
4319635393). These corrections preserve the earlier seven fixes and the native
inputs/text, authority/selective Undo and immutable legacy bytes/hash contracts.

- Protection walks the original parent/clip dependency graph recursively and
  compares its geometry, tracks, inputs and resources at both command and
  authority boundaries. Forged operations prepared against an unlocked copy
  cannot change a locked layer through its mask or mask ancestors. Rejection
  leaves content/revision untouched; unrelated edits and peer-preserving Undo
  remain accepted.
- Key insertion samples the existing track with the same native interpolation
  used by scene evaluation. Group and composition layers do not need drawable
  scene items. Their midpoint keys retain the evaluated child poses. Production
  testing also found that a remount's initial zero notification overwrote the
  current playhead; preparation notifications now wait for ownership/onReady,
  preserving the editing time through key insertion and Undo.
- The reusable React Player fills its container without a 180px minimum. The
  standalone Design conversion, legacy and saved-source previews own their 180px height. A real Slide
  presentation with a 320×60 animation object checks that the Player and SVG
  viewport equal the foreignObject height in both desktop and mobile layouts.

Reproduction logs: `/tmp/pr303-round2-repro.log` records the authority accepting
the forged mask edit and both container layer keys taking base x=10 instead of
evaluated x=200. `/tmp/pr303-round2-layout-repro2.log` records the old Player at
270 screen pixels inside a 90px scaled container. `/tmp/pr303-round2-2d.log`
records the subsequent playhead reset exposed by production assertions.
The first layer-action regression (`/tmp/pr303-round2-layers.log`) caught the
legacy preview without a container height: its controls overlapped the migration
button. That run was interrupted after the failure; the standalone legacy and
saved-source containers were corrected before rebuilding and rerunning the suites.

Initial test preparation errors are separate from those product reproductions:
the first layout test checked toolbar visibility before asynchronous import
finished, and the first authority fixture used a non-native input address and
prepared a peer operation from an already stale entity. The corrected tests wait
for the imported artifact and use native root input paths and a fresh peer base;
the actual refusal, midpoint value and unchanged-pose assertions are retained.

### Validation of these corrections

| Gate                                            | Result                                                                              | Log                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Focused authority/core/key insertion            | PASS: 37                                                                            | `/tmp/pr303-round2-focused3.log`                                       |
| All units                                       | PASS: 2,911 / 281 files; existing 9 optional skips (2,903 main + 8 isolated corpus) | `/tmp/pr303-round2-units.log`                                          |
| Tooling                                         | PASS: 109                                                                           | `/tmp/pr303-round2-tooling.log`                                        |
| Lint / strict TypeScript                        | PASS; final build repeats strict TypeScript                                         | `/tmp/pr303-round2-lint-final3.log`, `/tmp/pr303-round2-typecheck.log` |
| File policy                                     | PASS: 2,435 files / zero failures                                                   | `/tmp/pr303-round2-files.log`                                          |
| Four production builds                          | PASS                                                                                | `/tmp/pr303-round2-build-final2.log`                                   |
| Current 2D production                           | PASS: 16, desktop 8 / mobile 8                                                      | `/tmp/pr303-round2-2d-final2.log`                                      |
| Legacy migration / layer actions / saving guard | PASS: 10, desktop 5 / mobile 5                                                      | `/tmp/pr303-round2-layers-final.log`                                   |
| Existing Animation/Slide connection             | PASS: 64, desktop 32 / mobile 32                                                    | `/tmp/pr303-round2-connection.log`                                     |
| Existing Design / independent Host / mobile     | PASS: 4                                                                             | `/tmp/pr303-round2-design.log`                                         |

The final production suites use one fixed rebuilt source and total 94 tests,
without retries; console/page errors fail tests. Short Slide objects in both
viewports, the standalone Design preview and independent Japanese React output
were visually inspected. Changed-file formatting and diff whitespace checks pass.
Generated files stay outside Git. No PR #301 Design model/view/template or common
connection file is changed in this correction round. The earlier NOT RUN and
operational holds remain in effect.

Implementation/test source for this round:
`65ea2318ef0d8c59c55d136e142e84381088f389`. Completed local code snapshot:
`work/issue74-2d/review-round2-code`, manifest SHA-256
`b91c59496bbb621856c24a0281e31ca620a265cbd5035e44810acaefa313e48d`.
Export and check both passed their fresh npm dev/optional audit and three OSV
queries, with 1,973 source files plus manifest and no residual/manifest failures
(`/tmp/pr303-round2-public-export.log`, `/tmp/pr303-round2-public-check.log`).
This receipt identifies a completed immutable code artifact. The receipt-only
head's local snapshot is separately reported in the PR. No public repository is
synchronized. PR #301 still points to `a8cbdc26`; the complete merge-tree check
passed without conflicts (`785c74ccc82facf8b0028575b772e914e73b493e`). This is a
merge check, not combined runtime certification.

## Review of `be8fef4c`: locked composition source closure

Finding 4319789378 identifies a local composition dependency missing from the
lock guard. `/tmp/pr303-round3-repro.log` reproduces an accepted raw patch to a
grandchild of a locked composition instance. The correction recursively protects
local source compositions (layers/order/metadata/tracks), their public inputs,
used image/font assets and further composition sources. Exact references compare
their immutable resolved owning snapshot. Unrelated local compositions and unused
assets remain editable. The composition set is visited once across protected roots.

Native ProseMirror steps now pass the same final-content guard as animation patches,
so editing a descendant text source cannot bypass the new protection. Tests prepare
valid raw domain/text operations against an unlocked copy and submit them directly
to a locked authority: each rejection preserves content/revision. Independent peer
edits and actor Undo on unrelated content remain accepted. Production tests edit a
referenced composition through the real Surface, retain its rejected inputs, then
edit an unrelated composition and Undo through the existing native history.

The initial all-unit invocation was interrupted when the native text boundary
case was added; its partial run is not counted. The final unit log is separate.
This round changes Animation core, its domain codec and focused tests/guide only;
it does not change PR #301 Design/native/view/template or the common connection
file. Existing limits, unsupported features and operational holds still apply.

| Gate                                                      | Result                                                                              | Log                                                                   |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Focused native/authority/source/key guards                | PASS: 39                                                                            | `/tmp/pr303-round3-focused-final.log`                                 |
| All units                                                 | PASS: 2,913 / 282 files; existing 9 optional skips (2,905 main + 8 isolated corpus) | `/tmp/pr303-round3-units-final.log`                                   |
| Lint / strict TypeScript                                  | PASS                                                                                | `/tmp/pr303-round3-lint-final.log`, `/tmp/pr303-round3-typecheck.log` |
| Tooling / file policy                                     | PASS: 109; 2,436 files / zero failures                                              | `/tmp/pr303-round3-tooling.log`, `/tmp/pr303-round3-files.log`        |
| Four production builds                                    | PASS                                                                                | `/tmp/pr303-round3-build.log`                                         |
| Current 2D desktop/mobile                                 | PASS: 18                                                                            | `/tmp/pr303-round3-2d.log`                                            |
| Layer/migration/save regression                           | PASS: 10                                                                            | `/tmp/pr303-round3-layers.log`                                        |
| Animation/Slide connection                                | PASS: 64                                                                            | `/tmp/pr303-round3-connection.log`                                    |
| Existing Design / independent Host / mobile               | PASS: 4                                                                             | `/tmp/pr303-round3-design.log`                                        |
| Explicit rejected-buffer assertion and screenshot capture | PASS: 2 desktop/mobile cases                                                        | `/tmp/pr303-round3-source-capture.log`                                |

The final production suites total 96 (18 + 10 + 64 + 4), excluding repeated
focused checks/captures. Console/page errors fail tests; no retries were used.
The source-edit refusal and retained y=300 buffer were visually inspected in
both viewports, while the rendered source stayed unchanged. Formatting and diff
whitespace pass. Generated evidence remains outside Git. There is no additional
performance measurement, CI/Actions restart, public synchronization or deployment.

Implementation/test source: `4ea4f0f14dbcc00b1ef99374a38d049c319f7dc2`.
Completed code snapshot: `work/issue74-2d/review-round3-code`, manifest SHA-256
`54de8a26600a5917a73058cc7cc716d5a498f24d9507e2dd566ed7bc2d0641b7`.
Export and check passed fresh npm dev/optional audit and three OSV queries on
each invocation, with 1,974 source files plus manifest and no residual/manifest
failures (`/tmp/pr303-round3-public-export.log`,
`/tmp/pr303-round3-public-check.log`). The receipt-only head's checked snapshot
is reported separately in the PR. No public repository is synchronized.
PR #301 remains open at `a8cbdc26`; the complete merge-tree check passed without
conflicts (`79c0cf72a155ba65ab83b623db1912aaa01d9493`), without a combined
runtime acceptance claim.

## Review of `5a2afc5f`: authoring boundaries and static notices

Seven findings (4319949254, 4319949259, 4319949262, 4319949269,
4319949271, 4319949280, 4319949281) are addressed as follows:

- Bounded Unnest accepts only hold-after mappings; loop/hide refuse without a
  command/history entry. Hold retains the terminal evaluated pose.
- Converted clip masks have the same converted parent as their visible layer.
  Moving the converted group moves both shape and clip world matrices.
- Public-input property display and submission use the same available property
  after changing layer kinds. Unsupported text/fill selections fall back to opacity.
- Duration has one boundary in the existing EditorInputs registry, capturing its
  native base and committing through the existing command/history. Other dirty,
  composing, move or asset-read boundaries disable/reject it; its own draft stays
  editable and supports commit/cancel. No second registry/history is introduced.
- Zero endpoint derivatives use the nearest distinct Bezier control point's
  limiting tangent, preserving final orientation for quadratic/cubic motion.
- Exact adoption retains providers used by other layers, including nested source
  providers, and prunes superseded unreferenced providers before final aggregate
  validation. Retained snapshot bytes and old Undo content are not rewritten.
- PNG contains an uncompressed UTF-8 iTXt chunk with the same captured provenance
  and used-resource attribution/license metadata as SVG. Chunk CRCs are verified
  against Node's independent crc32 implementation; existing PNG chunks/pixels stay
  unchanged. Production Chromium decodes the actual downloaded PNG and checks its
  font attribution/license notice.

`/tmp/pr303-round4-core-repro2.log` records the Unnest, clip matrix, tangent and
source-retention reproductions. `/tmp/pr303-round4-ui-repro.log` runs against the
previous production build and records stale property display (`x`), enabled
duration during another input, and absent PNG notices. The corrected focused
native/adapter/PNG tests pass in `/tmp/pr303-round4-unit-focused.log` (13).

Initial test setup used the wrong nest argument shape and Vitest array-row shape;
those were corrected before the valid reproductions. The first post-fix adapter
assertion used exact floating-point equality (50.000000000000014); its tolerance
now checks the same displacement. The multi-MiB adoption fixture needs a 30-second
unit timeout; this changes no application budget or performance acceptance.

The first corrected production run passed 100 cases. An added two-peer case then
found that keying the duration input by composition ID discarded its private
buffer when a peer unnested the edited composition
(`/tmp/pr303-round4-duration-target-repro.log`, 180 replaced by 120). The input
now retains its original target/base across that external change, reports the
stale target, and requires explicit cancellation before applying to a different
composition. The final suites include that case in both viewports; the earlier
100-case run is separate from the final result below.

| Gate                                        | Result                                                                              | Log                                                                           |
| ------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Focused native/adapter/PNG regressions      | PASS: 13                                                                            | `/tmp/pr303-round4-unit-focused.log`                                          |
| All units                                   | PASS: 2,921 / 284 files; existing 9 optional skips (2,913 main + 8 isolated corpus) | `/tmp/pr303-round4-units.log`                                                 |
| Lint / strict TypeScript                    | PASS (final build repeats strict TypeScript)                                        | `/tmp/pr303-round4-lint-final3.log`, `/tmp/pr303-round4-typecheck-final2.log` |
| Tooling / file policy                       | PASS: 109; 2,440 files / zero failures                                              | `/tmp/pr303-round4-tooling.log`, `/tmp/pr303-round4-files.log`                |
| Four production builds                      | PASS                                                                                | `/tmp/pr303-round4-build-final2.log`                                          |
| Current 2D desktop/mobile                   | PASS: 24                                                                            | `/tmp/pr303-round4-2d-final.log`                                              |
| Layer/migration/save regression             | PASS: 10                                                                            | `/tmp/pr303-round4-layers-final.log`                                          |
| Animation/Slide connection                  | PASS: 64                                                                            | `/tmp/pr303-round4-connection-final.log`                                      |
| Existing Design / independent Host / mobile | PASS: 4                                                                             | `/tmp/pr303-round4-design-final.log`                                          |

The final fixed-build production suites total 102 (24 + 10 + 64 + 4), including
both viewports for the two-peer stale-duration-target case. Console/page errors
fail tests; no retries were used. The actual annotated PNG and independent React
Japanese rendering were visually inspected, along with the Design conversion
preview in the first corrected run. Formatting and diff whitespace pass.
No generated evidence is committed. These fixes do not change PR #301's Design
native/view/template implementation or the common connection file. No extra
performance measurement, CI/Actions restart, public synchronization or deployment
was performed; existing unsupported features and operational holds still apply.

Implementation/test source: `773ed578c4a3c2eb6faf28cfbf4bb4dd8babec3c`.
Completed code snapshot: `work/issue74-2d/review-round4-code`, manifest SHA-256
`4f41798ede5ba5c73ada924fe81e108803579df987cfed6ecb93d25d2795d37c`.
Export and check each passed a fresh npm dev/optional audit and three OSV queries,
with 1,978 source files plus manifest and zero residual/manifest failures
(`/tmp/pr303-round4-public-export.log`, `/tmp/pr303-round4-public-check.log`).
The receipt-only head's snapshot is reported separately in the PR; there is no
public repository synchronization. PR #301 remains open at `a8cbdc26` and the
complete branch merge-tree check passed without conflicts
(`d037c2fb9644aa0b040a74bad40c7802eb47c957`), without claiming combined runtime
acceptance.

## Review of `65751d53`: compatible inputs and retained-resource ownership

Four findings (4320177519, 4320177523, 4320177527, 4320177531) are addressed:

- Slide adoption compares the previous and candidate declared kinds for each
  consumer override before retaining it. Color/text strings cannot change API
  meaning silently; compatible kinds preserve the override and removed IDs still
  report the existing unknown-input error.
- Deletion shares the exact-provider retention helper with adoption. It prunes
  after all actions, retaining direct/nested providers used by any remaining
  editable composition. Retained snapshots remain byte-identical. Unit cases
  cover last/shared instances, resource budget recovery, nested-only providers,
  delete/reinsert in one batch, native Undo and authority actor Undo through a
  peer geometry edit.
- Provenance mapping source IDs use bounded opaque strings (2,000 characters)
  instead of Animation's native ID grammar. Original spaced/Japanese/punctuation
  IDs survive reviewed Design capture, adoption and Undo; generated IDs retain
  their native grammar.
- Repeated Design images reuse the captured asset matching both hash and media
  type. A 102-image fixture stores two assets (101 repeated images and one with
  distinct bytes), keeping per-layer geometry and notices.

`/tmp/pr303-round5-unit-repro.log` records five failures for all four findings.
`/tmp/pr303-round5-ui-repro.log` records three old-build desktop failures: the
last deleted provider remains, Slide exposes the incompatible candidate, and an
opaque Design ID prevents preview. The first corrected opaque-ID test expected
one provenance row per element, but the frame legitimately maps both its group
and background; the assertion now compares original-ID sets without discarding
any mapping. Corrected focused tests pass (24) in
`/tmp/pr303-round5-focused.log`.

| Gate                                                    | Result                                                                              | Log                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Focused adoption/retention/Design/authority regressions | PASS: 24                                                                            | `/tmp/pr303-round5-focused.log`                                 |
| All units                                               | PASS: 2,927 / 284 files; existing 9 optional skips (2,919 main + 8 isolated corpus) | `/tmp/pr303-round5-units.log`                                   |
| Lint / strict TypeScript                                | PASS                                                                                | `/tmp/pr303-round5-lint.log`, `/tmp/pr303-round5-typecheck.log` |
| Tooling / file policy                                   | PASS: 109; 2,441 files / zero failures                                              | `/tmp/pr303-round5-tooling.log`, `/tmp/pr303-round5-files.log`  |
| Four production builds                                  | PASS                                                                                | `/tmp/pr303-round5-build.log`                                   |
| Current 2D desktop/mobile                               | PASS: 28                                                                            | `/tmp/pr303-round5-2d.log`                                      |
| Layer/migration/save regression                         | PASS: 10                                                                            | `/tmp/pr303-round5-layers.log`                                  |
| Animation/Slide connection                              | PASS: 64                                                                            | `/tmp/pr303-round5-connection.log`                              |
| Existing Design / independent Host / mobile             | PASS: 4                                                                             | `/tmp/pr303-round5-design.log`                                  |

The final production suites total 106 (28 + 10 + 64 + 4), using the same fixed
build with console/page errors as failures and no retries. The reviewed Design
preview was visually inspected in both viewports: the triangle and three repeated
logos retain their geometry while the native result stores one image asset.
Formatting and diff whitespace pass. Generated evidence remains outside Git.
The production source does not change PR #301's Design native/view/template or
the common connection file. No extra performance measurement, CI/Actions restart,
public synchronization or deployment was performed. Existing unsupported features
and operational holds remain in effect.

Implementation/test source: `0f44a907093beb85f4e9ce62630905c952740bec`.
Completed code snapshot: `work/issue74-2d/review-round5-code`, manifest SHA-256
`19fb6775a20e15f39a76d97f7760604270b69abf0b36e4c69180937aa2ec622c`.
Export and check each passed a fresh npm dev/optional audit and three OSV queries,
with 1,979 source files plus manifest and zero residual/manifest failures
(`/tmp/pr303-round5-public-export.log`, `/tmp/pr303-round5-public-check.log`).
The receipt-only head's snapshot is reported separately in the PR; there is no
public repository synchronization. PR #301 remains open at `a8cbdc26` and the
complete branch merge-tree check passed without conflicts
(`5c589b58c756709c8a080c28a3900794d639b221`), without claiming combined runtime
acceptance.

## Review of `dd0152b2`: repeated adoption and effective playback controls

Three findings (4320319272, 4320319276, 4320319282) are addressed:

- Design adoption reuses an equivalent target asset only when hash, media type,
  attribution and license match. An owned copy remaps image/font asset IDs; the
  reviewed capture and existing target assets stay unchanged. Three fresh
  1.5-MiB image captures fit as one asset, while another source notice retains a
  separate asset. Native Undo restores the previous ownership.
- A shared core projection walks the selected composition's recursive local
  closure. Slide controls and native placement/replacement/adoption keep only
  those consumer inputs. Independent compositions and exact nested sources do
  not expose ineffective controls. Existing pins are inspected without rewriting
  their snapshot or ignored input metadata; explicit new writes use the scoped
  projection. Removed declarations and reachable kind conflicts still refuse.
- A duration shrink clears an invalid work area. The controls, commit handlers
  and Player share the same effective range immediately; a later content Undo
  does not resurrect the invalid private range.

`/tmp/pr303-round6-unit-repro.log` records duplicated target assets and retained
unreachable inputs (two failures). `/tmp/pr303-round6-ui-repro.log` records three
old-build desktop failures: stale work-area start 20, an ineffective independent
input control, and two assets after a fresh repeated capture. Corrected focused
tests, including immutable legacy playback/migration, pass (14) in
`/tmp/pr303-round6-focused-final.log`.

The first corrected production run passed 29/30 but the existing mobile text
fixture failed: Playwright's contenteditable `fill` left the initial `Text` after
the Japanese insertion (`/tmp/pr303-round6-2d.log`, trace under
`/tmp/pr303-round6-2d-results`). The fixture now selects all through the native
keyboard path, inserts the Japanese text and asserts the editor buffer before
saving; it keeps the exact saved/rendered-text assertions. This changes no text
engine implementation or expected text. The focused mobile case passes in
`/tmp/pr303-round6-text-selection.log`. The final production run is separate below.

| Gate                                        | Result                                                                              | Log                                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Focused adoption/closure/legacy regressions | PASS: 14                                                                            | `/tmp/pr303-round6-focused-final.log`                                        |
| All units                                   | PASS: 2,929 / 284 files; existing 9 optional skips (2,921 main + 8 isolated corpus) | `/tmp/pr303-round6-units.log`                                                |
| Lint / strict TypeScript                    | PASS                                                                                | `/tmp/pr303-round6-lint-final2.log`, `/tmp/pr303-round6-typecheck-final.log` |
| Tooling / file policy                       | PASS: 109; 2,441 files / zero failures                                              | `/tmp/pr303-round6-tooling.log`, `/tmp/pr303-round6-files.log`               |
| Four production builds                      | PASS                                                                                | `/tmp/pr303-round6-build.log`                                                |
| Current 2D desktop/mobile                   | PASS: 30                                                                            | `/tmp/pr303-round6-2d-final.log`                                             |
| Layer/migration/save regression             | PASS: 10                                                                            | `/tmp/pr303-round6-layers-final.log`                                         |
| Animation/Slide connection                  | PASS: 64                                                                            | `/tmp/pr303-round6-connection-final.log`                                     |
| Existing Design / independent Host / mobile | PASS: 4                                                                             | `/tmp/pr303-round6-design-final.log`                                         |

The final production suites total 108 (30 + 10 + 64 + 4), using one fixed build,
console/page errors as failures and no automatic retries. The repeated Design
preview and actual Japanese PNG were visually inspected. Final formatting and
diff whitespace pass. No generated evidence is committed. Design native/view/
template and the common connection file are unchanged in this round. No extra
performance measurement, CI/Actions restart, public synchronization or deployment
was performed; existing unsupported features and operational holds still apply.

Implementation/test source: `2aa2835ef78ec33d752f1b4dfec25a107f19b560`.
Completed code snapshot: `work/issue74-2d/review-round6-code`, manifest SHA-256
`9e1906597c3b972839e25c7b9553fb5363856043e1b4698dcd2ac6fb40d23273`.
Export and check each passed a fresh npm dev/optional audit and three OSV queries,
with 1,979 source files plus manifest and zero residual/manifest failures
(`/tmp/pr303-round6-public-export.log`, `/tmp/pr303-round6-public-check.log`).
The receipt-only head's snapshot is reported separately in the PR; there is no
public repository synchronization. PR #301 remains open at `a8cbdc26` and the
complete branch merge-tree check passed without conflicts
(`94446518459698355c323c95cdbb6ada446f0d6a`), without claiming combined runtime
acceptance.

## Review of `c56c7f07`: protected authoring and render admission

Five findings (4320474953, 4320474958, 4320474963, 4320474970, 4320474975) are addressed:

- Selected-key easing inherits the ordinary layer/ancestor/read-only disabled
  state. Change/composition-start callbacks cannot create a draft while disabled.
  Existing pending inputs can still be cancelled.
- The canonical source status page now describes the same schema-2 Animation
  subset as README and the public overlay, including shared editing/static output
  and the remaining unsupported features. Only Animation capability statements
  change; table padding is formatting. PR #301's Design statements stay on its
  branch and are not copied into this work.
- The final protected-content guard rejects root-pointer changes away from an
  old root with locked layers. A valid raw root patch prepared on an unlocked copy
  is rejected by the locked authority without a revision/content change. A locked
  unrelated composition does not prevent switching an unlocked root.
- Stage movement checks public x/y bindings before creating a gesture/preview,
  keeping controlled geometry and native history unchanged.
- The expanded clip budget is reduced from 200,000 to 32,768, conservatively
  including intermediate layers and nested multiplicities. The 8-MiB SVG bound
  remains an independent serialization/resource limit. A compact 159-instance,
  100-shape-per-instance source formerly passed validation and then exceeded the
  SVG limit; it now refuses during validation. An admitted 32-instance variant
  renders 3,200 items / 32,000 visible clip references within that SVG bound and
  supports exact static planning. This is a correctness/size regression, not a
  new performance measurement or acceptance claim.

`/tmp/pr303-round7-unit-repro.log` records the accepted locked-root switch and
late SVG-size failure (two failures). `/tmp/pr303-round7-ui-repro.log` records
interactive easing on a locked layer and a controlled x drag changing the hidden
base from (80,80) to (110,100). Corrected focused tests pass (8) in
`/tmp/pr303-round7-focused.log`.

The first corrected production run passed 32/34. Both stage cases passed their
content/controlled-field checks, then failed the fixture's assumption that an
empty history disables the independent Host's Undo button. That Host intentionally
enables Undo based on permission/busy state (`/tmp/pr303-round7-2d.log`). The case
now first creates a real width edit and verifies that one Undo after the refused
drag reverts that edit directly, with Redo restoring it. This verifies history
behavior without changing the Host or weakening the content assertion. The final
production run is recorded separately below.

| Gate                                        | Result                                                                              | Log                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Focused lock/render regressions             | PASS: 8                                                                             | `/tmp/pr303-round7-focused.log`                                             |
| All units                                   | PASS: 2,932 / 284 files; existing 9 optional skips (2,924 main + 8 isolated corpus) | `/tmp/pr303-round7-units.log`                                               |
| Lint / strict TypeScript                    | PASS                                                                                | `/tmp/pr303-round7-lint-final.log`, `/tmp/pr303-round7-typecheck-final.log` |
| Tooling / file policy                       | PASS: 109; 2,441 files / zero failures                                              | `/tmp/pr303-round7-tooling.log`, `/tmp/pr303-round7-files.log`              |
| Four production builds                      | PASS                                                                                | `/tmp/pr303-round7-build.log`                                               |
| Current 2D desktop/mobile                   | PASS: 34                                                                            | `/tmp/pr303-round7-2d-final.log`                                            |
| Layer/migration/save regression             | PASS: 10                                                                            | `/tmp/pr303-round7-layers-final.log`                                        |
| Animation/Slide connection                  | PASS: 64                                                                            | `/tmp/pr303-round7-connection-final.log`                                    |
| Existing Design / independent Host / mobile | PASS: 4                                                                             | `/tmp/pr303-round7-design-final.log`                                        |
| Targeted controlled-position native history | PASS: 2                                                                             | `/tmp/pr303-round7-history.log`                                             |
| Source/overlay status consistency and links | PASS                                                                                | `/tmp/pr303-round7-docs.log`                                                |

The final production suites total 112 (34 + 10 + 64 + 4), using one fixed build,
console/page errors as failures and no automatic retries. The controlled-position
mobile screenshot was visually inspected. The targeted two history cases are
additional repetitions, not added to that total. Final formatting and diff
whitespace pass. No generated evidence is committed. Final authority guards remain
shared by native text and raw domain submissions; no alternative submission or
history path was introduced. The clip validator is a common source-admission
limit, not a rendering exception or a promise that every admitted combination
fits the independent SVG serialization limit. Design native/view/template and the
common connection runtime file are unchanged in this round. No extra performance
measurement, CI/Actions restart, public synchronization or deployment was performed;
existing unsupported features and operational holds still apply.

Implementation/test source: `931578505c1f2f848d184dc54f75977746f472db`.
Completed code snapshot: `work/issue74-2d/review-round7-code`, manifest SHA-256
`deab7f60bbd97cf5ea7ab77dc20e925a3afea5df9c8d1d036dec69497049f8f3`.
Export and check each passed a fresh npm dev/optional audit and three OSV queries,
with 1,979 source files plus manifest and zero residual/manifest failures
(`/tmp/pr303-round7-public-export.log`, `/tmp/pr303-round7-public-check.log`).
The receipt-only head's snapshot is reported separately in the PR; there is no
public repository synchronization. PR #301 remains open at `a8cbdc26` and the
complete branch merge-tree check passed without conflicts
(`5dec37c7a74dd869e65c95e909b66a69ebec4ad5`). The branches now share
`docs/status.md` as well as `editor-transactions.ts`; only the Animation capability
statements change here. This supersedes the baseline decision to leave source
status unchanged and does not claim combined runtime acceptance.

## Review of `d211ffc7`: resource ownership and vector data

Four findings (4320645410, 4320645414, 4320645419, 4320645423) are addressed:

- Validation counts actual serialized path-command/coordinate code units with
  nested multiplicity, in addition to the existing command count. Expanded path
  data is limited to 4 Mi code units, reserving half of the independent 8-Mi SVG
  bound for other output. The 390-instance / 512-command cubic fixture formerly
  passed admission and failed SVG serialization with long coordinates. It now
  refuses at admission; the same command/instance count with short coordinates
  still renders and produces an exact static plan. The final combined output
  bound remains separate; these are resource limits, not performance acceptance.
- Resource preparation follows the selected composition's recursive local/exact
  closure using the existing source resolver and owning asset table. Mount and
  static export pass the selected composition identity. Independent compositions
  and unused retained providers do not cause browser decode or rewrite. Reachable
  resources still undergo header/hash and browser-readiness validation, with the
  existing abort and font cleanup behavior.
- Image removal records candidate owned assets, then reclaims only candidates
  without references in any native composition after the complete action batch.
  Same-batch reuse, references in independent compositions and native Undo/Redo
  preserve ownership. Uploaded fonts and immutable retained records are not
  swept as unrelated resources. No second resource store or history is added.
- Design image conversion admits explicit fit only. Omitted fit means cropped
  fill in the Design renderer and now has the same refusal as explicit fill.
  Supported image fixtures declare fit; new omitted/fill regressions retain the
  source and require an error instead of a silently letterboxed capture.

`/tmp/pr303-round8-unit-repro.log` records four old-code failures: late vector SVG
failure, unrelated image decode, unreclaimed image bytes and admitted omitted-fit
capture. `/tmp/pr303-round8-ui-repro.log` records two old-build desktop failures:
unrelated header-valid/truncated image prevents root playback, and deletion leaves
the uploaded asset. Corrected focused tests pass (22) in
`/tmp/pr303-round8-focused-final.log`.

The first corrected focused run passed 21/22; the multi-MiB ownership/Undo fixture
exceeded Vitest's default five-second timeout. It now has an explicit 30-second
test timeout, keeping all ownership/content assertions. Early strict TypeScript
found a readonly cubic fixture tuple, and lint found an unused type import after
removing the global resource traversal; both were corrected before final gates.

| Gate                                              | Result                                                                              | Log                                                                           |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Focused vector/resource/ownership/fit regressions | PASS: 22                                                                            | `/tmp/pr303-round8-focused-final.log`                                         |
| All units                                         | PASS: 2,937 / 284 files; existing 9 optional skips (2,929 main + 8 isolated corpus) | `/tmp/pr303-round8-units.log`                                                 |
| Lint / strict TypeScript                          | PASS                                                                                | `/tmp/pr303-round8-lint-final2.log`, `/tmp/pr303-round8-typecheck-final3.log` |
| Tooling / file policy                             | PASS: 109; 2,441 files / zero failures                                              | `/tmp/pr303-round8-tooling.log`, `/tmp/pr303-round8-files.log`                |
| Four production builds                            | PASS                                                                                | `/tmp/pr303-round8-build.log`                                                 |
| Current 2D desktop/mobile                         | PASS: 38                                                                            | `/tmp/pr303-round8-2d.log`                                                    |
| Layer/migration/save regression                   | PASS: 10                                                                            | `/tmp/pr303-round8-layers.log`                                                |
| Animation/Slide connection                        | PASS: 64                                                                            | `/tmp/pr303-round8-connection.log`                                            |
| Existing Design / independent Host / mobile       | PASS: 4                                                                             | `/tmp/pr303-round8-design.log`                                                |
| Playback screenshot framing, assertions unchanged | PASS: 2 repeated viewport cases                                                     | `/tmp/pr303-round8-capture.log`                                               |

The final production suites total 116 (38 + 10 + 64 + 4), using one fixed build,
console/page errors as failures and no automatic retries. The initial mobile
playback screenshot captured the toolbar above the stage; the repeated capture
frames the actual SVG without changing behavior/assertions. That stage and the
Design preview with explicitly fitted images were visually inspected. Formatting
and diff whitespace pass. No generated evidence is committed. Old readers/hash,
native inputs/text and authority/selective Undo regressions pass. No Design
native/view/template or common connection runtime change, additional performance
measurement, CI/Actions restart, public synchronization or deployment was performed;
existing unsupported features and operational holds still apply.

Implementation/test source: `028f5a22a1d189b9628c149a749f6dbcf4b85095`.
Completed code snapshot: `work/issue74-2d/review-round8-code`, manifest SHA-256
`9c0d71b0968e53efb19fb7c04c339d41e011fe162e7dc71263da5b0ead504274`.
Export and check each passed a fresh npm dev/optional audit and three OSV queries,
with 1,979 source files plus manifest and zero residual/manifest failures
(`/tmp/pr303-round8-public-export.log`, `/tmp/pr303-round8-public-check.log`).
The receipt-only head's snapshot is reported separately in the PR; there is no
public repository synchronization. PR #301 remains open at `a8cbdc26` and the
complete branch merge-tree check passed without conflicts
(`216c61006666eac31e00b47f62d7d32de5fce372`), without claiming combined runtime
acceptance.

## Review of `35a63062`: local root locks and font prerequisites

Two findings (4320759768, 4320759774) are addressed:

- The root pointer guard traverses the root's mutable local-composition closure.
  The same pure closure helper now defines reachable public controls, preserving
  exact-source ownership and unrelated-composition behavior. Raw patches switching
  away from a locked child or grandchild reject with unchanged content/revision;
  the direct-lock and unrelated-lock cases remain covered.
- Shared Animation command preparation emits only required font/asset assignments
  before the native replacement that needs them. Native replacements that clear
  non-ASCII text can precede font removal; other metadata, including new locks,
  follows text. A mixed command can add a font to one text and clear another's
  font without an invalid intermediate state. This uses ordered actions in one
  authority operation; validation, native ProseMirror steps and actor history
  are unchanged. New/retained fonts and same-command text locking commit in one
  revision, Undo preserves B's geometry, and Redo restores the text/font result.

`/tmp/pr303-round9-unit-repro.log` records four old-code failures: accepted raw
switches with child/grandchild locks, `font-required: text` on assignment and
`font-required: clearing` on the mixed removal case. Focused final tests pass (17)
in `/tmp/pr303-round9-focused-final2.log`.

The first corrected checks exposed fixture assumptions, retained in
`/tmp/pr303-round9-focused.log` and `/tmp/pr303-round9-focused-final.log`: native
ProseMirror restores canonical plain runs rather than the empty-runs alias, and
Authority Redo takes the accepted Undo receipt ID rather than the original edit
ID. The fixture now starts with native canonical runs, keeps exact text-layer
comparisons, and invokes the existing Redo contract. No text-engine or history
validation was weakened to satisfy those checks.

| Gate                                               | Result                                                                              | Log                                                                         |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Focused local-lock/font/native history regressions | PASS: 17                                                                            | `/tmp/pr303-round9-focused-final2.log`                                      |
| All units                                          | PASS: 2,942 / 284 files; existing 9 optional skips (2,934 main + 8 isolated corpus) | `/tmp/pr303-round9-units.log`                                               |
| Lint / strict TypeScript                           | PASS                                                                                | `/tmp/pr303-round9-lint-final.log`, `/tmp/pr303-round9-typecheck-final.log` |
| Tooling / file policy                              | PASS: 109; 2,441 files / zero failures                                              | `/tmp/pr303-round9-tooling.log`, `/tmp/pr303-round9-files.log`              |
| Four production builds                             | PASS                                                                                | `/tmp/pr303-round9-build.log`                                               |
| Current 2D desktop/mobile                          | PASS: 38                                                                            | `/tmp/pr303-round9-2d.log`                                                  |
| Layer/migration/save regression                    | PASS: 10                                                                            | `/tmp/pr303-round9-layers.log`                                              |
| Animation/Slide connection                         | PASS: 64                                                                            | `/tmp/pr303-round9-connection.log`                                          |
| Existing Design / independent Host / mobile        | PASS: 4                                                                             | `/tmp/pr303-round9-design.log`                                              |

The final production suites total 116 (38 + 10 + 64 + 4), using one fixed build,
console/page errors as failures and no automatic retries. The actual Japanese
PNG and locked-source input-retention screenshot were visually inspected.
Formatting and diff whitespace pass. No generated evidence is committed. Old
readers/hash, native inputs/text and authority/selective Undo regressions pass.
The common connection change is confined to the Animation preparation branch;
Design native/view/template behavior is unchanged. No additional performance
measurement, CI/Actions restart, public synchronization or deployment was performed;
existing unsupported features and operational holds still apply.

Implementation/test source: `0b24ddcb754f667262da2280ce356e677977152d`.
Completed code snapshot: `work/issue74-2d/review-round9-code`, manifest SHA-256
`2e1fa643546909747765c4ca1555f795fdb171a2029ba4f0bd5759ea6582ff0d`.
Export and check each passed a fresh npm dev/optional audit and three OSV queries,
with 1,979 source files plus manifest and zero residual/manifest failures
(`/tmp/pr303-round9-public-export.log`, `/tmp/pr303-round9-public-check.log`).
The receipt-only head's snapshot is reported separately in the PR; there is no
public repository synchronization. PR #301 remains open at `a8cbdc26` and the
complete branch merge-tree check, including the changed common connection file,
passed without conflicts (`3c0b9be91900e2ad3dff5cac565c6ceabdd73ced`), without
claiming combined runtime acceptance.

## Review of `454f189c`: render data, reuse and complete export identity

Six findings (4320934289, 4320934295, 4320934299, 4320934306, 4320934313, 4320934316) are addressed:

- Pure SVG path/text serialization is shared by admission, evaluation and Player.
  Expanded path data and normalized text-run markup share the existing 4-Mi
  data budget, including declared text variants and recursive multiplicity.
  Private evaluated values are checked before output. The independent 8-Mi final
  SVG limit remains. Four instances of 20,000 alternating styled characters now
  refuse during admission; smaller styled text retains bold/color output and an
  exact static plan. No run is flattened, truncated or omitted to fit a limit.
- Insert/adopt and source pruning share recursive retained-provider lookup. A
  direct B already retained inside A reuses A's provider unchanged. A and B each
  own a 1.5-MiB image: direct insertion/adoption fits as the existing 3-MiB closure
  instead of duplicating B; native Undo restores the owner and exact bytes.
- Multi-root Design capture uses the union of selected root bounds, including
  rotation for non-frames. Selected descendants are not counted as independent
  roots, retaining an enclosing selected frame's viewport even when listed later.
- Upload and repeated Design adoption share exact asset equivalence: hash, media
  type, attribution and license. Repeated image/font uploads reuse the owned ID;
  different notices remain separate, and an unchanged font assignment creates no
  extra native edit. Existing stale-read, input and permission checks remain.
- Paint-order controls use complete sibling-subtree blocks, preserving internal
  order and parent IDs. A group's record can follow its children in native order.
  Nested/interleaved blocks, exact one-Undo restoration and protected-order refusal
  have units; actual group controls and repeated uploads have viewport regressions.
- Independent React export fingerprints every emitted relative file and byte,
  including CSS, generated files and handoff metadata. Reuse verifies the complete
  destination before discarding its own staging directory. Conflicts retain both
  the existing destination and new staging output for diagnosis. Bundler paths
  are relative to the owned staging root, making repeated output deterministic.

`/tmp/pr303-round10-unit-repro.log` records three old-code failures: late rich-run
SVG failure, duplicated nested provider and viewport limited to the first root.
`/tmp/pr303-round10-ui-repro.log` records unchanged group paint order and two assets
after uploading identical image bytes twice. Corrected focused tests, including
private text-budget and nested paint-order/lock regressions, pass (28) in
`/tmp/pr303-round10-focused-final4.log`. Export directory regressions pass (2) in
`/tmp/pr303-round10-export-unit-final.log`.

The old CLI did not reproduce a reused stale destination in two actual runs:
temporary UUID directory names appeared in JavaScript comments and changed the
JS-only hash. After normalizing those comments the two JS files were identical;
the old collision branch nevertheless compared only JS. The corrected ordinary
bundler configuration emits deterministic files, and two actual CLI runs reuse
one complete export (`/tmp/pr303-round10-export-final1.log`,
`/tmp/pr303-round10-export-final2.log`). A deliberately changed CSS file in the
dedicated reproduction output is rejected and preserved by the actual CLI
(`/tmp/pr303-round10-export-collision.log`); that fixture CSS is restored afterward.
An initial dedicated native fixture changed the artifact ID without its version
owner IDs and correctly failed `Invalid artifact version`; only those fixture
owner IDs were corrected, without changing the artifact reader or content hashes.

The first corrected production run passed 40/42 and reached the new notice-field check after
three image uploads and two font uploads had already reused their assets. That
fixture attempted to fill a field inside the still-collapsed assets panel and
timed out (`/tmp/pr303-round10-2d.log`). It now opens the normal summary before
editing attribution, retaining the distinct-notice and native Undo assertions.
Group fixture colors and a neutral parent transform make the rectangles overlap
and distinguish the actual painted order in its screenshot.
These fixture changes do not alter production panel behavior or input guards.

The intermediate corrected build passed 120 production cases in
`/tmp/pr303-round10-2d-final.log`, `/tmp/pr303-round10-layers-final.log`,
`/tmp/pr303-round10-connection-final.log` and `/tmp/pr303-round10-design-final.log`.
Final diff inspection then found a mask-only record could still determine a
group's position even though it is not painted. `/tmp/pr303-round10-mask-repro.log`
records the unchanged child/front order in that intermediate planner. Group
position and neighbor selection now use drawable records, excluding group and
mask-only records; the full subtree still moves together. The regression includes
both a group-owned mask and a sibling mask. Final gates for that source are
recorded separately below; the intermediate run is not reused as final acceptance.

| Final gate (including mask-only regression) | Result                                                                  | Raw log                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Focused regressions                         | PASS: 28                                                                | `/tmp/pr303-round10-focused-final4.log`                                         |
| All units                                   | PASS: 2,948 / 284 files; 9 existing optional skips (2,940 + 8 isolated) | `/tmp/pr303-round10-units-final.log`                                            |
| Lint / strict TypeScript                    | PASS                                                                    | `/tmp/pr303-round10-lint-final4.log`, `/tmp/pr303-round10-typecheck-final4.log` |
| Tooling / file policy                       | PASS: 111 / 2,444 files, zero failures                                  | `/tmp/pr303-round10-tooling-final.log`, `/tmp/pr303-round10-files-final.log`    |
| Four production builds                      | PASS                                                                    | `/tmp/pr303-round10-build-final.log`                                            |
| Current 2D desktop/mobile                   | PASS: 42                                                                | `/tmp/pr303-round10-2d-final2.log`                                              |
| Layer/migration/save regression             | PASS: 10                                                                | `/tmp/pr303-round10-layers-final2.log`                                          |
| Animation/Slide connection                  | PASS: 64                                                                | `/tmp/pr303-round10-connection-final2.log`                                      |
| Existing Design / independent Host / mobile | PASS: 4                                                                 | `/tmp/pr303-round10-design-final2.log`                                          |

The final fixed-build production suites total 120 (42 + 10 + 64 + 4), with
console/page errors as failures and no automatic retries. The actual overlapping
group/mask fixture and Japanese independent React output screenshots were visually
inspected. Changed-file formatting and diff whitespace pass. Generated evidence
stays outside Git. Old bytes/hash, native inputs/text, authority and selective Undo
regressions remain passing. No dependency or lock changes, Design native/view/template
changes, additional performance measurement, CI/Actions restart, public synchronization,
deployment or merge were performed.

Implementation/test source: `0366fa505aaaf08c62aec3ac0377b8c6640e1aef`.
Completed code snapshot: `work/issue74-2d/review-round10-code`, manifest SHA-256
`b6cfc3d07f4fe889f34288dfc97434a1f3e25b500d6fe772f3160df5b89e8058`.
Export and check each passed a fresh npm dev/optional audit and three OSV queries,
with 1,982 source files plus manifest and zero residual/manifest failures
(`/tmp/pr303-round10-public-export.log`, `/tmp/pr303-round10-public-check.log`).
The receipt-only head's snapshot is reported separately in the PR. PR #301 remains
open at `a8cbdc265eefa5661fa47ff734f99748e90e72fb`; the complete branch merge-tree,
including common connection files, passes without conflicts
(`89169855cfb6dc47e278a8caa29fda8a4c607b15`). This is neither an actual merge nor
combined runtime acceptance. No public repository is synchronized.

## Review of `65a10e74`: explicit policy and preparation boundaries

The user requested investigation of recurring review failures and approved
refactoring PR #303 first, with repository-wide findings against main `bca0cb1`
reserved for separate PRs. Those audit claims are not asserted as current-source
reproductions here. CI/Actions and the other operational holds remain unchanged.

The recurring PR findings cross three boundaries: which references determine a
locked result, how compact native sources expand into render data, and how native
text prerequisites interact with metadata. The implementation separates hierarchy,
lock policy, source resolution, expansion and Animation-specific command preparation.
The schema reader still validates structure, then expansion, then source hashes;
local commands and authority/native text still share the final protection policy.
Public exports, saved schemas and limits are unchanged. Text/font preparation keeps
its four existing phases in one operation, with explicit names and one typed list
of existing text-layer correspondences instead of duplicated pairing loops.
The initial extraction and projection refactor passed 66 focused tests
(`/tmp/pr303-refactor-focused1.log`, `/tmp/pr303-refactor-focused2.log`).

Four new findings (4321214399, 4321214403, 4321214414, 4321214421) are addressed:

- The lock policy derives reverse local-instance dependencies to a fixed point,
  including instances of instances. Referring instance metadata and its parent,
  clip, track and public inputs are protected. This does not freeze unrelated
  unlocked layers in the child owner. Both raw authority submissions and ordinary
  commands enforce it; unrelated edits and actor Undo remain available.
- Layer permutations add all validated layer IDs to authorization targets. A
  composition-only principal is rejected, forged target declarations are rejected,
  and a fully scoped principal can reorder and Undo.
- Slide's object/chooser poster adapter reports output refusal while preserving
  the native embed. It returns a diagnostic placeholder for the object and disables
  placement/adoption in the chooser. The Player's SVG refusal remains intact.
- Each duration action captures the current composition duration before mutation,
  retaining sequential batch semantics for end-aligned versus explicitly trimmed
  layers and exact one-Undo restoration.

`/tmp/pr303-round11-repro.log` records accepted under-scoped ordering, escaped
Slide SVG-size refusal and duration 200 instead of 300. Its initial reverse-lock
fixture used the invalid whole-transform wire path and correctly failed schema
validation; only that fixture was corrected to the scalar transform/x path.
`/tmp/pr303-round11-lock-repro2.log` then records the actual accepted lock bypass.
The corrected focused run initially hit the new real-size poster case's five-second
test timeout (`/tmp/pr303-round11-focused1.log`). Reusing one drawing result for
its assertions, rather than serializing it repeatedly, keeps the real 8-MiB boundary
fixture and refusal assertions. No timeout, output limit or validator was relaxed.
The resulting 41 focused tests pass in `/tmp/pr303-round11-focused2.log`, including
the parent/clip/track/input and forged-target cases.

The first TypeScript pass caught a new fixture using `version.id` instead of the
public `version.versionId`; correcting the fixture restores the declared API
(`/tmp/pr303-round11-typecheck1.log`, `/tmp/pr303-round11-typecheck2.log`). The
first full-unit pass also exceeded the poster case's default timeout under the
combined workload (`/tmp/pr303-round11-units1.log`). Its final real-size fixture
uses repeated long-coordinate geometry with the same embedded image bytes,
rather than thousands of styled runs, and still proves the actual 8-Mi SVG refusal.
The targeted final fixture passes (`/tmp/pr303-round11-poster-final.log`); the full
final source is verified separately below. No browser/output policy is bypassed.

That intermediate source passed 2,953 units and 111 tooling tests
(`/tmp/pr303-round11-units-final.log`, `/tmp/pr303-round11-tooling-final.log`).
Its lock production cases passed four viewport runs (`/tmp/pr303-round11-lock-ui.log`).
The new real-size poster browser case timed out waiting for the imported Slide
object in both viewports (`/tmp/pr303-round11-poster-ui.log`); the failure snapshot
still showed an active local save and the eventual Slide object. Inspection found
repeated preparation/serialization of the same embed during render. The poster
uses the existing inspected schema-2 prepared token, and the Slide adapter retains
results only for platform-deep-frozen embed identities in a WeakMap. Mutable input
is validated on every call; a mutable source changed without a new hash correctly
returns a refusal instead of a stale successful poster. Player/Slide units pass
20 cases (`/tmp/pr303-round11-poster-unit3.log`). Final full-source gates include
these changes; intermediate counts are not reused as their acceptance.

The corrected real-size poster production case passes desktop/mobile without
changing assertion timeouts (`/tmp/pr303-round11-poster-ui3.log`). Its actual
object placeholder and chooser refusal images were visually inspected. The
final full units pass 2,954 (2,946 main + 8 isolated, 284 files, 9 existing optional
skips) in `/tmp/pr303-round11-units-final3.log`. The added mutable-poster case
accounts for the difference from the intermediate 2,953 count.

| Final gate                                  | Result                                             | Raw log                                                                        |
| ------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------ |
| All units                                   | PASS: 2,954 / 284 files; 9 existing optional skips | `/tmp/pr303-round11-units-final3.log`                                          |
| Lint / strict TypeScript                    | PASS                                               | `/tmp/pr303-round11-lint3.log`, `/tmp/pr303-round11-typecheck3.log`            |
| Tooling / file policy                       | PASS: 111 / 2,451 files, zero failures             | `/tmp/pr303-round11-tooling-final3.log`, `/tmp/pr303-round11-files-final3.log` |
| Four production builds                      | PASS                                               | `/tmp/pr303-round11-build3.log`                                                |
| Current 2D desktop/mobile                   | PASS: 44                                           | `/tmp/pr303-round11-2d-final.log`                                              |
| Layer/migration/save regression             | PASS: 10                                           | `/tmp/pr303-round11-layers-final.log`                                          |
| Animation/Slide connection                  | PASS: 66                                           | `/tmp/pr303-round11-connection-final.log`                                      |
| Existing Design / independent Host / mobile | PASS: 4                                            | `/tmp/pr303-round11-design-final.log`                                          |

The final production suites total 124 (44 + 10 + 66 + 4), with one fixed build,
console/page errors as failures and no automatic retries. Actual Japanese React
output, reverse-instance lock refusal retaining the pending input, and oversized
poster/chooser diagnostic screenshots were visually inspected. Changed-file
formatting and diff whitespace pass. The first default-sandbox file check could
not spawn git (`/tmp/pr303-round11-files2.log`); the authorized normal checks pass
without changing the file policy. Generated evidence stays outside Git. Old
bytes/hash, native inputs/text, authority and selective Undo regressions pass.
No dependency/lock changes, Design native/view/template changes, extra performance
measurement, CI/Actions restart, public synchronization, deployment or merge were
performed. The repository-wide main audit remains separate from this PR's scope.

Implementation/test source: `aeb95c8f5c2d204b7dc5ef34bb23050fab1486af`.
Completed code snapshot: `work/issue74-2d/review-round11-code`, manifest SHA-256
`bdde1c4fc0cee9cd00c70d46ee84e681cb62e23eea80a3394fd845257fa6d222`.
Export and check each passed a fresh npm dev/optional audit and three OSV queries,
with 1,989 source files plus manifest and zero residual/manifest failures
(`/tmp/pr303-round11-public-export.log`, `/tmp/pr303-round11-public-check.log`).
The receipt-only head's snapshot is reported separately in the PR. PR #301 remains
open at `a8cbdc265eefa5661fa47ff734f99748e90e72fb`; the complete branch merge-tree,
including the refactored common command-preparation file, passes without conflicts
(`61929ce02a39ac76aaabc694e6dacb78467caae2`). No actual merge, combined runtime
acceptance or public repository synchronization is claimed.

## Round 12: rendered grants and consumer/output ownership

Reviewed head: `e7effc12dfb0093d65a28baec2d8e77a14b8dfca`. Its completed review
reports five new findings (4321433103, 4321433111, 4321433120, 4321433128,
4321433132). None was treated as resolved based on a prior reaction or our report.

- Authorization targets now have one native Animation policy in
  `collaboration-adapters/src/animation-targets.ts`. Both validated states supply
  parent, clip and local-composition rendering dependencies. Inherited transform,
  active-state/time and matching track edits include affected descendants;
  clip-shape edits include clipped dependents. Existing permutation targets remain.
  Rename-only metadata retains narrower grants; exact retained sources retain
  separate immutable ownership. Forged wire targets still fail at authority.
- Derived scenes carry each visited owning snapshot's captured source reference,
  element mapping and reviewed losses. SVG metadata and PNG iTXt use the same
  records. Validated exact reference hashes identify nested owners without hashing
  their content on every frame; repeated instances of that owner share its entry.
  Native schema, retained bytes and hashes are unchanged.
- Slide measures UTF-8 canonical JSON of complete embeds, including consumer
  inputs and wrapper metadata, for its existing aggregate 8-MiB limit. Snapshot
  inspection keeps its own original byte semantics and limits.
- Player input updates render the candidate before committing private inputs.
  Rejected evaluation/serialization leaves the old frame/inputs usable for seek
  and playback. The owner-window autoplay check is shared by initial imperative
  mounting and React's deferred start after restoring the Host playhead. Explicit
  controls remain available under reduced motion.

The old source fails three new unit regressions (`/tmp/pr303-round12-unit-repro.log`):
under-scoped group transform is accepted, captured provenance is absent, and a
small snapshot with legal escaped consumer strings exceeds 8 MiB but is admitted.
The old browser implementation fails all six controlled desktop/mobile cases
(`/tmp/pr303-round12-browser-repro.log`): input refusal followed by seek destroys
the Player, host-allow/target-reduce autoplays, and the inverse preferences block
legitimate target autoplay. The corrected six cases pass in
`/tmp/pr303-round12-browser-fixed.log`; actual retained frame and owner-document
screenshots were inspected. The controlled Host bundles public entrypoints and
runs through ordinary local HTTP. Preference simulation exists only in the test;
no product, output limit or browser policy bypass was added.

The focused final units pass 37 (`/tmp/pr303-round12-focused-final.log`), including
track/clip/local-instance descendant grants, wire-target refusal, metadata-only
rename, peer-preserving Undo, repeated exact-owner provenance, and below/above
complete-embed byte limits. All units pass 2,958 (2,950 main + 8 isolated codec
corpus, 284 files, 9 existing optional skips) in
`/tmp/pr303-round12-units-final.log`. Strict TypeScript, lint, four production
builds and 111 tooling tests pass (`/tmp/pr303-round12-typecheck-final.log`,
`/tmp/pr303-round12-lint-final.log`, `/tmp/pr303-round12-build-final.log`,
`/tmp/pr303-round12-tooling-final.log`). Subsequent browser/source and completed
snapshot receipts are recorded below after their gates finish.

The first full production run caught an incorrect label in the newly added
Design-output test: `getByLabel('Composition')` waited until the existing 90-second
test timeout. The actual public control is labelled `Animation composition`.
Only that test selector was corrected; export assertions, output limits and
assertion timeouts were retained. Its failed run remains separately identified;
the completed final suite below uses the corrected selector.
The intermediate run reports 48 PASS / 2 FAIL in
`/tmp/pr303-round12-2d-selector-failure.log`; both viewport failures identify that
old selector. A new test process runs the corrected source, rather than counting
its unchanged worker cache or retrying the failed action as success.

| Final production gate                       | Result   | Raw log                                   |
| ------------------------------------------- | -------- | ----------------------------------------- |
| Current 2D desktop/mobile                   | PASS: 50 | `/tmp/pr303-round12-2d-final.log`         |
| Layer/migration/save regression             | PASS: 10 | `/tmp/pr303-round12-layers-final.log`     |
| Animation/Slide connection                  | PASS: 68 | `/tmp/pr303-round12-connection-final.log` |
| Existing Design / independent Host / mobile | PASS: 4  | `/tmp/pr303-round12-design-final.log`     |

These total 132 cases on the same four production builds, with console/page
errors treated as failures and no automatic retries. Actual Design SVG/PNG
metadata equals the captured native records, including opaque Japanese source
IDs, mapping and reviewed losses. The exported triangle/images and mobile Slide
retained after consumer-budget refusal were visually inspected. Final lint and
strict TypeScript also pass after the added browser assertions
(`/tmp/pr303-round12-lint-final2.log`, `/tmp/pr303-round12-typecheck-final2.log`).
File policy passes 2,454 files with zero failures; changed-file Prettier and diff
whitespace pass. Generated evidence remains outside Git. The repository-wide main
audit remains separate from PR303. No dependency/lock, Design native/view/template,
CI/Actions, extra performance measurement, public synchronization, deployment or
merge changes were made. The old-byte/hash, native input/text and authority/
selective-Undo regressions remain passing.

Implementation/test source: `68b9bc7d3cb584e8702eb7c93ce4627a8cfd156c`.
Completed code snapshot: `work/issue74-2d/review-round12-code`, manifest SHA-256
`328315e3838f77bf6a3d23486aaf45f58b6b07c908202d58d158d311fcaf5572`.
Export and check each passed a fresh npm dev/optional audit and three OSV queries;
1,992 source files plus manifest pass all manifest/residual checks
(`/tmp/pr303-round12-public-export.log`, `/tmp/pr303-round12-public-check.log`).
The receipt-only head's snapshot is reported separately in the PR. PR #301 remains
open at `a8cbdc265eefa5661fa47ff734f99748e90e72fb`; full branch merge-tree passes
without conflicts (`13a6187bb103d830dadb1f21e1dfaf1269d5d261`). This is a Git
conflict check, not an actual merge or combined-runtime acceptance.

## Round 13: inherited lock grants, first frame and native container drag

Reviewed head: `43dcdbad0754f2db4a213e7533dba1bf1f1bdc1f`. Its completed review
reports 4321656273, 4321656283, 4321656291 and 4321656298; bot reactions are empty.

- Lock authorization now includes the native same-composition parent subtree for
  both lock and unlock. This ownership walk is separate from the rendering graph
  for clips/local instances. Under-scoped changes refuse with unchanged content
  and revision; complete grants permit the change and native actor Undo.
- Player and transport accept a validated initial tick. The first draw uses that
  frame, with the transport clock anchored there. The React hook passes numeric
  poster ticks or samples the editor's live playhead when a mount begins; private
  playback ticks do not trigger remounts. The independent SVG bound is unchanged.
- Evaluated scenes expose native layer poses in the selected composition, including
  non-painting group/composition containers. Stage hit resolution retains an
  already-selected native ancestor, and drag converts world deltas through the
  evaluated parent matrix. `animation/src/scene2/stage-drag.ts` owns preparation
  of the same native patch actions for preview and commit. Native preview evaluation
  keeps child/clip worlds aligned, without another model, history or authority path.
- Animation remains outside the reference Host's existing Comments entrypoint.
  The inspector now retains that same exclusion. The generic anchor resolver has
  no Animation support, so a new annotation UI is not advertised or implemented.
  Normal `activate()` already closes the inspector. The review's inspector-exclusion
  alternative keeps this correction within the existing capability contract.

`/tmp/pr303-round13-unit-repro.log` records both inherited-lock changes accepted
without child grants, and an Animation anchor classified Orphan by the unsupported
resolver. `/tmp/pr303-round13-browser-repro.log` records six old-code failures:
lightweight poster mounting fails on oversized tick zero, selected-group dragging
moves its child, and selected-composition dragging is refused, each in both viewports.
The corrected common Player passes eight owner-document/input-refusal/poster
browser cases in `/tmp/pr303-round13-owner-fixed.log`.

The first TypeScript run caught the new test treating a general Element as an SVG
Element (`/tmp/pr303-round13-typecheck1.log`); the fixture now obtains its containing
SVG through the typed DOM API. The first focused browser run passed four desktop
cases, then was deliberately interrupted at a new Comments test that had not opened
the existing artifact-actions menu (4 PASS, 1 interrupted, 5 NOT RUN;
`/tmp/pr303-round13-targets-fixed.log`). After correcting that menu action, the
prototype annotation case failed because `activate()` correctly closes the inspector
(1 FAIL, 1 interrupted; `/tmp/pr303-round13-comments-fixed.log`). Source inspection
also confirmed that the Animation Comments entrypoint was deliberately excluded.
The temporary annotation/focus extensions and their tests were removed; the final
correction restores the original inspector exclusion. No UI state forcing, alternate
annotation engine, relaxed timeout or output-policy bypass was added. Final browser
coverage exercises that existing navigation/exclusion contract instead.

| Final gate                                        | Result                                             | Raw log                                                                       |
| ------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| All units                                         | PASS: 2,963 / 285 files; 9 existing optional skips | `/tmp/pr303-round13-units-final2.log`                                         |
| Lint / strict TypeScript / four production builds | PASS                                               | `/tmp/pr303-round13-lint-final2.log`, `/tmp/pr303-round13-build-final2.log`   |
| Tooling / file policy                             | PASS: 111 / 2,457 files, zero failures             | `/tmp/pr303-round13-tooling-final2.log`, `/tmp/pr303-round13-files-final.log` |
| Current 2D desktop/mobile                         | PASS: 60                                           | `/tmp/pr303-round13-2d-final.log`                                             |
| Layer/migration/save regression                   | PASS: 10                                           | `/tmp/pr303-round13-layers-final.log`                                         |
| Animation/Slide connection                        | PASS: 68                                           | `/tmp/pr303-round13-connection-final.log`                                     |
| Existing Design / independent Host / mobile       | PASS: 4                                            | `/tmp/pr303-round13-design-final.log`                                         |

Units comprise 2,955 main and 8 isolated codec-corpus cases. The fixed-build
production suites total 142, with console/page errors failing and no automatic
retries. They include a late lightweight poster, an editor remaining at tick 480000
after twenty early-layer duplicates make tick zero exceed the unchanged SVG limit,
group/composition stage movement preserving child transforms and one Undo/Redo,
and the existing Comments exclusion after switching from an open Document inspector.
Actual late-poster, restored-playhead and moved-container images were visually
inspected in desktop/mobile evidence. Parent rotation/scale sampling and both
directions of inherited-lock authorization have unit coverage. Changed-file
formatting and diff whitespace pass. Old bytes/hash, native inputs/text, authority
and selective Undo remain covered by passing regressions. Generated evidence stays
outside Git. The repository-wide main audit remains a separate PR; no dependency/
lock, Design native/view/template, CI/Actions, extra performance measurement,
public synchronization, deployment or merge changes were made.

Implementation/test source: `07d95d91779860afe06512bf34c25b52eae56142`.
Completed code snapshot: `work/issue74-2d/review-round13-code`, manifest SHA-256
`42ea237553bc4824f654a94d3e71d3f9beee6695f42a9c46667bd986b97c3142`.
Export and check each passed fresh npm dev/optional audit and three OSV queries;
1,995 source files plus manifest pass manifest/residual checks
(`/tmp/pr303-round13-public-export.log`, `/tmp/pr303-round13-public-check.log`).
The receipt-only head's snapshot is reported separately in the PR. PR #301 is open
at `a8cbdc265eefa5661fa47ff734f99748e90e72fb`; full branch merge-tree passes
without conflicts (`e363f531339c73c799fce7d32b5d0baefd47b86b`), including the
Animation-only inspector guard in the common Playground file. No actual merge or
combined-runtime acceptance is claimed.

## Round 14: controlled inputs, snapshot sharing and stable references

Reviewed remote/local head: `96fd59837fb5fbb651cc5519c68e310cdd1c9731`.
The October 20 05:54:58 UTC Codex submission contains four new findings
(comments `4321891527`, `4321891535`, `4321891545`, `4321891549`). Its official
summary identifies this exact commit and reports findings; no bot approval was
present. Existing resolved threads and earlier reactions do not certify this head.
The checkout was clean before adding reproductions; no other work was replaced.

- React input-only updates now call the mounted Player's existing atomic setter.
  Resource/transport ownership excludes input values. Updates arriving during
  preparation are reconciled against the newly attached Player; a newer value
  retries a refused initial preparation. Refusal of an update preserves the old
  frame, tick, playing state and controls, with a recoverable input diagnostic.
  Source changes and unmount still abort/dispose only the owned lifecycle.
- The saved catalog prepares each immutable version once and shares its frozen
  native snapshot across composition wrappers. A prepared-token factory checks
  token ownership, wrapper fields, source/hash/composition and snapshot bytes.
  Complete owning-JSON byte/node/string/depth limits include wrapper plus native
  source; only validated immutable source size is reused. Untrusted inspection
  still copies and validates complete JSON. Mutable records are revalidated.
  Playground memoization follows durable saved name/version changes, excluding
  optimistic storage writes and ordinary draft/view updates.
- The trusted core anchor mapper already owns the completed content; it now passes
  that content to the optional domain callback. Animation tests final stable-ID
  existence instead of treating a relocation removal as deletion. Direct legacy
  three-argument callers apply the patch to determine that final state. Native
  text-step mapping remains on the existing text engine.
- SVG metadata and PNG iTXt share ASCII JSON serialization. Escapes preserve every
  admitted opaque identifier through JSON parsing, including U+FFFE/U+FFFF and
  astral characters. Native readers, saved bytes/hash and text serialization are
  unchanged. Renderer/output limits still apply to encoded output.

Reproduction and intermediate attempts:

- `/tmp/pr303-round14-unit-repro.log`: three intended failures. Twenty-one
  compositions retained twenty-one snapshots; Nest orphaned both presence kinds;
  SVG contained a literal U+FFFE. The other 27 focused tests passed.
- `/tmp/pr303-round14-browser-repro.log`: desktop/mobile controlled input update
  changed the caption but lost the playing state (two intended failures).
- `/tmp/pr303-round14-unit-focused.log`: the three reproduction files passed,
  30 tests. `/tmp/pr303-round14-unit-focused2.log`: catalog and prepared-wrapper
  regressions passed, 15 tests. `/tmp/pr303-round14-browser-focused.log`: the two
  controlled input cases passed with the new lifecycle.
- `/tmp/pr303-round14-browser-focused2.log`: an intermediate attempt used an
  HTMLImageElement decode gate, while native readiness actually uses
  createImageBitmap; two readiness checks failed. A broad grep also selected an
  existing stage case while build was replacing its served dist, producing HTTP 404. The attempt was interrupted after these setup failures (three passed,
  three failed, one interrupted, three not run). The readiness fixture now gates
  the actual decoder. Final browser runs use completed, fixed production builds.

The final unit gate passes **2,967 tests / 285 files**, with nine existing optional
skips (2,959 in the main process, eight in the isolated Slide codec corpus):
`/tmp/pr303-round14-units-final.log`. Tooling passes **111**:
`/tmp/pr303-round14-tooling-final.log`. Lint, strict TypeScript, all four production
builds and file policy pass; file policy checks **2,458 files / zero failures**
(`/tmp/pr303-round14-lint-final.log`, `/tmp/pr303-round14-typecheck-final.log`,
`/tmp/pr303-round14-build-pre.log`, `/tmp/pr303-round14-files-final.log`).
Changed-file Prettier and diff whitespace also pass.

`/tmp/pr303-round14-browser-focused3.log` passes eight focused desktop/mobile
cases: mounted controlled updates/refusal/recovery, latest inputs during usable
or refused preparation, and actual Design SVG/PNG output with opaque noncharacters
and astral mapping IDs. Both outputs round-trip exact native provenance/owner hash.
Actual PNG and mobile review images were visually inspected. No retry, browser
policy bypass or native schema/hash change is used.

Final fixed-build production Chromium passes **148 cases**, without retries:
2D **66** (`/tmp/pr303-round14-2d-final.log`), layer/migration/saving guards **10**
(`/tmp/pr303-round14-layers-final.log`), existing connections **68**
(`/tmp/pr303-round14-connection-final.log`) and Design/independent Host/mobile
regressions **4** (`/tmp/pr303-round14-design-final.log`). Console/page errors fail
these cases. These totals exclude focused repetitions. Actual retained-frame and
captured Design PNG evidence was visually inspected in the final run.

The repository-wide main audit stays outside this PR. No dependency/lock changes,
Design native/view/template work, Actions/CI, additional performance measurements,
public synchronization, deployment or merge were performed. Old bytes/hash,
native inputs/text, authority and selective Undo remain covered. Physical devices,
native OS IME, screen readers, other engines and combined PR #301 runtime are
NOT RUN. Public snapshot and merge-tree receipts follow after the source commit.

Implementation/test source: `d40190769adfab17c132af45a4aea90183ddfa62`.
Code snapshot `work/issue74-2d/review-round14-code` has manifest SHA-256
`62b1ab3b3cf1203f234906cfabd99706bf06ee299afd4171335981e8559cde46`.
Export and check each passed fresh npm audit including dev/optional and three OSV
queries, with **1,996 source files plus manifest**, manifest/residual checks and
no public sync (`/tmp/pr303-round14-public-export.log`,
`/tmp/pr303-round14-public-check.log`). The receipt-only head's separately checked
snapshot is reported in the PR.

PR #301 remains open at `a8cbdc265eefa5661fa47ff734f99748e90e72fb`.
Full branch merge-tree against that head passes without conflicts, including the
common Playground and additive DomainCodec callback contract; combined tree
`68080c3bbcff33922763fa2e9fcd29e3b258a1d2`. No actual merge or combined-runtime
acceptance is claimed. Only these verified corrections are eligible for thread
resolution after the same-branch push; latest-head review approval remains separate.

## Round 15: exact version identity and trusted rendering boundaries

Reviewed remote/local head `75a26da397480e561e60e037abbd21257111fe4a` was clean and
matched the branch before changes. The October 20 06:36:32–33 UTC review added
comments `4322133672`, `4322133676`, `4322133683`, `4322133688`. Its official
latest-head summary completed with findings; no bot thumb was present.

- Native retained validation and embed admission share one artifact/version/hash
  registration rule. Embed admission seeds that rule with the root source ref
  before inspecting the validated retained closure, through both ordinary and
  prepared factories. Snapshot/native bytes are not rewritten.
- React seek controls catch the synchronous refusal after the Player's draw-error
  callback has reported and disposed resources. They preserve the original output
  diagnostic and disable failed controls without an uncaught browser exception.
- Authorization derives source/destination composition ownership from validated
  before/after layer-ID maps. Relocation requires both composition grants plus the
  existing affected layer/ancestor grants, independent of wire-declared targets.
- The shared final-state lock policy checks new identities above a protected layer,
  in addition to old pairwise order. Commands and forged wire patches both refuse
  covering insertions atomically. Explicit atomic background insertion below the
  protected stack remains valid, including native actor Undo. No intersection,
  layer-kind or opacity exception bypasses that ownership policy.

`/tmp/pr303-round15-unit-repro.log` records four intended failures (30 other tests
passed): conflicting root exact version, native covering insertion, forged covering
wire patch and missing cross-composition grants were all admitted. The desktop/mobile
seek repro (`/tmp/pr303-round15-browser-repro.log`) reached the diagnostic/disabled
controls but failed the global browser-error fixture on `Animation rendering failed`.

The first focused run (`/tmp/pr303-round15-unit-focused.log`) passed 33 tests but
its raw relocation fixture's Undo assertion compared multi-layer order that its
hand-written patch had not encoded. The grant regression now uses a single-layer
source, isolates relocation ownership and verifies accepted move/actor Undo.
`/tmp/pr303-round15-authority-focused.log` passes all 20 authority cases. The first
strict build/typecheck found missing union narrowing on rectangle-only fixture
width/height assignments; fixtures now assert the rectangle type before assignment.
That failed build is `/tmp/pr303-round15-build-final.log`; it is not final evidence.

Final focused core/authority cases pass **34** after rectangle fixture narrowing
(`/tmp/pr303-round15-unit-focused-final.log`). The full unit gate passes **2,971 /
285 files**, with nine existing optional skips: main 2,963 plus isolated Slide codec
8 (`/tmp/pr303-round15-units-final.log`). Tooling passes **111**
(`/tmp/pr303-round15-tooling-final.log`).

The first focused browser run passes both seek-refusal cases but fails the two
new insertion cases because their status selector also matched the frame output
and an inspector hint. The actual `locked: protected` diagnostic was present.
The selector now identifies that diagnostic within the editor; no product behavior
or assertion was removed (`/tmp/pr303-round15-browser-focused.log`). Final browser
runs use the completed fixed four-target build; no production files change during
the run.

Lint, strict TypeScript, all four production builds, file policy **2,458 files /
zero failures**, changed-file formatting and diff whitespace pass
(`/tmp/pr303-round15-lint-final2.log`, `/tmp/pr303-round15-typecheck-final2.log`,
`/tmp/pr303-round15-build-final2.log`, `/tmp/pr303-round15-files-final2.log`,
`/tmp/pr303-round15-format-final.log`). The full-unit product source is unchanged
by the later fixture type assertion; the final focused 34 cases validate those
exact fixture sources after narrowing.

Final fixed-build Chromium passes **152 cases** without retries: 2D **70**
(`/tmp/pr303-round15-2d-final.log`), layer/migration/saving guards **10**
(`/tmp/pr303-round15-layers-final.log`), existing connections **68**
(`/tmp/pr303-round15-connection-final.log`) and Design/independent Host/mobile
regressions **4** (`/tmp/pr303-round15-design-final.log`). Counts exclude focused
repetitions; browser console/page errors fail every case. New ordinary insertion
cases preserve locked native content after refusal, permit explicit unlock/add and
restore the exact original through two Undos. React seeks to an oversized frame
show the original size diagnostic, dispose failed controls and emit no uncaught
error. Final captured Design PNG and retained-frame images were visually inspected.

Old bytes/hash, native inputs/text, authority and selective Undo remain covered.
The broad main audit remains for a separate PR. No dependency/lock, Design
native/view/template, Actions/CI, additional performance measurement, public sync,
deployment or actual merge changes were made. Physical devices, native OS IME,
screen readers, other engines and combined PR #301 runtime remain NOT RUN.

Implementation/test source: `cfcd04cb63b39d25f4aa11712b6e5ca8c02e0799`.
Code snapshot `work/issue74-2d/review-round15-code` has manifest SHA-256
`9fb67d3a1b781d0c384b754ce6b50bd706e354582a0fccace8dc31fe4dfebbf8`.
Export and check each passed fresh npm dev/optional audit and three OSV queries;
**1,996 source files plus manifest** pass manifest/residual checks
(`/tmp/pr303-round15-public-export.log`, `/tmp/pr303-round15-public-check.log`).
The receipt-only head's separately checked snapshot is reported in the PR.

PR #301 is still open at `a8cbdc265eefa5661fa47ff734f99748e90e72fb`.
Full branch merge-tree passes without conflicts, combined tree
`1cfeb12f2c5c48b3aee9856e853b7b97e0687263`. No combined-runtime acceptance or
actual merge is claimed. Verified thread replies/resolution follow same-branch
push; latest-head Codex completion and a fresh bot thumb remain separate conditions.

## Round 16: native text ownership and registered playback settings

Reviewed remote/local head `0ef663ba6e268323fa75098098bf123e21607855` matched with a
clean checkout before changes. The October 20 07:15:57 UTC submission added
`4322394511` and `4322394525`; its official summary completed with findings and
bot reactions were empty.

- Animation authorization consumes explicit native field paths. The domain patch
  and native text branches both derive targets from the same validated before/after
  ancestor policy. The text branch supplies its actual text/runs addresses, retains
  native steps/version/preconditions/inverse and keeps existing invalidation keys.
  No synthetic patch, alternate authorization or text history is introduced.
- The trusted registered wrapper forwards retained `trigger === 'on-enter'` as
  autoPlay to the common Viewer/Player, as Slide already does. Manual triggers stay
  manual. Owner-window reduced motion and visibility remain enforced by the common
  Player; wrapper/runtime content pins and complete export fingerprints still derive
  from actual source, rather than reusing old generated output.

`/tmp/pr303-round16-unit-repro.log` records child-only native text accepted without
its parent grants (one intended failure, 20 other cases passed). The corrected
case rejects child-only, missing-parent and missing-grandparent scopes with unchanged
content/revision, permits complete grants and removes A's text through actor Undo
while retaining B's later native text. Existing root-level shared/lost-ack tests remain.
Focused authority/registration units pass **23**
(`/tmp/pr303-round16-unit-focused.log`).

`/tmp/pr303-round16-browser-repro.log` records both actual CLI-generated registered
React exports remaining at tick zero under the saved default on-enter setting.
The added expectation follows the existing Japanese authoring/save/native/export
flow and ordinary local HTTP, not a substitute renderer. Both desktop/mobile cases
failed on expected tick > 0, received 0. New wrapper cases additionally cover
manual/on-enter × normal/reduced motion, with explicit play still available.

Final full units pass **2,972 / 285 files**, with nine existing optional skips
(main 2,964 plus isolated codec 8), `/tmp/pr303-round16-units-final.log`.
Tooling passes **111**, `/tmp/pr303-round16-tooling-final.log`. Lint and strict
TypeScript/four production builds pass (`/tmp/pr303-round16-lint-final.log`,
`/tmp/pr303-round16-build-final.log`); the build includes the strict tsc gate.
File policy checks **2,458 files / zero failures** and changed-file formatting/diff
whitespace pass (`/tmp/pr303-round16-files-final.log`,
`/tmp/pr303-round16-format-final.log`). Four fixed Office font hashes pass before
unit/build gates. Browser runs use the completed fixed build.

The first full production run (`/tmp/pr303-round16-2d-final.log`) passed 77 cases,
including all eight trigger/motion cases and both actual CLI-export playback
assertions. Its mobile ordinary shared-text case failed because the simulated End
keystroke left the caret at the start: the correctly synchronized result was
`AText`, while the test intended to append and required `TextA`. The final test
explicitly focuses the native editable, sends Control/Meta+End and verifies the
collapsed DOM selection reaches the text end before typing, on both peers. The
original exact input/synchronization/actor Undo assertions remain unchanged.
Only this browser fixture changes; the fixed product build is reused for final
production runs, with fresh lint/typecheck of the corrected test source.

The corrected full 2D run passes **78**, including both ordinary shared native-text
flows with the original exact append/peer/selective Undo results
(`/tmp/pr303-round16-2d-final2.log`). Native input values, source hashes and the
product build are unchanged by the selection-fixture correction. Fresh lint,
strict TypeScript, file policy and formatting of the final test source pass
(`/tmp/pr303-round16-lint-final2.log`, `/tmp/pr303-round16-typecheck-final.log`,
`/tmp/pr303-round16-files-final2.log`, `/tmp/pr303-round16-format-final2.log`).

Final fixed-build Chromium passes **160 cases** without retries: corrected 2D
**78** (`/tmp/pr303-round16-2d-final2.log`), layer/migration/saving guards **10**
(`/tmp/pr303-round16-layers-final.log`), existing connections **68**
(`/tmp/pr303-round16-connection-final.log`) and Design/independent Host/mobile
regressions **4** (`/tmp/pr303-round16-design-final.log`). Counts exclude the failed
first run and focused repetitions. Browser console/page errors fail these cases.
Actual CLI-generated export images in both viewports were visually inspected:
Japanese text/font, Pause controls and nonzero ticks are present.

Old bytes/hash, native inputs/text, authority and selective Undo remain covered.
No dependency/lock, Design native/view/template, Actions/CI, extra performance
measurement, public synchronization, deployment or actual merge changes were made.
The broad main audit remains a separate PR. Physical devices, native OS IME,
screen readers, other engines and combined PR #301 runtime remain NOT RUN.

Implementation/test source: `c601011e53fbb18329036e76e2ceb39b188ca97e`.
Code snapshot `work/issue74-2d/review-round16-code` has manifest SHA-256
`323e3effb574b123ff67c4dcbdc0551eb5c09930e003ae575c22f7870572c9a7`.
Export and check each passed fresh npm dev/optional audit and three OSV queries;
**1,996 source files plus manifest** pass manifest/residual checks
(`/tmp/pr303-round16-public-export.log`, `/tmp/pr303-round16-public-check.log`).
The receipt-only head's separately checked snapshot is reported in the PR.

PR #301 remains open at `a8cbdc265eefa5661fa47ff734f99748e90e72fb`.
Full branch merge-tree passes without conflicts, combined tree
`a24477eda848cc4a077d977f6d04c3f88ad73b4c`. No combined-runtime acceptance or
actual merge is claimed. Verified replies/resolution follow same-branch push;
latest-head Codex completion and a fresh bot thumb remain separate conditions.

## Round 17: native replacements across base-style changes

Remote and local head `e6263a113af6320252eed6f9c5e9e8884a1d2017` matched before
work. The October 20 07:50:14 UTC review added `4322652401`; the official summary
completed with one finding and bot reactions were empty. Only the owned command
planner, its tests, the capability guide and this record change.

The prior planner encoded new text against the new base style while authority
applied that replacement before the metadata patch, against the old base. New
inherited styles became explicit run overrides. `/tmp/pr303-round17-unit-repro.log`
records five intended failures (fill, size, override, font-add and font-remove),
with 21 other cases passing.

Moving the base patch first made those five forward cases pass, but additional
old-override cases exposed lost original overrides during Undo: the inverse text
steps were then normalized against the new base before restoring the old base.
`/tmp/pr303-round17-undo-repro.log` retains two failures / 26 passes. That initial
attempt and its unit/build/tooling runs are superseded, not final evidence.
The final both-overrides case explicitly exchanges old/new inherited and explicit
values rather than repeating the original-override case.

The planner now owns an explicit working projection. Each native replacement
uses the current engine document/base, advances that target's native version and
projects actual `canvasTextValue`, matching authority instead of assuming raw
requested runs survive normalization. A combined base/text change clears the
old native text, prepares the new base and required font resources, then inserts
the requested text under that base. The empty native document has no inherited
marks to reinterpret. Actor Undo reverses these same steps: clear new text,
restore old context, restore old text/overrides. Remaining font removal, locks and
input ownership keep their final metadata phase. All phases use existing native
steps/domain patches, ordinary per-action validation and one atomic authority
operation. No intermediate state, alternate history or text engine is published.

Focused units pass **29** (`/tmp/pr303-round17-unit-focused-final.log`). Seven
cases cover fill, size, new override, old override, exchanged overrides and font
addition/removal, comparing exact local/shared output, a later base-style edit
and A Undo retaining B geometry. A real two-SharedEditorSession case initializes
both native engines, confirms the combined command at one authority revision,
synchronizes both peers, then retains B geometry and restores original explicit
text runs through A's ordinary session history.

Final full units pass **2,980 / 285 files**, with nine existing optional skips
(main 2,972 plus isolated codec 8), `/tmp/pr303-round17-units-final2.log`.
Tooling passes **111**, `/tmp/pr303-round17-tooling-final2.log`. Lint and strict
TypeScript pass (`/tmp/pr303-round17-lint-final3.log`,
`/tmp/pr303-round17-typecheck-final.log`). Four production builds pass with the
final planner (`/tmp/pr303-round17-build-final2.log`); the later session test
addition is included in the final units and standalone strict TypeScript gate.
Four fixed Office font hashes pass before unit/build gates. File policy checks
**2,458 files / zero failures**, `/tmp/pr303-round17-files-final.log`.

The completed fixed product build passes **160 production Chromium cases** without
retries: 2D **78** (`/tmp/pr303-round17-2d-final.log`), layer/migration/saving
guards **10** (`/tmp/pr303-round17-layers-final.log`), existing connections **68**
(`/tmp/pr303-round17-connection-final.log`) and Design/independent Host/mobile
regressions **4** (`/tmp/pr303-round17-design-final.log`). Both viewport suites
fail on browser console/page errors. Actual CLI-generated registered exports
were visually inspected: Japanese text/font, Pause controls and advancing ticks
are present on desktop and mobile. Changed-file formatting and diff whitespace
pass, `/tmp/pr303-round17-format-final.log`.

Old bytes/hash, native inputs/text, authority and selective Undo remain covered.
No dependency/lock, Design native/view/template, Actions/CI, extra performance
measurement, public synchronization, deployment or actual merge changes were made.
The broad main audit remains a separate PR. Physical devices, native OS IME,
screen readers, other engines and combined PR #301 runtime remain NOT RUN.

The shell's Git credential rejected authentication during the remote check;
authenticated connector reads still confirm the expected remote head. Uploads
therefore use the connected GitHub Git-data API with identical tree verification,
expected-head checking and a non-force branch update. This changes no product
authorization or validation gate. Snapshot/security results and the code/final
source receipt are recorded below after those checks.

Implementation/test source: `3b4d3d8887dde7730ad52ebc18d75e44af4eb048`.
Code snapshot `work/issue74-2d/review-round17-code-api` has manifest SHA-256
`adda041dda18e89396159214561aee6f3925460594a10782ca11c838dcc3f9d6`.
Export and check each pass fresh npm dev/optional audit and three OSV queries;
**1,996 source files plus manifest** pass manifest/residual checks
(`/tmp/pr303-round17-public-export-api.log`,
`/tmp/pr303-round17-public-check-api.log`). An earlier identical-tree export
from the temporary local commit is superseded by this exact API source receipt.
Git-data imports verify the complete commit hash as well as the tested tree;
the API's UTC date needs the original +0900 Git header offset for that hash.
The receipt-only head's separately checked snapshot is reported in the PR.

PR #301 remains open at `a8cbdc265eefa5661fa47ff734f99748e90e72fb`.
Full branch merge-tree passes without conflicts, combined tree
`24e556dd6ac17454448cdf91e174f2fd33460289`. No combined-runtime acceptance or
actual merge is claimed. Verified reply/resolution follow same-branch upload;
latest-head Codex completion and a fresh bot thumb remain separate conditions.

## Round 18: aggregate retained identities, text owners and output admission

Remote/local head `4ff353324b0bd514b8721df38241ea9361be540d` and the clean workspace
matched before work. The October 20 08:36:38 UTC review added `4323042427`,
`4323042433`, `4323042445` and `4323042453`; its official latest-head summary
completed with four findings, with no bot thumb.

- The existing native source-version registry now also accepts the consumer's
  aggregate map. Public playable inspection always performs its normal individual
  validation/cache ownership, then joins root plus recursive schema-2 retained
  identities to that map. Slide uses one map across all pages/objects; schema-1
  roots also participate without changing their snapshots, bytes or hashes.
- Canvas text-edit state records its owning composition as well as layer ID.
  Loss/relocation of the owner clears the unavailable edit state after the native
  editor unmounts. Live targets preserve existing buffers, bridges and stale-input
  guards; read-only/dirty/composing behavior is not bypassed.
- PNG chooses ceil(width) × ceil(height), gates that actual raster area before
  resource decode/allocation, and draws the complete captured image into exactly
  that size. SVG capture/consent/source metadata and its separate bounds stay intact.
- The trusted registered wrapper and document factory share one UTF-8 byte gate
  in `registered-native.ts`. Direct native props pass it before JSON parsing.
  Existing prop character and complete React document limits still apply. The
  transitive runtime-pin regression now also mutates this new dependency.

`/tmp/pr303-round18-unit-repro2.log` records five intended failures / 17 passes:
three deck contradictions (retained, nested retained and root/retained across pages),
a fractional source whose ceil raster exceeds 16 Mi pixels but raw area does not,
and direct registered native data admitted over 3 MiB. The native multibyte example
is individually valid, below the prop character limit and accepted by the complete
4 MiB React document reader. The first reproduction had a missing test import;
the corrected reproduction reaches the expected runtime-admission assertion.

`/tmp/pr303-round18-browser-repro.log` retains desktop/mobile deletion/relocation
stage-selection failures (aria-pressed remained false) and a desktop actual PNG
of 100 × 80 rather than the required 101 × 81. The focus-switch fixture initially
expected a display name different from its native `rect` value; that assertion
was corrected without changing the selection requirement. Worker restarts could
rebuild the source fixture after the product correction, so that mixed reproduction
is not final acceptance evidence. A first focused unit pass reached the correct
Slide rejection but expected an English error; it now checks the existing domain
diagnostic rather than accepting arbitrary thrown errors.

Final focused units pass **22 / 3 files**, `/tmp/pr303-round18-unit-focused2.log`.
They additionally verify consistent repeated pins remain valid, refused placement
leaves original deck bytes unchanged, SVG remains available for the oversized
raster and direct multibyte native below 3 MiB remains admissible. Focused Chromium
passes **10**, `/tmp/pr303-round18-browser-focused.log`: both viewports cover
external target removal/relocation/focus change, decoded PNG right/bottom edge
pixels and ordinary two-peer native text/selective Undo/pending flow followed by
peer deletion. The controlled fixture uses the public Surface and native commands;
the ordinary case uses the existing shared Host and actual reference transport.
Its final acceptance is repeated below against the complete fixed production build.

Final full units pass **2,985 / 285 files**, with nine existing optional skips
(main 2,977 plus isolated codec 8), `/tmp/pr303-round18-units-final.log`.
Tooling passes **111**, `/tmp/pr303-round18-tooling-final.log`. Lint and strict
TypeScript of the final browser fixtures pass (`/tmp/pr303-round18-lint-final3.log`,
`/tmp/pr303-round18-typecheck-final2.log`). All four production builds pass with
the final product source (`/tmp/pr303-round18-build-final.log`); only screenshot
capture paths and the explicit peer-sync precondition changed afterward. Four fixed Office font hashes pass before
unit/build gates. File policy checks **2,459 files / zero failures**,
`/tmp/pr303-round18-files-final.log`. Changed-file formatting and diff whitespace
pass, `/tmp/pr303-round18-format-final.log`.

The first complete 2D run (`/tmp/pr303-round18-2d-final.log`) passed **85** cases
but its desktop shared-deletion extension timed out at the disabled confirmation.
The peer screenshot explicitly shows “Animation changed. Cancel and review the
layers again.” A's resumed geometry had not yet reached B when B captured the
deletion plan. The fixture now waits for B's exact x=260 and confirmed state before
starting that deletion; the final-state/stale-plan guard and all original peer,
text, Undo and pending-export assertions remain. Product source/build is unchanged.
The corrected two-viewport shared case is checked before the full fixed-build
production configurations are rerun; the failed first run is excluded from final
acceptance counts.

The first connection run (`/tmp/pr303-round18-connection-final.log`) passed **67**;
the desktop large-poster case exceeded its 10-second object visibility wait.
The failure snapshot already contains the correctly named imported deck and its
Animation object while local saving is pending. No source, assertion, timeout or
fixture was changed for this failure. The unchanged focused case then passes both
viewports (`/tmp/pr303-round18-poster-focused.log`, **2**); a full connection rerun
is kept separate from that failed first run. No performance acceptance is claimed.

Final fixed-build Chromium passes **168 cases** without retries: corrected 2D
**86** (`/tmp/pr303-round18-2d-final2.log`), layer/migration/saving guards **10**
(`/tmp/pr303-round18-layers-final.log`), unchanged full connections **68**
(`/tmp/pr303-round18-connection-final2.log`) and Design/independent Host/mobile
regressions **4** (`/tmp/pr303-round18-design-final.log`). Failed first runs and
focused repetitions are excluded from this total. The synchronized shared case
also separately passes both viewports (`/tmp/pr303-round18-shared-sync.log`).
Browser console/page errors remain failures. Fixed-build target-recovery stage
images, the actual fractional PNG and Japanese CLI-generated registered output
were visually inspected; the PNG also has decoded edge-pixel assertions.

Old bytes/hash, native inputs/text, authority and selective Undo remain covered.
No dependency/lock, Design native/view/template, Actions/CI, extra performance
measurement, public synchronization, deployment or actual merge changes were made.
The broad main audit remains a separate PR. Physical devices, native OS IME,
screen readers, other engines and combined PR #301 runtime remain NOT RUN.
The connected Git-data upload follows the identical-tree/commit verification and
non-force expected-head checks recorded in Round 17; shell credentials are not used.

Implementation/test source: `3b24b0c2032de95fe4935a6e0089417e35669851`.
Code snapshot `work/issue74-2d/review-round18-code` has manifest SHA-256
`59ae532753dd8ec5d895f44cdb7ab0d3d2370608a8b44c3a182606b0fb2f01d1`.
Export and check each pass fresh npm dev/optional audit and three OSV queries;
**1,997 source files plus manifest** pass manifest/residual checks
(`/tmp/pr303-round18-public-export.log`, `/tmp/pr303-round18-public-check.log`).
Final source file policy/format checks also pass
(`/tmp/pr303-round18-files-final2.log`, `/tmp/pr303-round18-format-final2.log`).
The receipt-only head's separately checked snapshot is reported in the PR.

PR #301 remains open at `a8cbdc265eefa5661fa47ff734f99748e90e72fb`.
Full branch merge-tree passes without conflicts, combined tree
`f10d5767b65653497d3b56ae20bc9fa99b0c2132`. No combined-runtime acceptance or
actual merge is claimed. Verified replies/resolution follow same-branch upload;
latest-head Codex completion and a fresh bot thumb remain separate conditions.
