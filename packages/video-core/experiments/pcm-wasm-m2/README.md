# Private M2 PCM consumer connection

The 32-byte digest ownership correction and completed JS/WASM two-original archive checks
are documented in [the successor verification report](DIGEST-VERIFICATION.md).
That report supersedes the historical 48-byte hash-overlap claim below; corrected
peak is 80 bytes. Runtime bbb063ac and archive harness 89f84324 are separately pinned.

Candidate runtime `d03a6deb9f9e50b4e26713d4154b292ad3398cfa` is based directly on
reviewed #233 runtime `a9f209eb465ba361245fe497082f24f2c12b8c81`. This is a
private production-consumer connection in Video source/mix/playback/export code;
shared App/registry/loaders, normal target declarations and saved schemas are
unchanged. Actual validation uses the existing admitted portable M2 Host. It is
not a claim that the shared normal Host has adopted a new artifact.

## Accepted inputs and ownership boundary

Composition commit `1a802464f9ba5389c7c2b6c2b6db2347c292e492` restores68 files
byte-identically from #215 and #240. [accepted-inputs.json](accepted-inputs.json)
records each pin and SHA256. The v1 selection and scheduled-audio runtime modules
are unchanged; unrelated v1 Host files/tests were not transplanted. Frozen old
whole-renderer/mixer closures remain independent. All earlier evidence is retained.
Video/shared coordination was posted to #223/#233 before consumer work, followed
by the concrete file boundary. Existing-file edits are only M2 mix, source owner,
playback, export and their test consumers. No shared App/registry edits.

The realm uses the exact accepted #215 symbol
`editor-platform.private-pcm-budget.v1`, including an already loaded Host ledger.
A second independently loaded private bundle cannot obtain another8MiB allowance.
An observed wrapper delegates admission to that shared ledger; owner close never
resets reservations. The tested peak is the logical managed backing/native-output
ownership peak, not process/RAM/GPU/GC usage. Unproven native close remains charged.

Default is JS. Only the explicit private build chooses forced WASM. Missing,
mismatched or exhausted WASM fails; it is not silently relabeled fallback. Actual
source evidence associates immutable original/stream identity with backend,
completed calls, fallback state and WASM hash. No public package entrypoint,
backend preference schema, codec choice or rounding policy was added.

## Complete managed lease chain

All needed source owners are resident and counted, including sources not currently
contributing. Deduplication still follows original SHA and audio stream identity.
Every WASM source retains its657408-byte JS arena and786432-byte fixed WASM memory;
module copies remain separately reserved. One active source window at a time is
read/converted, and returned source planes release after the last mix read.
No assumption equates two simultaneous contributors with two resident sources.

Before the unchanged PCM-file preparation allocates decoded staging, the new
owner reserves288KiB:256KiB queued interleaved writes, one possible16KiB current
interleaved callback allocation before its quota check, and16KiB current planar
copy. The existing4096-frame mono callback validation bounds those terms. Actual
write promises settle inside createPcmFile before this reservation releases,
including failure cleanup. Original/encoded BlobSource cache and codec internals
retain their existing separate scope; no complete process-memory promise is made.
OPFS backing and encoded metadata/storage reservations are not PCM heap aliases.

Source read collector/interleaved/seen/callback buffers, returned backing, R0
staging and output are counted through the accepted source session. The legacy
JS renderer's currently active mono f64 sum adds8 bytes. Each private mix owner
has64KiB cumulative admission for f64 accumulation plus returned f32 planes.
JS gain/fade evaluation, contributor order, multiply/add order and final finite/
range guard are unchanged. No partial-sum clipping is introduced.

Each playback/export output owner has256KiB cumulative admission. Hash copies are
reserved before copying and retained through digest settlement. Native AudioBuffer
ownership transfers before connect/start and releases only on ended or fulfilled
owned context close, using unchanged #215 ScheduledAudio. Stop/disconnect alone
is not drain proof. Export copies are passed through actual AudioSampleResource;
caller close follows actual add settlement, and the backing releases only from
the library's last-alias resource close. A rejected add may release the already
copied original mix plane while its independent AAC backing remains held.

Existing AAC incoming/pending/transfer/WASM internals are separately inventoried.
The original command promise is observed without replacing encoder arithmetic or
queueing. Detached input stays unproven after rejected RPC; only actual command
acknowledgment removes its transfer count. Neither acknowledgment nor terminate
is whole-codec reclamation: diagnostics always retain false termination/reclamation
proof flags. The previous #239/#240 failure gates remain separate accepted evidence.

