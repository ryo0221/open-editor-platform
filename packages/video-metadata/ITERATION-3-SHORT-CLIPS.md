# Practical UI iteration 3: reachable short-clip controls

Accepted #136 baseline: `504d3a6d8616400acfeedeb69e91829e15b80654`.
Tested code: `c37d2aaf056d36ec31e756183d855ed5f751f276`.
The following checkpoint commit changes documentation only.

## Reproduction and change

Split the initial linked AV clip at frame 26 (25 fps): its left clip is one frame,
3.2 pixels at the default 80 px/sec zoom. At the accepted baseline the reference
installed Host at 1280 and 390 px could not pointer-click that clip body or its end
handle (four failed reachability attempts, /tmp/video-short-before.log).
The existing clip selector still works, but this made visual trim impractical.

Add stable, fixed-size Move / Trim start / Trim end controls for the selected clip,
with selected clip/source context and guidance to the existing selector. Preserve
true timeline geometry. These controls delegate to the same guarded pointer and
keyboard handlers, captured revision, Inputs preparation and public command path;
no extra history or transaction path. Controls respect read-only/locked state and
retain focus after pointer commits and repeated keyboard edits.

Production delta from #136 is only visual-timeline.ts (36 added lines). The other
addition is a package-owned installed harness. No Host, shared contract, manifest,
clock, media source, import/export, dependency or storage changes.

## Validation

At the exact tested code above:

- PASS: focused Video tests, 171 tests / 8 files.
- PASS: both installed Hosts, desktop 1280 and mobile 390, 12 cases: one-frame
  clip selection via dropdown, overlapping trim refusal, reachable trim/move,
  repeated arrow trimming and Undo; drag after 200 px/sec zoom and horizontal
  scrolling; pending input followed by another clip and Undo, cancel/apply/Undo.
  Every drag remains revision-free until release and commits exactly once.
- PASS: #136 focused keyboard installed regression, 8 cases including Save,
  Reopen and page reload; existing installed native Save regression, 4 cases.
- PASS: typecheck, lint, build, file-size and diff checks; offline packaging,
  verification, both consumer installs/types/builds/public-import audits.
- PASS: no browser errors or document horizontal overflow; desktop/mobile
  screenshots inspected. These are viewport tests, not physical touch acceptance.
- NOT RUN: actual H264 recordings (bytes unavailable here), real-media Save,
  physical touch/OS IME, full legacy suite, performance (still paused).

Initial candidate fd0a4081 had 169 PASS / 2 FAIL because its control-group label
matched the existing clip selector lookup. c37d2aaf gives the group a distinct
accessible name; final 171 PASS. No assertion was weakened. Zoom/scroll and pending
input tests reproduced no additional production defect, so those paths are unchanged.

## #136 / #139 and Host handoff

#136's focused Delete/S target selection and reserved-key handling are retained;
its installed regression passes. #139 remains a sibling under review and is NOT
incorporated. Its production diff from db6e7056 to 35d8a041 applies cleanly with
`git apply --check` on this branch. This is patch compatibility only, not combined
installed acceptance; parent/#76 should review and verify the combined package.

#76 owns actual-media playback verification. These installed native-fixture checks
do not establish real-media byte retention or Save support, codec selection, general
import, audio, export or complete practical Video/Epic acceptance.

## Reproduction evidence

- Kit: /tmp/video-iteration3-final-kit, controlled-animation profile.
- Provenance SHA-256:
  `3b9edd420d561566f752b6d1846214355e38601077de38613e96c508ca345f41`.
- Consumers: /tmp/video-iteration3-final-consumers/{reference,independent}.
- Harness: `node packages/video-metadata/test-host/installed-short-clip-check.mjs CONSUMERS`.
- Logs: /tmp/video-iteration3-final-{tests,types,lint,build,files,pack,verify,prepare,installed,keyboard,save}.log.
- Screenshots: /tmp/video-short-{reference,independent}-{1280,390}.png.

main was rechecked at 5a32d355ac107258a604e5a4d7a45d03f3b9efdb; no main changes.
All workflows remain manual-only; CI/file-size/Office remain disabled. No Actions
were enabled/dispatched, performance run, merge, release or license change made.
