# Actual AAC finalization ownership correction (historical #169 checkpoint)

Further cross-track and pending-init-RPC defects were independently confirmed.
See [per-track follow-up](TRACK-FIX.md); this original pin remains HOLD and its
limited single-flush evidence below is not full cleanup acceptance.

#168 remains HOLD pending independent review of this correction. Its evidence
HEAD `5b260e6013e9b678793c5625ab94a32aea729fc7` remains unchanged. This small follow-up
uses branch `codex/issue-75-finalize-drain`.

Exact corrected code: `e13d335df392ccca33b616045b955a59e05f1745`.

## Failure and correction

Pinned Mediabunny 1.61.3 returns from `Output.cancel()` immediately while state is
`finalizing`. Cancelling the caller's `abortable(finalizePromise, signal)` wait
therefore did not establish encoder completion. The old adapter released its
realm AAC state, and the outer Host drain reported success while AAC flush was
still paused. The actual-codec regression reproduced all three wrong observations:
job settled, underlying finalize pending, realm state cleared. A competing job
could enter that realm.

The corrected adapter retains the actual finalize promise independently of caller
cancellation/timeout and awaits its resolve/reject before releasing realm state.
It also owns start/add promises, so a cancelled wait cannot abandon their work.
The existing outer VideoExport disposal continues to await the adapter settlement.
A permanently unresolved operation keeps drain incomplete; a timeout is not treated
as proof of termination.

A second real-codec probe found that when the custom AAC flush rejects, the pinned
library's serializer can skip the queued custom `close()` call. Merely awaiting
finalize was not sufficient: the first attempted fix still left the AAC worker
unclosed. That failure is retained as well.

The already hash-pinned, in-memory AAC build patch now registers the encoder with
its current realm owner at init and releases that ownership on close. After all
owned operations settle, the adapter directly closes any encoder still retained
by that owner. The pinned AAC close synchronously terminates its worker. Only then
is the realm cleared. This is a private candidate adapter correction, not a new
root dependency, library installation, shared API or permanent adoption.

## Actual flush gate

`finalize-check.mjs` builds the real product-codec, real VideoExport, real Host
lifecycle, actual fixed Mediabunny/AAC worker and native video encoder. A test-only
build transform pauses the actual AAC `flush()` before its worker command. It
also observes the actual AAC close after worker termination. There is no fake
Output.cancel or fake codec port in this probe. Normal product builds do not
include these test hooks.

Two cases use a generated retained AVC/AAC original: release the paused flush
normally, or inject a rejection at that exact boundary. In both cases the Host
is revoked while the actual finalize remains pending.

| Observation                 | Pending flush | After settlement / cleanup |
| --------------------------- | ------------- | -------------------------- |
| Job settled                 | false         | true, rejected             |
| Underlying finalize pending | true          | false                      |
| Realm state cleared         | false         | released for recovery      |
| Host drain                  | incomplete    | drained                    |
| Competing encoder admission | refused       | fresh real export succeeds |
| Closed AAC encoders         | 0             | 1                          |
| Published cancelled result  | none          | none                       |

Normal flush emits its remaining packets into the **old retained owner** (45 → 48),
then closes. Rejected flush emits no extra packets and is explicitly closed. Both
cases then produce a fresh 57,442-byte MP4 through the real adapter. No browser
page errors occurred. These are cleanup/ownership tests, not performance results.

## Exact-pin verification

On a clean tree at the corrected code SHA:

- PASS: two actual delayed AAC flush cases (resolve and reject), including drain,
  competing-job refusal, worker close and real subsequent export.
- PASS: 108 combined Core/PCM/lifecycle/import/bundle/export unit tests.
- PASS: desktop/mobile full short A/V workflow, independent saved-file checks,
  real AAC packet cancellation and recovery.
- PASS: normal typecheck, lint, build and file-size check.
- NOT RUN: longer-media/audio playback/practical-size gates, real iPhone/Windows,
  HDR, unrelated suites and performance. This correction does not expand #168's
  short supported profile or make it a complete Video implementation.

```sh
node packages/video-metadata/host-media/finalize-check.mjs /workspace/video-codec-eval/deps /tmp/video-product-pinned/original.mp4 /tmp/video-finalize-pinned
node packages/video-metadata/host-media/product-check.mjs /workspace/video-codec-eval/deps /tmp/video-finalize-product-pinned
npx vitest run packages/video-core/src packages/video-core/experiments/pcm-renderer packages/video-metadata/host-media/workflow.test.ts
npm run typecheck
npm run lint
npm run build
npm run check:files
```

Use fresh output directories. Raw evidence remains outside Git:
`/tmp/video-finalize-pinned/results.json`, `/tmp/video-finalize-product-pinned/`,
`/tmp/video-finalize-pinned-*.log`. Original FAIL observations:
`/tmp/video-finalize-before/` (early drain/state release) and
`/tmp/video-finalize-close-after/` (first attempted fix: rejected flush skipped close).
Original #165 and #168 failure evidence also remains untouched.

Documentation was corrected: the saved-AAC verification used a separate page in
the same browser context. The bundle reopen used a genuinely new context. Runtime
staged verification checks metadata/provenance; independent full decoding is
acceptance-test evidence. The next longer-workflow test must add head trim,
retained segments with an internal cut and reorder, then bundle-only reopen,
synchronized audio preview and actual export. That work is not included here.

Automatic workflows remain manual-only, with CI/file-size/Office disabled. No
Actions dispatch, main push, merge, release, deployment or performance run.
