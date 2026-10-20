# Digest ownership correction and two-original archive verification

This report supersedes #244's hash-backing accounting claim, while retaining its
historical evidence at d03a6deb. The SHA-256 result's 32-byte ArrayBuffer was omitted.
The private helper now reserves copy+32 before allocation and retains the reservation
through digest settlement and hexadecimal conversion. The 16-byte original/export/hash
example has 80 bytes of overlap, not 48. No arithmetic, output bytes, Host schema,
shared App, cap/default, dependency/license or public API changed.

Runtime and actual media/focused-test pin:
`bbb063ace2786447b5fd59115cffc00b55805f12` (clean).
The follow-up archive-only harness correction is `89f84324310b0637010552cf628b0c416abf8f3a`; its
served runtime's 105 repository inputs are byte-checked against this pin. Esbuild
zero-byte disabled-module metadata is not a file and is skipped only after asserting
zero bytes and no imports. External dependencies remain separately pinned.

The actual ConsumerOwner regression tests refuse before digest at 63 bytes for
hashing and 79 for export. Exact 64-byte admission survives delayed digest, aborted waiter
and owner close, then drains after settlement/conversion. Controlled digest rejection
and conversion failure drain too. Real AudioSample clone tests now require 80-byte
peak and retain AAC backing through last-alias close, including rejected add.
The new fixture fails against d03a6deb; its error is retained, not discarded.

The persistent `compare-modes.mjs` runner compares all 100 PCM chunks and 189 AAC
packet payload hashes plus timing in each actual-check workflow. Only independently
assigned source UUIDs are normalized when comparing native declarations; relationships,
source hashes and editing fields remain compared. Positive/equal real WASM kernel
invocations/completions are mandatory in media runners. Preview PCM hashes describe
scheduled audio input, not captured audio-device output. Cross-mode equality supplements,
and never replaces, the unchanged independent FFmpeg audio/picture/timing oracle.

The archive workflow stores both complete accepted VISION originals plus generated
music, verifies fresh-context reopening and exact native content, plays and exports,
using the same 4-second edited composition, then preserves version 1 during version 2 save and controlled capacity refusal/retry
leading to version 3. It uses the pre-existing approved validation configuration:
512 MiB archive/external/scratch,1 GiB journal,2 GiB TotalCapacity with 144 MiB management allowance. This does not raise
the ordinary 256 MiB portable default. Original dataset licenses/identities and private
codec/toolchain notices remain unchanged; no originals are added to Git.

Retained development failures: initial archive guard treated node_modules as Git
inputs, then treated esbuild disabled markers as paths; both failed before browser
execution. Initial cross-mode native comparison rejected independently allocated
UUIDs, fixed by precise identity normalization. Initial test lint rejected unqualified
browser globals. All are retained outside Git alongside old-runtime fail-first.

Full root/legacy/kit/normal shared UI and physical mobile/Safari are NOT RUN here.
Upstream #242 test 197d51ce/docs b8593cf4 reports full 462 PASS and source review; it is
not same-pin acceptance for this successor. Performance benchmarking/tuning remains
on hold; no speed claim. Managed 8 MiB PCM accounting is not a codec/GPU/GC/process-heap
bound. Codec worker termination/reclamation remains unproven as separately reported.
No automatic CI/Actions dispatch, main push/merge, release, deployment or publication.

## Completed checks

At clean bbb063ac: 24 unit tests in owners/mix/requests/audio-import (four files),
16 reported frozen numerical/lifetime checks (10 groups plus six diagnostic rows),
10 pinned-library lifecycle/scope groups with 73 exact package identities, the
corrected output/digest fixtures, typecheck, focused ESLint, file policy and diff
checks PASS. Private browser builds pass in both modes and retain kernel/license
manifests. No new Rust source/toolchain change: the earlier official rebuild's
4,972-byte kernel is reused and hash-verified by every private build; this is not
claimed as a new compiler rebuild at bbb063ac.

At clean 89f84324: both archive workflows PASS with runtime closure pinned to bbb063ac.
All 105 repository inputs matched. Both retain versions 1/2/3, refuse before write
under controlled capacity pressure, preserve previous archives, and settle with
zero capacity reservations. These are logical coordinated storage checks, not a
physical disk quota guarantee.

| Mode | Actual workflow | PCM chunks | Managed peak bytes | Managed drain bytes |
| ---- | --------------- | ---------: | -----------------: | ------------------: |
| js   | two-direct      |        100 |             294912 |                   0 |
| js   | single-reopened |        100 |             294912 |                   0 |
| wasm | two-direct      |        100 |            4412424 |                9976 |
| wasm | single-reopened |        100 |            2968584 |                9976 |

