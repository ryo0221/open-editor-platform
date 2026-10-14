# #255–#257 検証記録

PR #258 の初回5指摘への修正と再検証は [review-258.md](review-258.md)、
続く5指摘は [additional-review-258.md](additional-review-258.md) に記録する。
次の3指摘は [serialization-review-258.md](serialization-review-258.md) に記録する。
さらに4指摘は [input-xml-review-258.md](input-xml-review-258.md) に記録する。
今回の3指摘は [typography-layout-review-258.md](typography-layout-review-258.md) に記録する。
以下の初回検証結果はそのまま保持する。

2026-10-14。Design の既存モデル・公開 API への追加。
設計は [Design text and graphics](../../design-reuse-graphics.md)。main base は
`efb6bd8`、対象はこの報告と同じ変更セット。既存の performance 保留は解除しない。

## 対象・環境

- #255: 明示設定で 10/11/12/15px の登録・linked 挿入、公開の文字収まり計算。
- #256: native shape の path geometry/provenance、fill/stroke token、dark mode、SVG/PNG。
- #257: Noto Sans CJK JP の既定と、明示した要素/文字範囲の書体の優先。
- Linux 6.18.44 / Debian 13、Node 20.20.2、npm 10.8.2。
- Chromium 151.0.7922.173。desktop 1440×900、mobile 390×844、既存回帰は 768px も含む。
- Platform の固定 Noto CJK JP/Mono 2.004、四つのフォント SHA-256 検査を実施。
- 独立 Host は public packages と package CSS のみ。通常 Playground は dev と production preview。
  独立 Host は production モードの esbuild bundle、通常 Host は Vite production build も検証。

## 実行結果

以下のコマンドを repository root で、Node 20.20.2 の PATH を選択して実行した。
ブラウザ・Office 子プロセスは実行環境のネットワーク権限を付与した sandbox で実行。
ネットワークポリシーや検査の上限は変更していない。

| Command / scope                                                                                                                                                                                                                                                                                             | 結果                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `npm run check:files`                                                                                                                                                                                                                                                                                       | PASS。生成 evidence を Git に追加していない            |
| `npm run test:tooling`                                                                                                                                                                                                                                                                                      | PASS。25 tests                                         |
| `npm run lint` / `npm run typecheck`                                                                                                                                                                                                                                                                        | PASS                                                   |
| `npm test`                                                                                                                                                                                                                                                                                                  | PASS。138 files、1,211 passed、9 skipped / 1,220 total |
| `npm run build`                                                                                                                                                                                                                                                                                             | PASS。通常 Host / registered React preview の両 build  |
| `npm run test:e2e -- tests/e2e/design-reuse-graphics.spec.ts tests/e2e/design-reuse-graphics-mobile.spec.ts tests/e2e/issue2-embedding.spec.ts tests/e2e/issue2-mobile.spec.ts tests/e2e/reuse-style.spec.ts tests/e2e/reuse-style-mobile.spec.ts --output=/tmp/design-reuse-browser-final --reporter=list` | PASS。10 cases                                         |
| `npm run test:e2e -- --config=playwright.design-reuse.production.config.ts`                                                                                                                                                                                                                                 | PASS。3 cases                                          |

既存の 9 skipped は PASS に含めない。全 Playwright suite を実行したとは主張しない。

## 条件別の判定

