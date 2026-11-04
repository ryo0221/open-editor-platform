# Design local path and PNG editing

## Scope and responsibility

The Design packages own opt-in stroke input, owned embedded PNG editing and
native commands. Playground is the reference Host for data-only proposals,
input/revision/permission checks, preview/apply/reject and existing history/save.
The existing independent `/authoring.html` Host and its small native fixtures
remain the reference for page editing, proposals, Undo, save and reader output.
No generated artwork, fixed character taxonomy, production workflow or AI
runtime is required by this feature.

## Reproducible regression inputs

`tests/e2e/playground-ink.spec.ts` creates native paths/pages in the test.
`tests/e2e/playground-raster.spec.ts` creates a 128×128 geometric PNG in the
browser. Neither requires downloaded manga artwork or private filesystem paths.
The unchanged common `authoring.production` suite selects only its small
`authoring` / `authoring-normal` fixtures; no production-manga spec is selected.

After the documented Node/font/browser setup, run:

```sh
npm run check:files
npm run test:tooling
npm run lint
npm run typecheck
npx vitest run packages/design/src/stroke-path.test.ts packages/design/src/raster.test.ts apps/playground/src/app/design-ink-proposal.test.ts
npm run build
E2E_SUITE=playground-ink npx playwright test
E2E_SUITE=playground-raster npx playwright test
E2E_SUITE=authoring.production npx playwright test
```

Inspect screenshots and fail browser errors as required by the repository's
verification rules. Do not disable font/security checks to run these commands.

## Source-specific evidence and current split

At the pre-split source `ba81dbabdb470b4b9a5aeb0d41135b9ac9ab0541`, existing
records report 8 Playground ink and 6 PNG desktop/mobile checks passing, plus
model/type/lint/build checks. Those are historical results, not a rerun of this
split. Findings preserved in the source include correct stroke parent selection,
reselecting the same layer, proposal preview paint bounds, and full-width/height
raster-region edges. Native path/PNG proposal checks cover stale revisions,
scope, write permission, unfinished input, atomic operations and old versions.

During the 2026-10-28 split, the attached executor is offline and rejects even
`pwd` before execution. Source/tree/import/link selection can be inspected through
GitHub; lint, tooling, typecheck, model tests, builds, desktop/mobile E2E and
screenshots of the split are **NOT RUN / BLOCKED** until a usable executor is
attached. Previous Codex approval does not approve the split.

Artwork quality, full comic production, physical stylus/pressure/native IME,
shared raster/path operations, high-resolution printing, performance and
production authentication/durability are outside this acceptance.
No dependency, license, merge, public snapshot or deployment is introduced.

## Review after resolving main documentation conflicts

The review of `639e6371140b1835aeb37728ee3f67202193aedf` reported P2:
mutating a retained add-operation bounds object after preview could change the
eventual insertion without a new preview. The native path was already cloned,
but the Host passed the caller-owned bounds through to a deferred command.

The Host now clones bounds before preparing the insertion. A regression mutates
all four bounds fields after preview and adopts through the normal local
Playground session, requiring exact equality with the preview and reviewed
bounds. The reviewer reported reproducing the old failure. This thread's new
test/type/build/E2E checks remain **NOT RUN**, because the executor is offline;
this is not a claim of locally executed fail-before/pass-after verification.
