# Issue #99：工程定義の Editor の検証

日付：2026-11-28。[設計](../../workflow-definition-editor-design.md) の段階表 WD5 に並べた条件を、どの試験で確かめたかの記録。
段階は WD1（#105）・WD2（#106）・WD3・WD4 で、受け入れ PR で main へ入れる。

## source と環境

ベース：main `edbcb7b`（#104 の設計）。統合 branch：`feat/workflow-definition-editor`。
実装と試験の source は受け入れ PR の head（実行結果の節に commit を書く）。
Linux、Node 22.23.5、npm 10.9.9、Chromium（Playwright 同梱、Chrome for Testing 158）。
e2e は既定の suite（開発サーバ）の desktop と mobile で、変えたところに絞って実行した。全 e2e は流していない（自動の Actions は止めてある）。

## 宣言する範囲

| 能力                                 | 状態                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Viewer / local 編集                  | 対応。流れ・一覧（章立て）・マトリクス・定義の情報・差分。Undo／Redo は Host の一つの履歴              |
| 外部の提案 / headless                | 対応。定義の intent の batch を preview／apply／reject。`./model` は React なしで使える                |
| Native JSON                          | 対応。OWD format 1 の JSON そのもの。読み書きは Host。知らない欄（gates・placements・view など）は保持 |
| マインドマップとの対応               | 対応。枝の `link`（Mind Map の command と提案の操作 `link`）。二つの成果物で Undo は別                 |
| 共同編集・テンプレート・形式別の出力 | 非対応（入口を出さない）                                                                               |
| `gates`・`placements` の編集         | 非対応（保持と表示だけ。ID の変更・削除はそこへの参照も追う）                                          |
| 性能                                 | 測定しない（止めてある）。fixture は公開済みの最大の定義（fiction-manga）まで                          |

## 条件ごとの根拠

