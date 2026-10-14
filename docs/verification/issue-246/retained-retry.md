# PR #250 retained-comment retry correction

This follow-up preserves the previous [review report](review-250.md), including its
failures. The earlier delayed-rejection test stopped after checking the note and
missed the stale retained operation. It did not establish Save/Leave recovery.

## Ownership and scope

The prior task ended at `e1634459c4759a1da1c20b7d04fe5832168fb894`; the parent
reported two failed follow-up admissions and no concurrent admitted writer. Remote
head was checked twice unchanged before edits. An isolated worktree and separate
correction branch preserve the author branch. Ownership was announced in PR #250.

Main `5afe78b36dbd3bb0c23eebc8e216d3d80decaee7` is integrated in merge
`7b3d4ad90ff466417b4da5a4c066902f0929c0ff` with additive documentation conflict resolution. Graph, Canvas,
spatial-index, the spatial build script, root manifest and lockfile are unchanged
from that main. Both Design and spatial documentation/policy entries remain.

## Behavior

The Host keeps a rejected comment's operation identity. Retry uses the existing
`previewRetained` / `applyProposal` path with the original thread/reply IDs. That
path applies current authority checks and selective history and removes only the
matched retained operation after accepted synchronization. An uncertain proposal
response reuses its proposal ID; an explicit rejection permits a fresh preview.
The original JS input stays available on failure. Changed input following confirmed
old delivery remains a separate draft; explicit discard is distinguished from a
successful generic retained replay using the original confirmed thread IDs.

There is no session, authority, native schema or public API change. Save and Leave
retain their existing pending/rejected-input guards. Unrelated retained entries
are never cleared by the comment handler.

## Fail-first

Test-only pin `3e16eba45ca45045f1ccc3f84df4192fce7206ce` preserves the runtime of
`e1634459`. Production build PASS. The extended delayed authority rejection /
regrant / retry browser test FAILS at the confirmed-status assertion: actual
`Rejected · 1 retained edit(s)`, despite one successfully saved annotation. Raw
log, screenshot and trace are retained outside Git in
`/workspace/pr250-retry-evidence/fail-first-browser*`.

## Verification

Runtime fix: `1543c61a32bd59c07133533f54077944c2a1fe2e`.
First corrected test pin: `18fc267add54a4037af7006abbb81c41f9a7f603`.
Final test/source pin: `6aee2fcc801cb1dceedd7f535335a5ee72ff1a46` adds two
explicit retained apply/discard cases. Only browser tests changed after the runtime fix; `apps` and `packages` trees are
identical. Later changes record documentation and snapshot inclusion only.

Production build/typecheck at 1543c61a PASS. The first corrected browser run had
2 FAIL: both passed retry/reconciliation, Save and Leave, then asserted the shared
note against the original local artifact after Leave. `shared-host.tsx` intentionally
navigates to `/` on Leave and retains that original local artifact. The final tests
instead capture the peer URL before Leave, verify successful exit, reconnect as a
fresh peer and verify exactly one shared note and one version. No runtime change or
timeout increase accompanied that test correction. All failure logs/screenshots/
traces remain under `corrected-browser-1*` beside fail-first evidence.

At 18fc267a, the production prototype matrix PASS: desktop 10 + mobile 2 = 12.
The new unrelated-edit scenario rejects a layer rename, then rejects a comment;
loses the first **accepted proposal** response; retries the identical proposal ID;
compares the remaining rejected entry byte-for-byte with the original unrelated
edit; proves Save/Leave stay blocked; previews/applies that remaining edit; and
checks that its replay cannot duplicate the note. It then saves/leaves and inspects
the shared artifact from a fresh peer. Existing original-submission lost-ack,
local failed-write/revised-draft retry, native input Undo/Redo and shared selective
history regressions also pass. Desktop overlay and normal mobile completion
screenshots were visually inspected.

At 6aee2fcc, eight additional production browser cases PASS: the two new generic
retained apply/discard cases; Review and File shared annotations; Document shared
editing/mapped comments; and three normal persistence regressions. This totals
20 distinct passing browser cases (18 desktop / 2 mobile) across the two runs.
Production runtime files are identical to the successful build.

Full default `SPATIAL_WASM_REQUIRED=1 npm test` PASS: 135 files / 1,194 tests,
no skips, including Office I07. This run started at 18fc267a; the only subsequent
source change is the two additional E2E tests at 6aee2fcc. All unit sources/config,
application/package runtime and lockfile are identical between those pins.

At final source 6aee2fcc: lint PASS; typecheck PASS; tooling PASS (25 tests);
file policy PASS (1,134 tracked files including this documentation, zero failures).
No runtime fixes followed the successful production build.

Environment: Linux, official Node 20.20.2/npm 10.8.2, Chromium
151.0.7922.173, locked npm install, four existing Office fonts. Default test and
expectation timeouts are unchanged. No Office workaround or test exclusion.

The existing spatial Wasm artifact is reused from the independently tested #252
correction, SHA-256
`837e8c06237c9238837e3c81e3abe8a4abbacd2816280e419640a6548c56f423`.
This is input to the default unit suite, not a new Rust build/performance claim.

Automatic CI remains manual-only. Performance, main merge, release, deployment
and public publication remain unapproved and unperformed. Full repository E2E,
other browser engines, native IME/AT and production authentication/durability are
NOT RUN by this correction.

## Reproduction commands

```sh
npm run build
npx playwright test --config=playwright.design-prototype.production.config.ts
SPATIAL_WASM_REQUIRED=1 npm test
npx playwright test --config=playwright.production.config.ts --project=desktop tests/e2e/design-prototype.spec.ts tests/e2e/editor-collaboration.spec.ts tests/e2e/issue2-persistence.spec.ts --grep 'explicit retained|EI-Q08|EI-Q04/Q10|failed local writes|a delayed immutable|legacy frame migration'
npm run lint
npm run typecheck
npm run test:tooling
npm run check:files
```

The first full prototype command selected 12 tests at 18fc267a; at 6aee2fcc it
would select 14. The two added cases were actually run through the second command;
the earlier twelve have unchanged test bodies. Output directories were supplied
outside Git under `/workspace/pr250-retry-evidence/` for logs, screenshots and traces.
