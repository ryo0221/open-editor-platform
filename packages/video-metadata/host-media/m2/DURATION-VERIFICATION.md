# Duration input preservation review correction

Code `26c191bb82de43b6418b94f34262a65835c85f56`, successor to unchanged #216
code1421e7aa/docs c05b53f1. No normal Host or Rust integration in this fix.

An unconditional render reset previously erased unapplied duration on rejected
commands and same-revision saving notifications. Dirty duration is now local UI
state: notification/rejection/Undo/Redo preserves the exact text. Resize applies
through the existing command path; only success clears dirty state and displays
canonical native duration. Reset duration discards the text and displays current
native without a command/history entry. A clean field follows later Undo/Redo.
Input/reset increments the existing replacement input generation. Save continues
to capture committed native, never implicitly applies this field.

Both source-derived findings were reproduced before the fix: enter1 against a
2second source, Resize rejects and replaced text with2/1; enter3 without applying,
Save replaced text with2/1. Logs `/tmp/video-duration-reject-before.log` and
`/tmp/video-duration-save-before.log` retain the FAILs. The earlier loop/remux
fixture attempt is recorded separately in `/tmp/video-duration-before.log` and
is not acceptance evidence; the final harness generates a fresh2second AVC/monoAAC
source using the established profile. No university original is modified.

`duration-check.mjs <codec-deps> <fresh-output-dir> [save]` runs the two regressions
at1280/390. It asserts unchanged native/revision, retains and exercises a pre-existing
Redo branch after rejection and Save, inspects the archive's sole saved version,
and proves explicit reset adds no history and successful apply Undo/Redo follows
native duration. The optional save-only mode reproduces the second old failure
independently when the first assertion stops the harness. Screenshot/browser-error
checks are included. This is desktop Chromium narrow-layout evidence, not hardware
mobile. Evidence and final results are recorded below after exact-pin gates.

## Next verification slice: actual-original output oracles

Feasible without changing portable capacity: keep the approved full original
bytes locally, edit a4second two-original sequence plus independent AAC as in#214,
and export the bounded output directly. Independently derive source membership,
presentation origin/PTS and global48k sample positions from native plus ffprobe;
FFmpeg-decode each source separately. Apply explicit gain/fade equations and stable
sum in the oracle, compare all valid decoded output audio samples with declared
lossy AAC thresholds and selected output pictures after independent orientation,
contain scaling/background. Never choose expected source time using returned PTS.
Record source/output hashes, exact native, selected frame indexes and max/RMS/mean
errors. Existing generated oracle thresholds are a proposal for the same profile;
record failures rather than silently widening them.

For reopened-output coverage within256MiB, use one unchanged146163851-byte original
plus small independent AAC, edit/save/reopen in a fresh origin, export and run the
same independent oracle. Two-original direct export and one-original reopened
export prove different scopes; neither is combined two-original portable acceptance.
All final-output PCM/pixel oracle work here is planned/NOT RUN. #214 actual UI and
#216 reopened exports remain decode-check only; their generated-output oracle
is separately strong evidence, not a substitute for these actual-output checks.

Limits unchanged:256MiB external/scratch,1GiB journal;512MiB/archive and2GiB total
remain unanswered. No history deletion, automatic CI, performance, main merge,
release, normal registration, public API or consuming-product changes.

## Exact-pin outcome

At clean26c191bb82de43b6418b94f34262a65835c85f56: type/lint/build/files PASS;
173 tests/15 files PASS; new duration browser1280/390 PASS (rejection, save,
Redo retention, reset, apply/Undo/Redo); existing portable5groups PASS.
Browser errors0; screenshots inspected. Summary `/tmp/video-duration-checks.json`,
logs `/tmp/video-duration-final-*.log`, reports/screenshots in
`/tmp/video-duration-pinned` and `/tmp/video-duration-portable`.
The11:28UTC disconnect notice was checked with pwd/git/evidence reads and live
runnerPID322758/browser-checkPID323404; access worked, no restart or log overwrite.