| 条件                                               | 判定・証拠                                                                                                                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N01/N02/N12: native/domain/input                   | PASS。path 引数群、arc flags、finite 値、文字数/本数、出どころ必須欄、markup 拒否。`vector.test.ts`                                                                                   |
| N03/N10: 旧定義・保存                              | PASS。旧 template bytes/hash、retained closures、確定版は不変。native JSON roundtrip、通常 Host 保存/reload。`design-reuse-graphics.test.ts` / `vector.test.ts` / browser             |
| N04/N05: pure/atomic/history                       | PASS。入力不変、長い入力の拒否で空の destination が不変、instance のみを expand。通常 Host/独立 Host の Undo/Redo                                                                     |
| N06/N07/N08/N11: Surface/Host                      | PASS（対象範囲）。public Host、通常 Design、安定 layer ID で色変更、390px の mode/export、既存埋込み/各 Surface 回帰。screenshot を目視確認                                           |
| N09: read-only/authority                           | PASS（対象範囲）。独立 Host の disabled mode、readonly shortcut の無変更、trusted authority の readonly/malformed 拒否                                                                |
| N13/N14: 回帰・文書                                | PASS。上記 checks、README/status/公開 snapshot 文書の同期、再現コマンドと API 契約                                                                                                    |
| C05/C06: template/reuse                            | PASS。10〜15px、default 16px 維持、他 domain の 10px 拒否。差し替えた文字の fixed/expand 検査。登録→linked 挿入→dark により icon/文字/地の色が変わり、retained definition hash が不変 |
| C07: SVG/PNG                                       | PASS。SVG の色/provenance、実ブラウザ PNG の icon 部分の RGB pixel。51/102/153 → 255/153/51 を検出。明示書体と fallback の unit assertions                                            |
| C04/S01/S02/S04: shared field                      | PASS（unit 範囲）。vector の serializable transaction、readonly/不正 geometry の拒否、A geometry → B paint → A selective Undo/Redo で B の色が残る。`design-vector.test.ts`           |
| C04/S03/S05/S06: 新 vector の shared browser/fault | NOT RUN。追加 vector 固有の複数 context/再接続 browser は実施していない。既存 shared 実装の全面再受け入れを宣言しない                                                                 |
| C08: semantic React vector output                  | N/A。今回の追加能力ではない。矩形へ黙って変換せず `visual-unsupported`。明示の registered React への置換は native validator を通る                                                    |
| C01/C02                                            | N/A（追加能力）。新しい text engine/IME や annotation semantics を追加していない                                                                                                      |
| C09/C10/performance                                | NOT RUN。追加測定/実機/native IME/他 browser/外部 SVG reader は未実施。既存停止・保留を維持                                                                                           |

## 初回失敗と修正

- 初回 full unit は Node 24 / 制限 sandbox で実行し、Office image decoder 等の失敗と
  二つの Design template 回帰があった。旧 template の component-local geometry を
  展開時に変更しないよう、effective instance text の検査を新定義の opt-in 欄へ分けた。
  slash を含む旧 native part ID も従来どおり読める。Office の失敗は Node 20 と子プロセスを
  使用できる実行条件で解消した。Node と sandbox のどちらが原因かは分離していない。
- 初回ブラウザは通常 Host の React console error を検出した。SVG data 属性を
  camelCase にしていた共通 renderer を修正し、data/aria 属性を保持した。
  エラー検査を無効化せず、最終 dev 10 / production 3 cases は console error なし。
- 中間 unit の明示 React mapping 検査で native shape 専用の vector が残る問題を検出した。
  明示置換ではこれを除去し、元の Design input は保持する。最終 full unit は全対象 PASS。

初回失敗を最終結果へ置き換えず記録する。raw logs はこの作業環境の
`/tmp/design-reuse-full-unit.log`、`/tmp/design-reuse-full-unit-node20.log`、
`/tmp/design-reuse-browser.log` に保持。最終 logs は `/tmp/design-reuse-unit-final.log`、
`/tmp/design-reuse-browser-final.log`、`/tmp/design-reuse-production.log`。
画像は `/tmp/design-reuse-browser-final` と `/tmp/design-reuse-production-results` に保持。
公開アーカイブは作成していないため、これらの raw evidence はこの環境以外から参照できない。
上記コマンドで再現できる。

## 受け入れる範囲と限界

公開 API による小さい Design 再利用部品、path の色/style/mode、local 編集、native 保存、
SVG/PNG の対象機能は検証済み。新 field の trusted shared transaction は unit 検証済み。
ライセンス付き path を Host が供給し、出どころを artifact と SVG に残す。内蔵 icon catalog、
任意 SVG markup の import、フォント埋込み、製品固有の画面モデルは追加していない。
未実施の shared browser と performance/実機/全 browser を受け入れ済みとはしない。
