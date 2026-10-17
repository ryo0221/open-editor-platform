# Timing and decoder follow-up (provisional)

Original `results.json` and the original failing generators remain unchanged.
This follow-up is an isolated experiment, not a Host/API or dependency adoption.

## Reviewable commits

- HEVC fixture correction: `e3ab1efc9d00c6503b7a78c18c0f747e71c961f4`.
- AAC raw packet PTS / independent edit origin experiment:
  `223829bc1ad53564dcf1a9b22ccde0d8aaf42834` (subsequent commits fix test setup/lint).
- Actual EAGAIN/resend and EOF handling:
  `21846e726080003cf9df410a3ff15778b16b6944`.
- AAC terminal sample duration:
  `94e9d7c6a83b1f4c5244909878cf7c9e0dc158a7`.
- Final tested code and explicit timestamped presentation experiment:
  `e485a23fd935d1daa1ea5be305f16bd3fe86f574`.

## HEVC: generated container defect, not an ignored edit list

The original generated file has movie timescale 1,000 and media timescale 12,800.
Its `elst` is `(segment_duration=560, media_time=1024, rate=1)` and its last
`stts` entry is `(count=1, duration=0)`. The sample at presentation PTS 7168/12800
(0.56 s) lies exactly at the half-open edit end and gets the demux discard flag.
Both native and WASM decoders correctly omit it under that edit interval.

The corrected generator explicitly sets packet duration to 1/25 s using
`setts=pts=PTS:dts=DTS:duration=1/(25*TB)`. Explicit PTS/DTS preservation matters:
the filter's generic TS default otherwise changes the reordered timestamps.
The corrected file retains the edit list, has a last `stts` duration of 512 and
`elst` duration 600 ms; the `ctts` entries are identical. No source media or
decoder behavior is changed to ignore legitimate edits. This fixes the malformed
test fixture, not any claim about untested iPhone files.

Assertions require all 12 expected display PTS (`0,.04,.08,.16,.20,.24,.32,.36,
.40,.48,.52,.56`), duration 0.60, reordered packet PTS, no discard-marked packets,
and independent native YUV hashes/metadata. The original 11/12 FAIL is retained.

