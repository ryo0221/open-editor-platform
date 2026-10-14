# PR #258 行高・自動レイアウト・JSON record レビュー修正

2026-10-14。レビュー対象 `021cc2c` の追加3指摘を修正した。
[初回検証](README.md) と先行レビューの検証履歴を保持する。

## 指摘と修正

| Review comment                     | 修正と回帰検証                                                                                                                                                                                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `4268894952`: 実効行高             | 公開 measureTemplateTextFit に任意の typography/runs を追加。layoutDrawingText と同じ行領域と padding を計算し、従来の保守的な見積りとの大きい方を使用。instance-aware Design の拡張・診断が実効書式を渡す。12px / lineHeight 3 の base/run、padding、fit による縮小を避けた拡張、error policy での拒否を検証 |
| `4268894975`: 非 record / 継承属性 | vector / viewBox / provenance を通常または null prototype の JSON record に限定し、必須欄の own property を確認。配列の named fields、各必須欄の prototype 継承、Date、vector 自体の継承を validator / constructor / native validation で拒否。null prototype の record は native JSON 往復で維持             |
| `4268894991`: 古い兄弟レイアウト   | instance-owned size override の書込み後に designInstanceElements を再計算。後続 fill/hug の文字を更新後の投影寸法で測る。column の2 fill labels で先頭を4行へ拡張し、縮んだ後続 label も拡張する。入れ子と定義不変性、native roundtrip を検証                                                                 |

既存の text/bounds/fontSize/minFontSize のみの公開 preflight は従来の見積りを保持する。
textScope 未指定の旧定義と他ドメインの診断・拡張を変更しない。原本・immutable 定義の
bytes/hash、共有 component の局所 bounds、空 placeholder の寸法を維持する。
フォントの字形計測や固定 clipping frame の自動拡張を追加していない。

## 検証結果

Linux 6.18.44 / Debian 13、Node 20.20.2 / npm 10.8.2、Chromium 151.0.7922.173。
desktop 1440×900、mobile 390×844、既存 mobile 回帰は768pxを含む。
Node 20.20.2 の PATH を指定し、repository root で実行した。
browser / Office / tooling の子プロセスは実行環境の network 権限付き sandbox を使用。
固定 Noto CJK JP/Mono 四つの SHA-256 検査を維持した。

| Command / scope                                                                                                                                                                                                                             | 結果                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `npm run lint` / `npm run typecheck` / `npm run build`                                                                                                                                                                                      | PASS。通常 build と registered React preview build       |
| `npm test`                                                                                                                                                                                                                                  | PASS。149 files / 1,324 passed / 9 skipped / 1,333 total |
| `npx vitest run packages/design/src/vector-record-review.test.ts packages/templates/src/design-typography-layout-review.test.ts packages/templates/src/design-text-fit-review.test.ts packages/templates/src/design-reuse-graphics.test.ts` | PASS。4 files / 35 tests                                 |
| `npm run test:e2e -- tests/e2e/design-reuse-graphics.spec.ts tests/e2e/design-reuse-graphics-mobile.spec.ts tests/e2e/issue2-canvas.spec.ts tests/e2e/issue2-mobile.spec.ts --output=/tmp/pr258-fifth-final-browser --reporter=list`        | PASS。23 cases                                           |
| `npm run test:e2e -- --config=playwright.design-reuse.production.config.ts --output=/tmp/pr258-fifth-production`                                                                                                                            | PASS。19 cases                                           |

`npm run check:files` / `npm run test:tooling` は PASS。tooling は25 tests。
最終の lint / typecheck / file policy / tooling は `/tmp/pr258-fifth-final-checks.log` に保持。

Host の maxWidth 調整後に上記 dev / production の command へ `--grep expanded` を
加え、別出力先でそれぞれ3 cases PASS。新規 desktop/mobile 文字検証と compact arc を含む。
document の scrollWidth が viewport 内に収まることも検証した。

独立 public Host の SVG text の実 getBBox が各文字枠内に収まることと、native の
保存・reload 後の内容一致を確認した。clipContent を持たない部品は親 frame 外にも描画できるため、
browser fixture に十分な寸法の export page を明示した。固定 clipping frame の拒否は既存回帰に含む。
console error / uncaught exception を失敗条件とし、desktop/mobile の screenshots を目視確認。
9 skipped を PASS に含めない。全 unit 後の型ガード宣言修正では runtime を変更せず、
型チェックと focused 35 tests を再実行した。

