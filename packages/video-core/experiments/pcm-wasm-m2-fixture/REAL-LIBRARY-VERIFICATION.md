# Real-library fixture: historical input-ownership evidence and scope correction

Tested clean code **0cfef80f3bdb1117a9c45ae046390910e65db35b**. Preserves accepted
#236 mapping and #235 fixture checkpoints. No production M2/Host/library wiring,
codec/default/numerical or cap change. **Scope correction:** the original non-fit
interpretation compared separately owned codec memory with the managed-PCM ledger.
That inference and cap-decision request are withdrawn. See
[accepted-scope reconciliation](PCM-BUDGET-SCOPE.md) and
[corrected verification](SCOPE-VERIFICATION.md). The historical results below
remain at their original pin; they are not relabeled as corrected-pin results.

## Reproducible contract evidence

`real-library-check.mjs` verifies all71 installed Mediabunny dist/modules JS files
plus package metadata and LICENSE (73 entries), exact file set, and unmodified
source excerpts before importing **actual**1.61.3 AudioSampleResource, AudioSample,
AudioSampleSource, Output and serializer/clone path. `Delayed` is the only test
encoder, registered through the existing library API. No source/clone/queue method
is replaced. A NullTarget accepts output; this does not test actual AAC encoding.

[inputs.json](library-evidence/inputs.json) contains hashes and exact excerpts with
file/line coordinates for constructor/reference counting, clone closure, early
add resolution and poisoned serialization. SHA256:
`23fbd02f635ca5f4acd06cea41f9ebff0d69558cb8b13a75b99c69dc0b5c17fa`.
[NOTICE](library-evidence/NOTICE.md) and the unchanged upstream MPL2.0 license
preserve attribution; no dependency or license has changed. Excerpts are review
inputs, not a vendored production library. Drift fails before tests, never skips.

```sh
node packages/video-core/experiments/pcm-wasm-m2-fixture/real-library-check.mjs /tmp/r0-v1-deps /tmp/m2-real-library-fresh
node packages/video-core/experiments/pcm-wasm-m2-fixture/aac-inventory.mjs /tmp/r0-v1-deps
```

Use the verified1.61.3 dependencies and a fresh evidence directory outside Git.
The5s correctness deadline fails unresolved lifecycle dependencies; it does not
release resources or loosen admission. This is not a performance benchmark.

## Results at the exact pin

**10/10 actual-library fixture groups PASS**, Node24.19.0 / V813.6.233.17-node.51:

- Actual add resolves while the custom encoder's clone is still delayed, and
  caller close leaves the backing charged. Final alias close releases once.
- An extra external clone retains backing after the encoder clone completes;
  double close does not double release.
- Actual output cancellation after early add settlement waits for delayed clone
  consumption; cancellation during encoder init does not permit early caller close.
- Aborted caller waiting during init leaves the sample open until actual add
  settlement, then retains backing through the encoder clone.
- Resource-backed samples and BufferSource samples produce identical f32 bits
  (signed zero and subnormal inputs included), format/rate/frame/channel/duration;
  both expected timestamps are checked explicitly on the same timeline.
- Constructor rejection after resource reference increment releases the fixture's
  still-unhanded allocation directly. No sample escaped; no library counter is
  rewritten. This does not authorize reclaiming an escaped/partially native object.
- A rejected actual serializer task causes queued encode calls to be skipped, but
  each queued clone-finally still closes its resource. Last-alias release is once.
  **Custom close is skipped by the poisoned serializer**: input release is not
  evidence of encoder/worker disposal.
- Three short inputs complete input ownership individually with flush count0.
  Finalization is requested only after the loop; actual flush/close then run once.
  No per-input dependency on final track flush exists in this tested path.
- Historical tenth control proved only that a number above8MiB is refused. It
  incorrectly classified AAC codec heap as managed PCM and is superseded by the
  bounded managed-envelope/refusal control. It is not evidence of policy non-fit.

