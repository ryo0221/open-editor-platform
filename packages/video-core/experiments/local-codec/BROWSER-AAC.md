# Saved MP4 → native browser AudioData (isolated)

Tested code: `57dabd0921d5466ee99dd9f0f2fb784bd68db43c`.
**PASS:** 30/30 browser cases, 30/30 missing-sample and overlap rejections,
12/12 video-marker comparisons, root typecheck/lint/build/file-size check and
54 Video Core unit tests. Local evidence: `/tmp/browser-aac-reviewed/`;
checked-in case summaries: `browser-aac-results.jsonl`.

This adds a separate native WebCodecs AAC decode route. It does **not** change
the original strict raw-count gate or `decodeAudioData` failures in #157. It
does not invoke the extension encoder while decoding or claim that the newly
built FFmpeg WASM AAC decoder was tested.

## Evidence boundary

`browser-aac-check.mjs` loads the exact saved MP4 bytes from the previous final
AAC run and verifies their recorded SHA256. `browser-aac.mjs` independently reads
the saved `mvhd`, audio `mdhd`, `elst` and `stts` boxes. Neither fixture origin nor
fixture sample count is passed to the decoding/presentation implementation.
Those expectations are used only by the outer test assertions.

The fixed Mediabunny 1.61.3 demuxer provides raw access-unit bytes and decoder
configuration. Its packet timestamps are deliberately not used as the exact
time authority; its demux sequence number must match the independently read
sample table, including priming packets. No demuxed access unit may be omitted.

Native `AudioDecoder` output captures PCM, timestamp, sample rate, channel count
and frame count together in **one AudioData callback**, then closes AudioData.
The callback timestamp must exactly identify a submitted raw media timestamp.
The immutable association preserves that sample's integer media PTS; no second
FFmpeg/ffprobe execution supplies the audio timestamp or PCM for coverage.

The [WebCodecs API](https://www.w3.org/TR/webcodecs/#audiodata) uses microsecond
timestamps. For this tested Chromium/native AAC profile, submitted media times
are converted to integer microseconds by explicit floor, with unique keys, and
callback timestamps must match those keys exactly. Exact sample positions
are not reconstructed from rounded seconds. Intermediate `flush()` calls caused
the decoder's timestamp base to be restarted, producing cumulative µs differences;
the harness now waits for `dequeue` under backpressure and flushes only at EOF.
These are observed profile constraints, not a universal one-packet/one-callback
guarantee for all WebCodecs implementations or codecs. Unknown callback timestamps
or duplicates fail instead of guessing an offset or accepting missing samples.

## Exact presentation mapping

Saved edit durations and origins are represented with reduced BigInt fractions:

`composition_time = empty_edit_duration / movie_timescale
                  + (media_sample - media_time) / audio_timescale`.

Coverage uses a half-open media interval derived from the actual saved edit.
Each timestamped decoded block must cover the next required sample exactly;
overlap or missing coverage fails. Only samples outside the declared interval
are excluded. No silence, repeated sample or guessed tail is appended.

The current profile requires the valid edit boundaries to fall on the decoded
sample grid; fractional media boundaries requiring resampling are rejected.
Composition origin can be rational and need not lie on that grid. Six additional
comparison files use exact origin 1/8 s with movie timescale 8×sample rate. This
represents 0.125 s exactly at 44.1 kHz instead of rounding it to sample 5,513.
The previous files retain their original rounded origin and their original hashes.
The comparison fixture writer remains limited to generated v0 single-audio files;
it is not proposed as a general mux API.

## Matrix and negative checks

The matrix is 24 unchanged MP4 files from #157 plus six exact-rational-origin
files. It covers 44.1/48 kHz, 1/17/1,024/1,025 samples and ordinary durations,
zero/nonzero origins, and both cases where `decodeAudioData` had lost one sample
and cases where it returned the expected count. The original route's count and
FAIL status are preserved in the new evidence, not relabeled PASS.

Checks require complete coverage and exact presented count, nonzero left/right
impulse peaks within the existing lossy-waveform position bound (2 samples),
and exact rational origin. The two-sample waveform bound never permits missing
coverage or a shortened decoded result. All cases also deliberately remove one
required terminal sample and duplicate a required block; both must be rejected.

For the 12 files containing video, the new browser audio peak's rational
composition time is compared to independently decoded video marker timestamps
from the same saved file. The allowance is the existing 2-sample waveform bound
plus one 90 kHz video tick. This video reference does not supply audio coverage.

## Reproduction and limits

```sh
node packages/video-core/experiments/local-codec/browser-aac-check.mjs \
  /workspace/video-codec-eval/deps /tmp/aac-e485 /tmp/browser-aac-new
```

Use a fresh output directory; regenerate the previous 24 files with the pinned
`aac-timing-check.mjs` if needed. Results retain their source hashes. Dependencies
remain external and fixed; no new product dependency or shared API is introduced.

This reader is bounded experimental code for one AAC audio track, unfragmented
sample tables, one rate-1 media edit and an optional initial empty edit. Version
0/1 edit/header reading is present but only generated v0 inputs were exercised.
Multiple edits, ctts on audio, fragmented files, ambiguous stream selection,
callback splitting/coalescing, rational media edges, seek/preroll, abort/resource
faults in AudioDecoder, real iPhone/Windows and long inputs remain separate gates.
This does not replace a reviewed general demuxer/muxer or approve product adoption.
