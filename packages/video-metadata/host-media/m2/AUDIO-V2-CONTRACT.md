# Approved M2 audio policy — first isolated implementation slice

User approval covers gain0..1, linear-amplitude fade, preserved trim/split time
function, final mixed-sample rejection without automatic correction, separate
AAC/M4A audio admission and explicit new native/profile version. Capacity increase
is NOT approved by that policy; journal/history and current portable caps stay put.

This first code slice adds opt-in `video-core-prototype-v2`, preserving all v1 source
and time fields. Every audio clip adds mandatory `gain` and
`fade:{start:Time,end:Time,in:Time,out:Time}`. Anchors are source-presentation times
inside the original validity; ramps are nonnegative canonical durations whose sum
cannot exceed anchor length. They define a fixed linear amplitude function. Zero
ramp means no attenuation at that side; nonzero ramps clamp amplitude fraction to
[0,1]. A clip's source time is evaluated from absolute sequence k/R, then gain is
applied. Trim/split retain anchors unchanged; move shifts placement, not the source
function. Explicit fade editing intentionally re-anchors on the current clip.

Existing videoCommandV1 performs all structural edits on an internal timing-only
projection. V2 reattaches effects by stable ID/exact split map and validates before
return. This projection is not a persisted downgrade or migration. Existing
EditorSession supplies atomicity/Undo/Redo; no alternate history. Old validators,
old bytes and hashes remain unchanged. `adoptVideoContentV2` is an explicit owned
new-draft transformation only; it does not rewrite saved/retained versions.

The shared private block mixer accepts a validated owned v2 snapshot and an injected
resampler port. It requests all enabled audio contributions using the existing
planner, max2simultaneous contributors, mono48000Hz, max4096output points. It does
not declare wider codec or stereo support. Resampling precedes gain/fade at global
k/R; stable track/clip ordering and Float64 sums precede final finite/[-1,1] checks.
Partial sums are NOT range-rejected. Only a fully validated Float32 block returns;
preview must not schedule before resolution and export must not finish its sink on
failure. Those consumer connections are later gates, not implied by pure tests.

## Ownership and remaining implementation

Video owns v2 Core, shared mixer, audio-only probe/reader profile and private runtime
adapters. Shared/Extension keeps normal Host/App/registry/#76 contract ownership.
Storage must own explicit v2 portable/interpretation dispatch and preserve all old
retained versions. Proposed names `video-media-interpretation-v2` and
`video-file-zip64-candidate-v2` were sent in #75 comment6142432367 for coordination;
no Storage dispatch is implemented here. Generic Artifact envelope remains1.

AAC-only reader/probe, actual multiple-original runtime, persistent UI controls,
preview/export consumer validation, retained-version portable roundtrip and
independent mixed-audio oracle remain NOT RUN/unconnected at this slice. Actual
combined originals exceed the existing256MiBportable cap; capacity review remains
a blocker for that combined portable gate. No cap increase, journal growth or
history deletion. Rust implementation remains a separate milestone-gated stream.

## Original provenance

Approved second original is local-only at
/workspace/video-fixtures/vision-iphone6/D06_V_indoor_move_0002.mov.
Bytes152552809; SHA256
`2d9e3284f777980c212702f8cbfe03a3817d4ad9a2bd08ef8d21d805cd556022`.
[University source](https://lesc.dinfo.unifi.it/VISION/dataset/D06_Apple_iPhone6/videos/indoor/D06_V_indoor_move_0002.mov),
[license/errata](https://lesc.dinfo.unifi.it/VISION/README.txt): CSP Lab., Department
of Information Engineering, University of Florence(2017), CC BY-SA4.0. Existing
README/metadata remain beside it. No media upload/publication/redistribution.

Independent ffprobe: AVC High,1920x1080,yuv420p,limitedBT709SDR, videoT42591/600,
2130video packets (2121x20ticks,9x19ticks), PTS=DTS, no rotation side-data; publisher
rotation0. AAC-LC mono44100. Edit-applied packet view and raw sample tables are
reported separately; never substitute nominal FPS or rounded duration for clocks.
Raw local reports include second-original-download.json/second-original-ffprobe.json/
second-original-inspection.json. Browser raw-reader proof is a separate check.

Before pinned tests, initial3-test development run had1FAIL from a harness calling
nonexistent EditorSession.getContent(); changed to the actual public content getter.
The failure log is /tmp/video-m2-audio-pre-unit.log. Subsequent8focused tests PASS;
this does not erase the initial failure. Final exact-pin checks follow separately.

## Exact first-slice result

Code `eb019798328c93f3321502002a54a0974c34e86f`, clean tree: root typecheck/lint/build/
file policy PASS; focused v2 tests plus existing Core/planner/rational tests PASS
(see /tmp/video-m2-audio-unit.log). No v1 implementation file changed. The initial
harness failure remains recorded above. Browser second-original reader PASS/errors0:
raw AAC3133440points/3060packets, validity end14197/200, final videoPTS42571/600,
rotation0, reader/scratch owners0 after disposal. Screenshot inspected; no whole
original File.arrayBuffer. This is the existing reader's new-original proof, not
v2 UI/mix/export acceptance.

Results: /tmp/video-m2-audio-checks.json SHA256 `c35be2569da2fc53060b1ee6542a29c99bbf1b07873803481aa7a68680e17333`;
/tmp/video-second-source-pinned/results.json SHA256 `9ba162ff4fb41974f5507ac10f9895f124f635c344832ef085ef4f52df1a21da`.
Reproduction: root npm scripts, `npx vitest run packages/video-core/src packages/video-metadata/host-media/m2 packages/video-metadata/host-media/file-source/rational-v1.test.ts --no-file-parallelism`,
and `node packages/video-metadata/host-media/m2/second-source-check.mjs /workspace/video-codec-eval/deps /workspace/video-fixtures/vision-iphone6/D06_V_indoor_move_0002.mov <fresh-output-directory>`.
No CI/performance/main merge/release/license change.
