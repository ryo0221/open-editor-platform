# Remaining actual AAC lifecycle gate

Clean tested code **1e782d451358aeabfffc5e0a0dde0cb00ddc2f97**, separate successor
to accepted #239 code50651519494e2a2ef1e5ef4ed34da7c3bb14d250 /
docs2b5196c1c9fc620fa40748b5e32884dfa674cf17. Earlier files/pins/evidence are
unchanged. This is an isolated fixture, not production M2 adoption.

## Cases and injection boundaries

`lifecycle-aac-browser.mjs` and `lifecycle-aac-check.mjs` retain the previous
actual library/worker, original-promise observers, resource ownership, pinned
package/build/helper identity checks and independent output comparisons. The
existing builder's test-transform seam adds only two shape-checked hooks:
delay the real worker factory result before assignment, and intercept authentic
worker replies before the accepted close guard. Codec arithmetic and worker code
remain unchanged. The bundled test script hash and embedded codec WASM identity
are recorded in results. Test hooks are not installed in production.

Both4800 and5121 mono48kHz frames run six cases: BufferSource and resource normal
completion, creation-close, init-close, worker-error and late-response. Normal
cases stream400-frame chunks; each fault case holds the **entire4800/5121-frame
input in one AudioSample**, so fault ownership is not inferred from tiny chunks.
5121 is five1024-frame AAC frames plus a one-sample tail. Failure paths do not
claim to have encoded all input: creation/init failures encode none, while the
other faults interrupt the first actual transferred1024-frame command.

- **Creation-close:** await the real factory, hold its result before assignment,
  close the owner, cross a microtask, assert the full Host input is still owned,
  then return the actual worker. The accepted late-creation guard terminates it,
  rejects init and leaves ctx0, no worker and no owner. No PCM command is sent.
- **Init-close:** intercept a successful authentic init reply with exactly one
  pending RPC, ctx0 and full Host input still owned. Close, then replay that same
  reply through the actual callback. The accepted close guard ignores it; snapshots
  before/after replay match, no context is installed and no PCM is transferred.
- **Worker-error:** after verified detachment of a4096-byte frame, dispatch a
  controlled ErrorEvent on the real Worker. Its unchanged error listener rejects
  pending RPCs, nulls/terminates the worker, and the owning cleanup subsequently
  closes the encoder. Assert the exact injected error, intended phase, immediate
  pending-map drain, and Host input still held at error dispatch. This tests the
  actual handler, not a naturally occurring browser crash/CSP failure.
- **Late-response:** intercept a successful authentic encode response while its
  RPC and full input are held; close, then replay it through the actual callback.
  Assert identical closed snapshots (context, pending RPCs, worker, owners,
  emitted packets and managed bytes), no resurrection, and exact termination
  error. The received response is deliberately withheld from the normal pending
  resolution path; accounting conservatively leaves its transfer unproven.

Every fault must reach its phase, terminate the actual worker exactly once, leave
no pending RPC/worker/registered encoder, and release each Host input exactly once
through final resource alias closure. Each page has a30-second correctness
completion deadline; no timing/speed result is reported. Fresh browser contexts
bound cases, but their disposal is not treated as a codec termination acknowledgment.

## Managed versus codec-owned results

All12 cases PASS; zero browser errors. Host original backing and overlapping hash
copy are reserved before allocation/copy; hash settlement and actual library
alias close determine release. Peaks below cover only those fixture-managed PCM
terms, not video/encoded output/source/mix/process memory.

| Case                | 4800-frame peak | 5121-frame peak | Final Host bytes | Unproven codec transfer |
| ------------------- | --------------: | --------------: | ---------------: | ----------------------: |
| BufferSource normal |           20800 |           21768 |                0 |                       0 |
| Resource normal     |            3200 |            3200 |                0 |                       0 |
| Creation-close      |           38400 |           40968 |                0 |                       0 |
| Init-close          |           38400 |           40968 |                0 |                       0 |
| Worker-error        |           38400 |           40968 |                0 |                    4096 |
| Late-response       |           38400 |           40968 |                0 |                    4096 |

At injection, fault inputs retain19200/20484 managed bytes after their hash copy
has settled. Close/error/replay snapshots still retain them; only subsequent
actual caller/library alias release brings this term to0. Zero transferred PCM
in creation/init means none was sent, **not zero codec memory**. All cases record
`terminationAck:false` and `codecReclamationProven:false`; initialized context
numbers may remain as inert fields after close. Actual codec worker reclamation
is not proven by a synchronous terminate call or an empty owner set.

The unchanged AAC heap inventory remains separate from the accepted8MiB managed
ledger. No new cap or total-process fit claim follows from these numbers. Incoming
codec copies,262144-byte pending buffer and4096-byte transferred frames are
separately observed; native suballocations remain inside the declared codec heap.
See the corrected [scope](PCM-BUDGET-SCOPE.md) and prior [AAC proof](ACTUAL-AAC-VERIFICATION.md).

## Independent output/timing and retained evidence

Four normal outputs use the unchanged accepted metadata helper. Its >1024-frame
profile requires two tracks, so each fixture includes one128x128 AVC picture with
duration=count/48000. Video is supporting fixture content; this is not the real
M2 video timeline or a video quality/A-V synchronization acceptance claim.

FFprobe verifies audio mono48000, timebase1/48000, start0, duration=count,
priming packet[-1024,-1024,1024] and every subsequent PTS/DTS/duration on the1024
sample grid, with exact final remaining duration and1024 skip samples. All audio
packet payload hashes, sizes, side data and timing match between BufferSource and
resource paths; input hashes match too. FFmpeg decoded f32 bytes match exactly.
Both independent comparisons PASS.4800-frame presentation decodes5120 frames
(320 outside the proved interval);5121 decodes6144 (1023 outside). No assertion
silently truncates those tails. Raw probes and decoded files are retained.

```sh
node packages/video-core/experiments/pcm-wasm-m2-fixture/lifecycle-aac-check.mjs \
  /tmp/r0-v1-deps /tmp/m2-aac-lifecycle-final
```

Use the prior verified external dependencies and a fresh output directory.
Node24.19.0/V813.6.233.17-node.51, Chromium151.0.7922.173,
FFmpeg/ffprobe7.1.5-0+deb13u1; Mediabunny/AAC encoder1.61.3.
Clean-pin results and raw artifacts are `/tmp/m2-aac-lifecycle-final/`, copied
alongside development runs/logs to `/workspace/m2-aac-lifecycle-evidence/`.
PASS also: private bundle, root typecheck, changed-file ESLint,28 consumer
ownership regressions, file policy1843 files. Full root suite, desktop/mobile
product flows, actual M2 connection and benchmarks NOT RUN.

First development run FAILED creation-close's expected error check because the
fixture wrapped an already wrapped Error. The successor now preserves the
original error through its watched promise and rethrows that error. The failed
run at `/tmp/m2-aac-lifecycle-first/` and subsequent successful development run
at `/tmp/m2-aac-lifecycle-second/` are retained; neither certifies the clean pin.
This was fixture error handling, not a product encoder fix.

Review/Video-owner coordination remains required before real integration. No
production wiring, cap/default/codec choice/schema/public API changes. Accepted
sources/licenses and earlier pins remain intact. All workflows remain manual-only;
no dispatch, main push/merge, release/deployment/publication or performance work.
