# #180 codec/resource review corrections

Exact clean code gate: `b5a04b1edeaeee0cf43a958364604f9ac29f544a`.
Separate branch `codex/issue-75-integration-cleanup`, based on unchanged #180
`9de5ee07226f70c017d5e3889013162b2099d9ee`. No storage, root, shared API or dependency
changes. #180's scope/limits and real-iPhone rejection remain unchanged.

## Independent cleanup

Actual OPFS removeEntry failure reproduced the review finding: export rejected,
but video sessions remained1, encoder realm remained owned, and the next export
failed `Encoder realm busy`. Evidence is retained in `/tmp/video-cleanup-before/`.

Export now starts every independent cleanup, settles cleanup and owned track work,
and releases the encoder realm before reporting aggregated cleanup errors. Primary
errors are retained in the aggregate when present. Cancellation-started cleanup
promises are observed. Playback likewise waits for picture work, PCM disposal,
video disposal and AudioContext close even if one rejects. Error reporting occurs
after the finally block, without skipping cleanup or masking failure as success.

PASS with actual injected OPFS removal refusal in both export and playback:
no publication; video sessions0; no encoder owner; playback AudioContext closed;
the undeleted scratch reservation remains quarantined (one384000-byte file), and
a fresh actual MP4 export succeeds (57450bytes). The test explicitly removes its
remaining filesystem residue afterward, without pretending the production budget
was released. This is failure injection, not physical disk/permission certification.

## Narrow metadata rejection

Before payload acquisition, the indexed profile rejects unknown/duplicate sample
tables, including stsz+stz2, and moov/mvex declarations. Root inspection admits only
ftyp/wide/free/mdat/moov and therefore rejects trailing mfra before the demuxer can
follow its footer into an oversized allocation. The known continuous-AAC roll
sample-group layout and sync-sample table are checked structurally; unsupported
group semantics are refused. This is a narrow profile, not general BMFF support.

Both PCM and video readers reject conflicting size tables, an unsupported senc
sample table, mvex, and a9MiB trailing mfra with mfro footer. Instrumented source
slices prove zero payload reads for each rejection. Existing sample-size/range,
preflight admission and released-clone checks continue to pass.

## Stronger independent output oracle

The actual four-second desktop/mobile-width workflow now requires at least192000
stereo decoded frames, byte alignment, and finite values throughout every valid
sample. A truncated/undefined/NaN tail cannot pass a peak-only comparison.

FFmpeg independently compares head128, both sides of the cut256, and tail128
samples/channel against the selected original intervals, with declared lossy AAC
maxDiff<0.1 tolerance. Observed maxima:0.007508254,0.001189484,0.001512271. The removed
left impulse must be absent (maxLeft<0.15, observed0.050787375); the retained right
impulse is sample34560. Valid interval192000 samples/channel; raw FFmpeg output
192512 including padding remains explicit. Existing100 frame PTS/color checks and
common preview/export PCM chunk hashes pass. This is not a lossless AAC claim.

## Gate and evidence

PASS at the exact code SHA: both actual cleanup-failure probes; indexed reader and
all malformed preflight cases; desktop/mobile-width longer workflow with strengthened
oracle; three crossed-track/late-init and two prior finalize probes; previous short
product workflow;137 focused tests; typecheck, repository lint, build, check:files.

Raw reports record the code SHA and empty working tree:
`/tmp/video-cleanup-{pinned,reader-pinned,integration-pinned,track-pinned,finalize-pinned,short-pinned}/results.json`.
Root logs: `/tmp/video-cleanup-{type,lint,unit,build,files}-pinned.log`.
An intermediate lint FAIL at e54f9404 (finally throw and a test this-alias) is retained
in `/tmp/video-cleanup-lint-first.log`; final code reports errors after cleanup.

```sh
node packages/video-metadata/host-media/cleanup-check.mjs /workspace/video-codec-eval/deps /tmp/video-product-pinned/original.mp4 /tmp/video-cleanup-pinned
node packages/video-metadata/host-media/indexed-media/check.mjs /workspace/video-codec-eval/deps /tmp/video-cleanup-reader-pinned
node packages/video-metadata/host-media/integration-check.mjs /workspace/video-codec-eval/deps /tmp/video-indexed-pinned/source.mp4 /tmp/video-cleanup-integration-pinned
node packages/video-metadata/host-media/track-check.mjs /workspace/video-codec-eval/deps /tmp/video-product-pinned/original.mp4 /tmp/video-cleanup-track-pinned
node packages/video-metadata/host-media/finalize-check.mjs /workspace/video-codec-eval/deps /tmp/video-product-pinned/original.mp4 /tmp/video-cleanup-finalize-pinned
node packages/video-metadata/host-media/product-check.mjs /workspace/video-codec-eval/deps /tmp/video-cleanup-short-pinned
npm run typecheck
npm run lint
npx vitest run packages/video-core/src packages/video-core/experiments/pcm-renderer packages/video-metadata/host-media/workflow.test.ts packages/video-metadata/src/edit.test.ts
npm run build
npm run check:files
```

No Actions dispatch/enablement, performance measurement, merge, main push, release,
deployment, publication or license change. Full-repository E2E and real-device,
iPhone integration/HDR/large-archive acceptance remain NOT RUN. A transient GitHub
read-only401 occurred and later the read-only API recovered without credential edits.