## 失敗履歴・証拠

修正前の focused は2 files / 12 tests中9 failed / 3 passedで、行高・padding・record の
不具合を再現した。兄弟の初期 fixture は先頭3行では後続がまだ収まり、4行へ補正した。
再投影だけを旧処理へ一時的に戻した検証では nested 有無の2 casesが overflow で失敗。
直後に再投影処理を復元した。フィルタ外の7 casesは未実行。
中間 focused は error policy の3 casesで失敗した。新しい診断が登録時点で不適合を拒否するため、
登録後の展開例外を期待していた fixture を登録拒否の検証へ修正した。

初回 typecheck / build は record 型ガードの宣言で失敗。宣言を object に修正し再検証した。
初回 browser は21 passed / 2 failed。DrawingView の local 原点の getBBox を world の y と
比較していた検証側の誤りを修正し、23 casesを再実行した。
mobile の大きい export preview は独立 Host 側で maxWidth を指定して表示を調整した。

初期 logs は `/tmp/pr258-fifth-repro.log`、`/tmp/pr258-fifth-sibling-repro.log`、
`/tmp/pr258-fifth-focused.log`、`/tmp/pr258-fifth-build.log`、`/tmp/pr258-fifth-browser.log`。
成功 logs は `/tmp/pr258-fifth-unit.log`、`/tmp/pr258-fifth-focused-final.log`、
`/tmp/pr258-fifth-static-build-final.log`、`/tmp/pr258-fifth-browser-final.log`、
`/tmp/pr258-fifth-production.log`、`/tmp/pr258-fifth-responsive-browser.log`、
`/tmp/pr258-fifth-responsive-production.log`。screenshots は上記 browser の output と
`/tmp/pr258-fifth-responsive-browser` / `/tmp/pr258-fifth-responsive-production` に保持。
raw evidence / build / fonts / exports は Git 外に置き、公開アーカイブは作成していない。

追加3指摘の範囲を検証した。実機/native IME/全 browser/外部 SVG reader、vector 固有の
複数 browser context/fault は NOT RUN。追加 performance 測定・tuning は行わず、
既存の停止・保留を維持する。

## Post-merge vector and run minimum correction

Separate corrective draft, based on main `8a6cffad6916d489d1777bd2f5ee7b8bb65a243c`.
No concurrent corrective PR was present at initial or pre-publication lookup. PR #259's
Video integration branch was not checked out or changed.

Review findings: linked vector adoption and effective rich-run minimum.

The change adds `vector` to the existing three-way native fields. Geometry and provenance
adopt together; native local overrides (including explicit default-equal values) remain
owned. Existing dependency stamps reject stale updates and shared Undo restores the vector
and exact definition reference together. There is no schema or ownership-contract change.
The public text-fit helper now tests normalized effective run sizes with the existing drawing
8px run floor, retaining its base-size check and conservative clip-mode height estimate.
Empty/stale runs, Design expansion/fit behavior and Document/Slide defaults retain their
existing semantics. The ordinary renderer does not silently enlarge a rejected 9px run.

### Exact source and validation

Runtime/unit implementation: `2483efc41f90ef1f350f16df46ab0a13f98b8927`.
Final test-source commit: `3e348b03f066bd3ecbf2464554140095c4c355c6` (only the browser selector
changes after 2483efc4). Documentation follows as a separate commit, identified in the PR.

- PASS at 2483efc4: full units 1,331 passed / 9 skipped, 150 files; root lint/typecheck,
  file guard, tooling 25/25, and both production builds. The nine optional Spatial WASM
  tests were skipped; no skipped test is counted as a pass.
- PASS at final source 3e348b03: full units 1,331 passed / 9 skipped in 150 files;
  root lint/typecheck/file guard; production browser 21/21, zero retries/skips/failures.
  The new desktop/mobile screenshots were visually inspected. The production build and
  tooling results above remain attributed to 2483efc4; only a browser selector differs.
