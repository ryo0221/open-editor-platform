# Known-SDR product workflow candidate

Issue #75/#77, draft PR #168. Adoption HOLD pending finalize-ownership review;
see [finalize correction](FINALIZE-FIX.md) and [per-track follow-up](TRACK-FIX.md). **A narrow actual workflow now works:** selected
original MP4 → existing linked timeline edits → portable project save → new empty
browser context / bundle-only reopen → timestamped timeline frame preview →
verified 1920×1080 AVC + stereo AAC MP4 download. This is a local candidate in the
same Host, not a new history, persistence service, public extension or codec experiment.
Audio preview playback is not implemented; preview here means explicit frame seeking.

Exact tested code: `ffc4e560403bbf48c5c1e6053f5da63682191abe`.
Main checked unchanged: `5a32d355ac107258a604e5a4d7a45d03f3b9efdb`.
This document is an evidence-only follow-up; generated outputs remain outside Git.

## Reviewed composition

- Import/bundle base #164: `d12af2c801ef7218f792031373fb258e7bca5c91`.
- #163 cancellation code `0e421c020720566d812c2cc5a126632b54e9e6a2`, including
  prerequisite #158 cleanup, incorporated and regression-tested. Its WASM decoder
  is **not activated as an HEVC fallback** in this first AVC product profile.
- #165 PCM code `85216973f0695078bb8acce8b4f2b57a9ce39e14`, with #159 saved AAC reader.
- #166 lifecycle code `44d5025bd0fcbe73052b5549ec529dd3b568f957`.
- #167 boundary code `696856364b3636aec435fd3b8a32f2dfd15ad2c0`.
  Parent review explicitly cleared #166 and provisional `edge-hold-v0` together.
  The session conflict was resolved by retaining #166's ownership/check sequence
  and passing #167's explicit boundary arguments through it. Strict default remains.
- New Host drain correction: `7369565f5d8771ba49942c04e107fa3c55aa5ac0`.

The product entrypoint opts into `edge-hold-v0`. Only filter taps outside the
immutable original valid interval use nearest-endpoint extension. Missing decoded
coverage, trim/split boundaries and returned-buffer edges never qualify. The MP4
comment metadata records boundary/filter profile, snapshot hash, original hash,
rate and valid sample count. More detailed render evidence is captured alongside
the browser test results. Original bytes are retained unchanged.

## Actual profile and operation boundaries

The first profile requires one explicit BT.709 SDR AVC original with stereo
48 kHz AAC, no transform/alternate tracks, 16:9 source pixels at most 640×360,
at most 64 source frames, and a contiguous unity-speed video/audio timeline on a
25 fps grid. Output duration is 0.1–1 second (subject to that frame grid). The tested
edit is linked split at frame 20, deletion of both tail clips, then existing
sequence-duration command to 4/5 second. Both tracks must cover the entire export;
gaps, overlaps and unsupported profiles reject. No silence or missing-frame fill.

The original-media read index derives raw PTS from saved `stts`/`ctts`, independently
of library-normalized packet timestamps. Native decoder callbacks are matched to
these timestamps; missing/duplicate frames fail. Timeline frame selection uses
exact rational mapping from native clips. Preview and export share that mapping.
Export uses one output canvas with sequential frames, and PCM windows use the
reviewed bounded renderer. Source AAC resets/prerolls from packet zero per window;
this does not add indexed long-seek support.

The job deeply freezes the existing native read snapshot, scope/revision/hash,
original Blob references and interpretation plans. Subsequent clean edits do not
change that export. Existing input, permission and save-reconciliation checks run
at the operation boundaries. Native history and project SaveCoordinator remain
canonical. Encoding and container verification precede a synchronous in-memory
publication; browser download is separate. One completed output is retained.
Cancellation/failure preserves it; Host disposal drops it.

Disposal aborts immediately but returns a promise that settles only after the
active job finishes its cleanup. The Host lifecycle owns that promise. The deferred
encoder test proves `incomplete` while encoding remains pending and `drained` only
after its late result is rejected and cleanup finishes. The earlier implementation
reported `drained` incorrectly; that failing evidence is retained. Preview requests
also register their settlement with the existing lifecycle.

There is one AAC encoder operation per realm, protected by a private state owner.
The fixed external AAC candidate is patched in memory at build time to retain raw
packet PTS and terminal duration. Hash/patch-shape checks refuse drift. Generated
container edits explicitly remove 1,024 AAC priming samples from presentation;
media payload is checked unchanged by the metadata correction. PCM outside [-1,1]
is rejected before the encoder: no automatic limiter/clipping is applied.

This is not bit-exact passthrough and does not promise absence of filter overshoot.
The tested rendered peak is 0.5424200892448425; this is fixture evidence only.
Native decoder/encoder allocations are not an independently measured total-heap
bound. Output is bounded to 32 MiB before publication, not a general streaming or
filesystem durability implementation.

## Exact-code gates

All commands exited zero on the clean code pin above.