`decode.c` now retains a packet when send returns EAGAIN, drains pending frames,
and resends that packet before unref. The deferred-receive mode provokes the real
decoder state (not a mocked error): four EAGAINs/four successful resends, then
all 12 matching frames. Normal and deferred flushing must reach decoder EOF;
EAGAIN after an accepted drain is an error, not a successful completion.
See the [FFmpeg send/receive contract](https://ffmpeg.org/doxygen/7.1/group__lavc__encdec.html).

Final HEVC run: **13 PASS / 1 retained original FAIL**, exit 1.
Cancellation between packet steps, packet-limit rejection and malformed header
are included. In-flight worker termination, memory fault injection, truncated
inputs, seek/preroll and broad adversarial resource tests remain NOT RUN.

Final bridge SHA256:

- WASM: `0f56453d3bbfd12eb0228e3e8cc1ac5aeff684416033e6202acb7ccd7f2ab453`
- JS: `bef5bada09b513590fcbae45055912b863aec2c7edf3fb48723c7d2eefd5a41c`

## AAC: head delay, tail padding and composition origin are distinct

The original 12 FAILs concern **@mediabunny/aac-encoder 1.61.3**. They do not test
the newly built FFmpeg 7.1.5 WASM AAC encoder. The control uses the environment's
native FFmpeg 7.1.5 encoder, solely as an independent local oracle.

The extension pads input to 1,024 samples and encodes an additional priming
packet. Its wrapper discards FFmpeg packet PTS and instead starts sequential
packet timestamps at the input origin. Therefore original decoded count is
`ceil(valid_samples/1024)*1024 + 1024`. That combines two different problems.

`aac-timing-check.mjs` patches the pinned extension in memory via esbuild; it
does not modify installed packages or vendor a changed binary. The original
bundle SHA256 must be
`a8f777ab53d8d654bd2339e974de8c80f457e68943afd72e7e55ca0f0dbea214`.
The narrow changes preserve actual packet PTS and shorten the _declared final
packet duration_ to the measured valid input end. Encoded access units remain
intact. Raw encoder packet PTS/duration are recorded separately.

The generated MP4-only metadata patch sets movie timescale to the audio sample
rate, represents positive composition origin with an empty edit, then declares
`media_time = rounded_input_origin - first_raw_packet_pts` and valid input count.
The measured head delay is 1,024 for this candidate and is asserted as a profile
expectation, not used as an unexplained compensation. Video movie-unit durations
are rescaled too; media timebases remain unchanged. The coded `mdat` bytes are
asserted unchanged. This is not a general input MP4 editor or a public trim API.

At 44.1 kHz, 0.125 s falls between sample boundaries; this experiment explicitly
rounds to sample 5,513 (0.125011… s). A permanent rational-origin policy still
needs technical review; this rounding is not a new product contract.

The matrix covers 44.1/48 kHz, valid counts 1, 17, 1,024, 1,025, rate+123 and
3×rate+29, origins 0/0.125 s (24 cases). Both decoders' raw output counts and
left/right impulse peak positions are recorded. Ordinary/non-frame-aligned
cases also contain an actual encoded 96×64 H.264 video with red/blue markers;
independent full video decode checks colors and audio-peak/video-PTS differences.
This is a synchronization fixture, not the earlier 1080p output acceptance.

For every case, identical PCM is also encoded by native FFmpeg with sample-rate
movie timescale. Evidence records first/last packet and skip metadata, declared
duration, normal decode, ignore-edit-list decode and browser decode. Native
control with a positive timestamp offset does not independently solve priming:
its first packet can begin before the intended valid origin. That is reported,
not used as a golden output or proof that the proposed patch is unnecessary.

Neither valid metadata nor a correct encoder implies that every decoder returns
only valid PCM. For example, the native control with one valid sample at origin
zero declares duration 1 and a 1,024-sample skip, but native decoding still returns
1,024 samples; ignore-edit-list decoding returns 2,048. Browser decoding can also
round duration differently. These consumer differences remain visible.

Final pinned result: strict overall gate **4 PASS / 20 FAIL**, exit 1. All 24
cases pass waveform position, channel/rate/origin checks. All 12 actual video
cases pass decoded colors and A/V timing checks (the other 12 are audio-only).
Browser raw count passes 18/24; six cases return one sample fewer than requested
(17 at both rates/origins and 132,329 at 44.1 kHz/both origins). Native raw count
passes only the four frame-aligned 1,024-sample cases. Do not round these failures
away or insert replacement samples.

`ffprobe` stream `duration_ts` for positive-origin files can include priming even
when the edit declares the valid interval. It is recorded as observed stream
metadata, not treated as the authoritative valid PCM count. The explicit edit,
raw packet timeline and decoded block timestamps remain separate evidence.

## Proposed presentation semantics, separate from the raw codec gate

The experiment additionally reads independent decoded frame PTS/nb_samples,
intersects each block with the explicit half-open valid interval, and requires
complete, nonoverlapping coverage. It then verifies exact presented count and
impulse positions. Missing coverage fails; no padding or guessed offset repairs
the data. This is an explicit timeline-renderer proposal, **not** silent slicing
to make the original raw-length assertion pass. The original strict browser and
native raw-count checks remain in the overall status and keep exit 1 on failure.
All 24 native timestamped-presentation cases pass. This does not repair the
browser's one-sample-short output; that path still fails exact coverage and is
not adopted as a complete renderer.

Product use requires review of this distinction, the MP4 timing implementation,
nonzero-origin precision, actual target consumers and real iPhone audio. The
scope does not introduce new license commitments, services, cost or access.
Redistribution/source/relink/notice requirements from the first checkpoint remain
unresolved; no experimental codec or patched package is distributed here.

## Reproduction and remaining gates

Use the existing fixed build recipe, then fresh directories:

```sh
node packages/video-core/experiments/local-codec/decode-check.mjs \
  /workspace/video-codec-eval /tmp/hevc-followup-new
node packages/video-core/experiments/local-codec/aac-timing-check.mjs \
  /workspace/video-codec-eval/deps /tmp/aac-followup-new
```

Local final evidence is `/tmp/hevc-e485/` and `/tmp/aac-e485/`. Raw box evidence
is `/tmp/hevc-edit-boxes.json`. A premature HEVC harness invocation used the old
WASM before the rebuild finished and failed on the missing new export; it is
retained at `/tmp/hevc-resend-reviewed/` and is not the final bridge test result.
Intermediate test-setup/lint failures were corrected before the final pinned run.

At final code SHA: root typecheck, lint, build, file-size check and all 54 Video
Core unit tests **PASS**. `followup-results.jsonl` contains per-case evidence;
long raw packet arrays are reduced to first/last/count in the checked-in copy.
The earlier six 1080p H.264 checks were not rerun because their code and encoding
route did not change; their prior exact-pin evidence remains in `results.json`.

Actual iPhone, Windows, original AAC seek/priming/tail, HDR→SDR, sound quality,
long combined 1080p exports and portable projects remain NOT RUN. Performance
remains paused. No Host/root manifests/shared API or license was changed.
