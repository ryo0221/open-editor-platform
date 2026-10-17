# R0 isolated backend correctness/build checkpoint

**Executed code: `35083350872f1ae330aa5d87a5db490236097dca`.** Runtime/build manifests record that clean tree; root checks exercised the same source state. The subsequent verification commit is docs-only.
Base accepted candidate: PR #200 docs `f60aa218a7c27831b3aa359b057c0b60bbdbb73a`,
code `7d90adeeedee9a86defe00211d0a043e66885ecc`. Reviewed direction: PR #203
`c2c3130bf4136a3b34f343487a09c920b4e26bdb`. Its prior Host/root2077/domain50/
package192/legacy461/kit evidence remains historical and unchanged, not a pass
for this new backend.

## Scope and result

All changes live in `packages/video-core/experiments/pcm-wasm-r0/`. The old renderer,
normal Host, M2 schemas/policies, external FFmpeg oracle, public exports, dependency
lockfile and workflows are unchanged. Boundary coordination was posted on
the plan PR.
No separate Video-owner acknowledgment or integration acceptance is claimed.

| Gate on the executed pin                                                                                            | Result                                                              |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Rust builds twice into fresh directories using verified official toolchain and frozen/offline Cargo                 | PASS; identical WASM and deterministic manifest                     |
| Frozen whole renderer / explicit JS / forced WASM, Node24.19.0 V8 13.6.233.17-node.51                               | PASS; 54 result records plus asserted negative-origin/error cases   |
| Same suite in Chromium151.0.7922.173                                                                                | PASS; 54 result records; browser errors0                            |
| Actual unchanged v1 product finite/clipping guard with controlled decoder/session binding                           | PASS; 8 paired acceptance/rejection records                         |
| Focused Core + old renderer + new adapter/oracle tests                                                              | PASS; 88 tests / 7 files                                            |
| Root typecheck, lint, file policy, formatting                                                                       | PASS                                                                |
| Root default production build                                                                                       | PASS; default root + React UI build, not a WASM-enabled Host bundle |
| Actual normal Host bundle, Save/reopen, native codec preview/export, original/edited FFmpeg oracle with R0 selected | NOT RUN; no production selection/wiring in this isolated candidate  |
| Full root2077, domain50, package192, legacy461, kit regression with R0 selected                                     | NOT RUN; base evidence is not reused as R0 evidence                 |
| Physical Safari, other browser engines/devices, mobile export                                                       | NOT RUN                                                             |
| Dedicated worker behavior                                                                                           | N/A; this backend owns no worker or transfer buffers                |
| Performance, benchmark, tuning, speedup                                                                             | NOT RUN; hold remains                                               |

This is a reviewable private kernel/adapter implementation, **not completed product
R0 acceptance**. The next integration must preserve existing session/decoder owners,
connect consumer/cache leases to admission, and execute the unrun gates before
selecting WASM in the normal Host. There is no environment/toolchain blocker left.

## What the tests prove

The independent frozen render.ts and rational dependency are hash-pinned; new
preparation shares neither with that oracle. The matrix covers 44.1→48k and
48→48k, mono/stereo, silence/DC/impulses/tones/extreme finite inputs, all three
existing boundary modes, 1/64/127/4096 frames, irregular reverse-order chunks/seeks,
fractional physical endpoints/cuts, negative source origin, large global clock,
quarter/four-times rates, missing support and nonfinite input. Explicit JS pairing
also covers endpoint/extreme, negative-origin, fractional-cut and large-clock cases.
No cross-engine coefficient identity is claimed: each engine hashes its own source
and JS-generated coefficient/address/total/length tile bytes.

Raw kernel comparisons check Uint32 bit patterns, independently known IEEE expected
bits for signed zero, subnormal/underflow, rounding ties/above-half, ordered f64
accumulation and finite→f32 overflow. Raw Infinity is preserved in both kernels,
then tested separately against the SAME existing product guard. No clipping,
normalization, finite rejection or tolerance is added only to Rust.

Forced WASM has an exact module hash, one initialization self-test, verified entry
and successful completion counters; unavailable/trapped WASM never reports a
fallback as WASM success. A test-only binary mutation inserts an actual runtime
trap for rows>1, after the one-row self-test. It records a distinct mutant hash,
invocations1/completions0, rejects without fallback and disposes its owner. Both
engines execute direct ABI shape/row/total/weight/address/PCM rejection and fixed
memory growth refusal. Cancellation tests cover before start, between tiles,
after the final tile before publication, close/drain, retained output and module
leases, overlapping calls/refusal, replacement ownership and immutable staging.
No synchronous WASM instruction preemption is claimed.

The guard fixture bundles the actual unchanged `timelinePcmV1` function and records
its source hash. Decoding/timing/session bindings are controlled fixtures. Its
success is not native AAC decoding, source-media validity, canonical Host workflow
or independent FFmpeg verification.

