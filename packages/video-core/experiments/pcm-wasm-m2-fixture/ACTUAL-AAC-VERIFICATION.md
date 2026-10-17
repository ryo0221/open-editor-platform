# Actual AAC resource/drain fixture

Clean tested code: **a11965fb0efdec0d682944efab9f3e25891c6c61**.
Stacked on corrected #237 docs `45019062e28c7b80601b0e23a9c9c52b8b87129e`;
all earlier evidence, including the withdrawn codec-heap budget interpretation,
is preserved. This is a private consumer proof, not M2 adoption or a performance result.

## Exact implementation and reproduction

`actual-aac-check.mjs` builds `actual-aac-browser.mjs` through the unchanged
accepted `productBuild`. The runner verifies the package/source hashes in
[REAL-CONSUMER-SOURCES.json](REAL-CONSUMER-SOURCES.json), plus the accepted
audio-only metadata helper SHA256
`85917ad1d02d64554e4db0ad2d2a191ea00e6c922cfd1b49beba87b510997acc`.
Mediabunny and @mediabunny/aac-encoder are both 1.61.3. The existing pinned
AAC timing/close patch is applied by that builder; no replacement encoder,
worker queue, coefficient or numerical implementation is installed.
The retained inventory records the shipped AAC bundle and embedded WASM hash
`8488acb0bc9f43055b83600cc4c2c07d20f07675aa65671f91ac1d75515845d9`.
Existing license/provenance files remain unchanged. No dependency is added.

```sh
node packages/video-core/experiments/pcm-wasm-m2-fixture/actual-aac-check.mjs \
  /tmp/r0-v1-deps /tmp/m2-actual-aac-final
```

Use a fresh external output directory and the verified dependency root from the
prior fixture setup. Requires Chromium at `/usr/bin/chromium` and FFmpeg/ffprobe.
The run records clean Git pin, browser version, bundle SHA, codec inventory,
helper SHA, tool versions, sample hashes, command transitions and ownership counts.
Raw scripts, metafile, MP4s, probe JSON and decoded PCM remain outside Git at
`/tmp/m2-actual-aac-final/`, copied to `/workspace/m2-actual-aac-evidence/final/`.
The first development run and lint failure logs are retained in `/tmp` and copied
logs in `/workspace/m2-actual-aac-evidence/`. They do not certify the final pin.

## Ownership observed through actual encoder calls

Mono 48 kHz deterministic inputs arrive in chunks of at most 400 frames. Each
original allocation is reserved before allocation, and a separate hash copy is
reserved before copying and retained through digest settlement. Resource mode
closes the caller only after the actual `audio.add` promise settles; the original
lease releases only from `AudioSampleResource.close`, after the library's last
alias closes. Each input closes exactly once. The independent BufferSource path
retains originals until final teardown, avoiding reliance on that resource proof.

Observers wrap the registered actual encoder instance's `encode` and
`sendCommand`, returning their original promises. They observe allocations,
ArrayBuffer detachment, actual worker acknowledgments and existing close behavior.
Normal worker init reports frame size 1024. Acknowledgment proves transferred
frame consumption for that command, not worker termination or process reclamation.

| Scenario                                                 | Managed peak bytes | Managed remaining | Codec transfer left unproven |
| -------------------------------------------------------- | -----------------: | ----------------: | ---------------------------: |
| BufferSource 1000 frames                                 |               4800 |                 0 |                            0 |
| Resource 1000 frames                                     |               3200 |                 0 |                            0 |
| BufferSource 1024 frames                                 |               4992 |                 0 |                            0 |
| Resource 1024 frames                                     |               3200 |                 0 |                            0 |
| Resource, abort after actual transfer                    |               3200 |                 0 |                         4096 |
| Resource, close after actual transfer                    |               3200 |                 0 |                         4096 |
| Resource, synchronous postMessage failure before handoff |               3200 |                 0 |                            0 |

All seven PASS. The 1000-frame resource inputs drain before finalization/flush;
AAC's independent pending copy then supplies the tail. At 1024 frames the final
896-byte input backing remains owned at the actual encode send and drains through
actual clone closure. Abort/close occurs while this input is owned. Its safe last
alias closure is distinct from the codec transfer, which stays explicitly
unproven after command rejection. A fresh browser context bounds each case; context
teardown is not presented as a worker termination acknowledgment.

