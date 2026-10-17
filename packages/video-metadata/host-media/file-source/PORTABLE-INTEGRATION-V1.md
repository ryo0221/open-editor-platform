# Conditional v1 portable integration checkpoint

Historical checkpoint. The later same-code integrated gate is recorded in
[FINAL-V1-ACCEPTANCE.md](FINAL-V1-ACCEPTANCE.md); its completed result supersedes
the blocked/NOT RUN status below without deleting the earlier failures.

Context `2537a7e72b6b768c010df6c7e95874bf50aa614d` combines Video #197 with
parent-authorized Storage #196 docs2d366d721254ef23889f65a1b476106a0bce1bb0
(runtime d3702f7f470890b971334dc4e7281e104a2714f6, later tests2f7e1b430930845fec66b0b9a654481627baf3ae).
No main or GitHub PR merge. Storage-only limitedGO is not actual-media acceptance.

## Same-owner unknown recovery

Host code `eed4975ccda15c2168f24f974124d95ece1d5340` adds optional private
PersistenceV1.reconcile(operationId,signal):Promise<WriteEvidence>. Evidence is
passed only to the same existing owner.saves.reconcile; only its definitive
observation clears the unknown latch. Still-unknown evidence keeps originals and
blocks new Save/Open/disposal. A close already awaiting Save that becomes unknown
refuses, resets its terminal/closing state, and allows same-owner reconciliation.
It does not drain persistence before that resolution, fabricate no-write or replace
the coordinator. UI and non-UI callers share these guards.

At that exact clean pin: PASS Host browser regression/errors0, root lint/file policy.
The injected-seam browser proof covers pending-close refusal, still-unknown receipt,
committed receipt, next Save, replacement and exact cleanup of both owners. It is
Host ownership evidence, not storage-durability proof. Core/storage tests initially
FAIL155/156: existing archive F01 exceeded its5000ms timeout while root checks ran
concurrently. Same exact pin with --no-file-parallelism: PASS156/156. No test timeout,
production limit or implementation was changed. Preserve both logs.

Root typecheck/build FAIL at Storage-owned integration/v1-harness.ts:102: old
host.handle reference. #195 removed that unrestricted bypass; the harness must use
host.editor.save() and unwrap its SurfaceSaveResult.outcome. Storage factory must
also expose reconcile by delegating to its existing SAME live storage.reconcile.
Requested exact patches and actual-factory unknown-recovery coverage in #196
comments6139130349/6139217275. Video has not edited Storage-owned files.

Logs /tmp/video-v1-reconcile-{type,lint,build,files,unit}-pinned.log and
/tmp/video-v1-reconcile-unit-serial.log. Browser
/tmp/video-v1-reconcile-host-pinned/results.json. Code Actions0.

## Prepared actual-original gate

Harness code `bc8809e18daa68960ad7209333a87bca5ca40547` (lint PASS) implements
normal Host factory wiring, full retained compressed-source/interpretation probe
comparison through the shared external opener, and explicit fixture budgets:
original256MiB/liveUndo512MiB/scratch256MiB/external256MiB/journal1GiB. These are
separate quotas, not total-resource or production-capacity guarantees. No shadow
ZIP validator/history. The same immutable originals remain byte-identical.

The prepared browser flow saves imported whole original, a linked split and restored
whole native as three retained versions; closes the browser; launches new processes
with verified empty origin storage using only the portable file; verifies retained
versions/hashes/plans/original SHA; saves a fourth version; previews/plays; exports
whole-original MP4 and independently decodes/compares it. Desktop/mobile are1280/390.
The gate explicitly requires the real factory reconciliation port before acceptance.
Run after the two owner patches:

```
node packages/video-metadata/host-media/file-source/portable-ui-v1-check.mjs /workspace/video-codec-eval/deps /workspace/video-fixtures/vision-iphone6/D06_V_indoor_move_0001.mov /tmp/video-v1-portable-final
```

Actual146163851-byte save->emptyHost reopen is currently NOT RUN. The whole-original
normal unsaved UI/export PASS remains pinned to #197, not relabeled as portable
acceptance. Native/interpretation/portable v1 is explicit; #196 retains generic
artifact envelope schemaVersion1, differing from the earlier requested2. This
compatibility interpretation was reported to the parent before conditional wiring;
no v0 migration or shared envelope implementation change is introduced here.
CI/performance/main/release/deploy/publication/license holds remain in place.
