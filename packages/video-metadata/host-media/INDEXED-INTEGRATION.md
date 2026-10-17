# Indexed audio preview and two-segment product workflow

Code gate: `29585c8b3d48320531e11f9e295a27035cba15b7`, clean checkout.
Main baseline: `5a32d355ac107258a604e5a4d7a45d03f3b9efdb`.
Branch: `codex/issue-75-indexed-integration`, stacked on #174 docs
`355d665173084019533174232623f1e4bbdc61b4`, including reviewed #171.
No #170/#172 storage implementation or other lane changes were incorporated.
This is private product integration, not full #75 completion or a permanent API.

## Actual product behavior

The existing Host now uses indexed readers for exact frame preview, audio playback,
and MP4 export. Playback and export use the same `PcmRenderSession`, global integer
sample phase, `edge-hold-v0` boundary policy and raw-PTS video selector. No new
history, save coordinator, native model, remote encoder or dependency was added.
The new move-to-frame field submits the existing linked native move command.

The actual browser workflow imports the 48-second generated original, previews
47.96 seconds, splits at 46 seconds, independently trims the earlier video/audio
pair to source [1,3), removes the intervening material, and reorders the retained
pairs to source [46,48) followed by [1,3). The four-second result contains two
video and two audio clips. Save includes the original. The first context is closed;
a new empty Host/context reopens only that bundle and preserves the native model.

A real AudioContext plays the reopened timeline. `currentTime` is used for audio
scheduling; `getOutputTimestamp().contextTime` maps the output position back to a
global sample and the corresponding video frame. Without that method, the UI
explicitly labels the `currentTime - outputLatency - baseLatency` estimate.
The independent picture loop continues while PCM reads await I/O. Late pictures
are skipped rather than drawn at a stale audio position. This does not promise
every frame is displayed or establish physical speaker/display latency.

The provisional scheduling policy uses 1,920-sample chunks (40 ms at 48 kHz),
roughly 240 ms lookahead and an 80 ms initial/rebuffer lead. Suspend freezes the
context clock. On underrun, the player waits for queued valid samples to reach
output, freezes at their end, then starts a new scheduling origin; it does not
invent PCM or skip sequence samples. Seek/stop/edit/revoke abort the playback
owner, stop scheduled sources, close the AudioContext, and await reader cleanup.

Exact eligibility remains deliberately narrow: one original, contiguous enabled
AVC/AAC stereo-48-kHz tracks, unity video speed, 25 fps output grid, 16:9 source
at most 640×360. Playback/seek admits up to 60 seconds of sequence; export up to
10 seconds. The exercised export is four seconds, 1080p AVC + AAC. Original import
still has the existing 16 MiB gate. These ceilings are not general-media acceptance.

Silent and wider originals retain independent browser-native **reference** frame
preview, clearly labeled as not frame/sample accurate. Export refusal does not
undo import or report a committed import as failed. Silent 320×180 and wider
1280×720 cases preview, retain native state after export refusal, and save originals.

## Resource and #174 review corrections

- PCM build/preflight admission is reserved before metadata reading/parsing.
  Parallel preflight refusal performs zero additional metadata reads.
- Before any demux payload access, the validated `stsz` table limits each declared
  sample to 1 MiB and `stsc` + `stco/co64` mapping validates its file range. The
  narrow profile rejects unsupported compact `stz2` instead of fetching it.
  This also covers first/following key packets. At most two tracks are expanded.
- Packet acquisition is explicit `getFirstPacket/getNextPacket`, not adaptive
  `packets()` prefetch. Metadata reads remain bounded at 8 MiB. The 1 MiB
  BlobSource cache setting is a **soft LRU configuration**, not a measured hard
  resident-memory cap. Codec-internal allocations are not measured here.
- Video returns explicit release-owned clones, at most two outstanding/queued
  requests per reader. Clearing a GOP cannot close a returned clone. Disposal
  awaits releases. Two concurrent cross-GOP returns remain live; a third is refused.
- PCM scratch remains one build, four files/128 MiB, two reads, 32,768 samples per
  read, with unique immutable hash/stream/policy/generation identity. These are
  per-realm budgets, not crash recovery or an origin-wide lock.
- Export interleaves bounded PCM/frame submission. A paged StreamTarget enforces
  a 32 MiB output-stage ceiling with 64 KiB chunks. Final materialization and
  metadata correction still make bounded output copies; this is not large-file
  streaming export. No whole-PCM array or whole-original media decode is used.
- Existing #171 ownership of both track closures and AAC worker/RPC termination
  remains in place. Original hashes are still verified by existing import/bundle
  paths; the large-original streaming hash/storage review remains separate.

## PASS at the code gate

- Desktop 1280 and mobile-width 390 actual import/edit/save/new-context reopen,
  47.96-second source seek, synchronized playback, four-second two-segment export.
- Playback replacement closes the old context; stop closes the current context.
  Actual suspend/resume, injected delayed PCM read -> rebuffer, and explicitly
  labeled estimated-clock fallback pass. Every presented frame records the actual
  output-clock origin and sample mapping; its raw PTS matches export selection.
- All 100 scheduled PCM chunk hashes match export chunks at identical global
  sample ranges, including the segment boundary. Headless software output-clock
  evidence is not acoustic loopback or physical-device lip-sync certification.
- Independent FFprobe verifies both tracks start at zero and last four seconds;
  all 100 decoded video PTS equal i/25. FFmpeg verifies green -> white -> blue
  segment markers and the retained right-channel impulse at sample 34,560 (0.72 s).
  Valid presentation is 192,000 samples/channel. FFmpeg returns 192,512 decoded
  samples including padding beyond that interval; this is recorded, not hidden.