| Gate                                                         | Result                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| Combined unit: Core + PCM + lifecycle + import/bundle/export | PASS, 108 tests                                              |
| Actual desktop/mobile product workflow                       | PASS, 1280 and 390 px                                        |
| Prior import/bundle negatives and reopen workflow            | PASS, desktop/mobile                                         |
| #166 native acquisition/cancel probes                        | PASS, six cases                                              |
| Prior actual native AAC seek/cancel/fractional-edge cases    | PASS, four cases                                             |
| Boundary real AAC matrix                                     | PASS, 20 cases; independently decoded split sides            |
| Saved AAC regression                                         | PASS, 30 cases including rational origins                    |
| WASM cleanup                                                 | PASS, 14 fault/cancel cases and 16 reopen cycles             |
| WASM unfinished cancel/terminate handshake                   | PASS, three cooperative and three termination/recovery cases |
| Typecheck / lint / build / file-size                         | PASS                                                         |
| Local serving script                                         | PASS, loopback HTML/JS smoke                                 |
| Audio preview playback / real iPhone / Windows / HDR         | NOT RUN / not implemented or unavailable                     |
| Long-seek / practical-size / file-backed portable storage    | NOT RUN / not implemented                                    |
| Performance / actual Animation integration                   | NOT RUN, holds remain                                        |

The product browser check imports a generated known original, edits it through the
existing UI, saves, destroys the browser context and reopens from the bundle alone.
It compares native/original identity and timestamped preview, exports, then cancels
another export immediately after an actual native AAC packet submission. No late
download occurs; a fresh export recovers. Screenshots were inspected. Browser
errors fail the test. Requests are loopback or embedded WASM data URLs; no remote
media upload/encode is performed.

### Independent output evidence

FFprobe and FFmpeg inspect/decode the saved MP4 independently of the product port.
A separate page in the same browser context decodes saved AAC using timestamped
AudioData coverage; only the bundle-reopen step creates a new browser context.
Runtime staged verification checks container metadata and provenance. Independent
full decoding is acceptance-test evidence, not a runtime decoder verification claim.

- Both tracks present exactly `[0, 4/5)`; audio edit starts at raw sample 1,024.
- 38,400 valid presentation samples at 48 kHz; impulses at 11,520 and 34,560
  (0.24 s and 0.72 s), matching the input fixture/edit mapping.
- 20 video frames with PTS `i/25`, 1920×1080; red→blue change at frame 10 / 0.4 s.
- Native/FFmpeg valid PCM difference is zero for this fixture. This compares two
  decoders of the **same lossy encoded output**, not output vs original transparency.
- First stereo samples: `[0.011646327562630177, 0.013425447046756744]`.
- Last valid stereo samples: `[0.017044514417648315, 0.015565861016511917]`.
- Endpoint checks also compare independently decoded original samples against
  pre-encode render evidence (tolerance 0.01), and encoded endpoints against render
  evidence (0.015). Endpoints are nonzero; these fixture tolerances are not a
  general quality standard.
- FFmpeg emits 38,912 decoded samples including 512 codec-tail samples outside the
  valid presentation interval. The container interval and timestamped browser
  coverage establish 38,400 valid samples; we do **not** report raw FFmpeg length
  as the presentation duration or hide it as a decoder discrepancy.

MP4 files:

- `/tmp/video-product-pinned/export-1280.mp4`, SHA256
  `da5a0bb15a70db79e07179ae847f3fabd267e5eb753277784dfaec9a425c1b2c`.
- `/tmp/video-product-pinned/export-390.mp4`, SHA256
  `06f010ccd4cd244d1b2880cfbba42b9227a7fd39fef2f204a69f7b89b22f3db8`.

Native IDs/provenance differ between independently created projects, so file-byte
identity across the two outputs is not expected.

## Reproduce / inspect

External candidates remain Mediabunny 1.61.3 and AAC encoder 1.61.3, with lock SHA256
`c29da29ce08e2459127dcc04b3e173467c3ef5f8dc3f4fa2c82c972ec32f98e1`.
The AAC source hash remains
`a8f777ab53d8d654bd2339e974de8c80f457e68943afd72e7e55ca0f0dbea214`.
No root dependency, lock, shared Host registry/API or license change was made.
Node 24.19, Chromium 151 and native FFmpeg 7.1.5 were used locally. Native FFmpeg
is a fixture/verification oracle, not the browser export engine.

```sh
node packages/video-metadata/host-media/product-serve.mjs /workspace/video-codec-eval/deps 4178
# Open http://127.0.0.1:4178; use the generated known fixture below for this limited profile.
node packages/video-metadata/host-media/product-check.mjs /workspace/video-codec-eval/deps /tmp/video-product-pinned
npx vitest run packages/video-core/src packages/video-core/experiments/pcm-renderer packages/video-metadata/host-media/workflow.test.ts
npm run typecheck
npm run lint
npm run build
npm run check:files
```

Use a fresh output directory when rerunning browser scripts. Original, project
bundles, MP4 exports, screenshots and result JSON are under
`/tmp/video-product-pinned/`. Combined evidence is in
`/tmp/video-product-pinned-*.log`, `/tmp/video-product-*-pinned/`; prior gate commands
are in the respective PCM/bridge review documents with those output directories.

Failures retained, not relabelled PASS:

- Original #165 session/native acquisition failures remain at their original paths.
- `/tmp/video-product-drain-before-real.log`: wrong early `drained` on old export code;
  corrected regression PASS at `/tmp/video-product-drain-after-real.log` and final unit gate.
- `/tmp/video-product-first/`: verifier loaded the same library twice; browser-error FAIL.
- `/tmp/video-product-second/`: request assertion initially excluded embedded WASM data;
  FAIL, corrected to accept that local data scheme while still rejecting remote requests.
- Code `27d4ac90b48f78aae059221f3655198e0ca1bff8`: lint FAIL from missing node URL import
  in the local serving script; corrected on the final pin. Other results at that
  older code are intermediate evidence, not the final gate.

Actions remain manual-only, CI/file-size/Office disabled, and code-pin run count 0.
No main push, merge, release, deployment, publication or performance run occurred.
This candidate does not complete Video #75 or the full Editor Platform epic.
