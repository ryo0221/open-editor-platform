# PR #258 追加レビュー修正

2026-10-14。レビュー対象 `7c92b14` に対する追加5指摘を修正した。
[初回検証](README.md) と [最初のレビュー修正](review-258.md) の履歴は保持する。

## 指摘と修正

| Review comment                      | 修正と回帰検証                                                                                                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `4267055427`: vector viewport       | transform 内の userSpaceOnUse clipPath で宣言した viewBox に制限。非ゼロ原点、縦横比の余白、回転・反転、一意な clip ID を確認。座標 1,000,000 までの塗りが SVG/Surface/PNG の枠外へ出ない                                 |
| `4267055437`: style geometry        | appearance は native element / singleton template の vector を優先し、その後正規の override を適用。style の未定義 vector 欄は図形を提供・置換しない。通常 shape、singleton、detach、composite、入れ子、色の継承を確認    |
| `4267055445`: indexed placement     | base shape の x/y を保持し、幅・高さだけを正規化。index 0/1/2/3/5 の配置と小数 viewBox の既存回帰を確認                                                                                                                   |
| `4267055448`: sparse paths          | 全 index に自身の値があることを確認し、空の疎配列、一部の穴、prototype から継承した値を拒否。constructor / isDesign / JSON の扱いと既存サイズ上限を確認                                                                   |
| `4267055453`: clipped expanded text | instance-aware 診断に投影後の祖先 clipBounds を反映。固定 frame は拡張せず、文字が隠れる場合は expand 後も overflow で挿入を拒否。入力差替え、入れ子、回転・反転、下側の空白、旧 textScope 未指定の挙動と定義不変性を確認 |

文字の判定は SVG の決定的な line layout の padding / 縦配置 / 行高さを使う。
横方向は文字枠の全幅を含む保守的な行領域であり、実フォントの字形を計測しない。
必要な文字領域が隠れると、利用側は文字を短くするか固定 frame を明示的に広げる。
既存定義や共有 component の局所座標を暗黙に変更しない。

## 実行結果

Linux 6.18.44 / Debian 13、Node 20.20.2 / npm 10.8.2、Chromium 151.0.7922.173。
desktop 1440×900、mobile 390×844、既存 mobile 回帰は 768px も含む。
固定 Noto CJK JP/Mono 四つの SHA-256 検査を維持した。
以下は Node 20.20.2 の PATH を選択して repository root で実行。
ブラウザ・Office・tooling の子プロセスは実行環境の network 権限付き sandbox を使用。

| Command / scope                                                                                                                                                                                                                                               | 結果                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `npm run lint` / `npm run typecheck`                                                                                                                                                                                                                          | PASS                                                     |
| `npm test`                                                                                                                                                                                                                                                    | PASS。142 files / 1,256 passed / 9 skipped / 1,265 total |
| `npm run build`                                                                                                                                                                                                                                               | PASS。通常 Vite build / registered React preview build   |
| `npm run check:files` / `npm run test:tooling`                                                                                                                                                                                                                | PASS。tooling 25 tests                                   |
| `npx vitest run packages/design/src/vector-additional-review.test.ts packages/templates/src/design-text-fit-review.test.ts packages/design/src/vector-review.test.ts packages/design/src/vector.test.ts packages/templates/src/design-reuse-graphics.test.ts` | PASS。5 files / 65 tests                                 |
| `npm run test:e2e -- tests/e2e/design-reuse-graphics.spec.ts tests/e2e/design-reuse-graphics-mobile.spec.ts tests/e2e/issue2-canvas.spec.ts tests/e2e/issue2-mobile.spec.ts --output=/tmp/pr258-extra-browser --reporter=list`                                | PASS。13 cases                                           |
| `npm run test:e2e -- --config=playwright.design-reuse.production.config.ts --output=/tmp/pr258-extra-production`                                                                                                                                              | PASS。9 cases                                            |

PNG 回帰は実ブラウザで 144×40px の export を読み、非ゼロ viewBox の塗りを確認する。
通常および 90°回転・反転で赤い画素は viewBox 内 288、外 0。
Surface の clip 属性と描画、native 保存/reload、既存の token mode / Undo / readonly、
通常 Compare と foreign vector の境界、canvas / mobile の既存回帰を含む。
browser console error / uncaught exception をすべて検査し、desktop/mobile と production
のスクリーンショットを目視確認した。9 skipped は PASS に含めない。

## 失敗履歴と証拠

修正前の focused 再現は 2 files / 25 tests 中 13 failed / 12 passed。
indexed placement、sparse paths、style geometry、viewport clip、clipped text のすべてを
再現した。最初の修正後は 2 tests が失敗した。新診断で初期サンプルの検証時点に
拒否される fixture だったため、正常な初期サンプルと文字 slot の入力差替えに直し、
登録成功後の expand が拒否される経路を確認した。定義と元 content の不変性も確認。
Playwright の再帰的な native 型を addInitScript 引数へ渡すと TypeScript の型展開上限に
達したため、fixture の初期化引数を JSON 文字列にした。最終型検査は PASS。

再現と中間 logs は `/tmp/pr258-extra-repro.log`、`/tmp/pr258-extra-fix.log`。
最終 logs は `/tmp/pr258-extra-focused.log`、`/tmp/pr258-extra-unit.log`、
`/tmp/pr258-extra-typecheck.log`、`/tmp/pr258-extra-lint.log`、
`/tmp/pr258-extra-build.log`、`/tmp/pr258-extra-browser.log`、
`/tmp/pr258-extra-production.log`、`/tmp/pr258-extra-tooling.log`、
`/tmp/pr258-extra-files.log`。screenshots は上記 browser / production の出力先に保持。
raw evidence、build、font、export を Git に入れず、公開アーカイブは作成していない。
この環境以外では記載コマンドで再現する。

追加5指摘の対象範囲は修正・検証済み。vector 固有の複数 browser context/fault、
実機/native IME/全 browser/外部 SVG reader は NOT RUN。
追加 performance 測定・tuning を行わず、既存の停止・保留を維持する。
