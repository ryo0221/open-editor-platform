# WASM bridge lifecycle checkpoint

Tested code: `8cf47cabaeb7ac55f6ae36a645f31f8e476bc21c`, based on #157
evidence HEAD `d4f34568cc34f1600d062b3cabf7b89d57d2333d`. No AAC interpretation
or raw-count expectation changed. This remains an isolated bridge experiment.

The old bridge handed a newly allocated AVIO buffer directly to
`avio_alloc_context`; a context-allocation failure could orphan that buffer.
The bridge now owns and frees it on that path, checks parameter-copy failure,
and closes all partial opens automatically. Decode errors and EOF also release
owned objects; explicit repeated close remains safe.

Test-only fault controls exercise format allocation, AVIO buffer/context,
codec allocation, parameter copy, codec open, packet/frame allocation, frame
copy allocation and I/O error (10 stages). These are deterministic failures at
the bridge boundary, not exhaustive failures of every FFmpeg internal allocation.

At the exact code pin:

- **PASS:** root typecheck/lint/build/file-size check and 54 Video Core unit tests.

- **PASS:** 14 fault/cancel/invalid-size/invalid-limit cases leave zero owned
  format/IO/codec/packet/frame handles without requiring caller cleanup.
- **PASS:** 16 cycles of all ten faults followed by successful re-open/full decode.
  Every decoded frame hash matches the warm run. Allocator occupied bytes return
  to the warmed baseline of 144 each time. This is resource accounting, not a
  speed or performance measurement. The WASM heap reservation need not shrink.
- **LIMITED historical evidence:** three termination requests after a worker
  reports an open decoder, followed by decoding in a new worker. The original
  worker might already have finished its workload before the parent handled that
  notice; this did not establish cancellation of unfinished work.
  This does not prove termination happened inside a specific C instruction, or
  independently measure browser reclamation of a terminated worker's heap.
- **PASS:** HEVC regression 13 cases; **FAIL retained:** the original malformed
  VFR fixture's 11/12 frame result. Explicit-duration fixture and real EAGAIN
  resend/EOF checks remain passing.

Final binary SHA256:

- `decode.wasm`: `53ad16cccae8fcafc5fa422fd9a520f79d77ae2bf598e80f55b39d50bbeca7d4`
- `decode.mjs`: `ffe5d5c9c82571a645db0b35e9bd8fe62641ceda67adaed50f27e639614efa58`

Reproduce after the existing fixed build recipe, with a fresh output directory:

```sh
node packages/video-core/experiments/local-codec/bridge-lifecycle-check.mjs \
  /workspace/video-codec-eval \
  /tmp/hevc-e485/hevc10-hlg-vfr-explicit-duration.mp4 \
  /tmp/bridge-lifecycle-new
```

Generate the explicit-duration fixture with `decode-check.mjs` if needed.
Local full evidence: `/tmp/bridge-lifecycle-reviewed/` and
`/tmp/hevc-lifecycle-reviewed/`; checked-in summary: `lifecycle-results.json`.
An initial focused-lint failure on browser timers was fixed before the code pin.

Not run: real memory exhaustion throughout FFmpeg, hostile/truncated corpus,
huge metadata/pixel limits during demux discovery, seek/preroll, sanitizer builds,
actual iPhone/Windows, HDR conversion, or performance. The earlier warning about
stream discovery preceding the decoder's explicit max-pixels setting remains.
No claim of a complete security boundary, product codec adoption or #75 completion.
