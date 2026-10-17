# Local codec feasibility checkpoint (provisional)

For subsequent HEVC timing correction, actual resend/flush tests, AAC timing
patch/control experiments and remaining consumer failures, see [FOLLOWUP.md](FOLLOWUP.md).
The original evidence below is preserved as the first checkpoint.

This isolated experiment implements the approved local-codec evaluation direction
from #75/#153. It does not register a Host, change shared APIs or manifests, install
a product dependency, or establish a permanent codec contract. No input media is
sent to a remote encoder. Generated fixtures are not actual iPhone acceptance.

## Baselines and scope

- Tested code: `825034a0a4285e428d9bc8a6899be12e2d0dd688`.
- Branch base: `3099182a13e3b9456eaa37753386a5d14aaf3ff3` (#153 documentation).
- Main rechecked: `5a32d355ac107258a604e5a4d7a45d03f3b9efdb` (#52 merged).
- Open #37: `3da6d2cbc6a4d5e414d7596639471877ee3b6701`; #39:
  `93693c9631188b6dd9b7ee5c4098174118770183`; #41:
  `cbe0d8fd5c3505b4be17e405851c15397625e8d6`. No new integration from these PRs.

The scope is generated HEVC decode, actual generated 1080p H.264 file output, and
generated PCM→AAC→MP4 validity. Product import, media-inclusive portable projects,
render/export UI and original iPhone audio/video remain separate gates.

## Functional results

| Exact-code check                                | Result              | Evidence/limit                                                  |
| ----------------------------------------------- | ------------------- | --------------------------------------------------------------- |
| HEVC browser WASM                               | **9 PASS / 1 FAIL** | 3 fixtures × decode/cancel/packet limit plus malformed input    |
| H.264→MP4→full native decode                    | **6 PASS**          | 1920×1080 and 1080×1920; 24, 25, 30000/1001 fps; 12 frames each |
| AAC→MP4→browser/native decode                   | **12 FAIL**         | Valid sample counts exceed supplied PCM length                  |
| Video Core unit tests                           | **54 PASS**         | `npx vitest run packages/video-core` (2 files)                  |
| Focused JS lint, shell syntax, diff whitespace  | **PASS**            | No product runtime changes                                      |
| Root typecheck / lint / build / file-size check | **PASS**            | Normal local checks at the tested code commit                   |
| `build.sh` repeat execution                     | **PASS**            | Configure, incremental static build and bridge relink           |
| Actual iPhone files / Windows                   | **NOT RUN**         | Neither available in this environment                           |
| Performance                                     | **NOT RUN**         | Explicitly paused                                               |

`results.json` preserves per-case results and output hashes; HEVC frame lists are
reduced to counts and first/last frames here. Full local results and generated
files are in `/tmp/video-{hevc,h264,aac}-825034/`. The harness regenerates them.

### HEVC boundary failure remains open

The 8-bit fixture and 10-bit HLG/VFR fixture without an MP4 edit list decode all
12 frames. Raw YUV frame MD5s, PTS, pixel format and dimensions match the native
reference; HLG reports primaries/transfer/matrix 9/18/9. This verifies decoding
and metadata propagation, **not HDR→SDR conversion**.

The original 10-bit HLG/VFR fixture with the default edit list produces 11 frames
instead of the requested 12. Native FFmpeg/ffprobe also expose 11 decoded frames;
container metadata reports 12. Disabling the edit list is a diagnostic factor,
not a correction to the original gate or grounds for dropping its FAIL. The
fixture/container edit interval and terminal presentation boundary need an
explicit expected timeline before product adoption.

Cancellation here means close after two packet steps, followed by a rejected
decode step. Packet-limit and malformed-header rejection pass. Packet/extradata
padding is checked before decoder calls. Forced EAGAIN/resend, buffer-lifetime
fault injection, in-flight Worker cancellation, seek/preroll, truncated flush,
large/untrusted input and allocation-failure matrices are **NOT RUN**. AVFormat
stream discovery precedes the explicit decoder max-pixels setting; this is not
a completed product security boundary.

### AAC adoption is blocked

Both browser and native FFmpeg decode 2,048 samples for 1/17 supplied samples,
46,080 for 44,223 at 44.1 kHz, and 49,152 for 48,123 at 48 kHz. This reproduces at
origins 0 and 0.125 s. Rate, channel count and stream origin checks pass; valid
sample count fails in all 12 cases. Do not pad the expected result to make it
pass. Priming/tail signaling and muxed edit/trim semantics require correction
and independent validation before adopting this candidate. This is not evidence
that every AAC implementation fails.

The supplied PCM contains channel impulses, but peak alignment/waveform quality
assertions remain **NOT RUN**. Original iPhone AAC decode (original priming/edit
offset, seek preroll, tail, A/V sync) is a different, still-unrun gate. Combined
audio+video export has not passed.

### H.264 scope

These are actual native Chromium H.264 encoder output files finalized by the
fixed muxer, independently fully decoded by FFmpeg. Checks cover codec, dimensions,
frame count, PTS/duration (2 µs tolerance) and each frame's generated color
(8/255 per-channel tolerance). They do not prove text/detail quality, browser
playback, long exports, output-file transactional save, audio sync, real media,
HDR conversion or product UI completion.

## Reproduce locally

Sources/toolchain and npm packages live outside the repository. `build.sh` does
not download dependencies; it checks source HEADs and builds portable C/WASM.
The native `/usr/bin/ffmpeg` 7.1.5 GPL-enabled binary is only a fixture generator
and independent decode oracle, not a proposed distributed product component.

```sh
bash packages/video-core/experiments/local-codec/build.sh \
  /workspace/video-codec-eval/ffmpeg /workspace/video-codec-eval/emsdk \
  /workspace/video-codec-eval
node packages/video-core/experiments/local-codec/decode-check.mjs \
  /workspace/video-codec-eval /tmp/video-hevc-new
node packages/video-core/experiments/local-codec/h264-check.mjs \
  /workspace/video-codec-eval/deps /tmp/video-h264-new
node packages/video-core/experiments/local-codec/aac-check.mjs \
  /workspace/video-codec-eval/deps /tmp/video-aac-new
```

Use fresh output directories. Expected current exit codes: HEVC 1, H.264 0,
AAC 1. Chromium is `/usr/bin/chromium` 151 in this Linux environment. The
headless test process uses `--no-sandbox`; this is not a product runtime setting.

## Pinned inputs and distribution boundary

- FFmpeg n7.1.5 source: `3a0867c2bfda4a4d4309ca1a8cbdc6175e67f587`.
- emsdk 4.0.10: `62a853cd3b3134398ce85cde8bb5cbb2ef0194cb`.
- Emscripten source tag: `b7dc6e5747465580df5984e723b9d1f10d8e804b`;
  SDK binary release mapping: `8103ffedfb0c42d231c6af6859a5a1a832260b43`.
- Official downloaded wasm-binaries SHA256:
  `0183f887b56c3f8d4b45826cb49856a3324afb66236ad3c13944c0fd2550cbbc`.
- Official downloaded Node 22.16.0 archive SHA256:
  `f4cb75bb036f0d0eddf6b79d9596df1aaab9ddccd6a20bf489be5abe9467e84e`.
  These hashes identify bytes reread from the pinned official URLs; they are
  not independent signature verification.
- Isolated npm: `mediabunny@1.61.3`, `@mediabunny/aac-encoder@1.61.3`, installed
  with lifecycle scripts disabled. Isolated lock SHA256:
  `c29da29ce08e2459127dcc04b3e173467c3ef5f8dc3f4fa2c82c972ec32f98e1`.
- Tested `decode.wasm` SHA256:
  `bb0cff178a53232b8b367dad12ae641f0a1ecfbd508a1402ed94cff2659ce528`;
  `decode.mjs`: `88a67c914859fd924faaa57e17803c0e11530c53f37163a272a3df55ae937d19`.

Build configuration disables GPL/nonfree/version3, network, threads, assembly,
external auto-detection and filesystem. Generated `config.h` reports LGPL 2.1 or
later with GPL/NONFREE/VERSION3/NETWORK/GPLV3 all zero. Portable-C configuration
reported unknown wasm32 architecture / native nm-format warnings; compilation
and linking succeeded. Sources, configure/build/link logs and static archives
remain in the isolated workspace. WASM starts at 32 MiB and is capped at 256 MiB;
input is capped at 16 MiB, packet steps at 1,000, with read/pixel/frame-size bounds.
These are experimental guards, not adopted product limits or performance findings.

Redistribution compliance is **NOT VERIFIED**. Before distributing any engine,
preserve matching corresponding source, modifications, build inputs/instructions,
relink materials and notices; inspect the AAC extension's embedded engine/build
provenance separately. A source-license label alone does not establish compliance.
No repository license or root package/lock file changed.

## Next technical review

Keep this experiment isolated. Resolve AAC timing and HEVC edit-boundary
expectations, then add resend/flush/lifetime fault coverage and validated HDR→SDR.
Obtain actual iPhone SDR/HDR/VFR/Spatial fixtures and Windows results before
acceptance. Product asset/schema/Host API and dependency integration still require
parent technical review under #76. Portable project closure and combined audio
1080p output remain unimplemented gates; this is not completion of #75 or #77.
