# Isolated consumer ownership contract and worksheet

This successor preserves accepted #234 code5dca1b10/docs2817648e. It is **fixture
only**, not a replacement M2 renderer/player/codec. Frozen numerical files are
unchanged. #233 normal integration and its catalog-isolation/final gates remain
with the Shared owner; no production consumer or Host file is edited here.

Video's conditional acknowledgment
and Shared-thread note
are accepted as the contract direction. The 64KiB mix / 256KiB output ceilings are
still provisional review targets, not proven production fit or installed policy.
Existing 8MiB realm / 2MiB source caps, numerical policy and public APIs are unchanged.

## Precise private contract

- Trusted source dispatch binds immutable original SHA, stream and decode policy
  to a source port. `sourceId` alone is not an identity check; the isolated adapter
  does not claim to validate dispatch. Every resident deduplicated source remains
  accounted even when it contributes no current sample.
- `SourcePort.render` transfers one source `PcmLease`. Consumer owns its release
  after the final read, including validation, abort, gain or guard exceptions.
  `dispose` stops new source work and awaits actual work/port transfer; it cannot
  revoke a transferred lease. Existing accepted source-session behavior is reused.
- Mix and output reservation owners are independent of source sessions and share
  the injected Host ledger. Reserve before allocation, both against cumulative
  owner bytes and realm bytes; failed admission leaves both unchanged. Owner close
  stops new reservations but keeps all outstanding releases valid and all bytes
  charged. Never blanket-reset or evict an old lease to admit new work.
- Each source row is released after consumption in finally. The f64 accumulator
  and final f32 allocation overlap during conversion. The returned mixed plane
  carries a distinct lease that survives render completion and owner close.
  Retaining earlier results consumes the next render's available space. This
  fixture refuses conversion when that cumulative overlap exceeds the owner cap.
- Hash staging is a separate full-size copy, retained until actual digest
  settlement. Abort of a caller's wait is not digest completion. Playback's
  scheduling-gap skip releases its mixed lease but not an outstanding hash copy.
- Reserve native AudioBuffer bytes before creation/copy. Before native handoff,
  allocation/copy/source-construction failure releases unscheduled backing.
  Handoff to the accepted `ScheduledAudio` owner precedes connect/start, so failure
  after handoff keeps bytes until ended or fulfilled owned close. Stop,
  disconnect, currentTime and context.state cannot release. Rejected/unknown close
  conservatively retains bytes; repeated close shares one promise. Delayed ended
  events are bounded by cumulative output admission, not the 0.24s schedule rule.
- Export stages separate export and digest copies. `AudioSample` and clone views
  alias one accounted full backing; alias view length is not allocation size and
  sample.close is not release authority. A transferred backing retains the same
  charge after detachment; an actual additional worker copy requires a separate
  reservation before copying.
- The export fixture requires two independent conditions: actual add settlement
  (including synchronous throw/rejection) **and fulfilled `consumersDone`**. The
  latter must prove all worker/encoder/clone readers are done, including any
  required track flush/close and worker drain. It is not an alias for add or
  sample.close. Caller wait abort changes neither condition. Rejection of this
  proof retains backing conservatively even if add settled and sample.close ran.
  No timeout, accounting reset or unproven cleanup is permitted. Sample cleanup
  failure after a valid drain proof is reported while independent releases finish.

`consumer-ownership.ts` contains an isolated allocation/lifetime skeleton with
injected controlled ports. `mixOwnership` delegates arithmetic to test callbacks;
it does not implement gain/fade or replace the frozen numerical oracle. Native
ports and completion promises in these tests are controlled fixtures, not proof
that real WebAudio/Mediabunny/worker events satisfy this contract. In particular,
real export must identify the true consumersDone boundary from its pinned library
and worker lifecycle before any backing may be freed.

## Peak worksheet, exact fixture inventory

The representative four-resident-source test reserves the following simultaneous
terms in one 8388608-byte accepted Ledger. It models categories explicitly; it
**does not instantiate four real M2 source indices or prove their total heap fit**.
Separate forced tests instantiate three actual R0 WASM owners. The reference M2
4-derived-file/128MiB scratch policy is storage accounting, not PCM admission.

| Simultaneous category                                             |       Bytes | Lifetime                                                        |
| ----------------------------------------------------------------- | ----------: | --------------------------------------------------------------- |
| Shared module                                                     |        9976 | Retained module                                                 |
| Four resident WASM sources: each657408 JS arena +786432 memory    |     5775360 | Includes inactive source owners                                 |
| Coexisting v1 JS backend arena                                    |      657408 | Independent owner in same realm                                 |
| One preparation cache                                             |     1048576 | Preparation overlap only; not multiplied as permanent residence |
| Pending write backing                                             |      262144 | Until actual writer drain                                       |
| Range-read full backing                                           |       16384 | Until final read                                                |
| Collector planes/seen/callback:4096×9 +4096×4                     |       53248 | Decode overlap                                                  |
| Older returned mix plane                                          |       16384 | Consumer still owns it                                          |
| Scheduled native mono1920 buffer                                  |        7680 | Ended/owned close proof                                         |
| Current mix accumulator                                           |       32768 | Through final conversion                                        |
| Current source result (or final mixed plane after source release) |       16384 | Distinct source/mix owners, never implicitly transferred        |
| **Representative peak**                                           | **7896312** | Remaining realm492296; not a production headroom promise        |

The test asserts this exact total, realm refusal one byte past remaining space,
source-result release before mix-result retention, and zero bytes only after
all owners' independent proofs/releases. Returned-mix owner peak is65536:
old16384 + accumulator32768 + new16384. With two old results held, the next final
conversion is refused, leaves old32768 intact and releases its accumulator.

Other fixture phase peaks are checked separately: for64-frame export,
export256 + digest256 =512 bytes after mixed input has been copied/released;
after digest settles, export256 remains until both proofs. Playback reserves
16×4096×4 =262144; the next schedule is refused with all sixteen buffers retained.
These values are not claims that every real source preparation and output phase
can coexist at these limits. During initial copying the input lease also overlaps;
source/mix and output owners are separately charged, with no alias-based discount.

Before real connection, replace each modeled preparation/source term with proven
lifetimes for File/PCM backing, BlobSource cache, metadata/index arrays, native AAC
callbacks, pending interleaved writes, range reads, collector, backend snapshots,
transfer/worker staging and all outstanding outputs. Count every source plus
coexisting v1/other PCM owner; identify actual copies versus aliases. Encoded
originals, OPFS, video/storage buffers and unmeasured engine overhead remain
explicit separate categories, not silently declared free or covered by this
8MiB ledger. Any unaccounted native/worker ownership blocks real adoption.

## Fixture gates

`consumer-ownership.test.ts` exercises cumulative/shared admission, full backing
versus alias views, source/mix lifetime separation, mismatch/gain/guard/abort
cleanup, delayed digest, scheduling-gap skip, delayed ended/rejected close,
allocation/copy/connect/start failures, actual add and consumer proof in both
orders, sample-close-only refusal, transfer detachment, early wait abort,
add/sample/digest failures and cleanup failures across independent owners.

Successful forced conversions now assert kernel completions >0 **and exactly
completions == invocations**, alongside backend/hash/engine/no-fallback proof.
Cancelled requests may have no completed conversion; they are not relabeled as
successful forced conversions. Raw kernel matrix and common product guard remain
separate; full frozen M2 bit tests remain unchanged except stronger diagnostics.

No quota, default, cap, rounding, numerical, schema or public API change. No
benchmark or automatic Actions. Real connection requires this contract/fixture
review and the Shared/Video owners' subsequent exact composed pin and gates.
