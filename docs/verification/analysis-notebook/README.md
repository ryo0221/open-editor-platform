# Analysis notebook implementation verification

This record distinguishes implemented behavior from acceptance. **A0–A3 are implemented;
full functional acceptance is not declared while the NOT RUN items below remain.**
Implementation PR: #503.
No merge into main, release, performance claim, Actions run or public synchronization is included.

## Source and environment

- Base main: `9dd69734f592a830766c41801e6bc84edf020b0b`.
- Design PR #498 was open/unmerged
  at the initial inspection; head `dc1e85fd62ac8b67ac1a3e6ac3267cb800539ae8`.
  Its one ordinary bot comment reported no findings; inline threads and review submissions
  were empty. This implementation branch depends on that design, but targets main and copies
  only the common/Analysis documents. No code was added to the design branch.
- `edaa177e`: A0 calculation/model/validator/evaluator foundation.
- `d0d3e103`: A2 explicit source remapping, immutable run preservation, step operations,
  scenario comparisons and numeric boundary corrections.
- `9acabfe1`: A1 ordinary/independent Hosts, Worker guards, input buffers and A3 reference
  preflight/proposal adoption. Pure components remain separate from React and existing domains.
- `b49fc5ab`: named desktop/mobile production suite and ordinary CSV/static-copy/scenario flows.
- `7abdc538`: documentation and synthetic composition/readOnly UI assertions.
- `f14ea238`: merge main `159d1f10` after upstream CAD/BIM integration; the three overlapping
  Host registration/import files merged automatically. No feature branch from another author
  was incorporated directly. Final checks use this integration point.
- Environment E1: managed Linux, Node 24.19.0, npm 11.9.0, pinned Office fonts,
  Chromium production previews. Desktop 1440×900; mobile emulation 390×844.
  This is not physical-device, screen-reader or OS native-IME evidence.

The final runtime source is `96ad8cd1` (Host routing at `8682d473`); the final browser suite is `b1da56ab`, environment E1.
Earlier initial runs below retain their historical source and failures. The final refresh below supersedes initial command outcomes for the integrated source.
Raw logs/screenshots/native downloads are outside Git under `/tmp/analysis-*` and are local
execution evidence, not permanently hosted artifacts. Test sources and commands reproduce them.

## Commands and results

