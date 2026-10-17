# Private M2 mount adapter

Code `e3ff8cc83624cac2f9b11fd339ac9ff8dfd16603`, separate successor to #218
code26c191bb/docs870d0bbe. Implements the parent-approved minimum from #217.
No #200 branch changes, normal App/catalog registration, public API, Rust backend
or storage policy changes are included.

`prepareV2Workspace` injects the existing persistence factory, codec, optional
immutable archive and a required owning Host leave-guard callback. It creates the
existing M2 Host; no extra EditorSession, SaveCoordinator or history is added.
The caller remains responsible for saved-hash, Library publication and initial
portable registration policy; a missing callback refuses. Native remains v2,
Artifact envelope1; v1 identity/reader is untouched.

When externalSwitching is set, standalone inner Open is hidden, disabled on every
busy-state update and ignored by its event handler. The outer owner cannot retain
a controller made stale by nested replacement. Default standalone behavior remains.
Transition state exposes only private busy/unknown-save/dirty-duration booleans.

`createV2MountSlot` prepares candidates without replacing the live workspace. Each
candidate binds the current owner, controller/input pin and generation. Only the
latest still-current candidate can enter commit. During commit, competing handoff
requests refuse. The previous workspace is made inert, flushes existing bound
inputs, checks pending/unknown save and unapplied duration, snapshots, invokes the
owner's leave guard, and rechecks the pin. Refusal resumes the same owner; stale or
failed candidates close their acquired owners. Success closes previous ownership
before publishing the candidate. Close follows the same guards, then drains pending
candidate preparations. No timeout skips unresolved ownership.

## Browser coverage

`mount-check.mjs <codec-deps> <fresh-output-dir>` builds an isolated two-workspace
harness using the real admitted v2 persistence factory and existing JS product
codec. It generates a local2second AVC/monoAAC source; no user original is rewritten.
At1280/390 it covers:

- Import/edit/save through the actual Host. Unsaved handoff refuses.
- Inner Open stays disabled across notifications and synthetic change events;
  namespace count and native/revision remain unchanged.
- Invalid archive admission, delayed restore superseded by new input, explicit
  dirty-duration refusal, and a caller's pending-publication refusal retain the owner.
- Actual coordinator save held after capture blocks handoff. Real journal commit
  with a deliberately lost ACK blocks handoff/close and preserves the same owner
  until reconciliation. Marked saves retain their1→2→3 order.
- A newer candidate opens a saved original-inclusive archive while an older
  preparation is delayed; old candidate closes and never becomes current.
- Actual JS playback reaches playing, handoff-close refuses during playback,
  Stop settles, then close drains live originals and empties the mount root.
  Every acquired persistence owner closes exactly once. This does not add a new
  independent PCM/pixel oracle or a total-process-memory claim.

The publication predicate is controlled harness policy, not actual normal Library
integration.390 is desktop Chromium narrow-layout coverage, not hardware mobile.
Saved portable bytes come from the actual factory. Shared App registration, real
Library locator tests and Rust integration remain separate owner work.

## Preserved development failures

The first test installed beforeDispatch after schema admission, but the scoped
coordinator had already pinned its callback. The awaited test gate never opened;
the task-owned browser was terminated and `/tmp/video-mount-pre.log` preserved.
The next harness explicitly reported `Save did not enter dispatch gate` in
`/tmp/video-mount-pre2.log`. The corrected test installs a delegating hook before
mount/admission, controls its gate later and races save completion to diagnose an
unentered gate. Native edits ensure distinct saves. No runtime guard, timeout or
capacity was relaxed. Prototype pre3 PASS is separate from final exact-pin results. It permitted either
playing or already-ended playback, so it did not prove cancellation while playing.
At code1c2e89c20b8c98fe50c287435df40a63076b4802, root gates/173 units PASS but
mount FAIL: stricter playing-state assertion exposed final-mix overflow from the
loud generated fixture. Diagnostic pre4 confirmed the expected product rejection
before any chunks. The harness now explicitly applies25% gain through the UI before
saving; no normalization or product range relaxation. Final checks require actual
playing, close refusal while active, then Stop and settlement. Previous summary
`/tmp/video-mount-checks.json` and logs `/tmp/video-mount-final-*.log` retain that FAIL.

A subsequent screenshot inspection at c0fcaf60 found that the reference page's
label display rule overrode the hidden attribute. The inner input was disabled and
its handler refused events, but the control remained visible. The successor sets
inline display:none as well and checks computed style. Prior functional results
and screenshots stay in `/tmp/video-mount-accepted*`; they do not certify the final
visual correction. The earlier portable report's working-tree marker is retained
as recorded rather than asserted clean after an overlapping visual-only edit.

## Remaining work

Independent #218 correction review and this adapter review; shared-owner normal
Host/catalog/build-provenance adoption; actual-original output-oracle plan in
DURATION-VERIFICATION.md; separately reviewed Rust lease/ledger integration.
Combined university-original portable still BLOCKED by current256MiB cap;512MiB
archive/2GiB total policy unanswered, journal1GiB unchanged, no history deletion.
No automatic CI, performance, main merge, release, deployment, public API, consuming-product
or license change. This is a private mount adapter, not full normal M2 acceptance.

## Final exact-pin results

Clean e3ff8cc83624cac2f9b11fd339ac9ff8dfd16603: root type/lint/build/files PASS;
173 focused tests/15 files PASS; mount browser4groups at each1280/390 PASS;
duration review regressions1280/390 PASS; existing portable5groups PASS.
All three browser reports record the same clean source, errors0. Mount screenshots
inspected: inner Open absent at both widths. No legacy v1/normal Library suite was
rerun in this isolated M2 slice; stable #200 acceptance remains on its own pin.
Summary `/tmp/video-mount-final2-checks.json`, logs `/tmp/video-mount-final2-*.log`,
reports in `/tmp/video-mount-final2`, `/tmp/video-mount-duration-final2`,
`/tmp/video-mount-portable-final2`. Fixture media/screenshots/archives stay outside Git.
Focused Vitest uses the four paths listed in PORTABLE-VERIFICATION.md, maxWorkers1.
Main observed5a32d355ac107258a604e5a4d7a45d03f3b9efdb; workflows manual-only,
CI/file-size/Office disabled manually.