- Indexed-reader checks: five independent continuous-FFmpeg comparison windows
  total **2,944 samples/channel**, assertion maxDiff < 0.0001, observed difference 0.
  This is not a full 48-second bitwise oracle. Oversized declared samples reject
  during metadata preflight without payload reads/publication; concurrent preflight
  rejects; cross-GOP clone ownership, read/write/close cancellation and quota fault
  injection pass. Scratch/session counters drain to zero.
- Silent/wider reference preservation and original-inclusive save pass.
- Three crossed-track/late-init probes, two actual finalize probes, previous short
  product desktop/mobile-width workflow, 137 focused unit/browser tests, typecheck,
  repository lint, build and file-size checks pass.

Raw evidence, outputs and screenshots are outside Git:
`/tmp/video-integration-{final,reader-final,reference-final,track-final,finalize-final,short-final}/results.json`;
`/tmp/video-integration-{type,lint,unit,build,files}-final.log`.
The long checks record the exact code SHA and empty working tree.
Original generated fixture SHA-256:
`caea86f9196bd0ef530da1de419aa5423716b69af7a1a93f2e0d6b9213091970`.
Export SHA-256 (1280): `a041b043cc57c26d48579653fb6b5ca53781ba2b911f6586cbcd1f0399fe263d`;
(390): `58282f4a4968994021c335b1e24ac368e06e2c2573b69486e69b0c442f32009b`.

Reproduction (output directories must not already exist):

```sh
node packages/video-metadata/host-media/indexed-media/check.mjs /workspace/video-codec-eval/deps /tmp/video-integration-reader-final
node packages/video-metadata/host-media/integration-check.mjs /workspace/video-codec-eval/deps /tmp/video-indexed-pinned/source.mp4 /tmp/video-integration-final
node packages/video-metadata/host-media/reference-check.mjs /workspace/video-codec-eval/deps /tmp/video-indexed-pinned/source.mp4 /tmp/video-integration-reference-final /workspace/video-fixtures/vision-iphone6/D06_V_indoor_move_0001.mov
node packages/video-metadata/host-media/track-check.mjs /workspace/video-codec-eval/deps /tmp/video-product-pinned/original.mp4 /tmp/video-integration-track-final
node packages/video-metadata/host-media/finalize-check.mjs /workspace/video-codec-eval/deps /tmp/video-product-pinned/original.mp4 /tmp/video-integration-finalize-final
node packages/video-metadata/host-media/product-check.mjs /workspace/video-codec-eval/deps /tmp/video-integration-short-final
npm run typecheck
npm run lint
npx vitest run packages/video-core/src packages/video-core/experiments/pcm-renderer packages/video-metadata/host-media/workflow.test.ts packages/video-metadata/src/edit.test.ts
npm run build
npm run check:files
```

Earlier FAILs remain: `/tmp/video-integration-first/` (test attempted an overlapping
linked move, correctly refused); `third/` (test observed previous playback's stale
DOM evidence; reset now occurs synchronously); `reference/` (copy-trimmed fixture
had inconsistent sample duration, rejected); `reference-pinned/` at code a74a8640
(initial browser reference frame was black). Explicit initial seek fixes the last
case. Working-tree PASS runs are not substituted for the final clean code gate.

## Actual iPhone original: capability gap

With explicit user download permission, the unmodified
[VISION iPhone 6 original](https://lesc.dinfo.unifi.it/VISION/dataset/D06_Apple_iPhone6/videos/indoor/D06_V_indoor_move_0001.mov)
was retained outside Git at `/workspace/video-fixtures/vision-iphone6/` with the
[dataset metadata](https://lesc.dinfo.unifi.it/VISION/statistics/VISION_stats/exifStatsAll/D06_Apple_iPhone6/D06_V_summaryOrigin.csv)
and [license/errata](https://lesc.dinfo.unifi.it/VISION/README.txt).
Attribution: CSP Lab., Department of Information Engineering, University of
Florence (2017), VISION dataset, CC BY-SA 4.0. It is not a listed errata file.
No media was modified, committed, published, or uploaded elsewhere.

Verified bytes: **146,163,851**. SHA-256:
`69e089ae0cc9ad02b7d2461965d6a00d47cb91f7b02e620d10db9ec356731dd4`.
Actual ffprobe: QuickTime/MOV, iPhone 6/software 8.4, AVC High level 4.0,
1920×1080 stored, BT.709 yuv420p, display-matrix rotation **−90° in FFmpeg's
convention**, mono AAC-LC 44,100 Hz, approximately 70.418 seconds.
Video has 2,113 frames: packet durations 20/600 s (2,104 packets) and 19/600 s
(9 packets); sorted PTS deltas likewise vary. Do not call it constant 30 fps.
Raw `ffprobe.json`, `video-packets.json`, `SHA256SUMS` and `INSPECTION.txt` are local.

The actual Host import is **REFUSED: Original staging budget**, leaving native
state empty. This is a real capacity gap. Rotation, mono-44.1-kHz, VFR editing,
original-inclusive save/reopen and export of this real fixture are **NOT RUN**
beyond that gate. Do not claim iPhone, HEVC or HDR acceptance.

## Remaining / held

Large archive/hash integration awaits storage review. General codecs, mixed
originals, HDR, real-device/Safari/Windows playback, physical A/V latency and full
repository E2E remain NOT RUN. No Animation integration or shared Host registration.
No Actions enable/dispatch, performance measurement, main push, merge, release,
deployment, publication or license change. Workflow files remain manual-only;
CI/file-size/Office remain disabled. Final integration requires independent review.
