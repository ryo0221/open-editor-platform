# Actual-original M2 encoded output oracle

Tested code `b5084a87398832f3ebb29242868881cfc524a422`.
Verification-only successor to #219 docs3f1cf986; it does not exercise or certify
that adapter's lifecycle. Its separate race correction is #220. Runtime/native,
normal registry, Rust, Storage and numeric policies are unchanged here.

## Attribution and original identity

Local approved VISION dataset originals from CSP Lab., Department of Information
Engineering, University of Florence (2017), CC BY-SA4.0 per the downloaded
[dataset README](https://lesc.dinfo.unifi.it/VISION/README.txt).
Dataset paper: Shullani, Fontani, Iuliani, Al Shaya and Piva, “VISION: a video and
image dataset for source identification,” EURASIP Journal on Information Security
(2017), DOI10.1186/s13635-017-0067-2. Neither D06 item appears in the README errata.

- D06_V_indoor_move_0001.mov:146163851bytes,
  SHA69e089ae0cc9ad02b7d2461965d6a00d47cb91f7b02e620d10db9ec356731dd4.
- D06_V_indoor_move_0002.mov:152552809bytes,
  SHA2d9e3284f777980c212702f8cbfe03a3817d4ad9a2bd08ef8d21d805cd556022.

Both full original files are imported unchanged. Original SHA keys are checked
before and after both workflows. Local auxiliary monoAAC music is generated at
330Hz/44.1kHz for4.5seconds; it does not substitute for either actual video/voice
source. Original movies, derivative MP4s, archives, screenshots and raw metadata
remain local/outside Git. Attribution records no new license grant or change.

## Two distinct workflows

Direct two-original export reproduces #214's4second UI composition: original1
presentation[0,2), original2[0,2) placed at sequence[2,4), source voices gain1
and zero fades; independent music at[0.001,3.999), gain0.2, linear0.5second fades.
The UI exports portrait1080x1920,25fps,48kmonoAAC, opaque black contain background.
No two-original archive is attempted.

Single-original portable uses original1 presentation[0,4) with the same independent
music. Save produces an original-inclusive archive strictly below existing256MiB.
The initial Host/context closes; a fresh context proves empty OPFS before mounting,
opens only that archive, verifies the entire native content, then exports through
the same UI. This is not combined-two-original portable acceptance: the two full
originals total298716660bytes and remain BLOCKED by256MiB. No proxy/truncation,
capacity increase, history deletion or remote encode is used.

## Independent expectations

The Node oracle imports no production planner, time helper, resampler, reader or
mixer. Native declarations determine clip membership/source mapping; independent
BigInt rational arithmetic selects membership and video source/raw time exactly.
ffprobe reads each original's packet PTS/duration at1/600 and display metadata.
The expected packet must uniquely contain the target source time. FFmpeg selects
that independently determined PTS, applies original display rotation, scales with
aspect preserved and pads to the declared canvas/background. The actual encoded
output is independently decoded and selected by output frame index. Frames
0,1,49,50,51,99 cover both ends and before/at/after the source cut. Returned renderer
PTS/provenance is never used to choose expected pictures.

For audio, FFmpeg independently decodes and resamples each original to48k mono
presentation PCM, checking presentation start0. Exact sample indexes are derived
from native clip start/sourceIn. Independent source-anchored linear fade equations,
gain and stable summation construct expectations for every k=0..191999. Compare
the decoded encoded output at every valid sample, including first/last and cut.
Separate windows[0,256),[47,49),[95872,96128),[191951,191953),[191744,192000)
report boundary errors; no failed or boundary sample is silently omitted.
Any decoder output beyond the native4second endpoint is recorded separately as
trailing codec samples; it is not counted as native-valid PCM.

Unchanged encoded-output tolerances from existing v1/#214 gates: absolute max<0.1,
RMS<0.03 and RGB mean absolute pixel error<8. Every listed audio range must pass.
This is bounded lossy-codec correctness evidence for these declared edits, not
sample identity, exhaustive visual-frame comparison or universal codec support.
The native-output4second endpoint and mono48k/100video-frame geometry are checked.

## Reproduction and failures

`node packages/video-metadata/host-media/m2/actual-output-check.mjs /workspace/video-codec-eval/deps /workspace/video-fixtures/vision-iphone6/D06_V_indoor_move_0001.mov /workspace/video-fixtures/vision-iphone6/D06_V_indoor_move_0002.mov <fresh-output-dir>`.
The runner requires the exact approved SHA pins and fails on a different file.
Use a new output directory each run. `actual-output-oracle.mjs` is verification only.

Prototype `/tmp/video-actual-output-pre` completed both cases while adapter review
arrived. Its source was preserved ind342eeec753c7be5a133e047b388601282725cba,
but execution started before that commit; it is not a clean exact-pin acceptance.
No prototype oracle tolerance failure occurred. It was preserved, not overwritten,
while #220's distinct reproduced FAILs and correction were handled first.
Final summary `/tmp/video-actual-output-checks.json`, logs
`/tmp/video-actual-output-final-*.log`, reports/media/screenshots
`/tmp/video-actual-output-pinned`. Root checks and focused173-unit invocation use
existing commands/paths recorded in PORTABLE-VERIFICATION.md, maxWorkers1.

No performance measurement, automated CI/dispatch, main merge, release, deployment,
normal registry, Rust connection or consuming-product change. Hardware mobile and arbitrary
codecs remain NOT RUN. This does not complete all M2/Epic work.

## Final exact-pin outcome

At cleanb5084a87398832f3ebb29242868881cfc524a422: root type/lint/build/files PASS;
173tests/15files PASS; both actual-original output workflows PASS. Browser errors0;
UI screenshots inspected; full original SHA keys unchanged. No generated video
substitute is used. Runtime source equals the preserved #219 base; this commit adds
verification only, and does not claim #219 race acceptance.

| Output | All192000 PCM max | All192000 PCM RMS | Six selected-picture RGB means |
| --- | --- | --- | --- |
| two-direct | 0.0011913538013274471 | 0.00015960722474604483 | 2.826329, 2.653482, 3.809508, 1.328705, 1.482070, 1.119453 |
| single-reopened | 0.0020244709147761164 | 0.00019902710709888602 | 2.826329, 2.653482, 3.809508, 2.226300, 2.641337, 2.540493 |

All five additional boundary windows pass the same unchanged thresholds; their
exact values are in each oracle JSON. Audio decoder returns192512 samples for each
output; ffprobe independently confirms audio start0 and presentation duration4s,
mono48k. The512 samples beyond native k=191999 are recorded as codec tail, not
silently excluded valid samples. Supplemental endpoint check is preserved in
`/tmp/video-actual-output-pinned/audio-endpoints.json` at the same source pin.

Single archive146242298bytes <268435456bytes. Direct output1970385bytes;
reopened output2006398bytes. Original display rotations from ffprobe are−90° and0°;
expected contain pixels use those original display transforms independently.
No two-original archive was created.256MiB external/scratch and1GiB journal remain.
