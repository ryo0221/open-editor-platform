# Real consumer mapping — source review only

Preserves accepted #235 code `de0027294678310f847e4448fb83b840fd06ea49` /
docs `f2fac03db0b5f56c55f1e85057f32c7f119048f6`. **No consumer code changes.**
Inspected accepted #230 tested `1cbb0cb3f972814094753a3dca2c1bf493f9d6e3` /
docs `87c7aef1d47aefdf37cff5591be59f4ca8df77bb`, its actual build transform,
Mediabunny1.61.3 and AAC extension1.61.3. Hashes/paths are in
[REAL-CONSUMER-SOURCES.json](REAL-CONSUMER-SOURCES.json); no library source is copied
into the repository. Lines below refer to those exact installed source files.

**Findings:** add is backpressure, not unconditional consumption. The original
export backing and encoder-created copies need different completion proofs. A
per-chunk await of final track flush would deadlock the export loop. The AAC
pendingBuffer is262144 bytes of existing codec-owned staging; it is separately
inventoried under the accepted codec exclusion, not automatically charged to the
Host output-owner target. [Scope reconciliation](PCM-BUDGET-SCOPE.md) withdraws the
original incompatible cap comparison. Real connection still needs managed
allocation/alias/native lifetime review.

## API → private ownership contract

