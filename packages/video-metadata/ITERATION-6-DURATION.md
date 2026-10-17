# Practical UI iteration 6: explicit sequence duration

Base: #148 `5009b51afb3cea740a0270e075a602132cd1ed76` (authorized integration checkpoint).
Tested code: `63e7f8e9585050c3837534473699565edb2e5b42`.
The subsequent handoff commit is documentation-only.

## Behavior and scope

Two clips can be edited down to 8 seconds while the sequence still retains its
original 55.64-second end. The existing Core `resize` command already supports an
explicit sequence end and validates all clip ends. The Video Surface now exposes
that command through `Sequence duration (rational seconds)` and
`Apply sequence duration`. Enter `8` for this production QA scenario.

Duration is a rational number of seconds (integer or numerator/denominator), using
the existing parser and validator. It does not snap to a frame, infer a new end,
truncate clips, or rewrite sources. A shorter duration that excludes any clip is
refused. Empty sequences can also be resized. Each successful change is one
existing history entry; an equal duration is a no-op and retains Redo.

Duration and independent trim use the existing single Inputs registration and
cannot be pending together. Dirty/composing input, stale revisions, cancellation,
permission/revocation, Save preparation, and history use existing controller
semantics. No Core/Host/Player contract, capacity limit, shared manifest, source
schema, dependency, or license changes are introduced.

## Validation at the tested code SHA

- PASS: focused Video Core/Surface tests 189 in 9 files, including 18 new duration
  cases at desktop/mobile widths (exact-end shrink/grow, invalid input, no-op/Redo,
  dirty/IME, stale revision, empty clips, readonly/missing Inputs, revoke).
- PASS: root typecheck, lint, build, file-size and diff checks.
- PASS: pinned kit verification and offline install/types/build for both Hosts.
- PASS: installed duration 8 cases: both Hosts x 1280/390 x editable/readonly.
  Editable cases check 55.64 -> 8, reject 7, unchanged clip/source data, one revision,
  Undo/Redo/no-op, dirty/IME refusal, native Save/Reopen/reload, revoke and overflow.
- PASS: installed long trace 8 cases (20 history operations plus refusal/recovery per
  case), and short-clip/zoom/readonly/boundary/cancel regression 28 cases.

The installed scenario deliberately uses two synthetic metadata clips on one
source, not the two H264 media assets. Desktop/mobile screenshots were inspected;
labels and Apply controls remain visible with no document horizontal overflow.
No physical touch or OS-level IME acceptance is claimed.

Kit: `/tmp/video-duration-final-kit`; consumers: `/tmp/video-duration-final-consumers`.
Provenance SHA-256:
`502a330dc7afb7b39d6eed75d428971b97134d81a9e8aa75949a05ebb8a36b36`.
Logs: `/tmp/video-duration-final-{tests,pack,verify,prepare,installed,long,short}.log`
and `/tmp/video-duration-{types,lint,build,files}.log`.
Screenshots: `/tmp/video-duration-{reference,independent}-{1280,390}.png`.

Initial harness attempts failed (wrong DOM assertion API, widened test mode type,
and copied unrelated keyboard assertions). Those test-only issues were corrected;
initial failure logs remain in `/tmp/video-duration-{first,installed}.log`. The
first typecheck failure is described here because its log was replaced on rerun.
Final evidence above comes from the corrected exact code commit.

## Integration handoff and remaining gates

#76 should add the duration UI step (`8` then Apply) after its two-asset edit and
before playback acceptance in the existing production QA harness. Check native
sequence duration equals 8 and preserve clips/sources, then evaluate playback end
and history. This shared harness is intentionally not edited by the Video lane.
The actual H264 assets are absent locally, so that acceptance and real-media Save
are NOT RUN. Metadata fixture Save is not a substitute for media persistence.
General import/probe, audio/export and #149 design expansion remain out of scope.

Read-only comparison found #148 advanced to
`e07605fc024eaf20c9c325eecf0d9ae8feaa18be`; its additional files were Geo/shared docs,
with no Video overlap. That newer checkpoint was not imported or validated here.

Manual-only workflow definitions remain unchanged. CI/file-size/Office remain
manually disabled. No Actions enable/dispatch, performance measurement, main push,
merge, release or deployment was performed. Performance and full legacy suite
remain NOT RUN. This is a narrow UI correction, not Epic completion.

## Independent review correction: callback reentry and isolated IME gate

Superseding tested code: `37ad197ba33efc12ee1086c5119350f173ba0de3`.
The next documentation commit does not change executable code.

The Host `onTimelineIntent` callback can synchronously dispatch another input.
Previously, the outer handler checked the input kind only before that callback,
then overwrote an accepted inner draft's kind. The handler now rechecks ownership
following the callback and lifecycle check. An accepted inner draft remains the
owner; a conflicting outer duration/trim input is explicitly rejected in status.
Its Apply button is disabled until the accepted draft is applied or cancelled.
No new reservation API or aggregate commit behavior is introduced.

Regression: duration -> trim, trim -> duration, and duration -> composing trim at
1280/390. All six fail against the prior code and pass with the correction. Each
checks the retained inner value, explicit rejection, disabled conflicting Apply,
unchanged content before Apply, IME refusal where applicable, exactly one command
and revision, correct duration/clip start, and Undo/Redo. The initial selector-only
harness attempt was corrected before the valid before/after comparison.

Installed IME coverage now uses valid duration 9 after explicitly cancelling the
invalid 7 draft. During composition, both Apply and Save must leave content and
revision unchanged, with zero writes. After compositionend, Undo stays blocked
until explicit Apply; that Apply changes duration to 9 in exactly one revision.
Undo restores 8. This is checked on both installed Hosts at both widths, so an
invalid-value refusal cannot mask a broken IME gate.

Exact-pin results: PASS focused 195/9 files; root types/lint/build/file-size/diff;
package verify and both offline installed Hosts; duration 8; long trace 8; existing
short-clip suite 28. The short-clip harness is unchanged. Existing readonly,
gesture, dirty Inputs and single-command regression coverage remains included.

Kit `/tmp/video-duration-reentry-kit`; consumers `/tmp/video-duration-reentry-consumers`.
Provenance `9cf9b029db414f5a2d0897bf155e8c9fc8796e200d33255733d11af60230a281`.
Logs `/tmp/video-duration-reentry-{before-valid,tests,types,lint,build,files,pack,verify,prepare,installed,long,short}.log`.
Actual-media and other NOT RUN gates above are unchanged. #76 adoption still needs
reviewer GO; this correction does not authorize integration or merge.
