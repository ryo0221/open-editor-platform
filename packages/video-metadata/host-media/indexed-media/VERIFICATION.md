# Indexed reader checkpoint (not synchronized playback acceptance)

Exact code: `da2b0fbfacad22b6ae777fe86aec7a149ad1e890` (clean checkout).
Main checked: `5a32d355ac107258a604e5a4d7a45d03f3b9efdb`.
Reviewed short-profile prerequisite: #171 code
`4b5bcd40ac9a2400dc7c2f095d5d3d2265241db8`, docs
`13006f4f36ce865f6372b94042a710070b8dce72`.
Its #169 prerequisite and documentation were carried with it; no storage or other
lane implementation was incorporated. The proposed readers remain private and
are not connected to the product Host, export, or a permanent shared API.

## PASS at the code pin

- Actual Chromium 151 / Linux AVC + AAC 48-second fixture, 25 fps, BT.709,
  320 × 180, stereo 48 kHz. AAC: 2,251 packets, 2,250 retained callbacks,
  2,304,000 valid presentation samples/channel, 18,432,000 PCM scratch bytes.
- Exact raw sample/decode-order association and actual AudioData shape, with
  rounded microseconds only a consistency check (maximum observed delta 1 μs).
  Five windows (2,944 samples/channel total) including 45–48 seconds matched
  independent continuous FFmpeg decoding within the asserted tolerance <0.0001;
  the observed maximum difference was 0. This is not a full 48-second bitwise oracle. This does not claim compressed audio is
  lossless relative to the pre-encode fixture.
- Video seeks at 45.24, 46.72, 1.24 and 47.96 seconds selected the expected raw PTS
  and color markers. Maximum 25 cached frames; 100 packets decoded over four GOPs.
  Restart requires verified key-packet status plus an actual AVC IDR NAL; a
  container key flag or recovery SEI alone is insufficient.
- Original File.arrayBuffer deliberately throws in the test. Reader paths use
  bounded metadata and media ranges. Source cache is configured at 1 MiB (soft
  library LRU, not a hard resident-memory cap); observed
  decode queue 8, outstanding audio callbacks 9, pending writes 65,536 bytes.
- Two held PCM reads retain ownership; a third read is refused. Disposal waits
  for reads and the live lease. Repeated old disposal does not delete a successor
  scratch file. Final tracked PCM/video reservations return to zero.
- Injected QuotaExceededError, cancellation during a held real writer.write,
  and cancellation during a held writer.close all reject without ready output.
  Pending I/O retains the reservation until settlement. A competing build is
  refused. This is fault injection, not physical-device disk exhaustion.
- Three actual #171 crossed-track/late-init probes and two previous finalize
  probes; existing short product desktop/mobile-width import/edit/bundle/new
  context reopen/preview/A+V MP4 export regression.
- Typecheck, repository lint, 108 focused unit tests, build, check:files.

Evidence outside Git: `/tmp/video-indexed-pinned/results.json`,
`/tmp/video-indexed-track/results.json`, `/tmp/video-indexed-finalize/results.json`,
`/tmp/video-indexed-product/results.json`, `/tmp/video-indexed-{typecheck,lint,unit,build,files}.log`.
Fixture SHA-256: `caea86f9196bd0ef530da1de419aa5423716b69af7a1a93f2e0d6b9213091970`.

Reproduce from the code pin with the existing external pinned codec workspace:

```sh
node packages/video-metadata/host-media/indexed-media/check.mjs /workspace/video-codec-eval/deps /tmp/video-indexed-pinned
node packages/video-metadata/host-media/track-check.mjs /workspace/video-codec-eval/deps /tmp/video-product-pinned/original.mp4 /tmp/video-indexed-track
node packages/video-metadata/host-media/finalize-check.mjs /workspace/video-codec-eval/deps /tmp/video-product-pinned/original.mp4 /tmp/video-indexed-finalize
node packages/video-metadata/host-media/product-check.mjs /workspace/video-codec-eval/deps /tmp/video-indexed-product
npm run typecheck
npm run lint
npx vitest run packages/video-core/src packages/video-core/experiments/pcm-renderer packages/video-metadata/host-media/workflow.test.ts
npm run build
npm run check:files
```

## Earlier FAIL retained

`/tmp/video-indexed-first/` failed AAC callback association;
`/tmp/video-indexed-diagnostic/` established a 4,159,999 μs callback against the
4,160,000 μs encoded timestamp. Exact integer decode-order/sample coverage now
governs association. `/tmp/video-indexed-second/` and
`/tmp/video-indexed-faults/` are earlier working-tree PASS runs, not code-pin gates.

## Limits and NOT RUN

The caller must supply a previously verified immutable original hash; these
readers do not implement a streaming hash verifier. Scratch limits are private,
per-realm admission (one build, four files, 128 MiB total, two reads); they are not
an origin-wide lock, crash-recovery journal, or practical-capacity claim. Source
profile remains narrow; maximum 300 seconds and maximum 64-packet IDR GOP.

Synchronized audio playback, output-clock/underrun/suspend-resume acceptance,
shared preview/export PCM equality, long multi-segment product editing/export,
large-file hash/storage integration, and preservation of the #164 silent/wider
reference preview: **NOT RUN / pending implementation**. #170/#172 archive work
is excluded. Real iPhone, Windows, HDR, full repository E2E and performance:
**NOT RUN**. No Actions dispatch, performance measurement, merge, main push,
deployment, publication, or license change was performed.

Review follow-up: the resource/returned-frame P2s in this historical checkpoint
are corrected by the product integration in [INDEXED-INTEGRATION.md](../INDEXED-INTEGRATION.md).
The older code pin itself is not retroactively certified by those corrections.