| WD5 の条件                                     | 根拠                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #99 の受入：マインドマップから新しい定義を作る | e2e `workflow-definition-acceptance.spec.ts` の一つ目：空の定義を取り込み、枝から工程と成果物を足して link を付け、一覧で埋め、OWD の check（pin した写し）が空になるまで                                                                                                                                                               |
| #99 の受入：既存の定義を直す                   | 同じ spec の二つ目：公開済みの `fiction-manga` を取り込み、壊れた参照を直し、まとまりの追加・所属の変更・削除、規則の追加、ID の変更をして、OWD の check が空のまま                                                                                                                                                                     |
| Section の追加・所属変更・削除                 | 明示の操作：上の e2e と `workflow-definition.spec.ts`。ドラッグ：`graph-adapter.test.ts`「moves a phase into a section…」（`commitWithPresentation` で配置と所属が一つの Undo）と「only moves on a drop for a Host without…」、WD1 の `sidecar-section.test.ts`                                                                         |
| 規則の編集                                     | `model.test.ts`「rules are edited per rule ID」（複数対象の規則を保ち、同じ組の cites を二つ作らない）、e2e のマトリクスからの追加と不正な ID の拒否                                                                                                                                                                                    |
| link の設定・置換・解除                        | `mindmap.test.ts`「links (#99 WD4)」（command と提案の操作、古い提案・不正な入力の拒否）、`workflow-definition/src/model/mindmap.test.ts`、e2e `workflow-definition-mindmap.spec.ts`（枝から足す、ID の変更に追従、消した要素は「対応先が無い」と示して明示に外す、Mind Map の Surface で外す）                                         |
| 失敗時の無変更                                 | `model.test.ts`「refuses an edit that adds a problem and changes nothing」、`graph-adapter.test.ts` の拒否の各試験、e2e で Mind Map が断ったとき定義は足したまま「枝の対応は付いていません」と示す                                                                                                                                      |
| Undo／Redo                                     | e2e で追加・削除（cascade）・章立て・提案の適用を Host の Undo／Redo で戻す。工程・まとまりの ID を変えても手で動かした位置と枠の大きさは新しい ID へ移り、改名と一つの Undo／Redo で戻る（`workflow-definition-layout.spec.ts`、同時に書けない Host でも位置は保つ）。マインドマップの link は Mind Map の Undo で別に戻り、定義は残る |
| readOnly                                       | `graph-adapter.test.ts`「refuses every edit of a read-only definition」、`view.test.ts`「has no edit controls when read only」、e2e（追加の form・削除・Undo・提案の適用が止まる）                                                                                                                                                      |
| 古い提案の拒否                                 | `model.test.ts`「refuses a read-only definition and a changed base」、e2e で同じ提案を二度目に出すと「適用できません」で適用できない。Mind Map の `link` の提案は `before` の指紋で断る                                                                                                                                                 |
| 壊れた参照・重複した ID                        | `model.test.ts`「keeps an existing broken reference…」「repairs one of several broken references…」「renames an element that already has a problem」、`graph-adapter.test.ts`「still projects a definition with duplicate IDs…」「…duplicated acceptance…」                                                                             |
| 循環した下書き                                 | `model.test.ts`「allows a cyclic draft…」「reports every phase of overlapping cycles」、`graph-adapter.test.ts`「allows a cycle…」「still projects a phase that comes after itself」                                                                                                                                                    |
| `check` の無い Host                            | `model.test.ts`「says when the Host has no check」、`view.test.ts`、e2e（OWD check を外すと診断が「検査しない」の 1 件）                                                                                                                                                                                                                |
| gates・placements・view の保持と参照           | `model.test.ts`「keeps fields of a later format…」「renames and deletes through gates and placements too」「follows item kinds named by deliverable views…」                                                                                                                                                                            |
| desktop／mobile                                | e2e desktop 8 件、mobile 1 件（流れ・一覧・マトリクス・マインドマップで横にはみ出さないことと画面写真を確かめた）                                                                                                                                                                                                                       |

## 実行結果

試験した source：`65e49ae`（WD2 の `fb1077b` の上に WD3・WD4・WD5）。この後の commit はこの節だけ。

| 実行                                                                                                | 結果                                                                                                                                             |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| vitest：workflow-definition・structured-graph・mindmap-core・mindmap・collaboration-office・scripts | 54 files・601 件が通った                                                                                                                         |
| `tsc --noEmit`、`eslint`（変えたファイル）、`prettier`、`check:files`、`check:areas`                | 通った                                                                                                                                           |
| `vite build`（Playground と `/workflow-definition-host.html`）                                      | 通った                                                                                                                                           |
| e2e：`workflow-definition*.spec.ts`（desktop 8・mobile 1）                                          | 9 件が通った                                                                                                                                     |
| e2e 回帰：`structured-graph*.spec.ts`・`mindmap*.spec.ts`（desktop・mobile）                        | 97 件が通り 1 件が落ちた。落ちたのは `structured-graph.spec.ts:100`（「Open collaboratively」の数）で、main `edbcb7b` でも同じく落ちる既存の失敗 |
| 全体の vitest と全 e2e                                                                              | NOT RUN（自動の Actions は止めてあり、クラウドでは変えたところに絞る）                                                                           |

## 見つけたことと範囲の外

- Codex の指摘（#106 で 3 回、13 件）は、ID の変更が gates・placements・view を追うこと、既存の問題を位置や ID の変更で見失わないこと、読める下書き（自分への前後関係・自分を使う成果物・重複した ID）を流れで開けることにまとまる。どれも試験を足して直した。
- 差分の表は ID の変更を「削除」と「追加」の組で出す。版の比較は ID で照らすので、そのままにした。
- Host の設定（OWD check・配置の保存の方法）を切り替えると Surface を作り直すので、表示中のタブが流れに戻る。参照 Host だけのこと。
- U4（check の結果を構造化して返す）は OWD 側の issue で扱う予定で、ここでは文の先頭の語と ID・JSON Pointer で対応付けている。
