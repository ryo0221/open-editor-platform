# Original-backed v1 reader checkpoint

Exact implementation `d0ddd80266bdeaa97dae681e657646af3170a589` (#191). Integration
context includes the separately pinned #186/#187/#188/#189/#190 changes; no main
or upstream PR was merged. v0 runtime entrypoints and native schema remain intact.

PASS at this clean SHA, Node24.19/npm11.9/Chromium151:

- Root typecheck, lint, build and repository file-size policy.
- All336 Video Core/metadata/storage tests, including ordinary browser suites.
- Real unchanged146163851-byte original: streaming SHA
  `69e089ae0cc9ad02b7d2461965d6a00d47cb91f7b02e620d10db9ec356731dd4`;
  whole-original arrayBuffer prohibited. Metadata/index/root-range preflight before
  decoder construction. No packet may overlap another or lie outside actual mdat.
- Continuous native AAC proves the full3107840 mono44100 integer sample grid.
  Raw grid storage is separate from validity ending at42251/600 seconds; the final
  valid point is3105448, and output48k has3380080 points. Missing-window/endpoint
  behavior remains strict; edge hold applies only to original validity boundaries.
- Final video framePTS42231/600, clockwise90deg; independent FFmpeg comparison
  mean0.9055517/255,max7. Browser errors0. AVC GOP remains bounded64frames and
  two sessions, coded pixels at most1920×1112 (observed1920×1090 with visible
  1920×1080). PCM128MiB per-realm scratch cap unchanged, one builder/two reads.
- v0 real1280/390 Host import/edit/save/new-context reopen/playback/export regression
  PASS with independent4-second100-frame/192000-valid-stereo-sample output decode,
  endpoint/cut PCM oracle and zero browser errors.

Raw evidence outside Git: `/tmp/video-v1-media-*-pinned.log`,
`/tmp/video-v1-reader-pinned/results.json`,
`/tmp/video-v1-v0-regression-pinned/results.json` and screenshots.

Exploratory actual-source runs first refused self-contained QuickTime alis, then
four-byte terminal visual sample-entry padding; subsequent video callback guard
rejected native coded-row padding. These were narrowed to explicit v1 structural
forms, with the default hierarchy profile unchanged. `/tmp/video-v1-reader-{first,
second,third,fourth,fifth}/` preserves those failures; sixth passed before final
pin. Unknown boxes/duplicates still refuse. No safety-blocked synthetic demuxer
probe was recreated; tests use own plain grammar inputs and this ordinary original.

NOT RUN at this reader pin: v1 ordinary Host and original-inclusive portable
roundtrip; actual full export is a separate following layer. No general MOV, HEVC,
HDR, alternate audio-channel/layout or real-device acceptance is claimed. No
Actions enable/dispatch, performance measurement, main push, release or license
change. Code Actions runs0. Existing v0 bounded profile is not widened implicitly.
