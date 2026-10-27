# 計算・分析ノートの実装・検証計画

**計画 v0.1。実装後の結果は[検証記録](../verification/analysis-notebook/README.md)で条件ごとに管理します。** [設計](design.md)を受け入れるための予定であり、
現在のDataや未作成のpackageが合格した記録ではない。[共通数値・取得契約](../calculation/design.md)も対象。

## 固定するfixture

全て架空データとし、version/row/column IDを固定する。元snapshot、recipe、期待結果は小さなJSONとしてGitに置く。
実行ログ・画像・CSV/native export等の生成物はGit外に保持する。

| Fixture | 内容                                                        | 期待値・観測点                                                       |
| ------- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| AF1     | `a: qty=2, price=10`、`b: qty=3, price=20`。係数parameter=1 | 売上行20/60、合計80。係数1.1で22/66、合計88、差額8                   |
| AF2     | decimal text `0.1`, `0.2`、m/mm、null、空文字、不正数値     | 正確な0.3、1000mm=1m、nullと0を区別。不正castでrun失敗               |
| AF3     | leftに同key2行、rightにkey1行→2行へ変更                     | many:1は2行。right重複は事前拒否し4行を保存しない                    |
| AF4     | old/new Data版で同じcolumn IDのrename、ID削除、型変更       | renameで式不変。削除/型変更は明示mapping。古いrunの再現性維持        |
| AF5     | 演算cycle、255/256/257 AST node、上限前後、巨大join候補     | 境界が仕様どおり。上限超過・cycleはcontent/history不変               |
| AF6     | fake storage/access/Workerで遅延・重複・失敗・取消          | stale結果不採用。前の成功run維持。同ID異basisはconflict              |
| AF7     | 同一Artifactの2保存版、同hashの別Artifact、改竄version      | 別pinのidentity保持。同version異hashは拒否。現在版へ勝手に置換しない |
| AF8     | 5runsとinput更新、閉包の欠落・改竄・偽resultHash            | 原子的native拒否。未検証結果を現行表や参照出力に使わない             |

## 受け入れscenario

| ID   | 実行する操作                                                   | 成功・失敗で確認するもの                                                                               | 段階  |
| ---- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----- |
| AN01 | 空ノート→AF1入力→derive/aggregate→実行                         | 安定ID、80、basis/source版、無関係なfield不変                                                          | A1    |
| AN02 | AF2で加減乗除、quantize、単位変換、overflow                    | exact値、丸め位置、error code/path。Data evaluatorの結果と混同しない                                   | A0    |
| AN03 | AF5、unknown schema/op/property、accessor/非JSONをimport/APIへ | validatorで拒否、draftと全version/hash、library不変                                                    | A0/A1 |
| AN04 | step追加・複製・並替・削除、parameter変更、Cancel              | ID remap、参照保持、1操作1Undo、入力非破壊                                                             | A1    |
| AN05 | 実行中に編集/Undo/再実行/close、late/duplicate完了             | revision/basis/generation検査、取消後history不変                                                       | A1    |
| AN06 | 成功run採用→保存→reload→native往復→旧版restore                 | 全basis/閉包/result保持。旧version bytes/hash不変、restoreは新編集                                     | A1    |
| AN07 | storage failure→retry、hash待機中の編集、2重creation           | dirty継続、古い保存で新draftを上書きしない、atomic creation                                            | A1    |
| AN08 | readonly/権限失効をUI・paste・headless・proposal・完了境界で   | 全変更拒否。既に表示した派生値も失効時に隠す                                                           | A1    |
| AN09 | AF7、offline、missing、失効、別scopeへ切替                     | fixed pinの再現、許可なきcache利用なし、遅延応答のscope混同なし                                        | A1    |
| AN10 | 独立/通常Host、desktop/390px、native IME、keyboard             | public API/CSSのみ。buffer確定、Escape/focus、実行・保存・scroll、browser errorsなし                   | A1    |
| AN11 | AF1をCSVと新規Dataへ、式風text、null、decimal overflow         | 値・行数・無害化・precision保持、静的copyと明示、元Data不変                                            | A1    |
| AN12 | Imported runを再計算、engine不一致、hashだけ合う偽結果         | unverified表示と出力拒否、再計算照合後だけ採用、原本記録は不変                                         | A1    |
| AN13 | AF3のjoin、null、missing key、出力上限                         | 行増殖を拒否。未結合件数。安定tuple IDと順序                                                           | A2    |
| AN14 | AF1で2scenario比較、一方だけerror、parameter欠落               | 80/88/8、失敗を最安/最高と扱わない。input pinsが同じ                                                   | A2    |
| AN15 | AF4で新版試算→Cancel→mapping修正→採用                          | 旧入力/結果保持、採用は1Undo、列名の推測対応なし                                                       | A2    |
| AN16 | group/join key変更、同値row並替、AF7                           | 同じ基底の差と再編成を区別、row indexへ依存しない                                                      | A2    |
| AN17 | 保存結果を4 destinationに固定/更新連動で挿入                   | 保存成功後だけfollow更新、元のstep変更だけでは確定版を変えない                                         | A3    |
| AN18 | 参照capture中の入力/権限/source更新、上限、旧版出力            | 非同期preflight/冷cache/偽verifiedの拒否、既存resolver検査、snapshot/manifest一致、native全version検査 | A3    |
| AN19 | UI/headlessで同じproposal→preview/apply/reject                 | 差分と結果一致、preview不変、readsとlive revision再検査、1Undo                                         | A1/A3 |

