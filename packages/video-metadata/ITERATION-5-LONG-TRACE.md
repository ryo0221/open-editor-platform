# Practical UI iteration 5: long deterministic trace and Escape recovery

Base: combined #136/#139/#142 checkpoint
`461b32ee6c4ef59b593deedbb3a2f422ca92cb19` (tested production 86df12f5).
Tested fix and harness: `7b16e359a46ffc35043a05d75e70a163424e93bd`.
Following checkpoint is documentation-only. No new feature/API/backend work.

## Reproduced issue and narrow fix

Fixed trim-control pointer drag -> Escape retained content, revision and Redo, but
left keyboard focus on Timeline tracks. The next arrow therefore took the canvas
move path instead of the intended trim control path. Both installed Hosts, both
1280/390 widths and both seeds failed the explicit focus assertion:8 FAIL. All
other long-trace assertions completed before this final assertion.

Two production lines retain the originating fixed control and restore focus after
Escape cancellation only when the Surface is live and that control remains enabled.
The cancel function, window blur, zoom cancellation, revocation, history and command
paths are unchanged. This does not focus a retired or disabled control.

## Deterministic trace

Harness: `node packages/video-metadata/test-host/installed-long-trace-check.mjs CONSUMERS`.
Each case performs20 history-changing operations: move+1, move-1, trim start, trim
end, Undo, Redo, split, delete right cohort, Undo, Redo, Undo, trim end, Undo, Redo,
Undo, move right cohort, Undo, Redo, Undo, Redo. Captured content snapshots serve as
the Undo/Redo oracle; every operation increments revision once, with canUndo/canRedo
matching the expected stack. Keys verify stable control focus.

A seeded LCG selects split target and zoom without non-deterministic inputs:
seed75 => split48f/zoom120; seed142 => split53f/zoom160. This is a functional
correctness trace, not randomized fuzz coverage or performance measurement.

Interleaved recovery checks preserve content/revision/history through invalid trim
input, Save preparation refusal, blocked Undo, Cancel inputs, adapter-proven no-write
Save and Escape drag cancellation. Save then acknowledges exactly the final native
content. Revocation refuses stale operations; visible Reopen saved creates a fresh
readonly scope and empty history with identical native content. Disabled controls
refuse input. Reload retains readonly/content. Existing Host authorization creates a
new editable scope from the saved content; edit/Undo, Save and another actual reload
match it exactly. History reset across scope/reload is intentional existing behavior,
not a promise of persisted history. Authority setup uses the existing test Host API;
editing, history, Save and Reopen interactions use the real installed UI.

## Validation evidence

- PASS: long trace8 (2 Hosts x2 widths x2 seeds), before8 focus FAIL -> after8 PASS.
- PASS: combined short-clip/zoom/readonly/boundary/cancel regression28.
- PASS: #136 focused keyboard/UndoRedo/Save/Reopen/reload regression8.
- PASS: focused Video tests171 /8 files, root types/lint/build/file-size/diff checks.
- PASS: actual tarball verification and both offline consumer installs/types/build/
  public-import audits. No browser errors or document horizontal overflow.

Kit /tmp/video-iteration5-kit; consumers /tmp/video-iteration5-consumers;
controlled-animation provenance SHA-256:
`0f2b70797be4c3898501c7045d6ebbde00244a7034f52928b064fed25cd428d5`.
Logs /tmp/video-iteration5-{tests,types,lint,build,files,pack,verify,prepare,after,short,keyboard}.log.
Manual-only workflows remain unchanged, CI/file-size/Office disabled; no Actions
were enabled/dispatched and no performance run, main push, merge or release made.

NOT RUN: actual H264 bytes unavailable here, real-media Save, physical touch/OS IME,
full legacy suite, performance (paused). #76 remains real-media integration owner.
No general import/probe, remote encode, persistent media bytes or export is added.
No Host/shared contract, dependency, manifest or license changes.

Raw trace JSON includes seed, derived parameters, action names, hashes, revisions,
history flags, Inputs dirty and focus after each step. Traces/logs remain outside Git.
Before: /tmp/video-iteration5-before.log and /tmp/video-iteration5-before-traces/.
After: /tmp/video-long-{reference,independent}-{1280,390}-{75,142}.json.
