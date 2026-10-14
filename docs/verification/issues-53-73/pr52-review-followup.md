# PR #52 review follow-up (2026-10-11)

The subsequent six ordinary-use findings and the urgency assessment of unresolved
#40 comments are recorded in [the newer triage report](pr52-review-triage.md).
The counts below describe earlier checkpoints. All three rare cases deferred here
were later corrected in that report's completion section.

## Latest five findings: ordinary-use scope

Read the complete PR body, three conversation comments, ten review entries and all
26 inline comments/replies at head `61e2f5c17077b4d29dc84a63c97e7d1caa557851`.
At this checkpoint the maintainer's instruction excluded rare cases. Two ordinary
paths are corrected in this follow-up:

- CSV append reports a blocking mapping diagnostic for explicit and name-matched
  formula targets. Choosing an editable target permits import; formulas still
  compute from native fields. Native tests check both mappings, unchanged input,
  computed export and Undo. The ordinary UI checks rejection, Cancel, remapping,
  successful append and Undo.
- The independent Graph Host flushes registered inputs before preparing/executing
  a saved-version restore. A flush error keeps the source/buffer and reports that
  restoration is blocked. Native Graph and Data Form browser tests correct the
  input, restore, Undo back to the accepted draft, save without stale-input failure
  and verify immutable versions. The narrow viewport checks the Data Form path
  through focused keyboard activation of Restore.

The following findings were **unmodified / out of scope** under that instruction;
they were not counted as fixed in this checkpoint. The later completion corrects
all three:

| Comment    | Remaining rare case                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| 4239922677 | Review source lookup for an older annotation with no revision ID after its source is replaced.                         |
| 4239922678 | File remap of an imported annotation with multiple anchors, including foreign references, drops the unrelated anchors. |
| 4239922680 | PDF query results stop after 10,000 occurrences on a single page without exposing truncation.                          |

Latest checks: lint, strict TypeScript, production build, format/file guard and
**25 tooling cases PASS**; **1,125 units / 126 files PASS**. Production Chromium
**36 distinct cases PASS**: all 34 audit/review cases (30 desktop + 4 mobile,
including the four added regressions), plus two existing Graph protection/restore
cases. The new narrow-viewport screenshot was inspected. Source-only public export
and manifest/residual checks **PASS on 793 files including the manifest**. The
earlier 76-case and 111-case results below remain separate historical checkpoints.
Native OS IME, real devices/screen readers, other engines, real Office, production
durability and consumer trials remain NOT RUN.

Commands for this follow-up:

```sh
npm test -- packages/structured-data/src/csv-transfer.test.ts
npm run lint
npm run typecheck
npm test
npm run build
npm run test:tooling
npm run check:files
npx playwright test --config playwright.audit.production.config.ts --workers 1
npx playwright test tests/e2e/structured-graph.spec.ts --config playwright.usability-regression.production.config.ts --grep 'saved Data restoration|protected new records' --project desktop --workers 1
npm run public:export -- --ref HEAD --out work/pr52-comments-20261011/public-final
npm run public:check -- work/pr52-comments-20261011/public-final
```

The first narrow-viewport pointer test timed out because the focused Form intercepted
the scrolled Restore button. The fixture now exercises focus plus Enter through the
ordinary button handler; it does not force a pointer click or invoke the callback
directly. Mobile pointer reachability in that scrolled state is not established by
this check. No additional performance measurement, automatic Actions, merge,
consumer trial or generated-file commit is included.

## Previous seven findings checkpoint

Read the PR body, both reviews, all fourteen inline comments and both conversation
comments at head `0569c0dcad9bdfa09d6542e399593cf0330a4026`, including the seven-case
maintainer reproduction report. The earlier seven fixes remain in this same PR.

## Changes and regression coverage