## 既存受け入れ条件との対応

| 条件                | 本計画の証拠                                                        |
| ------------------- | ------------------------------------------------------------------- |
| N01–N03             | domain区分の設計レビュー、AN01/03/06/12                             |
| N04–N05             | AN04/05/15/19、pure command入力のfreeze検査                         |
| N06–N08             | AN10、通常Host作成/登録/選択、AN04/06                               |
| N09–N10             | AN03/06/07/08/09、16 MiB envelope境界                               |
| N11–N12             | AN02/03/08/10/11、text/CSV/JSONの非実行                             |
| N13–N14             | 各実装PRで検証sourceとコマンド、対応matrix・既知制限を更新          |
| C01/C03             | AN10/19。合成IMEとOS native IMEの結果を分ける                       |
| C07/C09             | AN06/09/11/12/17/18、容量超過・閉包破損                             |
| C10                 | 実browser/実機/screen readerの宣言対象に対してAN10。未実施はNOT RUN |
| C02/C04/C05/C06/C08 | 初期非対応のためN/A。通常UI/API/codec/catalogから拒否する負例を確認 |

## 実装PRの分け方と回帰

A0は`calculation-core`・model/validator/commands/evaluator、A1はSurface/独立Host/通常Host/lifecycle、
A2はjoin/scenario/source更新、A3はreference/diff adapterに分ける。既存Dataのformula/CSV/Grid/Chart、
Artifact保存・import・proposal、4 destinationの参照captureを変更に応じて回帰する。
数値演算fixtureは別の正確な整数/有理数の期待値で検証し、同じevaluatorをexpected値の生成に使わない。

実装後は`npm run lint`、`npm run check:files`、`npm run test:tooling`、`npm run typecheck`、
`npm test`、`npm run build`と該当E2Eをローカルで実行する。
新しいE2Eは既存`tests/playwright/suites.ts`に登録し、検出確認後に通常/独立Hostのproduction buildを検証する。
未作成suite名を現在使えるコマンドとして案内しない。console/page errorで失敗し、screenshotは目視確認する。

## 性能計画（測定前の案）

機能上限とは別に、fixtureは100行×10列、1,000行×20列、10,000行×10列、8stepで固定する。
最大fixtureは200,000セル/2 MiB内に実データを収め、収まらなければfixture自体を修正してレビューする。
単一scenarioと20scenarioを別測定し、source取得時間と演算時間、描画時間、保存時間、peak memoryを分ける。
測定環境を実装時に固定し、cold 5回、warmup 3回、warm 20回。median/p95/maxと失敗/取消率を報告する。
失敗sampleを除外して速度だけを合格にしない。

提案budgetは最大fixtureの単一scenario計算p95 2秒以下、取消後の応答p95 200ms以下、
20scenario全体15秒以内、Worker peak memory 128 MiB以下。Workerは単一job、同時scenario実行は1つ、
jobの上限30秒で終了し、未計算を成功にしない。budgetは測定前に合意し、実測に合わせて黙って緩めない。
既存の100ms目標を本domainへ転用しない。追加の性能測定は現行の停止条件を維持し、今回は実施しない。