The ten groups include separate alias/cancellation cases, not ten production
media scenarios. Original and test-encoder copy buffers are reserved before
allocation in the same accepted Ledger; scalar diagnostic bits are bounded test
evidence. Observed fixture peak is at most96 bytes, **not** the AAC encoder footprint.

Also PASS: existing38 focused regressions/4 files; root typecheck; focused lint;
file policy1834 files; private esbuild fixture. Full product/browser/real AAC worker,
raw kernel/forced WASM suite and real-original oracles NOT RUN anew. Source-only
inventory does not instantiate a worker or its oversized memory.

Evidence: `/workspace/m2-real-library-evidence/` (raw bundles/results/logs outside
Git), including clean code/empty working tree in `results.json` and static
`aac-inventory.json`. First development run retained **2PASS/1FAIL**: expected
constructor-error regexp used `sampleRate`, while actual error names `getSampleRate`.
Remaining ledger bytes were0. Correcting the assertion changed no lifecycle,
allocation or timeout behavior. Subsequent scope additions and final results are
not retroactively applied to that failed run.

## AAC inventory (separate accepted codec scope)

The hash-pinned shipped browser bundle
`a8f777ab53d8d654bd2339e974de8c80f457e68943afd72e7e55ca0f0dbea214`
contains the worker's embedded509386-byte WASM binary, SHA256
`8488acb0bc9f43055b83600cc4c2c07d20f07675aa65671f91ac1d75515845d9`.
`aac-inventory.mjs` statically parses the nested worker string using TypeScript,
decodes the shipped binaryDecode representation without eval, and reads the WASM
memory section. The standalone packaged module's embedded binary was also inspected
and has the same WASM hash. The authoritative runner repeats the shipped-bundle check.

| Allocation/category                                                |                                  Minimum or bound | Accounting implication                                                                                                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Worker WASM memory                                                 | 276 initial pages = **18087936 bytes (17.25MiB)** | Existing codec-owned backing, separately inventoried; not charged to the accepted managed-PCM ledger solely because of its size.                                   |
| Worker memory maximum                                              |                                 32768 pages =2GiB | Growth limit, **not** measured resident allocation. No2GiB allocation was performed. Growth cannot be silently admitted.                                           |
| AAC main-thread pendingBuffer                                      |                                      262144 bytes | Existing codec-internal JS backing; separately inventoried. Not the provisional Host output owner. Growth overlaps old/new arrays.                                 |
| Incoming extraction copy                                           |                                     4N mono bytes | Independent of caller resource; N<=4096 gives<=16384.                                                                                                              |
| Frame slice transferred to worker                                  |                                     4F mono bytes | F comes from init response. Transfer keeps ownership charge; no extra copy assumed merely for transfer.                                                            |
| Worker input buffer and AVFrame/codec allocations                  |                       Inside worker linear memory | Included in its full backing; **do not double-count** these as extra external buffers. Native codec lifetime is still separate from original input alias lifetime. |
| Worker packet HEAP slice/encoded outputs, loader bytes and JS code |                   Separate allocations/categories | Inventory still required; not silently zero or claimed covered by the PCM-only fixture.                                                                            |
| Four R0 resident sources + module                                  |                                     5785336 bytes | Unchanged all-resident-source baseline, plus coexisting owners/staging/results.                                                                                    |

The raw codec sizes remain valid, but summing them with the managed source ledger
and comparing the result to8MiB expanded the accepted scope. That comparison is
withdrawn. The generated byte-offset/hex evidence and managed-reservation formulas
are now in [PCM-BUDGET-SCOPE.md](PCM-BUDGET-SCOPE.md). No cap/scope/encoder decision
is requested on the basis of codec heap size alone.

The real-library input lifetime result remains useful; production integration
still requires exact owner/alias/native drain and concurrent managed allocation
review. Current known managed envelope fits the unchanged budget under its stated
conditions; arbitrary overlap may correctly refuse admission. Accepted codec
memory stays separate, visible and bounded by its existing implementation limits.
No production wiring, cap/default/numerical/CI/performance/main/release change.