- PASS final-source local public export and manifest/residual check: 884 files plus manifest;
  snapshot SHA256 `2420d1c0311738cd0004330cd323fe1906f732d97d82abbb79f90d52b8aaa5b5`.
  No exported snapshot execution or remote publication is claimed.
- Browser scope is production Chromium desktop 1440×900 and mobile viewport 390×844,
  workers 1 / retries 0, through `playwright.design-reuse.production.config.ts`.
  Added checks cover adopted geometry on screen and in downloaded SVG, the actual 9px
  rendered run versus rejected preflight, and native save/reload equality.
  Existing scoped tests cover PNG pixels, token modes, clipping, rich text expansion,
  input diagnostics and foreign-domain metadata. Browser errors fail tests.
- Unit additions cover exact-ref adoption/native/SVG roundtrip, local and default-equal
  vector ownership, authority stale-preview rejection/selective Undo, normalized rich
  runs, and nested-instance authoring rejection under error and expand policies.
- Node v24.19.0 / npm 11.9.0 / Chromium 151.0.7922.173 / Playwright 1.63.0.
  Full app-wide browser regression, other engines, physical devices and fresh exported
  snapshot install/build/browser execution: NOT RUN. Local export/residual validation
  is not publication or full public-snapshot acceptance.

### Retained failure history

1. Initial fail-first: 7/7 failed. Six reported missing vector/minimum behavior; the
   authority test also used an invalid action shape. The initial vector revision fixture
   mutated a projected copy, so its vector failures alone were not valid reproductions.
2. Corrected fixture uses `patchReusablePart` and `reusableNativeActions`. With both
   runtime files restored to main, final fail-first is **6 failed / 1 passed**: vector
   update/preserve diagnostics and effective minimum/authoring rejection fail. Shared
   stale-preview/Undo already passed on the baseline; it is regression coverage, not
   claimed as a newly reproduced failure. Fixed runtime then passes all 7.
3. First build attempt ran before pinned font extraction completed and failed the
   required fonts check. After extraction and four SHA256 checks, production build passes.
4. First scoped browser run at 2483efc4: **19 passed / 2 failed**. The new selector found
   the outer line tspan without a font-size attribute, rather than the inner rich-run
   tspan. 3e348b03 selects `tspan[font-size]`; no runtime or assertion value was weakened.
   Original screenshots, traces and logs are retained separately from the rerun.
5. Connector workflow-list fetch rejected the unsupported endpoint; read-only `gh api`
   succeeded. CI/file-size/Office remain `disabled_manually`; other workflows are manual
   dispatch only. No enable, dispatch, merge, deploy, publication, license change or
   performance measurement/tuning was performed.

Raw logs and initial/final browser evidence are outside Git under
`/workspace/fix258-evidence`; `/tmp/fix258-*.log` retain command outputs. Final evidence
hashes and the documentation-only head are provided in the draft PR. Earlier failures in
this document remain historical failures and are not retroactively relabeled.

## Design-only vector adoption follow-up

Separate corrective draft based on merged main `7e2190f7b3edc7a7692bd845956d67c08b578be1`.
Executable/test source: `bd32ef184113a7cf8bb89f7aec01e8c428714e7c`.
Final browser test source: `540caddd89c5e7e92e14eb9c5fe3842978484300`.
The only subsequent source change is comparison-fixture readiness; runtime/unit sources
are byte-identical to bd32ef18.
Documentation follows in a separate commit identified by the draft PR.

PR #262 added vector to a field list shared by Design, Slide and Whiteboard. The previous
review did not cover an incoming foreign-domain definition changing/deleting that metadata.
Such an adoption tried to change an unsupported native field and failed with
`Unknown element property: vector`. This correction removes vector from the common list
and adds it only for Design. No field allowlist, schema or rendering authority is widened.
Slide/Whiteboard preserve opaque imported metadata while adopting supported attributes
and the selected exact reference. Design update/local override/selective Undo and the
rich-run minimum implementation are retained.

### Coverage and results

- Corrected fail-first on unchanged main: 8/8 FAIL for Slide/Whiteboard × changed/deleted
  incoming vector × local/native-load or shared/Undo paths. Fixed focused 8/8 PASS.