| Mode | First archive bytes | Second archive bytes | Versions after retry | PCM peak / drain bytes |
| ---- | ------------------: | -------------------: | -------------------: | ---------------------: |
| js   |           298797537 |            298802754 |                    3 |             294912 / 0 |
| wasm |           298797537 |            298802754 |                    3 |         4412424 / 9976 |

WASM drain 9,976 is retained module backing; live consumer reservations are zero.
The full-media peak is dominated by source preparation, so it is unchanged by the
new digest reservation; the focused overlap test specifically verifies 80 versus
old 48. Every completed forced-WASM export records 1500/1500 kernel calls/completions
per 2-second video segment and 3000/3000 for 4-second sources/music, never fallback.
WASM SHA256 is `142871dcfdb24035b228f42ae72a369f6fb389d9b179a13512ae0053901a6bca`.

All six completed actual/archive exports pass the unchanged independent FFmpeg
oracle. The cross-mode runner additionally passes both actual workflows with all 100
PCM chunk hashes and 189 AAC packet hashes/timing equal. A deliberately corrupted
PCM hash is rejected. Engine: Chromium 151.0.7922.173; Node 24.19.0/V8 13.6.233.17-node.51;
FFmpeg 7.1.5-0+deb13u1. Bit equivalence remains same-runtime/identical-coefficient scope,
not cross-browser libm identity. Stop/restart and cancelled-export/no-publication
checks are in both actual workflows. Output and archive screenshots were inspected.

## Reproduction and raw evidence

Use the official build/dependency recipe in README and the accepted originals with
their existing SHA256 identities. Use fresh external output directories; failed
runs are never overwritten. Run the actual workflows at bbb063ac; the archive-only
harness fix is at 89f84324 and explicitly verifies bbb runtime bytes.

```sh
node packages/video-core/experiments/pcm-wasm-m2/output-check.mjs /tmp/r0-v1-deps <fresh-output-proof>
node packages/video-core/experiments/pcm-wasm-m2/numerical-check.mjs <kernel>/pcm.wasm <fresh-numerical-proof>
node packages/video-core/experiments/pcm-wasm-m2-fixture/real-library-check.mjs /tmp/r0-v1-deps <fresh-library-proof>
M2_PCM_MODE=wasm M2_PCM_KERNEL=<kernel> node packages/video-core/experiments/pcm-wasm-m2/actual-check.mjs /tmp/r0-v1-deps <original1.mov> <original2.mov> <fresh-wasm>
# Repeat actual-check with M2_PCM_MODE=js and a separate fresh-js directory.
node packages/video-core/experiments/pcm-wasm-m2/compare-modes.mjs <fresh-js> <fresh-wasm> <comparison.json>
M2_PCM_MODE=wasm M2_PCM_KERNEL=<kernel> M2_PCM_RUNTIME=bbb063ace2786447b5fd59115cffc00b55805f12 node packages/video-core/experiments/pcm-wasm-m2/archive-check.mjs /tmp/r0-v1-deps <original1.mov> <original2.mov> <fresh-archive-wasm>
# Repeat archive-check with M2_PCM_MODE=js and a separate fresh directory.
```

The product PCM modules later moved to `video-core/src/pcm/` and
`video-metadata/host-media/m2/`. `archive-check.mjs` looks up a moved module under
its pre-move path when the pin lacks the new one, so the closure is still compared
byte for byte; to verify a later tree, set `M2_PCM_RUNTIME` to that commit.

Raw files, builds, notices, screenshots, native declarations, all assertions/oracle
results, media outputs and retained failures are outside Git in
`/workspace/m2-digest-evidence/` (summary.json, actual-js/wasm, archive-js/wasm,
output, numerical, library, development and logs). Original `/tmp/m2-digest-*`
runs remain retained too. Shell-access checks after disconnect notifications
confirmed live work; neither completed run was restarted or duplicated.

No runtime code changed after bbb063ac. Source after that pin adds only the archive
harness correction and documentation. Draft #245 remains separate from preserved #244.
Graph main `ac0252c7fbf6e3d51cfafc0be15e3c2b4624957f` was not rebased or adopted mid-run;
later combined integration requires explicit composition and compatibility gates.
This report does not authorize Rust/M2 merge or certify normal shared Host adoption.
