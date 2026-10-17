# M2 private editing controls checkpoint

Tested source `6bf8b9820eea6623036d3d8713a9e396d843d40a`.
Base #208 `1ea90e5ccac50140abed067ca2783a970ab3c6a4`; same Video lane only.
No Storage/Rust/shared Host branch imported. Upstream drafts still require review.

This adds explicit v2 import, clip editing, independent mono AAC placement,
volume/fade controls and source-oriented still preview. The private Host is
isolated from v0/v1 entrypoints. Its lifecycle, scoped controller, SaveCoordinator,
EditorSession, revision guards, inputs and unknown-save behavior are derived
from the accepted private v1 Host, not an alternate history system. Native v2
validators/commands remain authoritative. Existing controlled-content4096node /
65536byte, original256MiB and live512MiB bounds remain unchanged.
The v2 Host copy is deliberately isolated while experimental; shared Host
registration or consolidation requires its owner's integration/review.

`LiveV2`, `PersistenceV2`, `PersistenceFactoryV2` are private provisional seams
for the Storage-owned v2 adapter, mirroring the prior storage lifecycle shape.
The actual entrypoint currently provides no factory: Save/Open remain disabled.
Optional codec play/encode/verify hooks are not supplied, so Play/Export are not
presented as working operations. Still preview uses natural per-source orientation
and display aspect, not a fixed export composition. No output geometry decision
is fixed by this preview.

## Same-pin verification

Root type/lint/build/files PASS; focused87tests/8files PASS.
Desktop1280 and mobile-layout390 browser workflow PASS using both full approved
originals and locally generated mono AAC/M4A (330Hz sine,44100Hz,4.5seconds,
128kbps AAC,faststart). UI trims first original to[0,2), appends/trims second to
[2,4), places music at.001 and trims it to3.999. It sets gain.2/fades.5,
Undo/Redo restores exact native, invalid101% volume rejects atomically, and stereo
AAC import rejects before native publication without destroying pending Redo.
Preview at frame50 displays second original at480x270. Unsaved Save/Open remain
unavailable; Play/Export absent. No horizontal overflow at390; screenshots
inspected; browser errors0. Closing uses the existing owner lifecycle.

Commands: standard root checks and focused test command in
ADMISSION-REVIEW-CORRECTIONS.md. UI:
`node packages/video-metadata/host-media/m2/editing-ui-check.mjs /workspace/video-codec-eval/deps /workspace/video-fixtures/vision-iphone6/D06_V_indoor_move_0001.mov /workspace/video-fixtures/vision-iphone6/D06_V_indoor_move_0002.mov /tmp/video-ui-v2-pinned`.
Reports/logs/screenshots remain outside Git in `/tmp/video-ui-v2-checks.json`,
`/tmp/video-ui-v2-*.log`, `/tmp/video-ui-v2-pinned/`.
Prototype PASS `/tmp/video-ui-v2-pre` is separate from pinned evidence.
This commit does not rerun full PCM/export/Storage gates: prior results keep
prior exact pins. No Storage durability or mobile hardware codec claim.

## Remaining gates

Continuous shared preview/export pipeline and output geometry approval;
Storage-owned exact-v2 profile/original revalidation and portable round-trip;
normal Host integration after reviews; actual two-original portable acceptance
still blocked by unchanged256MiB archive cap and pending numerical policy approval.
The generated small-fixture Storage adapter can proceed independently.
All performance, Actions dispatch, main merge and release remain NOT RUN/held.
This is a private UI checkpoint, not full M2/Epic completion.

## Empty-volume admission correction

Review found that Number('') became0 and caused unintended mute/Redo loss.
The old Host with the new regression failed (`/tmp/video-volume-before.log`):
Set volume returned applied instead of refusing. Corrected source
`20efc41b55f7157dd7aeb4c6da7e625ca30c6063` checks nonempty input,
HTML numeric validity and finite valueAsNumber before issuing a command;
explicit0 remains valid and step=any admits valid fractional percentages.

Same-pin root type/lint/build/files,87focusedtests and actual-original desktop1280 /
mobile-layout390 UI PASS. Regression sets volume, Undo leaves Redo pending,
clears Volume, checks refusal plus unchanged native/revision/input text, then
Redo restores exact gain. Explicit0 succeeds and Undo restores the preceding gain.
Prior101%/stereo rejection, fades and still-preview gates also pass. Evidence
`/tmp/video-volume-checks.json`, `/tmp/video-volume-*.log`,
`/tmp/video-volume-pinned/results.json`. No production native schema or caps changed.
Continuous play/export and Storage remain unconnected at this checkpoint.
