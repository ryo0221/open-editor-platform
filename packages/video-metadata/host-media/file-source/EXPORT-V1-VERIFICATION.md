# Full-original exact endpoint export checkpoint

Exact code `e1c43a515d7ae27b0e33d0cb6f1bb13283e6aba3` (#192), clean tree.
Source is the unchanged146163851-byte approved iPhone fixture, SHA
`69e089ae0cc9ad02b7d2461965d6a00d47cb91f7b02e620d10db9ec356731dd4`.
This is real local decode/render/encode; no shortened original, proxy or remote codec.

PASS at this SHA, Node24.19/npm11.9/Chromium151/FFmpeg7.1.5:

- Root typecheck/lint/build/file policy,89 Core/renderer/v1 tests.
- Whole interval42251/600 seconds exported as1080×1920 AVC + mono48kAAC.
  Output34333501bytes under explicit64MiB stage cap, SHA
  `9b8e138cfb7d969b9658e9e2c38f2b34813cd3647acca1cb893c45b95d4895bc`.
- Independent FFmpeg full decode succeeds. ffprobe:1761 video samples at1/48000;
  final packetPTS3379200,duration880. Thus last interval is[70.4,42251/600),
  exactly11/600seconds. Both stream presentation durations equal the original T.
- Valid output PCM has3380080 mono sample points, all finite. Independent decoder
  emits3380224 raw samples, including144 codec padding samples outside validity;
  they are not redefined as original presentation. Head/middle/tail256-sample
  comparison to independent source decode/resampling: maximum0/0.000349832/
  0.000852002, RMS0/0.000150680/0.000251765 (required max<0.1,RMS<0.03).
- Independently decoded first/middle/final pictures compared against original
  VFR sourcePTS0/21116/42231 @600 after correct90deg orientation. Mean RGB
  differences2.03815/1.58470/1.22370 per255 (required<8). Browser errors0.

Generated-output correction first verifies muxer timestamps against submitted
rational intervals. It preserves coded media bytes, gives video exact integer
frame durations, and keeps audio decoded grid/padding separate from presentation
edits. Unexpected B-frame/composition layout, timing drift or overflow refuses.
No common Time or v0 codec semantics changed. This private profile requires
contiguous unity-rate two-track/single-original timelines, mono source, portrait
orientation,25fps output,0.1–90seconds and bounded output staging. It is not a
streaming-large-output or general codec guarantee. Shared v1 PCM phase is used
by the private playback adapter; actual v1 ordinary Host playback is a next gate.

Raw logs `/tmp/video-v1-export-*-pinned.log`; output, packet/stream proof and
independent oracle in `/tmp/video-v1-export-pinned/`. Earlier working-tree export
first failed because a test download wait was not observed on failure; second
exposed inherited stereo-only chunk hashing. The v1 hash/playback adapter is mono;
third and final pinned exports passed. First oracle shell invocation had an extra
parenthesis and did not execute; corrected oracle and final pinned run passed.
These intermediate logs remain outside Git; none is claimed as final acceptance.

NOT RUN here: v1 ordinary Host original-inclusive portable save/reopen, real-device
or physical acoustic A/V timing, HEVC/HDR/general MOV, performance. Storage v1
schema/open-helper handoff remains a separate owner dependency. All workflows
manual-only; code Actions0. No main push, merge, release, deployment or license
change. Existing v0 Host regression is pinned separately in #191.
