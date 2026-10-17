# Per-track cleanup and terminated AAC RPC correction

Follow-up to #169; adoption remains HOLD pending independent review. #168 and
#169 heads remain unchanged. Branch: `codex/issue-75-track-drain`.
Exact tested code: `4b5bcd40ac9a2400dc7c2f095d5d3d2265241db8`.

## Confirmed defects

1. Pinned Output.finalize uses fail-fast Promise.all. One track failure could
   settle that outer promise while another track's flush/close still ran. #169's
   ownership of the outer promise was insufficient: the realm and Host drain could
   be released with pending cross-track work.
2. Terminating the AAC worker did not reject its pending RPCs. Cancellation during
   init could leave audio.add waiting forever, or a retained response could later
   initialize a context in an already terminated encoder.

Both original behaviors were reproduced against the #169 sources, preserving
`/tmp/video-track-native-before/results.json`. The tests use the real product
adapter, fixed Mediabunny, actual AAC worker and native VideoEncoder. The video
failure/hold is injected inside native VideoEncoder.flush so its enclosing source
cleanup still runs; it is not a fake source function that bypasses close.

## Correction

Each private AudioSampleSource/VideoSampleSource `_flushAndClose` promise is owned
independently by the export job, including when invoked by cancel. The adapter
awaits all tracked operations after the outer finalize/cancel returns or rejects.
The private hook is explicitly tied to pinned source shapes and hashes, not a
shared/public API. Build refuses drift in these Mediabunny 1.61.3 files:

- media-source.js SHA256 `1c60a60034eff049d8ee1a973de7ef665bb8e648ee14854227150556e25f9088`
- output.js SHA256 `699dae1192ee789c32577a0cf2e9980d41845af4e66b8ba626e6ba87f9b511b3`

On cancellation or failure, owned AAC workers are explicitly closed before waiting
for remaining tasks. The hash-pinned AAC patch makes close idempotent, marks the
instance terminal, rejects and clears every pending RPC, terminates/nulls its
worker, and releases that instance from the owner. A late worker acquisition is
terminated on assignment, late messages are ignored, and init checks terminal
state before installing the returned context. Subsequent sendCommand calls reject
through workerError. Old work cannot acquire the next job's realm state.

AAC may be definitively terminated while another track operation remains pending;
realm/drain still remain owned until that operation actually settles. A never-
settling native operation is not called drained merely because a timeout elapsed.
No whole-library patch, installed-file mutation, dependency, root manifest, shared
Host/API or permanent contract adoption is included.

## Exact-pin evidence

| Gate                                                                 | Result                                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| AAC rejects + native video flush held                                | PASS; pending track keeps drain incomplete and realm held; both encoders close before final drain |
| Native video rejects + AAC flush held                                | PASS; AAC is terminated, but pending track operation still keeps realm/drain owned until release  |
| Actual worker init response held, then cancel                        | PASS; pending RPC 1 → 0, actual job rejects/cleans, late replay leaves ctx=0 and worker=null      |
| New export after each of the above                                   | PASS; actual 57,442-byte MP4, no browser errors                                                   |
| Prior delayed AAC finalize resolve/reject                            | PASS, two cases under explicit termination policy                                                 |
| Combined Core/PCM/Host unit tests                                    | PASS, 108                                                                                         |
| Actual short product workflow                                        | PASS, desktop/mobile plus independent A/V output validation and cancel/recovery                   |
| Typecheck / lint / build / file-size                                 | PASS                                                                                              |
| Long synchronized preview / >44 s media / practical-size integration | NOT RUN / not yet implemented in this correction                                                  |
| iPhone / Windows / HDR / performance                                 | NOT RUN, existing holds remain                                                                    |

In the two crossed cases, observations while the other flush is held are:
jobSettled=false, stateHeld=true, competingRefused=true, drain=incomplete. After
release: rejected job, drain=drained, AAC close=1, native video close=1, no published
cancelled output. The init case can drain before the test replays its **already
invalidated** retained callback: the actual worker is terminated and its real RPC
promise is rejected. It is not a still-pending owned request. Late ctx remains 0.

#169's original resolve-after-cancel test allowed final packets to finish. This
correction deliberately terminates AAC on cancel, so no extra AAC packets are
emitted after cancellation; the held flush task is still awaited. Both behaviors
are distinguishable in retained evidence rather than silently relabelled.

```sh
node packages/video-metadata/host-media/track-check.mjs /workspace/video-codec-eval/deps /tmp/video-product-pinned/original.mp4 /tmp/video-track-pinned
node packages/video-metadata/host-media/finalize-check.mjs /workspace/video-codec-eval/deps /tmp/video-product-pinned/original.mp4 /tmp/video-track-finalize-pinned
node packages/video-metadata/host-media/product-check.mjs /workspace/video-codec-eval/deps /tmp/video-track-product-pinned
npx vitest run packages/video-core/src packages/video-core/experiments/pcm-renderer packages/video-metadata/host-media/workflow.test.ts
npm run typecheck
npm run lint
npm run build
npm run check:files
```

Use fresh output directories. Final raw results/logs are in
`/tmp/video-track-pinned/`, `/tmp/video-track-finalize-pinned/`,
`/tmp/video-track-product-pinned/` and `/tmp/video-track-pinned-*.log`.
Original #165/#168/#169 failures are retained. This corrects cleanup only; the
existing short A/V evidence does not certify longer audio playback or practical
media sizes. Indexed-media prototypes remain on their separate branch, unadopted.
Automatic CI remains stopped. No Actions dispatch, merge, release, main push,
deployment, publication or performance measurement.