| Finding                     | Correction and verification                                                                                                                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1 rejected Design text     | Return the native command result for root and component-part text. Test-only independent public-API Host rejects flush, retains editor/buffer/dirty and unchanged canonical content, then accepts the same input on retry.                                                                             |
| P1 inherited formatting     | Serialize engine marks against the base before dropping redundant true values. Native tests and real browser append preserve bold/italic/underline/strike; only a selected substring receives explicit false values, including reopening.                                                              |
| P2 multi-file annotations   | Status/click/remap use the same displayed address. Host remaps only the matching artifact/file anchor. Native tests preserve thread metadata and foreign references; ordinary Review browser covers Current/Outdated, remap, save and reload with three anchors.                                       |
| P2 singleton image          | Component template retains optional alt/web/imageFit/crop, validates optional web metadata, and retains old templates without those fields. Native tests cover strict conversion before/after publication, JSON reload and Undo; normal UI exports an actual React ZIP after image component creation. |
| P2 row-frame fit            | Main-axis fill divides inner space after padding/gaps; cross-axis dimensions fit the fixed frame. Tests use two oversized children and three alignments, check exact geometry and Undo/Redo; ordinary UI applies the phone preset.                                                                     |
| P2 overlapping Graph hits   | Search endpoint targets from the front of paint order. Real browser observes the front node in preview and committed edge, then checks native Undo.                                                                                                                                                    |
| P2 independent Host history | Buttons, context and shortcuts use private input history before native history, including private-only availability. Desktop browser checks save, interleaved private/native history and keyboard Undo/Redo; mobile checks availability and readonly.                                                  |

The original singleton-override test now explicitly starts with literal text rather
than a page-input binding: preserving native web metadata also preserves bindings,
which must be declared as component public props when publishing reusable definitions.
No page-input reference is silently removed by component creation.

## Reproduction and environment

Linux, Node 20.20.2, fixed font SHA checks, strict TypeScript, production Vite build,
Chromium desktop 1440×900 and mobile viewport 390×844. Browser fixtures fail on
console/page errors. The rejection fixture bundles public packages in memory using
esbuild; it supplies no playground state, transport or production authority.

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run check:files
npm run test:tooling
npx playwright test --config playwright.audit.production.config.ts --workers 1
npx playwright test --config playwright.audit.production.config.ts --project mobile --workers 1
npx playwright test tests/e2e/usability.spec.ts tests/e2e/structured-graph.spec.ts tests/e2e/usability-mobile.spec.ts tests/e2e/structured-graph-mobile.spec.ts --config playwright.usability-regression.production.config.ts --workers 1
npm run public:export -- --ref HEAD --out work/pr52-review-public
npm run public:check -- work/pr52-review-public
```

## Results

Lint, strict TypeScript, production build, format/file guard and tooling **25** pass.
All **1,124 unit cases / 126 files** pass. Production Chromium covers **76 distinct
passing cases**: audit/review **30** (27 desktop + 3 mobile, including 9 added review
cases) and existing Graph/usability **46** (41 desktop + 5 mobile). Actual image
component React ZIP generation, PDF extraction/search and native save/reload are
included. Row-frame and mobile Host screenshots were inspected.

The audit run first passed 29 cases and failed the new mobile test on its old
Inspector label. The corrected mobile project passed all three cases; desktop code
was unchanged. Earlier test setup failures used a singleton without published parts,
selected the fixture's pre-existing image instead of the newly inserted image, or
imported Surface CSS into the Node test runner. Correcting those prerequisites made
all eight added desktop cases pass. Strict-TS fixture inference was also corrected.
The inherited binding found in the existing native publication test is explained
above; the complete unit run passed after its literal-text fixture correction.

Source-only public export and manifest/residual verification pass on the committed
source (793 files including the manifest). The original audit's 111 browser cases are a prior
checkpoint, not a claim that all 111 were rerun in this follow-up.

Native OS IME, actual screen readers/devices, other engines, real Office, production
durability and consumer trials remain NOT RUN. This follow-up neither reruns unrelated
browser suites nor recertifies the entire Platform. Automatic Actions remain manual-only.
Performance acceptance stays held; tuning and additional measurement remain paused.
Generated images, ZIPs, fonts, bundles, traces and raw logs stay outside Git.