| Command                                                                                                                                                | Result / evidence                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint`                                                                                                                                         | PASS, `/tmp/analysis-lint-final.log`                                                                                                                                                                                                                                                                                |
| `npm run check:files`                                                                                                                                  | PASS, 6,571 files, zero failures; `/tmp/analysis-files-last.log`                                                                                                                                                                                                                                                    |
| `npm run test:tooling`                                                                                                                                 | FAIL: 115 PASS / 2 FAIL; `/tmp/analysis-tooling-last.log`. Both unchanged workflow migration fixtures omit `docs/workflow/markdown.mjs` in temporary repositories. Workspace dependency check passes.                                                                                                               |
| `npm run typecheck`                                                                                                                                    | Initial added-test union narrowing error corrected; final source refresh recorded below                                                                                                                                                                                                                             |
| `npm test`                                                                                                                                             | Initial full run: 4,055 PASS / 94 SKIP / 2 timeout FAIL, 420 files; `/tmp/analysis-all-unit.log`. Existing `schema-host` and `structure-instance-text` timeouts passed in isolated retry, alongside Slide import corpus: 12 PASS, `/tmp/analysis-unit-retry.log`. Not reported as an uninterrupted full-suite PASS. |
| `npm test -- packages/calculation-core/src packages/analysis-core/src packages/analysis/src packages/editor-host/src packages/artifact-references/src` | PASS, 10 files / 64 tests, `/tmp/analysis-focused-verified.log`                                                                                                                                                                                                                                                     |
| `npm run build`                                                                                                                                        | PASS (TypeScript and all four production builds), `/tmp/analysis-build-final.log`; final source refresh recorded below                                                                                                                                                                                              |
| `E2E_SUITE=analysis.production npx playwright test`                                                                                                    | Initial completed suite: 24 PASS, `/tmp/analysis-e2e-final.log`; extra scenario/copy checks added at `b49fc5ab`, final rerun recorded below                                                                                                                                                                         |
| `EDITOR_REFERENCE_PRODUCTION=1 E2E_SUITE=references npx playwright test`                                                                               | Regression execution/result recorded below                                                                                                                                                                                                                                                                          |

Initial failures are retained for context: default npm cache was unwritable (used
`/workspace/.npm-cache`); fonts were absent (fetched existing pinned assets); Node child Git
needed the environment network permission to avoid EPERM. Early E2E failures exposed a favicon
404, incorrect test selectors and an old Analysis Surface remaining mounted after switching
Editors. The Surface is now keyed by Artifact ID; all eight destination/mode tests assert that
Analysis unmounts. An isolated Vite rebuild removed the sibling Artifact Host output; rebuilding
the complete set resolves the preview startup timeout. No timeout was treated as a passed test.

## AN01–AN19

PASS refers only to the evidence explicitly listed. A row containing NOT RUN is not fully accepted.

| ID   | Implemented and tested evidence                                                                                                                                                                                                                   | Remaining / status                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| AN01 | AF1 pure evaluator and independent/normal production UI produce revenue/total 80 with stable field IDs and pinned input. `analysis.test.ts`, browser AN01.                                                                                        | PASS                                                                                                                      |
| AN02 | Exact 0.1+0.2; >binary64 integer multiplication; m/mm, hour/minute; four rounding modes and negative ties; zero division, scale/precision overflow; row/step/field error path. `decimal.test.ts`, `scalar.test.ts`, `boundaries.test.ts`.         | PASS for these boundaries; exhaustive unit-product combinations NOT RUN                                                   |
| AN03 | Unknown properties/operations, cycles, missing dependencies, accessors without execution, sparse arrays, node 256/257 and depth16/17, five/six runs. Validator also bounds input/output/cell/domain JSON sizes.                                   | PASS tested boundaries; every collection's exact limit±1 and native16MiB boundary NOT RUN for Analysis                    |
| AN04 | Duplicate remaps owned IDs/output IDs; move keeps identities; replace uses native session Undo/Redo; permission failure leaves content. `analysis.test.ts`, `host.test.ts`, browser Undo/Redo.                                                    | PASS; exhaustive keyboard delete/reorder combinations NOT RUN                                                             |
| AN05 | Cancel terminates Worker; late/duplicate completions cannot replace prior success. Edited/undone revision, closed controller, revoked permissions and tampered candidates reject. `host.test.ts`.                                                 | PASS; browser Worker timeout fault injection NOT RUN                                                                      |
| AN06 | Save/reload/native export-import in independent Host; ordinary immutable capture; every retained run replayed; whole-history preflight rejects forged old version even with rebuilt hashes.                                                       | PASS tested paths; Analysis UI old-version restore NOT RUN                                                                |
| AN07 | Analysis-specific native save failure/retry preserves edits and runs; second save leaves prior version bytes unchanged. Existing concurrent-save tests pass; copies use atomic creation.                                                          | PASS Analysis storage failure/retry and immutable prior-version bytes; storage fault UI NOT RUN                           |
| AN08 | Pure commands/controller recheck edit/read/export permissions and pending input at apply/output. Surface hides results after source denial. `host.test.ts`, existing Host/reference tests.                                                        | PASS headless, synthetic composition and ordinary readOnly; native IME / external authenticated Host NOT RUN              |
| AN09 | Exact native pins/hash, same version conflicting identity refusal, no source auto-upgrade; reference cache keyed by scope generation. `references.test.ts`, existing resolver tests.                                                              | PASS; remote authenticated source/offline connector NOT RUN (not supplied by local Host)                                  |
| AN10 | Independent public API/package CSS, Playground and Artifact Host production; desktop/390px run/save/reload; screenshots inspected and browser errors fail fixture.                                                                                | PASS Chromium viewport flows; native IME, physical mobile, screen reader and other engines NOT RUN                        |
| AN11 | Exact decimal strings in CSV/Data; formula-like text escaped; null and empty text distinct; immutable original. `analysis.test.ts`; ordinary CSV/static-copy browser check.                                                                       | PASS tested data; external spreadsheet auto-coercion is not guaranteed                                                    |
| AN12 | Recompute detects forged hashes/results; imported tamper rejects; unknown engine retains original for viewing, denies formal output/reference. `analysis.test.ts`, native preflight test, browser AN12.                                           | PASS                                                                                                                      |
| AN13 | Explicit inner/left and 1:1/many:1; duplicate RHS/LHS refusal, null never matches, unmatched rows retained, stable tuple IDs. `boundaries.test.ts`, `analysis.test.ts`.                                                                           | PASS; maximum-row join browser stress NOT RUN                                                                             |
| AN14 | Same pins yield 80/88/delta8; missing scenario parameters reject; ordinary scenario selection/comparison uses same evaluator.                                                                                                                     | PASS; full20-scenario sequence NOT RUN                                                                                    |
| AN15 | Explicit old/new column-ID mapping, rename/removed/type diagnostics; ordinary preview leaves input/run unchanged, rejection is non-mutating, adoption is one Undo/Redo. Old run bytes are retained.                                               | PASS headless mapping and ordinary single-source preview/reject/apply/Undo; multi-source mapping UI NOT RUN               |
| AN16 | Stable ID comparison; aggregate/join key changes produce regrouped diff rather than positional pairing; source/parameter/step and unit/value differences included. `boundaries.test.ts`.                                                          | PASS tested regroup; all sort/tie/source identity permutations NOT RUN                                                    |
| AN17 | All four ordinary destination Editors × fixed/follow × desktop/mobile capture native Analysis result80. Current-output adapter resolves recomputed saved result; fixed snapshot unchanged.                                                        | PASS: all four destinations, fixed/follow, source navigation, 80→88 recomputation/save, old destination version remains80 |
| AN18 | Async resolver preflight, cold sync adapter refusal, exact runtime scope key, forged result/hash refusal, all native versions replayed, retained fixed snapshot validated. Existing resolver regression covers capture access/change/limits.      | PASS targeted checks; Analysis-specific old-version Office/PDF output and all capacity fault combinations NOT RUN         |
| AN19 | `prepare` uses native preview without mutation; `apply` rechecks full candidate/revision/generation/permissions and executes one native transaction/Undo; reject cancels only private state. Semantic diff shows basis and exact numeric changes. | PASS headless and ordinary UI source-update preview/reject/apply/Undo                                                     |

## N/C mapping

| Conditions              | Evidence / disposition                                                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N01, N02                | Separate `analysis` native model, strict JSON validator, small pure calculation API. AN01–03. PASS tested subset; remaining bounds as above.                                                 |
| N03                     | Existing Artifact/version lifecycle; run snapshots immutable, explicit source adoption; AN06/15. UI restore NOT RUN.                                                                         |
| N04, N05                | Native command/transaction/session only; preview unchanged, one Undo; buffered text has native composition guard. AN04/05/19; native IME NOT RUN.                                            |
| N06, N07                | Independent entry uses public APIs/CSS; factory/validator/Surface/load/save/export in both ordinary Hosts. AN01/06/10. PASS tested flows.                                                    |
| N08                     | Row selection callback uses row ID; no new universal content/selection model. Reorder preserves IDs. Full selection/reload UI tracking NOT RUN.                                              |
| N09                     | Guarded headless/apply/async completion/export and result concealment; local Hosts explicitly authorize local sources. AN08/09. Authenticated Host integration NOT RUN.                      |
| N10                     | Whole-envelope preflight on load/save/native export; every retained Analysis version inspected. AN06/07/12/18. Analysis-specific save-fault UI NOT RUN.                                      |
| N11                     | Named controls, one-column mobile Surface, native inputs and Escape; desktop/mobile screenshots. Native IME/physical devices NOT RUN.                                                        |
| N12                     | No eval/Python/SQL/external jobs; typed AST only; text SVG escaped; static CSV formula text neutralized. PASS targeted tests.                                                                |
| N13                     | Local commands and known failures above; named production suite. Tooling remains FAIL; unexecuted conditions remain NOT RUN.                                                                 |
| N14                     | Design links, usage/API/limits, host/reference contracts and this matrix updated. PASS documentation review.                                                                                 |
| C01, C03                | Plain notes/native input buffers and guarded external candidate preview/apply. AN10/19. Native IME and complete UI proposal sequence NOT RUN.                                                |
| C07, C09                | Native preservation and static CSV/Data; explicit supported/rejected subset; capacity and closure validators. AN06/11/12/18, pending boundaries above.                                       |
| C10                     | Chromium desktop/390px emulation only. Physical mobile, screen readers, Firefox/Safari NOT RUN: unavailable in E1.                                                                           |
| C02, C04, C05, C06, C08 | N/A: no spatial domain, sharing, templates, linked reuse or React/Design code generation. Analysis is excluded/rejected at shared/template routes; unsupported source reuse/formula rejects. |

## Review decisions and limits

- Common extension points are optional async preflight hooks. Synchronous reference validation
  and domain-specific models remain unchanged. No second history/storage/job framework.
- Source mapping is explicit `native column ID → analysis field ID`; the UI accepts
  `old ID → new ID` and constructs this mapping. Labels and row positions never infer identity.
- Scalar multiplication by dimensionless values keeps the other unit rather than building
  verbose `dimensionless*dimensionless` unit strings; Unicode text comparison uses code points.
- Initial forms expose the common operations. Advanced grouping, rename, ordering and Chart
  declarations use validated condition JSON in the ordinary Surface; no arbitrary code runs.
- Unknown engines remain viewable but unverified; formal output requires supported recomputation.
  References conservatively reject snapshots that still contain any unknown-engine run.
- Formula/select/relation/reuse sources are explicitly refused in the initial subset; no Data
  evaluator semantics changed. Decimal copied to ordinary Data is text and clearly static.
- Retained history is bounded (five runs), never silently pruned. Users explicitly remove old runs
  from the draft before a sixth; existing immutable versions remain unchanged.
- Performance measurement/tuning, CI/Actions, public export synchronization and distribution
  remain stopped. Public inclusion policy was updated; no public snapshot/security gate was run.

## Final integration refresh

- Runtime/test source: `96ad8cd1`; main integration: `f14ea238` / upstream `159d1f10`.
- Unit: **30 files / 166 PASS**, `/tmp/analysis-complete-unit.log` (including Data,
  Artifact storage, reference, Host and Analysis regressions). The subsequent Surface-only
  focus fix is exercised by the final production browser rerun.
- Full lint passed at the integration point; changed files were checked again in
  `/tmp/analysis-final-lint.log` and `/tmp/analysis-focus-lint.log`.
- TypeScript and all four production builds passed in `/tmp/analysis-focus-build.log`.
  After the final boolean-input rejection, main and Artifact Host bundles were refreshed
  in `/tmp/analysis-runtime-refresh.log`; the main refresh preserves sibling preview outputs.
- File policy: **6,606 files / zero failures**, `/tmp/analysis-final-files.log`.
- Tooling after integrating main: **115 PASS / 2 FAIL**, `/tmp/analysis-final-tooling.log`;
  unchanged workflow migration fixture failures described above remain.
- Existing reference production regression: **279 PASS / 1 teardown FAIL**,
  `/tmp/analysis-reference-regression.log`. Parallel suites initially shared `test-results`,
  deleting an in-progress trace. The affected test plus Data/Graph placement regression
  were repeated with isolated output: **4 PASS**, `/tmp/analysis-reference-retry.log`.
  This is not presented as an uninterrupted 280-test PASS.
- Existing Data/proposal/history browser regression: **8 PASS**,
  `/tmp/analysis-data-proposal-regression.log`, named `default` development suite with
  `issue2-data.spec.ts proposal-review.spec.ts practical-history-review.spec.ts`.
- Further ordinary browser coverage adds Chart, scenario80/88/delta8, CSV/static Data,
  synthetic IME, readonly, source-new-version preview/reject/one Undo, and source navigation,
  save/update/fixed retention plus old destination version preservation in all four Editors.
  **Final named production rerun: 26 PASS**, `/tmp/analysis-final-production.log`,
  `E2E_SUITE=analysis.production npx playwright test` on the normal production previews.
  It includes every destination/mode on both viewports. Browser console/page errors are fatal.
  Inspected final screenshots include desktop Slide follow showing88 and mobile Artifact Host
  with result80, static-export controls and saved state. Screenshots are in `/tmp/analysis-e2e`.

Additional diagnosed failures: strict selectors for wrapped select labels were corrected;
empty Analysis blocks also satisfied the legacy Document shape predicate, so Host Surface
routing now uses Artifact kind and wrong-kind native imports reject. Subsequent desktop
follow-source tests exposed a blur-time toolbar click loss. Toolbar actions preserve native
input focus and flush registered boundaries at their normal guarded action boundary. Tests
keep the focused-parameter → Run path, rather than inserting a workaround blur into fixtures.

The last intermediate browser run had 25 PASS / 1 FAIL because its test navigated away before
an immutable destination save was acknowledged. `b1da56ab` uses the existing save helper to
wait for the actual History version count (source2/destination1/source3) before navigation.
The final 26-test run passed without retries or test skips. No failed intermediate run has
been relabeled PASS. Native OS IME, physical devices/assistive technology and the specifically
listed unexecuted fault/format combinations remain NOT RUN; PR #503 remains Draft.

## デモ後の操作改善

2026-10-25の10例デモで確認した条件編集・比較・表示・調査／復旧の課題については
操作改善の検証記録を参照してください。元のA0〜A3受入記録とは対象sourceと実行結果を区別します。