## Reproduce and retained evidence

See README.md for installation/build commands and full ownership/license details.
The final paths used were `/tmp/r0-official` (verified official installation),
`/tmp/r0-review-build-a` and `-b`, `/tmp/r0-review-correctness`,
`/tmp/r0-review-guard`, and `/tmp/r0-evidence/review-*.log`.

```sh
node packages/video-core/experiments/pcm-wasm-r0/build.mjs /tmp/r0-official /tmp/r0-review-build-a
node packages/video-core/experiments/pcm-wasm-r0/build.mjs /tmp/r0-official /tmp/r0-review-build-b
cmp /tmp/r0-review-build-a/pcm.wasm /tmp/r0-review-build-b/pcm.wasm
cmp /tmp/r0-review-build-a/manifest.json /tmp/r0-review-build-b/manifest.json
node packages/video-core/experiments/pcm-wasm-r0/check.mjs /tmp/r0-review-build-a /tmp/r0-review-correctness
node packages/video-core/experiments/pcm-wasm-r0/guard-check.mjs /tmp/r0-review-build-a /tmp/r0-review-guard
npx vitest run packages/video-core/experiments/pcm-wasm-r0 packages/video-core/experiments/pcm-renderer packages/video-core/src
npm run typecheck
npm run lint
npm run check:files
npm run build
```

The official toolchain was also reinstalled offline from checksum-verified cached
release archives using the committed installer. WASM is4972 bytes, SHA256
`142871dcfdb24035b228f42ae72a369f6fb389d9b179a13512ae0053901a6bca`.
The actual min/max are12/12 pages, with65536-byte stack allowance and657408-byte
arena. The module imports nothing. Full installed Rust/Cargo notices and the
explicitly labeled existing public-export license overlay are in each build's
`notices/`, with file hashes in its manifest. No new private license grant is made.

Emitted feature inspection caught official precompiled core/builtins advertising
bulk-memory, bulk-memory-opt, call-indirect-overlong, multivalue, mutable-globals,
nontrapping-fptoint, reference-types and sign-ext despite per-crate disabling flags.
The build now pins that exact list. It is not an MVP-only claim. No atomics, SIMD
or relaxed-SIMD feature is advertised. The rustc warning about explicitly disabling
unstable target-feature atomics is retained; no nightly or verification bypass
was introduced.

| Evidence                     | SHA256                                                             |
| ---------------------------- | ------------------------------------------------------------------ |
| Deterministic build manifest | `9418431c70d56b0831041f926d3757bfdaf45d709c5d155c5d244d7465609fd7` |
| Node results                 | `b80e25ad2f72cc10ffff7476241b4bbe832deba792e2900904104871c178eb94` |
| Chromium results             | `b154c2fc77b41590a081080a663231ba820d8cd971bc14a1b263a326249ecc65` |
| Actual product guard results | `59baa4eaeff3f11300dbf1e656139932b72af16c54c97389c0ece9d9c8470762` |

## Failure history (retained, not replaced by final PASS)

- `/tmp/r0-evidence/npm-ci.log`: initial install failed with ENOENT for the default
  `/home/agent/.npm/_cacache` and log path. Retried with writable `/tmp/r0-npm-cache`;
  `/tmp/r0-evidence/npm-ci-retry.log` records success with the unchanged lockfile.
- `/tmp/r0-evidence/build-first.log`: compilation succeeded but notice packaging
  failed on nonexistent root LICENSE. Corrected to preserve existing overlay
  provenance without applying it as a new private license.
- `/tmp/r0-evidence/check-first.log`, `typecheck-second.log`, `format-2.log`: test
  source initially used invalid unary-minus exponent syntax. Fixed parentheses;
  no numerical tolerance or kernel behavior changed.
- `/tmp/r0-evidence/lint-second.log`: four build-script WebAssembly global lint
  errors. Qualified runtime globals; no lint disable was added.
- `/tmp/r0-evidence/fonts-check.log`: required fixed fonts absent. The repository's
  pinned fetch/extraction verified all four expected hashes; see `fonts-fetch.log`.
- `/tmp/r0-evidence/reviewed-format.log`: final feature-inspection line needed
  formatting after qualifying TextDecoder. Fixed and final format gate rerun.
- Intermediate successful runs under `/tmp/r0-check-*`, `/tmp/r0-final-*`,
  `/tmp/r0-reviewed-*` and `/tmp/r0-submitted-*` retain their own code/tree fields.
  They are not substituted for the executed pin above. No observed numerical
  mismatch was relaxed or hidden.

Raw evidence, binary outputs and toolchain archives remain outside Git. These local
paths are not public durable artifact links; replay commands and compact hashes are
provided. No benchmark, Actions enable/dispatch, main push/merge, release,
deployment, public publication, public API or security-setting change occurred.
