# PR #258 レビュー修正

2026-10-14。レビュー対象は `c32144a`。以下は5件の指摘への追加修正と、この変更セットの
検証結果。初回の [#255–#257 検証](README.md) を置き換えない。

## 指摘と修正

| Review comment                            | 修正・対象検証                                                                                                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `4266814339`: resized instance の文字拡張 | canvas/native instance layout の投影後の寸法で測り、累積 sx/sy に従って高さを局所 override へ戻す。0.5/0.7/0.3/1/1.5/2 の縮尺、回転・反転、入れ子、拡張不要の維持、hug/fill と canvas auto-layout を検証。部品定義は不変 |
| `4266814345`: non-shape vector override   | singleton/root、component part、入れ子の参照先と実効型を検査。継承 vector の type 変更や参照切れも拒否。shape override の detach/native roundtrip と trusted authority の拒否を検証                                      |
| `4266814353`: shared drawing 境界         | Slide/Whiteboard の未定義 vector 欄を投影から除外。Design は検証済み shape vector のみを渡す。{}・不正 path container・完全な foreign vector に対し native validation、描画/export、通常ブラウザでの import を検証       |
| `4266814361`: fractional viewBox          | 原本の小数 viewBox と path は保持し、生成した native bounds を各軸 1px 以上にする。公開 constructor の結果が `isDesign` を通ることを検証                                                                                 |
| `4266814365`: version comparison          | canvas shape と singleton component 定義の比較に source/name/version/license、geometry fingerprint を追加。viewBox/path/provenance の差分、長い path の表示上限、通常 Compare UI を検証                                  |

fingerprint は既存の短い display fingerprint であり、保存の完全性検査の hash ではない。
path 本文を表示することで大きな比較結果を作らない。新しい content schema、製品型、
共有履歴や runtime は追加していない。

## 検証

Linux 6.18.44 / Debian 13、Node 20.20.2 / npm 10.8.2、Chromium 151.0.7922.173。
desktop 1440×900、mobile 390×844、既存 mobile 回帰は 768px も含む。
固定 Noto CJK JP/Mono の四つの SHA-256 検査を維持した。

| Command / scope                                                                                                                                                                                                                 | 結果                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `npm run lint` / `npm run typecheck`                                                                                                                                                                                            | PASS                                                     |
| `npm test`                                                                                                                                                                                                                      | PASS。141 files / 1,241 passed / 9 skipped / 1,250 total |
| `npm run build`                                                                                                                                                                                                                 | PASS。通常 Vite build / registered React preview build   |
| `npm run check:files` / `npm run test:tooling`                                                                                                                                                                                  | PASS。tooling 25 tests                                   |
| `npm run test:e2e -- tests/e2e/design-reuse-graphics.spec.ts tests/e2e/design-reuse-graphics-mobile.spec.ts tests/e2e/issue2-canvas.spec.ts tests/e2e/issue2-mobile.spec.ts --output=/tmp/pr258-review-browser --reporter=list` | PASS。10 cases                                           |
| `npm run test:e2e -- --config=playwright.design-reuse.production.config.ts --output=/tmp/pr258-review-production`                                                                                                               | PASS。6 cases                                            |

pure model/geometry の回帰は `design-text-fit-review.test.ts`、`vector-review.test.ts`、
`vector-domains.test.ts`。既存 `design-vector.test.ts` に trusted refusal を追加した。
N02/N04/N10/N12、C05/C06/C07 と shared S02 の対象範囲を確認した。
ブラウザは通常 Slide/Whiteboard の foreign vector import、Design Compare の前後の
geometry/attribution、既存 color/mode/native保存/Undo、canvas操作、mobile を確認。
すべて browser console error / uncaught exception を検査し、版比較・通常 canvas の
screenshots を目視確認した。9 skipped を PASS に含めない。

## 失敗履歴・証拠

最初の3つの追加 spec は23 cases中22 failed / 1 passed。文字拡張、non-shape override、
小数 constructor、同一に見える比較が失敗した。Slide fixture は必要な index を
渡しておらず、型検査と native validation が失敗したため修正した。最終 domain 回帰は
明示的に有効な Slide/Whiteboard content を生成し、そのまま {} 等の未定義 vector を
保持できることと、描画/export が壊れないことを確認している。

修正後の中間 focused run は9 files / 65 tests PASS。その後 hug/fill/canvas layout、
参照切れ、bounded comparison、trusted refusal を追加し、上記 full unit を実行した。
初回の `/tmp/pr258-review-repro.log` と `/tmp/pr258-review-fix.log` を削除していない。
最終 logs は `/tmp/pr258-review-unit.log`、`/tmp/pr258-review-browser.log`、
`/tmp/pr258-review-production.log`、`/tmp/pr258-review-build.log`。
screenshots は `/tmp/pr258-review-browser` と `/tmp/pr258-review-production`。
生成 evidence は Git 外に保持し、公開アーカイブは作成していない。
この環境以外から raw evidence を参照する場合は、上記 command で再現する。

5件の指摘の対象範囲は修正・検証済み。新 vector 固有の複数 browser context/fault、
実機/native IME/全 browser/外部 SVG reader は NOT RUN。追加 performance 測定を行わず、
既存の停止・保留を維持する。
