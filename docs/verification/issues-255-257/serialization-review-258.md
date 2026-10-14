# PR #258 SVG 追加レビュー修正

2026-10-14。レビュー対象 `9962827` の追加3指摘を修正した。
[初回検証](README.md)、[最初の修正](review-258.md)、
[次の修正](additional-review-258.md) の検証履歴は保持する。

## 指摘と変更

| Review comment                  | 修正と確認範囲                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `4267211898`: clip ID collision | 公開 drawingPrimitives は occurrence ごとの resource ID を使う。exporter は固定連番、Surface は React useId を渡す。native `a-b` と instance `a` / part `b` の同じ drawing address でも clip は別々。投影内部の hierarchy ID も native と分離し、異なる viewBox と祖先 frame の clip / hidden、保存済み ID、既存 drawing address、決定的な export を確認 |
| `4267211909`: SVG whitespace    | path の区切りを space / tab / CR / LF に限定。NBSP / form feed / VT / U+1680 / U+2003 / U+2028 / U+2029 / BOM を先頭・途中・末尾で拒否。validator / constructor / native validation を確認。対応4文字は JSON roundtrip、実 SVG path の getTotalLength、exported XML の parse を確認                                                                      |
| `4267211915`: custom SVG fonts  | Whiteboard Section と connector label、Structured Data chart の wrapper が共通 defaultDrawingFontFamily を使う。bar / line / pie、日本語と XML escaping、明示 node font と source 不変性を確認。通常 Host の Whiteboard / Data の SVG download と decode も確認                                                                                          |

primitive の resource ID は描画結果だけに属し、native content に保存しない。
`drawingPrimitives(drawing, resourceId?)` の未指定呼出しは新しい ID を割り当てるため、
同じ drawing を複数回使っても他の occurrence と clip を共有しない。
文字列の再現性が必要な Host は SVG 文書内で一意な resourceId を渡す。
既存 `drawingSvg` / Whiteboard exporter の出力は固定連番で決定的なまま。

## 最終検証

Linux 6.18.44 / Debian 13、Node 20.20.2 / npm 10.8.2、Chromium 151.0.7922.173。
desktop 1440×900、mobile 390×844、既存 mobile 回帰は 768px を含む。
固定 Noto CJK JP/Mono 四つの SHA-256 検査を維持した。
Node 20.20.2 の PATH を選択し、repository root で以下を実行。
browser / Office / tooling の子プロセスは実行環境の network 権限付き sandbox を使用。

| Command / scope                                                                                                                                                                                                                                                                                                    | 結果                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `npm run lint` / `npm run typecheck`                                                                                                                                                                                                                                                                               | PASS                                                     |
| `npm test`                                                                                                                                                                                                                                                                                                         | PASS。145 files / 1,276 passed / 9 skipped / 1,285 total |
| `npm run build`                                                                                                                                                                                                                                                                                                    | PASS。通常 Vite build / registered React preview build   |
| `npm run check:files` / `npm run test:tooling`                                                                                                                                                                                                                                                                     | PASS。tooling 25 tests                                   |
| `npx vitest run packages/design/src/vector-serialization-review.test.ts packages/whiteboard/src/svg-font-review.test.ts packages/structured-data/src/svg-font-review.test.ts packages/design/src/vector-additional-review.test.ts packages/design/src/render-cache.test.ts packages/slide-export/src/plan.test.ts` | PASS。6 files / 51 tests                                 |
| `npm run test:e2e -- tests/e2e/design-reuse-graphics.spec.ts tests/e2e/design-reuse-graphics-mobile.spec.ts tests/e2e/issue2-canvas.spec.ts tests/e2e/issue2-mobile.spec.ts --output=/tmp/pr258-third-final-browser --reporter=list`                                                                               | PASS。18 cases                                           |
| `npm run test:e2e -- --config=playwright.design-reuse.production.config.ts --output=/tmp/pr258-third-production`                                                                                                                                                                                                   | PASS。14 cases                                           |

headless primitive 回帰の SVG を実ブラウザで decode / rasterize し、144×40px の
赤 1,152画素 / 緑 288画素、各 viewBox の外 0画素、clip ID 2個 / 一意2個を確認した。
独立公開 Host の Surface と mobile でも clip を確認した。
既存 mode / SVG / PNG / Undo / readonly / native保存 / Compare と、通常 canvas / mobile
の回帰を含む。すべて browser console error / uncaught exception を検査し、
desktop / mobile / production の screenshots を目視確認。9 skipped を PASS に含めない。

## 失敗履歴と証拠

修正前の focused 再現は3 files / 17 tests中13 failed / 4 passed。
同じ clip ID、未対応の空白8種類、custom SVG の Arial を再現した。
中間 focused run は49 tests中3 failedで、clip resource API と Whiteboard の修正を
揃えた後に49 passed。祖先の clip / hidden を保つため投影内部の ID 分離と2つの回帰を
追加し、最終 focused は51 passed。途中の全unit 1,274 passed も最終結果に置き換えず
logを保持し、上記1,276 passedを最終 source の結果として記録する。

最初の browser 起動は spec の Whiteboard package root import から CSS を読み込み、
Playwright の spec 解析で失敗したため0 cases実行。公開の pure `/sections` entrypoint
へ変更後、上記18 casesが通過した。検証 runner の失敗を browser PASS に数えない。

初回・中間 logs は `/tmp/pr258-third-repro.log`、`/tmp/pr258-third-focused.log`、
`/tmp/pr258-third-focused-final.log`、`/tmp/pr258-third-unit.log`、
`/tmp/pr258-third-browser.log`。
最終 logs は `/tmp/pr258-third-final-focused.log`、`/tmp/pr258-third-final-unit.log`、
`/tmp/pr258-third-final-lint.log`、`/tmp/pr258-third-final-typecheck.log`、
`/tmp/pr258-third-final-build.log`、`/tmp/pr258-third-final-browser.log`、
`/tmp/pr258-third-production.log`、`/tmp/pr258-third-tooling.log`、
`/tmp/pr258-third-files.log`。screenshots は上記 browser / production の出力先に保持。
raw evidence / build / font / export は Git 外に置き、公開アーカイブは作成していない。
この環境以外では記載 command で再現する。

追加3指摘の対象範囲は修正・検証済み。vector 固有の複数 browser context/fault、
実機/native IME/全 browser/外部 SVG reader は NOT RUN。
performance の追加測定・tuning は行わず、既存の停止・保留を維持する。
