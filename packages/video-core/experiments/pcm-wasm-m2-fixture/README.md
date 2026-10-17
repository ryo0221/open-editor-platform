# Private M2 PCM port/oracle fixture

**Port/fixture only.** This preparatory successor to #232 leaves accepted #215,
real M2 mixer/timeline/playback/export, normal Host, schemas and defaults untouched.
It is not a product mix implementation or real-media correctness claim.

Consumer-fixture successor: see [the precise contract and worksheet](CONSUMER-CONTRACT.md)
and [exact-pin consumer verification](CONSUMER-VERIFICATION.md). Video has since
conditionally acknowledged the seam direction; the original #234 results below
remain historical. Owner ceilings remain provisional and real connection is held.

Actual AAC successor: [exact-pin resource and worker-input drain proof](ACTUAL-AAC-VERIFICATION.md).
This separate fixture uses the accepted codec and preserves corrected #237;
real M2 adoption remains held.

Remaining AAC lifecycle successor: [creation/init/error/late-response proof](LIFECYCLE-AAC-VERIFICATION.md),
including4800-frame input and a5121-frame short-tail boundary; fixture only.

## Frozen independent numerical oracle

`freeze.mjs` reads local Git objects at accepted #222 code
`c27b96cf7ebb6bafa2581b6b5bf0be45152a2348` (docs
`172255a33946ce1d6560f5bc4e9b5918d0de8e2e`). It snapshots the whole numerical
closure: old session/renderer, exact time, request/mapping order, model/validation,
gain/fade, f64 accumulation, final finite/range guard and f32 conversion. Fifteen
original files plus a frozen export facade are tracked. Only package-barrel
imports are redirected; original local imports and numerical statements are
unchanged. The facade exports original frozen modules, never the new adapter.
Native decode, original-file verification and native scheduling are outside this
numerical closure; deterministic decoded planes are supplied independently.

`oracle-inputs.json` records each original Git blob and SHA-256 plus frozen SHA-256.
Its SHA-256 is `3c00df6ecc6946f8c1e82779d1c48e8a01db2eb882c716ff43e33d4e8a4c22a5`.
The check regenerates the closure from the accepted pin, rejects byte drift and
unexpected files, and runs before fixture compilation. Do not format frozen files
or update the oracle to match a replacement. Copies retain repository provenance
and existing license; no new dependency, third-party source or license change.

## Proposed Video-owned private port

`port.ts` is a fixture adapter over an injected accepted #215 `SelectedPcmSession`.
The fixture supplies the shared ledger, explicit backend and deterministic decoder.
No global backend configuration is changed. `render` transfers a `PcmLease` with
idempotent release; `dispose` drains actual source work without revoking output
leases. The receiving mixer must release only after consumption, including errors.
A separate `ReservationOwner.reserve(bytes)` allocates from the same Host ledger;
output/mix lifetime is not attached to an arbitrary source renderer.

Contract agreement requested from Video in Issue75
and PR232.
At preparation time owner acknowledgment is pending. The real Video-owned files
are not edited. Shared Host's normal composition is still in progress. Latest
#230 acceptance is tested `1cbb0cb3f972814094753a3dca2c1bf493f9d6e3`, docs
`87c7aef1d47aefdf37cff5591be59f4ca8df77bb`; this fixture adopts none of that runtime.

## Running and evidence limits

Use the unchanged official offline build/provenance instructions in
[the R0 README](../pcm-wasm-r0/README.md). Toolchain is Rust 1.90.0, pinned compiler
and installed-file hashes; no additional toolchain or dependencies are downloaded.

```sh
node packages/video-core/experiments/pcm-wasm-r0/build.mjs /tmp/r0-official /tmp/m2-kernel-fresh
node packages/video-core/experiments/pcm-wasm-m2-fixture/freeze.mjs
node packages/video-core/experiments/pcm-wasm-m2-fixture/check.mjs /tmp/m2-kernel-fresh/pcm.wasm /tmp/m2-fixture-fresh
```

