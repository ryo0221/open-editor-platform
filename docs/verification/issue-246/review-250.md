# PR #250 review corrections

This records the 2026-10-13 source review response, not merge/release approval.
A later [retained-retry correction](retained-retry.md) fixes the rejected-operation
ownership gap missed by this report's original browser assertions.
Original PR head: `11f06f003cd3063ca8881daf935445ba07167d4d`.
Comparison base: `ac0252c7fbf6e3d51cfafc0be15e3c2b4624957f`.
Approved main integrated: `d4dedeb4d64090c4db85015cf2f3b61cfb23a579`.
Integration commit: `13000ce6ad127a4f013e7e9d81f17d0c00379139` (both Design and Graph status sections retained).
The Graph and canvas source trees remain identical to integrated main. No #252 changes,
root manifests, lockfiles, workflow settings or performance measurements are included.

## Corrections

- Prototype keyboard handling stops propagation of history shortcuts, while editable
  controls retain browser-native undo/redo. Native Design commands and history are unchanged.
- The normal Host only acknowledges shared comments after the receipt for that exact
  operation ID reports acceptance. A missing receipt retains the operation identity for
  reconciliation. Rejection retains the input; a later retry is a new authority submission.
- Local comment completion awaits the IndexedDB write result. The unsaved annotation
  remains part of the existing local draft/Not saved flow; retry reuses its thread ID.
  Concurrent submissions for the same artifact are blocked. Other persist callers retain
  their existing optimistic draft behavior and the write queue remains usable after failure.
- QA-17 explicitly reopens the narrow toolbar after source replacement confirmation
  closes it. The PDF paging assertion, both widths, all seven surfaces, default timeouts
  and browser-error assertions remain intact.

## Same-environment original comparison

Linux, Node 20.20.2, npm 10.8.2, system Chromium 151.0.7922.173. Separate clean
installs from the unchanged lockfile and four SHA-256-verified Office fonts; no
simultaneous build/unit/browser jobs. Vitest defaults: two workers, ordinary timeout
5 seconds, existing I07 explicit timeout 60 seconds. Browser defaults: 45-second test,
10-second expectation, two configured workers (one effective worker for the QA-17 file).

| Check | Original base | Original PR head | Interpretation |
| --- | --- | --- | --- |
| I07, exact test-name selection | PASS, 1 selected / 7 not selected | PASS, 1 selected / 7 not selected | Earlier timeout did not reproduce here; this does not erase it or certify full base suite |
| Full `npm test`, unmodified defaults | PASS, 130 files / 1168 tests | PASS, 133 files / 1180 tests | I07 also passes in each full suite; original reported timeout remains historical, cause not established |
| Production build | PASS | PASS | Includes typecheck and both Vite builds |
| QA-17, 390px and 768px | FAIL, 2/2 | FAIL, 2/2 | Both wait for hidden `Next PDF page` at line 64 after toolbar closes |

Commands (same on both checkouts):

```sh
npm test -- --testNamePattern='^I07 imports the separate self-export corpus as editable native elements with source text order$' packages/slide-import/src/import.test.ts
npm test
npm run build
npx playwright test --config=playwright.production.config.ts --project=mobile --grep 'QA-17'
```

Original QA-17 source blob is identical on both pins:
`358ce31bd3f7d76aca94a19fe23946219688ad71`. I07 source blob:
`74c34463af3882b2be8c1975f033b39ca9b4b0f3`. Lockfile blob:
`58a0fa64c9431847c1e0baf6461c20b027be61d5`.
Logs and raw screenshots/traces stay outside Git under `/tmp/pr250-*`.

## Regression sensitivity

The new local-storage failure and delayed-authority tests both FAIL against the original
PR production build: input is cleared before the write/receipt succeeds. The independent
real-typing regression FAILS against the original `prototype-view.tsx`: Ctrl+Z leaves the
text unchanged. The same regression checks native content and consumes/restores a real
prior Design history entry after leaving prototype mode. No timeout was increased.

## Follow-up failure history

The first corrected production matrix had 9 PASS / 1 FAIL: revocation removed the
submission callback and hid the input form. The Surface now retains a nonempty draft
when the callback becomes unavailable and disables submission. A subsequent test run
still used the earlier menu-based restoration step: Escape closed the modal and the
retry button could not be found (45-second default timeout). Restoration is now an
external reference-permission change while the same modal stays open; this corrected
scenario passed without a timeout change. These are retained investigation failures,
not replaced with a claim that the first run passed.

## Final source verification

Tested source: `e45d5d63595f85860ccb7efed9941768e83bd888`. Later changes only record
verification evidence. The production build uses the exact runtime files at this pin.

| Check | Result |
| --- | --- |
| `npm run lint` | PASS |
| `npm run build` | PASS, typecheck + Playground and React reference builds |
| `npm run test:tooling` | PASS, 25 tests |
| `npm run check:files` | PASS, 1110 tracked files, no failures |
| `npm run public:export -- --ref e45d5d63595f85860ccb7efed9941768e83bd888 --out /tmp/pr250-runtime-public` and `npm run public:check -- /tmp/pr250-runtime-public` | PASS, 828 exported files / 829 including manifest; local only |
| `npm test` (unmodified defaults, no selection/exclusion) | PASS, 133 files / 1180 tests, including I07 |
| `npx playwright test --config=playwright.design-prototype.production.config.ts` | PASS, desktop 9 + mobile 2 = 11; native history, local failure/revised-draft retry, delayed rejection/regrant, lost acknowledgement reconciliation |
| `npx playwright test --config=playwright.production.config.ts --project=mobile --grep 'QA-17'` | PASS, 390px / 768px, all seven surfaces |
| `npx playwright test --config=playwright.production.config.ts --project=desktop tests/e2e/issue2-persistence.spec.ts` | PASS, 3; failed writes, delayed immutable save with newer draft/annotation, migration/roundtrip |

The same one-line QA-17 test correction was applied temporarily to comparison base
`ac0252c7fbf6e3d51cfafc0be15e3c2b4624957f` without changing its runtime: both widths PASS
under the same production config/default limits. This is a test-only probe, not a claim
that the unchanged base QA-17 passed. The patch was then removed. Corrected test blob:
`10a6520609d050483afe5914bf9f8d22df776924`.

Graph preservation: `git diff d4dedeb4 -- packages/structured-graph packages/canvas-ui
 docs/verification/graph-default-labels` is empty. Graph unit tests run in the full suite;
the full Graph browser matrix is NOT RUN again at this pin. No claim of full repository
E2E acceptance is made. Browser console errors and uncaught exceptions are asserted
absent by the test fixture; expected storage/authority failures are handled UI results.

Both comparison full suites used `npm test` without flags. The comparison checkout was
returned to clean base `ac0252c7fbf6e3d51cfafc0be15e3c2b4624957f` afterwards. The original
I07 timeout is not reproduced under either the focused check or full default suite in
this environment; no Office source, timeout, worker default or test exclusion changed.

All three review requests have functional evidence at the stated pins. Independent
source review remains pending; this author report does not approve merge/release.
Production authentication/durability, other browsers, native IME and assistive technology
remain NOT RUN. CI and performance acceptance remain paused.
