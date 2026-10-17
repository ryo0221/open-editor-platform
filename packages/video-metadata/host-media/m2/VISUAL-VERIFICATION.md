# M2 bounded multi-source visual reader

Tested clean source `70187f96c49a91e604f46a02b87ca4c51d3d688f` on corrected
#207 base `c0ab0657d784520d398115161b768fb33663ee42`.
Private reversible adapter; no shared Host registration, output fit policy or
codec dependency change. Source verification was extracted without semantic
change so PCM and visual readers verify identical original SHA/interpretation.

`createVisualV2` owns at most two original readers under existing frame budgets,
selects frames from exact sequence/source clocks, returns each frame's own PTS,
scale and rotation, returns null for disabled/gap visuals, and rejects overlapping
visual contributions rather than silently compositing. One pending request is
admitted at a time. Returned frame leases belong to the caller; dispose aborts
pending requests, attempts all reader closes and waits for outstanding leases.
A failed second-original preparation releases the first reader. Source references
and native content are snapshotted; no alternate history or mutation occurs.

## Same-pin evidence

Root type/lint/build/files PASS; focused87tests/8files PASS.
Original visual browser and FFmpeg pixel comparison PASS (pixel/orientation only;
its FFmpeg seek used product-reported PTS, so this prior pin did not independently
prove requested-time-to-frame selection):
sequence0 and49/25 select first original,2 and99/25 select second; rotations90,
90,0,0; mean channel errors0.934,0.907,1.400,1.403 (declared threshold8).
Screen capture was inspected. Held-frame disposal waits until release; disabled
visual track returns null; wrong second SHA refuses; final reader sessions0.
Actual three-source PCM regression after shared verifier extraction PASS.
Browser errors0, clean worktree recorded in both reports.

Commands: root npm typecheck/lint/build/check:files; focused command from
ADMISSION-REVIEW-CORRECTIONS.md. Visual:
`node packages/video-metadata/host-media/m2/visual-check.mjs /workspace/video-codec-eval/deps /workspace/video-fixtures/vision-iphone6/D06_V_indoor_move_0001.mov /workspace/video-fixtures/vision-iphone6/D06_V_indoor_move_0002.mov /tmp/video-review-mix-pinned/results.json /tmp/video-visual-pinned`.
PCM: mixed-pcm-check.mjs with the same deps/originals and output
`/tmp/video-visual-mix-regression`.

Raw evidence stays outside Git: `/tmp/video-visual-checks.json`,
`/tmp/video-visual-pinned/results.json`, `concatenated-frames.png`,
`/tmp/video-visual-mix-regression/results.json`, `/tmp/video-visual-*.log`.
Prototype browser PASS at `/tmp/video-m2-visual-pre` is NOT fixed-pin evidence
(the reporting HEAD/worktree changed while that process ran). Initial prototype
lint FAIL on unqualified browser globals was corrected to globalThis before pin.
Neither failure nor prototype result is substituted for clean source verification.

## Remaining

NOT RUN: actual user editing UI, continuous playback, multi-source encoded output,
preview/export geometry equivalence, v2 Storage round-trip, normalHost integration.
The fixed portrait contain-fit geometry proposal awaits confirmation; this adapter
only preserves per-source geometry and does not silently fix that choice.
Full two-original portable still exceeds current256MiB cap; no increase or proxy.
Performance/Actions/merge/release remain held. This checkpoint is not M2 complete.

## Independent selection oracle correction

Test-only successor `9f9b1f773beeae9a84710c3da5f27dbd351ff92f` leaves runtime
unchanged. Native clip half-open membership, source window, speed and presentation
origin are evaluated with a separate BigInt rational implementation in the Node
harness. Independently read ffprobe packet PTS/duration intervals determine the
expected frame; returned sourceId/sourceTime/rawTime/PTS/scale must all match
before pixel comparison. FFmpeg now seeks using that independent expected PTS.
Mutated result PTS/rawTime are explicitly rejected by the selection assertion.

Same-pin focused lint PASS and actual browser gate PASS at six times:
0,49/25,1999/1000,2,2001/1000,99/25. Immediately before the cut, first-original
PTS42231/600; at/after the cut, second-original PTS0/600. Pixel comparisons and
ownership/failure gates also PASS; browser errors0, worktreeclean, screenshot
inspected. Evidence `/tmp/video-visual-independent-pinned/results.json`,
`/tmp/video-visual-independent-pinned.log`, `/tmp/video-visual-independent-lint.log`.
Run the same visual command above with output `/tmp/video-visual-independent-pinned`.
Root type/build/full lint/unit/PCM are NOT RUN on this test-only successor; their
previous PASS remains at70187f96. This stronger gate does not retroactively certify
the old oracle and does not certify full UI/playback/export/portable.
