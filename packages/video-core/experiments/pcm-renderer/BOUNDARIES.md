# PCM physical-source boundary proposals (historical comparison)

Integration update: parent review cleared provisional `edge-hold-v0` only together
with #166. The product candidate combines both; see
[product workflow evidence](../../../video-metadata/host-media/PRODUCT-WORKFLOW.md).
The comparison-branch limitations below describe its original standalone pin.

Issue #75 / #77. Code tested: `696856364b3636aec435fd3b8a32f2dfd15ad2c0`.
Base: #165 evidence HEAD `5462816803c8d6e314ba362102bcb91a619823b0`.
Main checked unchanged at `5a32d355ac107258a604e5a4d7a45d03f3b9efdb`.

## Decision requested

The strict filter-support default cannot render a whole original because the
resampler needs samples outside its physical start/end. This patch compares two
explicit private profiles, without changing the default or fixing a shared API.

| Profile                               | Outside the original's valid sample domain                    | Recommendation                                         |
| ------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------ |
| `require-support` (unchanged default) | Reject                                                        | Useful diagnostic, insufficient for full-clip workflow |
| `edge-hold-v0`                        | Extend the nearest valid endpoint sample for filter taps only | Recommended provisional candidate                      |
| `valid-taps-v0`                       | Discard invalid taps and renormalize remaining signed weights | Comparison only; not recommended                       |

The two-sample `[0, 1]` source exposes gain above 2 with valid-tap
renormalization, including 44.1 → 48 kHz. Edge hold remains below 1.2 in those
specific tests and matches a separately materialized endpoint-extension oracle.
This is not a universal peak bound. Sinc filtering can overshoot, introduces an
endpoint assumption, and is not bit-exact even at equal rates. No clipping,
limiting or subjective audio-quality acceptance is claimed.

The recommended profile is opt-in and requires review before candidate adoption.
Physical validity comes from the original stream's exact rational interval,
not from a trim boundary or the currently returned decoder buffer. The integer
valid sample domain is `[ceil(start * Fs), ceil(end * Fs))`. All requested mapped
clip time must remain inside the exact interval. Output sample membership and
duration remain on the original rational global grid. Original bytes are never
rewritten. Missing actual in-domain PCM, even one sample, still fails the
collector; a shortened decoder window cannot become artificial source support.

## Exact-code verification

All commands below exited zero on a clean tree at the code SHA above.

| Gate                                                       | Result         | Scope                                                                    |
| ---------------------------------------------------------- | -------------- | ------------------------------------------------------------------------ |
| Focused Vitest                                             | PASS, 76 tests | 54 Core + 11 prior PCM + 11 boundary tests                               |
| Actual Chromium AAC boundary checks                        | PASS, 20 cases | 44.1/48 kHz × 1, 17, 1024, 1025, rate+123 source samples × both policies |
| Existing actual Chromium AAC checks                        | PASS, 4 cases  | Prior seek/cancel/fractional-end checks                                  |
| Typecheck / lint / build / file-size check                 | PASS           | Normal repository commands                                               |
| Product timeline + A/V MP4 export                          | NOT RUN        | Not implemented by this comparison                                       |
| Real iPhone / Windows / HDR / practical file-backed bundle | NOT RUN        | Separate acceptance gates                                                |
| Performance                                                | NOT RUN        | Explicit hold remains                                                    |

Unit coverage includes one/two-sample sources, DC, endpoint impulses, high
frequency downsampling, fractional physical end, missing PCM and split/chunk
invariance. The browser checks use retained generated AAC originals, not real
iPhone input. For each longer source, both sides of the 29.97 fps split are
independently planned and freshly native-decoded; concatenated PCM equals the
unsplit render exactly. Each chunk has its own bounded decode window. Maximum
observed returned PCM window was 33,312 bytes; this is an allocation observation,
not a performance measurement or a total-heap bound. Browser errors fail checks.

Reproduction (use a fresh output directory):

```sh
npx vitest run packages/video-core/src packages/video-core/experiments/pcm-renderer
node packages/video-core/experiments/pcm-renderer/boundary-browser-check.mjs /workspace/video-codec-eval/deps /tmp/aac-e485 /tmp/pcm-boundary-browser-final
node packages/video-core/experiments/pcm-renderer/browser-check.mjs /workspace/video-codec-eval/deps /tmp/aac-e485 /tmp/pcm-boundary-existing-final
npm run typecheck
npm run lint
npm run build
npm run check:files
```

Raw evidence stays outside Git: `/tmp/pcm-boundary-final-*.log`,
`/tmp/pcm-boundary-browser-final/results.json`, and
`/tmp/pcm-boundary-existing-final/results.json`. External dependencies and
generated original fixtures retain #165's pins; no dependency or lockfile change.

## Integration gate and remaining work

This branch deliberately does **not** incorporate #166. Its #165 session/native
adapter still has the independently identified reentrant cancellation and late
resource acquisition defects. The four existing browser checks do not cover
those defects and must not be read as lifecycle clearance. #166 code
`44d5025bd0fcbe73052b5549ec529dd3b568f957` / evidence HEAD
`5335a61d1bd151a3c58084aed0bc2dafe3943cd3` carries the separate regression fixes,
pending independent review. This branch is not standalone adoptable.

After lifecycle and boundary review, the next isolated candidate can combine
reviewed #163/#164 with the corrected PCM path for known non-HDR import → actual
timeline preview → A/V MP4 export. No shared Host registration, native schema,
history, SaveCoordinator or root manifest change is included here. Prefix decode
remains capped at 2,048 packets (about 44 s at 48 kHz AAC) and original input at
16 MiB; indexed seeking and practical file-backed storage remain necessary for
real-phone acceptance. No actual Animation integration, remote encode, release,
merge or main push is performed.

Before push, all checked workflow definitions were manual-dispatch-only; CI,
file-size and Office workflows were also disabled. Actions must remain unstarted.
