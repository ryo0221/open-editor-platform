# Issue #85：業務 ID の引用（AR3）の検証

日付：2026-11-24。[設計](../../analysis-references-design.md) の段階表 AR3 に並べた条件を、どの試験で確かめたかの記録。
AR1（#87）・AR2（#88）で入った試験も、AR3 の条件に当たるものは下の表に挙げる。

## source と環境

ベース：main `90ffea1`（#88）。実装と試験の source：`d13ae3011e8734020f4cfcc824e95bc3e40f305e`。
それ以後の commit はこの記録と設計書の状態の行だけ。
Linux、Node 22.23.5、TypeScript 5.9.2、Playwright 1.63.0、Chromium（同梱）。
e2e は既定の suite（開発サーバ）の desktop と mobile で実行した（`graph.production` には両方の spec を入れてある）。

## 条件ごとの根拠

| AR3 の条件                                               | 根拠                                                                                                                                                                                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 引用・解除の Undo/Redo                                   | `packages/artifact-references/src/items.test.ts`（解除の Undo で選択が戻る、後の選択の Undo で前の選択に戻る ほか）、e2e `item-references.spec.ts` の AR2 の一つ目（選ぶ・外す・Undo/Redo）、mobile は `item-references-mobile.spec.ts`（外してキーの Undo） |
| 選んだ後に引用先が変わり表示が更新されても選んだ版のまま | `apps/playground/src/app/item-reference-host.test.ts`「AR3 選んだ後、保存の前に…」（AR3 で追加）                                                                                                                                                             |
| 証跡の Undo/Redo                                         | `items.test.ts` の ledger の試験、e2e AR2 の一つ目（外して Undo で戻した引用も証跡を保存へ運ぶ）                                                                                                                                                             |
| 消費済みの再送・期限切れ                                 | `item-reference-host.test.ts`「消費済み・期限切れ・食い違う証跡は使わず…」                                                                                                                                                                                   |
| 別の画面での保存・再読み込み                             | `item-reference-host.test.ts`「AR3 別の編集の場…」（新しい ledger は証跡を持たない。AR3 で追加）                                                                                                                                                             |
| 手入力・取り込みは証跡なし                               | `items.test.ts`「a citation removed by any edit and typed back carries no choice」、`structured-data/src/items.test.ts`「CSV import makes no items」                                                                                                         |
| 保存と再読込                                             | e2e「AR3 保存と再読み込みで引用が残り…」（再読み込みの後も引用と状態が出る。AR3 で追加）、版の書き込み失敗からのやり直しは AR2 の一つ目                                                                                                                      |
| native JSON                                              | `import-artifact.test.ts`「AR3 keeps item declarations and row references through native JSON export and import」（AR3 で追加）                                                                                                                              |
| CSV                                                      | `structured-data/src/items.test.ts` の CSV の三つの試験                                                                                                                                                                                                      |
| FM の食い違いの診断                                      | `fmea-templates.test.ts`「diagnoses an FM whose rows disagree…」                                                                                                                                                                                             |
| 権限なし・欠落・重複・古い・残した・確かめられないの表示 | e2e「AR3 保存と再読み込みで…」：`kept`・`forbidden`・`offline` は Playground の状態の差し替え（下）で、重複・見つからないは実際の保存で出し、どれも値を変えないことを確かめる。古いは AR2 の一つ目。権限のない・届かない引用先を開くと理由を出す             |
| Host なしの編集                                          | `structured-data/src/items.test.ts`「AR3 keeps declarations and row references through edits made without a Host」（セルの編集・並べ替え・ほかの行の削除で宣言と行の参照が残る）                                                                             |
| `items@1-draft` を読めない Host                          | `extension-runtime/src/items-v1.test.ts`「hands a declaration only to a Host that reads its version…」                                                                                                                                                       |
| 古い版での schema 3 の拒否                               | Graph：`shape.test.ts`「…refuses newer schemas」。Data：`structured-data/src/items.test.ts`「AR3 refuses a newer schema…」（schema 4 を読まない。AR3 で追加）                                                                                                |
| 旧い Profile の成果物                                    | `analysis-graph-templates.test.ts`「keeps diagrams of the older Profiles as they are…」「moves an older diagram … only by the explicit command…」                                                                                                            |
| desktop／mobile                                          | e2e desktop 3 件、mobile 1 件（横にはみ出さないことと画面写真を確かめた）                                                                                                                                                                                    |

## Playground の状態の差し替え

Playground の架空の Host は、同じ Library の保存版からは `kept`・`forbidden`・`offline` を作れない。
`sessionStorage` の `ep-item-ref-states`（業務 ID ごとの `ItemRefState` の JSON）があると、その ID の状態として返す。
表示の確かめのためだけのもので、本物の Host（PaoBub）はこれを使わない。

## 実行結果

- vitest：`packages/structured-data/src/items.test.ts`・`apps/playground/src/app/item-reference-host.test.ts`・`apps/playground/src/app/import-artifact.test.ts` の 37 件が通った。
- `tsc --noEmit`、`eslint`（変えたファイル）、`prettier --check`、`check:files`、`test:tooling`（212 件）が通った。
- e2e：`item-references.spec.ts`（desktop 3 件）と `item-references-mobile.spec.ts`（mobile 1 件）が通った。
- 全体の vitest と全 e2e は流していない（自動の Actions は止めてある）。

## 見つけたことと範囲の外

- 携帯の幅の Data には Undo のボタンが無く、キー（Ctrl+Z）だけで戻せる。引用に限らない既存の形なので、この段階では変えない。
- 行の参照の欄の見出しは欄の名前（`refs.causeCandidates`）のまま出る。表示名は Profile の宣言で与えるもので、引用の検証の範囲の外。