- Related focused suite: 69/69 PASS across 8 files, including existing Design exact-ref
  update, local/default-equal override preservation, selective Undo/stale reads, rich-run
  minimum, Design text expansion, Slide and Whiteboard reuse checks.
- New native-load fixtures include existing opaque vector metadata in both current native
  content and retained definition. Exact hashes/closure are resealed and validated through
  `templateCodec` and `validateNativeReusableDefinitions` before adoption. The source value
  deliberately includes nested foreign fields to prove full metadata preservation.
- Unit checks cover adoption/reference advance, supported stroke update, no vector change
  row, full native JSON roundtrip, validation, unchanged input and authority selective Undo.
- New browser checks use headless adoption through the public API, then normal app native
  import, immutable save, reload, draft/version comparison and native export. They cover
  both domains and both incoming changes on desktop/mobile; vector metadata never becomes
  a rendered Design path. These do not claim the ordinary Library update UI was exercised.
- At bd32ef18: PASS full units **1,339 passed / 9 skipped** in 151 files, root lint,
  typecheck via production build, both builds, file guard and tooling25/25. Optional
  Spatial WASM skips are four canvas-query and five spatial-index cases, still unverified.
- At 540caddd: PASS complete production Chromium suite **29/29**, workers1/retries0,
  including all eight desktop/mobile foreign-domain definition change/delete save/reload
  cases. The isolated comparison also passes; representative desktop/mobile screenshots
  were inspected. The source-level restriction and all unit-test files are byte-identical
  to the fully tested bd32ef18; only comparison setup changed afterward.
- Related focused69/69, root lint/typecheck were repeated at a8ab1cb0; the final comparison
  spec passes focused lint at 540caddd. Full units/build/tooling remain attributed to
  bd32ef18 and are not relabeled as executions at subsequent test-only/docs commits.
- Final-source local public export/residual check PASS at 540caddd: 886 files plus manifest;
  SHA256 `8b752757e8303e89f06b1b1c7922fc9c010e2586450b0dfa67eb247038f8ef0a`.
  The documentation-only export is checked separately, without unit/browser rerun claims.
- Local committed-source public snapshot manifest/residual check PASS at bd32ef18:
  886 files plus manifest; SHA256 `418c1f0f9e80bfd084611b50ef57a68dc9f7b855d51038b987f61f416ff03dda`.
  This was local export validation, not exported-snapshot execution or publication.

### Failure history and boundaries

The first fixture tried to insert a new Slide/Whiteboard object containing vector metadata;
existing native command field allowlists correctly rejected it (`Invalid inserted domain
fields`). That was a fixture setup error, not the adoption reproduction. The corrected
fixture constructs a validated imported linked state without changing runtime admission.
Both initial and corrected logs remain outside Git.

First complete browser run at bd32ef18: **28 PASS / 1 FAIL**, including all eight new
Slide/Whiteboard save/reload cases passing. The unchanged Design comparison case timed
out waiting for History and compare: the matched button detached, and the final page was
Home. Initial asynchronous storage loading racing immediate programmatic import is a
source-supported explanation, not proven browser root cause. Runtime startup/import
behavior is not corrected or certified here.

The comparison fixture now opens Library, waits for the existing New artifact control to
be enabled (it reflects initial storage readiness), imports the record and waits for the
expected Artifact name before opening Compare. No comparison assertion or timeout was
weakened. Two setup attempts failed because the awaited control was hidden, then because
its accessible name includes the full-width `＋` prefix. These are harness errors, retained
separately: a8ab1cb0 complete run 28 PASS / 1 FAIL, c9119068 isolated case FAIL. Final
540caddd uses `/New artifact$/`; isolated comparison PASS. Whole-suite rerun is recorded
separately after completion, and does not erase any previous failure.

Raw evidence is retained under `/workspace/design-only-vector-evidence` and
`/tmp/design-only-vector-*.log`; browser outputs are copied there before subsequent runs.
The nine optional Spatial WASM unit skips remain unverified; no pass is inferred.
Full app-wide browser regression, other engines, physical devices, and fresh public-snapshot
execution are NOT RUN. This work does not validate #259. CI remains stopped; no dispatch,
performance measurement/tuning, license change, merge, deployment or publication. The draft
requires user confirmation before merge/publication.