| Actual code / evidence                                                                       | Meaning and required ownership                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sample.js:1732–1816,2036–2060,2127–2144`                                                    | BufferSource construction makes a view; clone shares its backing. Closing one sample does not close another alias. Reserve the whole ArrayBuffer once, not a view length; caller close alone is insufficient. Validating constructor failure before any handoff permits caller-owned release; no assumption about a partially escaped native object.                                                                                                                                                                                         |
| `media-source.js:1618–1715,1771–1785,2133–2157`                                              | M2 supplies no transform. Custom encode clones the sample, queues encode in CallSerializer, closes clone in finally, and only awaits that task when queue size reaches4. Earlier add resolutions can precede any source read. Actual add settlement must stay owned across abort, and must be paired with backing-specific last-reader proof.                                                                                                                                                                                                |
| `sample.js:1711–1750,1942–1974,2036–2042,2127–2136`; `sample.d.ts:442–470`                   | Existing AudioSampleResource shares an internal reference count across sample clones and calls resource.close at last close. **Candidate proof for the original export backing:** a private resource owns its lease; close is idempotent and resolves that backing's consumersDone. This is a proposal, not yet tested with the real encoder. Preserve mono f32/48000 data and exact metadata. Validate getters/data before construction; test constructor throw and partial reference increment without treating it as escaped consumption. |
| AAC `src/encoder.ts:149–184` (shipped bundle encoder body)                                   | encode creates a new incoming audioBytes allocation, copies sample data into it, then into pendingBuffer. Those are independent allocations. The original sample need not wait for the future padded tail flush once all aliases are closed; the copied tail remains owned by encoder staging.                                                                                                                                                                                                                                               |
| AAC `src/encoder.ts:206–233`; `src/encode.worker.ts:113–132,159–178`; `src/bridge.c:113–142` | Each frame uses pendingBuffer.slice, transfers that new frame backing to worker, then worker copies bytes into WASM input memory; bridge copies/deinterleaves into an AVFrame. Transfer detachment does not release accounting. A successful encode response follows synchronous input processing; it is a candidate no-future-read proof for the transferred input, not proof that worker heap/native codec state was freed.                                                                                                                |
| AAC `src/encoder.ts:187–204,273–304`; worker command switch                                  | Flush pads tail, sends flush command and resets logical timestamps; worker reset only calls avcodec_flush_buffers. There is no worker close/free command in this implementation. Upstream close merely terminates worker. Neither command acknowledgment nor sample.close proves all persistent encoder/native allocations released.                                                                                                                                                                                                         |
| Accepted `product-build.mjs:35–89`; `encoder-state.mjs`                                      | The **actual accepted patch** registers encoder ownership, rejects pending commands on close, terminates/nulls worker, handles late worker creation and ignores post-close messages. It does not create a termination acknowledgment, release pendingBuffer, or add worker close_encoder handling. Treat rejected command promises as errors, not worker-memory drain proof.                                                                                                                                                                 |
| `misc.js:766–773`; `media-source.js:2074–2107`; `output.js:607–674`; M2 codec cleanup        | CallSerializer chains `.then(fn)`; a rejection can skip later functions. Output flush/close uses fail-fast Promise.all. Accepted codec owns each track promise and bypasses a poisoned serializer through closeOwnedEncoders. Keep all these owners; neither first failure nor encoder-set deletion alone proves every backing released.                                                                                                                                                                                                     |

## Avoid the final-flush dependency cycle

Proposed per-input state machine: reserve original/copies → construct private
resource/sample → invoke and own actual add → after actual add settles, close the
caller sample → wait for that resource's final alias close → release original
backing. Library clone-finally runs when that chunk's custom encode task settles,
including skipped queued calls after a serializer failure. Sub-frame tail data is
already copied into encoder staging, so original-resource closure need not await
flush. A bounded input queue may wait for the oldest **per-input** proof; it must
not wait for Output.finalize or track flush inside the frame loop.

After all samples have been submitted, start normal finalization once and drain
track/worker/target owners. On cancellation stop submission, preserve actual add
and resource promises, initiate existing close/cancel concurrently and await all
independent cleanup. A failed resource/worker proof retains its own charges. Do
not close caller sample merely because abortable waiting rejected while add may
still read it. Per-backing consumersDone can be narrower than whole encoder drain:
this refines #235's generic fixture signal without weakening last-reader proof.

## Native playback constructor/handoff mapping

Accepted `playback-v2.mjs:201–212` creates AudioBuffer, copies channels, creates
source, assigns buffer, connects, registers source, then starts. The future owner
must reserve first, retain local cleanup for pre-handoff failures, and register
ownership before connect/start. A start failure after registration remains owned
until ended or fulfilled owned context close. Clear all owned buffer references;
unknown/rejected close conservatively retains charges.

The [dated W3C Web Audio draft](https://www.w3.org/TR/2026/WD-webaudio-1.1-20260922/#dom-audiobuffer-copytochannel)
specifies copying and possible copy errors. Its
[acquisition algorithm](https://www.w3.org/TR/2026/WD-webaudio-1.1-20260922/#acquire-the-content)
retains channel data for start; additional copies may be lazy, not guaranteed absent.
[Context close](https://www.w3.org/TR/2026/WD-webaudio-1.1-20260922/#dom-audiocontext-close)
does not automatically discard all referenced objects. Thus logical drain plus
reference clearing is not a claim of immediate physical heap reclamation.
No Chromium native implementation was inspected or executed in this review;
constructor/copy/connect/start failure behavior still needs real-engine fixtures.
Budget any acquisition copies conservatively until proven for the supported path.

## Updated allocation worksheet and blockers

For N mono input frames, the Host-managed export4N and hash4N copies remain
charged with source/mix/native overlap. Existing codec-internal incoming4N,
pendingBuffer262144, transferred frame4F and worker WASM/native state remain
separately inventoried. F comes from the actual init response. Worker C input and
AVFrame storage are suballocations of its heap, not additional external backings.
Queue count4 is backpressure, not a whole-memory bound. Preserve source/pending
buffer growth and worker cleanup review; no hidden Host-managed copy is exempt.

The accepted #211/#215 budget excludes total codec/GPU/JIT/GC/process memory.
Therefore neither AAC's staging size nor its initial codec heap alone proves
managed-budget non-fit. No cap increase, encoder replacement or silent scope
change is proposed. The corrected bounded managed envelope and additional-owner
refusal conditions are in [PCM-BUDGET-SCOPE.md](PCM-BUDGET-SCOPE.md). Native/drain
review remains necessary; source-only analysis cannot certify the final consumer.

## Bounded next implementation plan (not implemented here)

1. Add an isolated real-library fixture using hash-pinned AudioSampleResource and
   controlled custom encoder delay. Prove add can resolve early, last alias close
   releases exactly once, constructor/queue errors do not lose leases, and short
   chunks complete input ownership before any final flush. Keep sample bits and
   metadata identical to the BufferSource path. Include cancellation before add
   completes and poisoned serializer closure. This is the smallest useful next slice.
2. With Video, review Host-managed reservations before allocation and separately
   inventory the existing codec's incoming copy, old/new pendingBuffer, transferred
   frame and worker input/AVFrame lifetimes. Do not charge the whole codec to the
   managed ledger or change arithmetic, padding, codec/timestamps or staging size.
   Keep worker disposal proof separate from original-input alias release; retain
   unresolved Host leases until their actual readers drain. No runtime patch here.
3. Reconcile managed-owner overlap and native backing charges inside existing
   limits; codec-owned internals remain separately inventoried. Extend controlled
   fixtures with the relevant real inventory and refuse managed admission when
   that overlap cannot fit. Test errors after handoff, worker crash/CSP, late init/
   response, postMessage throw, pending digest and independent cleanup failures.
4. Only after this review and the remaining exact-pin Shared#233 acceptance gates,
   agree an exact combined pin and let Video own real consumer edits. Run frozen
   numerical, actual-original/audio/video timing, native drain and normal Host gates
   there. No historical PASS is integration acceptance.

Validation here: local package/source hashes match accepted build's pinned
media-source/output/AAC bundle identities. Executed unchanged accepted productBuild
with a capture-only transform hook; build succeeded and recorded the patched AAC
body SHA256 `ba4bc68f52d57efe2bd47da3df9a0bbbadf4e8a07daa321c79ca11f7824345fb`.
Capture/metafile at `/tmp/m2-real-consumer-review`, outside Git. No encoder execution,
consumer/browser test, kernel rebuild, benchmark or production build claimed.
Documentation formatting/file/whitespace checks only; existing numerical/runtime
sources unchanged. CI/manual-only, caps/defaults/numerics/public API, performance,
main/release/publication/license/security holds preserved.
