# Explicit audio-only AAC/M4A v2 admission

Code `6ea5e5d989e685925dd97f58826a513eed99d0a4`, clean tree. Builds on #204's
approved-policy Core/mixer slice without changing native v1 behavior.

The bounded metadata parser is shared, with an explicit track-set gate. Existing
mp4ProbeV1 still requires video; audio-only gate requires exactly one audio track.
New interpretation is `video-media-interpretation-v2`, profile `aac-mono-v2`, with
one selected audio stream using the existing rational validity/integer sample-grid
fields. Only AAC-LC mono44100/48000Hz and the existing unfragmented MP4/M4A grammar
are admitted. No generic AAC/ADTS/HE-AAC/stereo/multitrack promise. Packet addresses
must first pass the existing hierarchy/index/disjoint mdat proof. Original256MiB,
metadata and PCM scratch limits are unchanged. The parser refactor causes an
indentation diff; semantic changes are the explicit audio-only gate and adapter.

The PCM reader selects this probe only for `aac-mono-v2`; raw continuous AAC decode,
range reads, sample origin, edit-list validity, ownership and scratch limits are
reused. Old v0/v1 dispatch is unchanged. Pure prepareAudioImportV2 creates one new
source and unlinked clip at an explicit sequence time, with gain1/zero fades. It
validates the whole candidate and rejects locked destinations/unknown fields; Host
must stage immutable bytes and submit through its existing transaction boundary.
No Host registration or Storage v2 dispatch is supplied here.

## Exact-code verification

PASS root typecheck/lint/build/file policy and85tests/7files (Core, planner, new
v2 gain/mix/import and rational-v1). PASS native Chromium audio-only runner:
synthetic real M4A mono44100 and48000 decode/resample, priming/edit origin retained,
old v1 refusal, stereo refusal, errors0 and scratch owners0. Independent FFmpeg
comparison over1024output points at1second:44.1k max6.8470836e-6/RMS1.4228098e-6;
48k max9.3877316e-7/RMS1.1409376e-7. These are source-only resampling tests, not the
full multi-source mix/export oracle. No screenshot is required for the audio-only
harness; it has no new product UI.

PASS same-code second-original AVC/AAC browser reader (152552809bytes, same approved
SHA), and existing baseline indexed-media browser suite. No old accepted evidence
is overwritten. Initial uncommitted profile prototype PASS is stored separately
at /tmp/video-audio-only-pre; it is not used as exact-code evidence.

Run root npm scripts; `npx vitest run packages/video-core/src packages/video-metadata/host-media/m2 packages/video-metadata/host-media/file-source/rational-v1.test.ts --no-file-parallelism`.
Run `node packages/video-metadata/host-media/m2/audio-profile-check.mjs /workspace/video-codec-eval/deps <fresh-directory>`;
second-source-check.mjs and existing indexed-media/check.mjs commands are unchanged.
Node24/Chromium151/Linux. Logs /tmp/video-m2-profile-*.log; report hashes:

- `/tmp/video-m2-profile-checks.json`: `d57b0c2b3ed6c53e0f1cea45b40d2454878365dee4d7aa357771345c27c200a6`
- `/tmp/video-audio-only-pinned/results.json`: `68a1aaf0f90b6671ad522c4bb1c3ebefffcd95f435eb4ecd55cc4d3192fb6954`
- `/tmp/video-second-source-profile-pinned/results.json`: `4f98f35b0aa1d35af9843516e60f1df5bce38cab6b597044f68adb896d8d51ee`
- `/tmp/video-profile-v0-regression/results.json`: `1a474f1eae0167344de8dfba931eb5a88b712ba2f230951827292e48d12e24e2`

NOT RUN/unconnected: normal UI audio-only import, real multi-source mixing,
preview/export scheduling and final-sink failure behavior, Storage-owned v2
portable/retained-version dispatch, combined-original portable acceptance and
physical mobile. No total-capacity change, journal growth, history deletion,
new dependency, CI dispatch, performance measurement, main merge or release.