The fixture runner requires actual WASM matching reviewed SHA-256
`142871dcfdb24035b228f42ae72a369f6fb389d9b179a13512ae0053901a6bca`.
Missing bytes, wrong hash, fallback or zero completed WASM invocations fail;
there is no optional skip. Fresh external evidence records engine, commit, dirty
state, backend/source diagnostics and module hash. No elapsed-time benchmark.

Both JS and forced WASM compare raw source f32 bits and whole frozen mixed output
bits using identical deterministic inputs in the same Node/V8 runtime. Fixtures
include signed zero/subnormal source inputs, fades, irregular cuts/endpoints,
three resident source sessions with at most two simultaneous contributors,
retained result after disposal, idempotent release, competing admission, abort
with delayed decode/drain, missing forced module and final mix guard ordering.
The fixture collector retains source leases until the entire frozen mix completes;
it is deliberately **not** a new production mixer or a bounded product mix owner.
Its test-only accumulator/collector is not advertised as production-accounted.
Raw kernel overflow/rounding and browser tests remain separate R0 checks; this
small fixture does not replace them or #222's actual media/output timing oracles.

## Before real adoption: explicit ceilings and whole ownership review

Proposed new-owner ceilings for owner review are **64 KiB per active mix owner**
and **256 KiB per playback or export output owner**, inside the unchanged 8 MiB
realm ledger. Existing source-session ceiling remains 2 MiB. These proposed
ceilings are documentation only, not installed policy or a capacity increase.
At N <= 4096, accumulator plus final mixed plane overlap is 8N + 4N = 49152 bytes.
Source leases stay charged to source owners, not counted as free mix capacity.
The output ceiling includes hash/export copies and every pending native buffer;
when exhausted, refuse admission rather than recycle an unproven native lifetime.

The future admission worksheet must use the following simultaneous sum, evaluated
before allocating or accepting each owner. Every term requires measured allocation
sizes/ownership proof from the eventual composed implementation, not timing tests:

`module + sum(all resident source base/cache/backing bytes) + active source staging/transfer/result + mix accumulator/final + sum(all output staging/native bytes)`.

| Item                       | Accounting requirement / proposed bound                                                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module                     | Accepted module reservation 9976 bytes once per shared module owner; independently retained modules count separately.                                                                                    |
| Every resident WASM source | 657408 JS arena + 786432 WASM memory = 1443840 bytes per source even when it contributes no sample now. Source work plus base must fit existing 2 MiB session cap.                                       |
| Three fixture WASM sources | Idle base 4331520 + module9976 = 4341496 bytes; this is not a complete application peak.                                                                                                                 |
| Active source              | Add decode full backing, read collector/callback, JS snapshot, transfer overlap and outstanding output planes. Count all live source results; do not derive source count from the two-contributor rule.  |
| Mix                        | Proposed 65536-byte owner; 49152 bytes maximum f64/f32 conversion overlap at N4096 plus any explicitly owned PCM intermediates.                                                                          |
| Output                     | Proposed 262144-byte owner each; independently count playback and export owners if composition permits both, including delayed ended/add/digest/close.                                                   |
| Other resident sources     | JS decoder caches and index/PCM backing, even when no WASM backend exists, must be inventoried; original/encoded/video/storage ownership remains explicitly separate, not silently credited as free PCM. |

For five idle WASM sources the known base alone is 7219200 bytes, plus module;
that leaves 1159432 of the realm for **all** other charged overlap. Five times
the 2 MiB session ceiling is not admissible under an 8 MiB realm. Do not infer a
safe source count from this incomplete worksheet. The real source/cache and
consumer inventory, owner ceilings agreement and entire release chain must be
reviewed before integration. Native AudioBuffer ended/fulfilled owned close and
underlying audio.add settlement proofs remain mandatory; unknown/rejected native
close retains conservative charges. No real adoption is authorized by these tests.

No rounding, source/mix policy, default, existing cap, public API or benchmark
changes. CI remains disabled/manual-only. No main merge/push, release, deployment,
public publication, dependency license or security-setting change.