Separate codec inventory: largest observed incoming copy 1600 bytes, pending
buffer 262144 bytes, transferred frame 4096 bytes. The embedded WASM declares
initial memory 18087936 bytes and maximum growth 2147483648 bytes; these are
static declared bounds, not measured process usage. Native input/AVFrame
suballocations are inside that heap. These existing codec internals are outside
the accepted managed-PCM ledger, not an 8 MiB refusal or a cap-change request.
The 3200-byte result covers fixture originals and hash copies only, not the
complete source/mix/playback/export envelope in [PCM-BUDGET-SCOPE.md](PCM-BUDGET-SCOPE.md).

## Independent output and timing checks

FFprobe independently verifies each stream: mono48000, time base1/48000,
start_pts0, duration_ts1000 or1024; the two packet PTS/DTS/duration triples are
`[-1024,-1024,1024]` and `[0,0,count]`, with1024 skip samples. All packet payload
SHA256s, sizes, timing and side data match BufferSource versus resource input.
Input chunk hashes and intervals also match. FFmpeg independently decodes both
outputs, and all decoded f32 bytes match. The1000-frame case decodes1024 frames
with24 trailing frames outside the proved presentation interval; the1024-frame
case has no trailing frames. This does not claim the decoder emits exactly the
presentation count. Both independent comparisons PASS.

Engine Chromium151.0.7922.173; Node24.19.0/V813.6.233.17-node.51;
FFmpeg and ffprobe7.1.5-0+deb13u1. Zero browser errors.
Also PASS at the tested pin: private product bundle, root typecheck, focused
fixture-directory ESLint,28 consumer ownership unit tests and file-size policy
(1840 tracked files). Initial lint failed on one unused variable and two browser
timer globals; fixed before committing and rerun successfully. Injected AAC
errors remain recorded as expected errors, not erased or labeled successful encodes.

## Limits and held work

The unchanged accepted timing helper permits these short audio-only cases. This
is not the >=4800-frame M2 profile, A/V timing, real-media end-to-end M2, normal
Host adoption, or a revalidation of R0 numerical bits. No native playback owner,
source cache, parallel export or full composed memory peak is established here.
Full root suite, normal desktop/mobile flows and performance tests NOT RUN for
this isolated fixture. Existing R0 and frozen numerical oracle checks retain
their separate scope and accepted pins.

Review and Video-owner coordination remain required before any real connection.
The worker exposes no termination acknowledgment; aborted transferred bytes remain
unproven. No codec switch, public API, schema, default, existing cap, production
Host, numerical or security changes. All seven workflow files remain manual-only;
the read-only Actions permissions query returned HTTP403 and was not bypassed,
so server-side disabled status could not be freshly confirmed. No workflow was
dispatched. No main push/merge, release, deployment or public publication.

## Review correction: pre-handoff fault identity

Review found an acceptance gap at the original tested pin: the post-throw branch
required only some failure and zero pending transfer bytes, allowing an unrelated
initialization failure to satisfy it. This was a fixture validation gap, not a
proven product encoder bug. The original evidence remains historical and intact.

Corrected clean tested code **50651519494e2a2ef1e5ef4ed34da7c3bb14d250** now
requires `beforePostFailed`, an `encode` record with state
`rejected-before-handoff`, `handed === false`, exactly4096 bytes (1024 mono f32
frames), and the exact `Error: Fixture postMessage pre-handoff failure`, in
addition to zero pending transfer bytes. The encoder is unchanged.

PASS: the affected actual case records init acknowledgment followed by the
4096-byte rejected-before-handoff encode and expected injected error. The existing
seven-case runner and two independent output comparisons were rerun unchanged;
all PASS, zero browser errors, clean tree recorded. Focused changed-file ESLint
and formatting also PASS. Prior root typecheck/unit/file checks retain their
original pin; not rerun for these assertion-only changes.

Reproduce with the same runner/dependency root and fresh output
`/tmp/m2-actual-aac-postthrow-review`. Raw evidence is retained there and copied
to `/workspace/m2-actual-aac-evidence/postthrow-review/`. No cases were added:
late-init, worker-error and post-close-response cases remain **NOT RUN**. All
previous integration, memory-scope, performance and publication limits remain.
