# Practical UI iteration 4: combined candidate operation check

Per parent instruction, combine #142 short-clip controls (HEAD
6f2d35470d2e4ff07038d870909cd7825550a526) with #139's exact production display
change and installed split-target harness from 35d8a041d6c55605ead3760e4de9595b49b93560.
This is a verification branch, not review acceptance, a main merge or a release.
#136 focus targeting remains intact. No new production fix was needed in this pass.

Tested code: `86df12f5dd9cda8624a5e9102bd4915e74738035`.
The following checkpoint changes documentation only.

## PASS: installed native-fixture UI

Both reference and independent Hosts use actual offline-installed packages, each
at 1280 and 390 px. Expanded short-clip harness: 28 PASS / 0 FAIL (7 scenarios x4).

- Existing short clip, zoom/scroll drag and pending-input scenarios remain PASS.
- Split at26f; extend start twice and shorten end twice with fixed-control arrows,
  leaving one frame [23,24). Button split at either boundary and keyboard S refuse
  without changing content/revision. Undo restores the previous trim, Redo restores
  one-frame content, native Save/Reopen and actual page reload preserve that content.
- On locked audio selection, all three fixed controls are disabled. Dispatched key
  and pointer events still cannot change content/revision or leave Inputs dirty.
  On unlocked video with linked locked audio, move refuses without changing content.
- In readonly Host mode, all fixed controls are disabled; dispatched key/pointer
  events cannot change content/revision or leave Inputs dirty.
- After a committed move and Undo, zoom200 and horizontal scroll120, drag then
  scroll/Escape cancels; changing zoom during a drag cancels; zero-distance gesture
  is a no-op. Each preserves content/revision and the Redo entry, clears Inputs;
  subsequent Redo/Undo restores exactly the expected moved/original content.

#139 split-target installed check:4 PASS. #136 focused keyboard/history/native
Save/Reopen/reload:8 PASS. Existing installed Video native-Save suite:4 PASS.
No browser errors or document horizontal overflow. Desktop/mobile screenshots
inspected with both new controls and red Split target guidance present.

## PASS: local checks and packaging

171 focused tests /8 files, root typecheck, lint, build, file-size and diff checks.
Verified kit, both outside-checkout offline installs/types/build/public-import audits.

- Kit: /tmp/video-iteration4-kit, controlled-animation profile.
- Provenance SHA-256:
  `5ce2717ba5195ba0fa16160a8a4c3bf27ff4a13f815e50df7dae718acc0d6a1b`.
- Consumers: /tmp/video-iteration4-consumers/{reference,independent}.
- Logs: /tmp/video-iteration4-{tests,types,lint,build,files,pack,verify,prepare,installed,split,keyboard,save}.log.
- Screenshots: /tmp/video-short-{reference,independent}-{1280,390}.png.
- Harnesses: packages/video-metadata/test-host/installed-{short-clip,split-target,keyboard}-check.mjs CONSUMERS.

## Limits and integration handoff

NOT RUN: real H264 (no supplied bytes in this environment), actual-media Save,
physical touch/OS IME, full legacy suite, performance (still paused). #76 owns
integrated real H264 verification. Native metadata persistence here establishes no
media byte retention, general import/probe, audio/export or full Video acceptance.
No new Host/shared contracts, clocks, dependencies, manifests or storage model.

No extra feature PR is created for passing paths. This branch provides an exact
combined checkpoint and expanded tests for parent integration. Review #139/#142
normally; their PR branches are unchanged. Actions remain manual-only, CI/file-size/
Office disabled. No enable/dispatch, merge, release or license change.