## Reproduction and historical d03a6deb results

Use official Rust1.90.0 installation proven by the unchanged R0 installer/build
workflow. The rebuild at ae512b61 reproduced the accepted4972-byte kernel,
SHA256 `142871dcfdb24035b228f42ae72a369f6fb389d9b179a13512ae0053901a6bca`,
fixed12/12 memory pages and no imports. Rust inputs are unchanged at d03a6deb.
The retained compiler warning about the unstable atomics target-feature flag is
not hidden. Build/notices/manifests remain external, with exact dependency licenses.
Mediabunny and AAC encoder remain1.61.3. No dependency/license change.

```sh
node packages/video-core/experiments/pcm-wasm-r0/build.mjs /tmp/r0-official <fresh-kernel>
node packages/video-core/experiments/pcm-wasm-m2/numerical-check.mjs <kernel>/pcm.wasm <fresh-numerical>
node packages/video-core/experiments/pcm-wasm-m2/output-check.mjs /tmp/r0-v1-deps <fresh-resource>
M2_PCM_MODE=wasm M2_PCM_KERNEL=<kernel> node packages/video-core/experiments/pcm-wasm-m2/actual-check.mjs /tmp/r0-v1-deps <original1.mov> <original2.mov> <fresh-output>
# Repeat the actual workflow with M2_PCM_MODE=js in another fresh output.
```

