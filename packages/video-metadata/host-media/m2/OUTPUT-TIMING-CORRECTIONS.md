# Encoded-output timing gate review corrections

Code `c27b96cf7ebb6bafa2581b6b5bf0be45152a2348`, verification-only successor to
#221 codeb5084a87/docs8d2e853e. No runtime, normal registry, Rust, capacity or
#220 lifecycle code changes are included.

## Acceptance gap and corrected assertions

The earlier #221 oracle checked video count/duration and audio rate/channels, but
audio start/duration were only checked in a supplemental local ffprobe command.
That supplemental PASS did not make interval proof part of the reproducible gate.
The earlier six picture comparisons also used decoded ordinal n assuming n/25;
video count100/duration4 alone could miss incorrect intermediate presentation PTS.
Existing sample/pixel numerical results remain attributed to the old pin; these
new assertions are not retroactively claimed on it.

Before any PCM tail classification, the retained oracle now requires audio
start_pts0, time_base1/48000, duration_ts192000, start_time0.000000 and duration4.000000,
plus existing mono/48k checks. `audioPresentation` retains those exact ffprobe fields
in each artifact's oracle JSON. Failure stops before samples beyond192000 can be
reported as outside the proven native presentation interval.

For video the independent helper reads rational time_base and requires start_pts0,
start_time0, duration_ts*time_base=4 exactly and duration4. Both packet and decoded
frame lists must contain100 entries. Packet entries are retained in demux/decode
order including DTS, then sorted by presentation PTS; sorted item n must equal n/25
and duration1/25 via BigInt cross multiplication, with no floating tolerance.
ffprobe's decoded-frame output is checked separately in presentation order, the
same ordering used by FFmpeg select(n): pts and best_effort_timestamp must equal
n/25 and each duration1/25. Thus ordinal picture selection has a checked timestamp
basis. `videoPresentation` retains stream timing, packet decode order, sorted
presentation packets with decode indexes and all decoded-frame timing metadata.

Metadata-only controls verify that reversed packet order is accepted, while
nonzero stream start and a one-tick intermediate packet/frame PTS or duration
change are rejected. They do not claim new B-frame codec support. No production
timing/planner/renderer code supplies these expectations.

The existing full192000 valid-sample comparisons, five extra boundary windows,
six actual-original contain/rotation picture comparisons and encoded tolerances
max<0.1/RMS<0.03/mean<8 are unchanged.512 extra decoded samples are retained as
outside-presentation codec tail only after the exact interval assertions pass.

## Pins, evidence and scope

Audio-only interval correction47ba0d954f2cf608b5f58ae3eca8559b5bd3b9fa separately
passed both real-original workflows and focused lint/file policy; evidence remains
`/tmp/video-actual-endpoints-pinned` and `/tmp/video-actual-endpoints-checks.json`.
The final combined gate reruns both workflows at the code pin above using fresh
output `/tmp/video-actual-timing-pinned`; summary
`/tmp/video-actual-timing-checks.json`, logs `/tmp/video-actual-timing-*.log`.
Reproduction uses the exact actual-output-check.mjs command and full original SHA
pins in ACTUAL-OUTPUT-VERIFICATION.md, with a new destination directory.

Root type/build/173-unit suites are NOT RUN for this test-only successor; their
prior #221 PASS is retained on b5084a87. Focused lint/file policy and both complete
actual direct/reopened browser+FFmpeg workflows are the relevant new gates.
No old failure/supplemental evidence was deleted or overwritten.

Attribution stays VISION/CSP Lab., University of Florence2017/CC BY-SA4.0 as in
ACTUAL-OUTPUT-VERIFICATION.md. Original media and derivatives remain local outside
Git; original SHA keys must remain unchanged. Single-original archive stays below
256MiB. Full two-original portable remains BLOCKED by combined298716660bytes;
512MiB/archive and2GiB total policy unanswered, no cap or history changes.
No CI dispatch/enable, performance work, main merge/release, consuming-product or license change.

## Final outcome

Clean c27b96cf7ebb6bafa2581b6b5bf0be45152a2348: focused lint/file-policy PASS;
both full actual-original direct and archive-reopened gates PASS, browser errors0.
Each output has audio and video time_base1/48000, start_pts0 and duration_ts192000.
All100 packet presentation positions/durations and100 decoded-frame positions/
durations pass the exact25fps grid. All five timing mutants refuse; reversed packet
order passes the metadata-only ordering control. Both outputs retain192000 compared
valid audio samples and512 explicitly recorded trailing samples after interval proof.

Direct PCM max0.0011913538013274471/RMS0.00015960722474604483;
reopened max0.0020244709147761164/RMS0.00019902710709888602. All boundary windows and
six selected pictures per output pass unchanged tolerances; worst picture mean
3.809508101851852. Single archive146242298bytes, unchanged full-original SHA pins.
The earlier standalone endpoint JSON is no longer needed to reproduce interval
acceptance: assertions and retained metadata are part of each oracle result.
