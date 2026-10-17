# Private rational PCM renderer — first review unit

Exact tested code: **85216973f0695078bb8acce8b4f2b57a9ce39e14** (clean tree).
First implementation pin: **b9b49dba974f8a3f2aed4a52c22103327e6a437c**.
Base: reviewed #159 evidence HEAD **04b6ab623268831d8f4730658db93f4d1625142e**.
No #163/#164 changes or other lanes are incorporated; those branches stay stable.
Main checked: **5a32d355ac107258a604e5a4d7a45d03f3b9efdb**.

## Proposed private behavior, not a public contract

`Mapping` is a transient render plan, not a persisted native schema, history or
sync system. Shared/public API and codec dependency adoption remain unapproved.

- Output sample k is located at exact rational k/Fout. Clip membership is
  `[ceil(start*Fout), ceil(end*Fout))`; boundaries are never independently rounded
  and accumulated per clip. Source position is sourceStart + (k/Fout-start)\*speed.
  `frameSource` uses the same mapping with exact frameTime(index,fps); it is a frame
  **query**, not a functioning video frame decoder or player integration.
- Source positions remain rational through mapping and integer/fractional-phase
  separation. Only the bounded fractional phase and PCM amplitudes become floats.
  1001/30000-second cuts occur at 1471.47 source samples (44.1 kHz) or 1601.6
  (48 kHz); they are not rounded to integer source sample edges.
- `renderPcm` is the one PCM entry point intended for preview and export. The tests
  compare different chunk sizes and split/unsplit plans through that same entry
  point. There is no speaker UI, encoder or muxer connection yet.
- Prototype filter: normalized Blackman-windowed sinc, cutoff
  `0.95 * min(1,Fout/(Fin*speed))`, radius `ceil(32/cutoff)`, maximum 256.
  This is a finite approximation to band-limited reconstruction, not an ideal
  infinite filter or an approved final audio-quality profile. No limiter, gain
  normalization across clips or saturation/clipping policy is introduced.
- Kernel support may cross an edit cut into the same original's valid samples;
  it may not cross that original's valid presentation bounds. Insufficient
  physical-edge support rejects. **No zero fill, repeated endpoint, hidden tail
  samples or independent clip rephasing.** A physical-edge extension policy is a
  remaining design/verification gate before whole-source export.

## Timestamped decode, seek and ownership

`native-aac.mjs` reuses the reviewed exact saved-MP4 packet timing and fixed
Mediabunny 1.61.3 experiment. A submitted floor-microsecond timestamp identifies
one immutable raw-media PTS. PCM, callback timestamp, sample rate, channel count
and frame count are read together from AudioData; each AudioData is closed.
Unknown/duplicate callback timestamps, missing/overlapping coverage or changed
format reject. This does not infer PCM timing from a separate decoder invocation.

Every request creates a fresh native AudioDecoder and decodes from raw packet 0
through the required window, including actual codec priming/preroll. It flushes
once at the end of that decoder lifetime and never resumes after flushing. This
avoids the intermediate-flush timestamp epoch shift found in #159. It deliberately
does not assume an unreviewed AAC random-access recovery distance. Long prefix
seeks reject at the packet budget; efficient long-file indexed seek remains open.

The collector allocates only the requested integer sample window and tracks every
sample's coverage. `finish` rejects even one missing sample. Its zero-initialized
allocation is never accepted as evidence of decoded silence. Fractional valid-media
ends are preserved by an opt-in exact mode in savedTiming; the existing integer
mode is unchanged. The direct decode window contains only sample timestamps
strictly inside that fractional validity interval, not synthesized frame padding.

`PcmRenderSession` aborts superseded requests and rejects stale late results before
publication. Native cancellation closes the decoder/input; tests cancel after
exactly one submitted packet while further packets are still required, then verify
fresh decode recovery. Cancellation is at asynchronous/bounded-chunk boundaries,
not interruption inside a C/browser decoder instruction or a synchronous FIR tap.

Provisional per-request bounds:

| Resource                                        | Bound                              |
| ----------------------------------------------- | ---------------------------------- |
| Original in-memory input                        | 16 MiB                             |
| Parsed boxes / indexed raw samples              | 10,000 each                        |
| Prefix preroll submitted packets                | 2,048                              |
| Encoded packet                                  | 1 MiB                              |
| Native decode queue / outstanding timestamp map | 8 / 16                             |
| Collected PCM window                            | 32,768 frames × at most 2 channels |
| Output PCM chunk                                | 4,096 frames × at most 2 channels  |
| Native request deadline                         | 10 seconds, abort/close            |