Full originals are the accepted VISION D06 indoor move0001/0002, unchanged at
SHA69e089ae0cc9ad02b7d2461965d6a00d47cb91f7b02e620d10db9ec356731dd4 and
2d9e3284f777980c212702f8cbfe03a3817d4ad9a2bd08ef8d21d805cd556022.
Attribution remains CSP Lab., University of Florence2017, CC BY-SA4.0 per the
[source README](https://lesc.dinfo.unifi.it/VISION/README.txt). No media is committed.
Auxiliary mono44.1kHz music is generated separately; it does not replace the real
video/voice originals. Video/output/storage memory remains separately governed.

At clean runtime pin d03a6deb, PASS:

- 42 focused tests/4 files, root typecheck, focused changed-file ESLint, file
  policy1945 files, and diff checks.
- 10 frozen numerical/lifetime/refusal groups (plus six source diagnostic rows):
  whole old source+mix bits, gain/fade/cuts/endpoints, three resident sources,
  delayed decode, lease survival, final guard and forced refusal. JS and WASM
  each compare directly against the frozen closure; no fallback can pass.
- 10 actual pinned-library lifecycle/scope groups; all73 package-file hashes and
  exact snippets checked before import. Separate static AAC inventory matches.
- The connected export helper's actual AudioSample clone tests: successful and
  rejected add both retain AAC backing through the last alias, preserve input
  bits, and release the complete tracked overlap. The first failed expectation
  remains recorded below.
- Both actual workflows in JS and forced WASM: real native preview, Stop/restart,
  cancellation at the first real VideoEncoder frame with zero published download,
  full restart/export, and the fresh-context saved project case. Zero browser
  errors. Native content/original SHA keys remain unchanged; screenshots inspected.
- All100 pre-encode PCM chunk hashes per workflow match JS versus WASM; all189
  encoded audio packets per workflow match in payload SHA256, PTS/DTS/duration,
  size and side data. This is same Chromium151.0.7922.173 evidence, not cross-engine
  bit identity. Each final export source records actual completed backend calls
  and no fallback; three source owners for two-direct, two for single-reopened.

| Workflow                                    | JS managed reservation peak | WASM managed reservation peak | After drain JS / WASM |
| ------------------------------------------- | --------------------------: | ----------------------------: | --------------------: |
| Two video originals + music                 |                      294912 |                       4412424 |               0 /9976 |
| Freshly reopened one video original + music |                      294912 |                       2968584 |               0 /9976 |

The9976 remaining bytes are the deliberately retained shared module reservation,
not a claim of zero realm ownership. All source/output reservations drain after
Stop, cancelled export and successful output. Actual cancel checks here observe
zero outstanding codec transfer after its earlier commands acknowledged; the
unproven worker-transfer cases remain separately proven by accepted #239/#240,
with no whole-codec reclamation claim. The10 actual-library groups were rerun at
this pin; the #240 worker fault matrix was not rerun here.

Independent preview RGB mean errors (threshold8) were JS0.732/WASM0.795 for the
second-video picture and JS1.500/WASM1.504 for reopened first-video content. Those
are correctness errors, not speed measurements. The saved archive is146242298
bytes. Independent encoded audio/picture/full timing checks all pass their
unchanged #222 thresholds; decoded tail beyond the presentation interval remains
reported separately by that oracle.

Runtime: Node24.19.0/V813.6.233.17-node.51, Chromium151.0.7922.173,
FFmpeg/ffprobe7.1.5-0+deb13u1. Final raw directories are
`/tmp/m2-connection-shared-wasm/`, `...-shared-js/`, `...-shared-numerical/`,
`...-shared-output/` and `...-shared-library/`; cross-mode packet/hash report is
`/tmp/m2-connection-cross-backend.json`. Copies, all earlier attempts and logs
are retained under `/workspace/m2-connection-evidence/`, outside Git.

Before reproduction, run the accepted library verifier with the same dependency
root to check all73 exact file identities:
`node packages/video-core/experiments/pcm-wasm-m2-fixture/real-library-check.mjs /tmp/r0-v1-deps <fresh-library-proof>`.
The build also rejects drift in the pinned Mediabunny lifecycle/AAC input sources and
checks kernel identity, pages/imports and dependency versions. It copies full
kernel notices, manifest and existing package licenses into each external build.

The two-direct case uses two full video/voice originals plus independent music.
The save/reopen case uses one full video/voice original plus independent music,
within the unchanged portable cap; it does not claim a combined two-video portable
archive gate. Fresh-context reopen preserves exact native content, then repeats
preview, cancellation and independently verified export. No capacity cap is relaxed.

Preview PCM hashes match every exported pre-encode chunk. One actual preview
canvas readback is independently compared to FFmpeg pixels and packet PTS selected
from native declarations (no product mapper import). Encoded audio, picture samples
at head/cut/end and complete video/audio timing use the unchanged independent
#222 oracle. Test-only pixel readback/provenance instrumentation is outside production
PCM ownership accounting and is not included in the private consumer implementation.
Native decode/encode is lossy; encoded-audio comparisons use the unchanged oracle's
tolerances. Exact float bits are tested separately against the frozen renderer in
one runtime with identical coefficients, not across browser libm implementations.

## Retained failures, superseded work and limits

- The initial source composition included an unrelated v1 Host-budget test whose
  shared Host file was intentionally absent. Typecheck failed; only the actual
  unchanged runtime modules were retained before the candidate commit.
- The first output-resource test wrongly required the copied original mix plane
  to remain held after failed add. Its16-versus32-byte failure is retained; the
  corrected expectation still requires AAC clone backing to stay charged.
- A lint pass found browser document globals in the test runner; corrected to
  explicit globalThis before the candidate commit.
- The second official dataset download timed out near completion. Resumed from
  that same official URL; full accepted SHA was verified before any media check.
- Pre-candidate dirty-tree actual WASM runs passed but are development evidence
  only. No PASS is reassigned to a later source pin.
- Source audit found the first candidate's module-local ledger would not share
  #215 Host admission across bundles. The ae512b61 actual attempts were marked
  SUPERSEDED and stopped; d03a6deb installs/reuses the exact accepted identity and
  adds an independent-module contention test. Prior attempts remain retained.

No timing benchmark, performance tuning or speed improvement claim. Full root
suite/legacy/kit/normal shared UI and physical Safari/mobile are NOT RUN at this
new pin. Upstream #241 recorded kit/domain/package PASS at a9f209eb and legacy 460/461.
Later #242 test 197d51ce/docs b8593cf4 resolved that test-only failure and recorded
full 462 PASS with source review. Neither result is same-pin acceptance here.
No automatic CI/Actions enabled or dispatched; no main push/merge, release,
deployment, public publication, shared ownership, increase to existing caps, default or public API change.
Review is required before shared-owner artifact adoption.

## Subsequent normal Host startup ownership correction

The accepted-input inventory above records the reviewed #245 baseline. The normal Host successor adds pre-construction module input admission and transfers that reservation into preparation in `pcm-wasm-r0/kernel.ts`, `pcm-wasm-v1/selection.ts` and `pcm-wasm-m2/owners.ts`. These ownership files are therefore an explicit reviewable delta, not byte-identical baseline claims. Arithmetic, frozen numerical oracle and the approved WASM binary are unchanged. See the normal Host integration report for exact-pin verification and the retained initial failures.
