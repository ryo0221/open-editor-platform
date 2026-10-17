# M2 continuous playback and bounded export

This private slice uses the existing25fps /48kHzmono AAC /AVC SDR1080 profile,
90second sequence bound and64MiB output staging. No dependencies, native schema,
archive capacity, journal budget or normal Host registry changed.

## Render semantics

The owning Host snapshots explicit output settings `{width,height,background}`
for each job:1080x1920 or1920x1080, opaqueRGBbackground. These are private per-job
settings, not newly persisted native fields or a public #76 capability. Original
bytes are not modified. Still preview, continuous preview and encoded frames all
use the same contain drawing function: orient each full display rectangle,
center with aspect preserved, fill remaining area with the declared background;
no implicit crop/stretch. Blank visual intervals show that background.

Continuous playback and export use the same verified original-owning PCM adapter,
exact global48kHz positions, resample→gain/fade→stable sum→final finite/range guard.
The timeline adapter adds an explicit block end for existing chunk hashing;
resampler result shape alone is not used as the scheduler's range.
Preview rejects an invalid block before scheduling. Export never returns a
completed Blob after invalid PCM or cancellation. Audio output timestamps drive
preview picture selection; real-time playback may skip intermediate pictures,
and this is not a claim that every display frame is delivered. Existing integral
48kHz playback endpoint /25fps seek-grid constraints remain explicit.

AAC worker/track ownership, pending finalize/flush and independent cleanup follow
the existing pinned private v1 protocol. Native v1 timeline/playback/export and
Rust-owned backend/build files are unchanged. A separate small shared probe fix
first parses complete video child boxes, only falling back to existing four-byte
QuickTime padding on parsing failure: valid btrt ending with0 is no longer cut
short. Existing iPhone and AAC regressions accompany this change.

## Gates and evidence

Final clean source: `51128311600f64db70b1845b173ffee666360f16`.
All on that source: root type/lint/build/files PASS;87tests/8files PASS;
generated playback/export PASS; actual-original desktop/mobile-layout UI play/export
PASS; AAC mono44.1/48/stereo admission regression PASS; independent six-point
actual-original visual regression PASS. Screenshots inspected;browser errors0.
Decoded generated AAC oracle max0.013008597873151303 /RMS0.0004063805053138287;
portrait picture mean errors1.999/2.321/1.335/1.335; landscape1.497/1.905.
All50 actual scheduled PCM hashes match encoded-input hashes. Cancel/overflow
checks finish with PCMfiles0,readers0,closedAudioContexts and noencoderowner. Generated
fixture gate produces a1second1920x1080 synthetic test pattern with the already
admitted positive-coordinate clockwise display matrix, a1second640x360 landscape
pattern, and independent2.2secondmono44.1kHzAAC tone. All media is locally generated;
only the newly authored fixture's display matrix is set to the known profile.
FFmpeg confirms its rotation and source hashes remain unchanged after downloads.
No actual user original is rewritten.

The2second composition is encoded in both portrait and landscape canvases with
background#102030. Independent FFmpeg compares all96000 valid decoded audio
points to separately decoded sources and explicit gain/fade equations, and
selected output pictures to independently selected native-tool source pictures,
contain scaling and background padding. Real AudioContext scheduled buffers are
captured at start(): their50 block hashes equal export input and playback hashes.
Actual playback frame source/PTS is checked independently on the generated clock.
Loud final-mix overflow refuses before any audio scheduling and refuses completed
export. Playback abort after first scheduled chunk and export abort after first
VideoEncoder submission drain audio contexts, PCM files, visual sessions and
encoder owner. Landscape export cannot change the PCM hashes.

Actual two approved originals plus generatedAAC are separately exercised through
UI import/trim/placement/effects, Undo/Redo and invalid input regressions, still
preview, full4second playback and MP4 download on desktop1280/mobile-layout390.
FFmpeg decodes each downloaded output. This UI gate is not an independent full
PCM/pixel oracle for those actual downloads; the generated oracle and earlier
actual-source PCM/visual checks retain their distinct scopes/pins.

## Development failures retained

- Initial generated harness masked an underlying probe failure with an unowned
  download-wait rejection; the waiter is now collected/settled.
- A valid generated btrt ending in0 exposed the old unconditional four-byte trim.
  Explicit BT709 fixture metadata was also required; the admission profile stayed
  strict. Unsupported raw portrait encoding was replaced by the existing admitted
  landscape-coded clockwise display profile, not admitted by relaxing the reader.
- The first rotation-remux fixture retained no display matrix; its PASS was not
  mixed-orientation evidence. The later fixture explicitly authors and verifies
  the supported matrix before the gate.
- Adding landscape output initially collided with a generated source filename;
  the independent audio oracle failed. Output names are now distinct and every
  fixture source SHA is rechecked after download.
- The old UI expected natural480x270 instead of the newly selected270x480 canvas;
  its assertion was corrected to the explicit composition contract.
- Source9d7e46bf failed root lint due to duplicate result key `audio`; the result
  metadata key is renamed. Prior passes do not override that FAIL.

Logs `/tmp/video-delivery-pre*.log`, `/tmp/video-delivery-ui-pre*.log`, and the
initial fixed-pin `/tmp/video-delivery-checks.json` are preserved outside Git.

## Remaining

Exact-v2 portable integration is a separate branch using reviewed#212; original
codec admission must cover retained-only sources before target publication.
Combined actual-original portable remains blocked by pending capacity approval.
Normal Host adoption, Rust integration, hardware mobile, general codecs and
performance/Actions/main merge/release are NOT RUN/held. This is not all M2/Epic
completion and makes no opaque decoder/process memory guarantee.

## Reproduce / supporting files

Root commands npm run typecheck/lint/build/check:files; focused command as in
ADMISSION-REVIEW-CORRECTIONS.md. Generated gate:
`node packages/video-metadata/host-media/m2/play-export-check.mjs /workspace/video-codec-eval/deps /tmp/video-delivery-final`.
Actual UI gate: editing-ui-check.mjs with the same dependency path, both full
approved original paths and output `/tmp/video-delivery-ui-final`. AAC profile
gate outputs `/tmp/video-delivery-aac-final`. Visual gate takes both originals
and `/tmp/video-review-mix-pinned/results.json`, outputs `/tmp/video-delivery-visual-final`.
Exact commands are also in committed runners; all generated media, MP4s, screenshots
and logs stay outside Git. Summary `/tmp/video-delivery-final-checks.json`, logs
`/tmp/video-delivery-final-*.log`, each directory's `results.json`.

Main observed unchanged5a32d355ac107258a604e5a4d7a45d03f3b9efdb. No external lane
code is incorporated in this checkpoint. Own #208 independent-oracle and #210
empty-volume corrections are preserved as own-lane cherry-picks; their original
verified pins remain in their documents. Storage integration follows separately.