PCM window payload is at most 256 KiB plus a 32 KiB coverage map, with one bounded
callback copy. This is not a total browser/native decoder memory measurement.
Native implementation overhead, original/demux storage and caller-retained output
windows are separate; callers must release consumed chunks. No performance run or
production security-boundary claim is made. Tests cover unity-rate stereo AAC at
44.1/48 kHz; mono/other rates and variable-speed audio acceptance are NOT RUN.

## Exact-code results

| Gate                                                           | Result                                   |
| -------------------------------------------------------------- | ---------------------------------------- |
| Renderer unit tests                                            | PASS, 11                                 |
| Existing Video Core tests                                      | PASS, 54                                 |
| Root typecheck / lint / build / file policy                    | PASS                                     |
| Chromium real AAC window/seek/cancel + fractional-end cases    | PASS, 4                                  |
| Existing #159 AAC timing regression                            | PASS, 30 (including 12 A/V timing cases) |
| Product audio UI / actual audio MP4 export                     | NOT RUN, not connected                   |
| Video frame decode / Player / Animation integration            | NOT RUN                                  |
| Full repository regression / other browsers / iPhone / Windows | NOT RUN                                  |
| File-backed practical bundle / HDR / performance               | NOT RUN                                  |

Unit oracles include a sine at fractional source phase (<0.0002 absolute error),
constant-amplitude phase independence, and 48→16 kHz downsampling of an 18 kHz tone
(RMS <0.001) while preserving a 1 kHz tone (RMS >0.70). Split and unsplit 29.97 fps
PCM across both source/output rates is exactly equal as Float32 values despite
different chunk boundaries. Coverage, output/window/preroll bounds, supersession,
late completion and caller abort have direct negative tests.

Real AAC tests use the identical generated #159 saved originals and independent
SHA-256 checks. Three forward/backward seek windows at each rate match reference
PCM exactly; the known impulse stays within two source samples of its fixture
position. Observed max decodeQueueSize is 8 and outstanding callbacks 9. Requested
4,000/5,000/6,000-frame stereo windows retain exactly 32,000/40,000/48,000 PCM bytes.
Oversized windows reject before native configuration. Both source rates render
3,204 samples for two 29.97 frames at 48 kHz, with split boundary 1,602; split and
unsplit output are identical. Cancellation after submission 1 closes owners and
fresh decode matches. Fractional-end fixtures retain 1471.47/1601.6-sample spans;
one additional sample beyond their end is rejected. Browser errors are zero.

During cleanup instrumentation, an omitted `onClosed` destructuring parameter
caused one working-tree browser FAIL (ReferenceError). It was corrected; broad
no-undef suppression was removed from the adapter/harness, and all exact-code
checks above were rerun. Initial failure retained at
`/tmp/pcm-renderer-browser-second/results.json`; it is not counted as a codec PASS.
Final logs: `/tmp/pcm-renderer-final-*.log`; raw generated fixtures/results:
`/tmp/pcm-renderer-browser-final/`, `/tmp/pcm-renderer-aac-regression/` (outside Git).

Reproduction:

```sh
npx vitest run packages/video-core/src packages/video-core/experiments/pcm-renderer/render.test.ts
node packages/video-core/experiments/pcm-renderer/browser-check.mjs \
  /workspace/video-codec-eval/deps /tmp/aac-e485 /tmp/pcm-new-run
node packages/video-core/experiments/local-codec/browser-aac-check.mjs \
  /workspace/video-codec-eval/deps /tmp/aac-e485 /tmp/aac-new-run
npm run typecheck
npm run lint
npm run build
npm run check:files
```

External evaluation deps remain Mediabunny/AAC extension 1.61.3, lock SHA-256
`c29da29ce08e2459127dcc04b3e173467c3ef5f8dc3f4fa2c82c972ec32f98e1`.
This adapter uses native AudioDecoder, not the AAC encoding extension. Node 24.19.0,
npm 11.9.0, Chromium 151.0.7922.173. No package install, root manifest, public API,
license, main push, merge, release or deployment. Workflows remain manual-only
(CI/file-size/Office disabled), with no enable/dispatch. Next end-to-end goals are
reviewed edge handling + actual audio MP4 export and practical file-backed bundles.
