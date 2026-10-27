# 計算・分析ノートの設計

**設計 v0.1 / 2026-10-25。実装状況・検証は[利用ガイド](guide.md)と[記録](../verification/analysis-notebook/README.md)を参照。機能受け入れは未完了。**
`kind: analysis`、純粋な`@editor-platform/analysis-core`とReactの`@editor-platform/analysis`を提案する。
domain担当はmodel・演算・差分、Surface担当は編集と表示、Host担当は保存・アクセス・実行接続を受け持つ。
[共通設計](../calculation/design.md)と[検証計画](verification-plan.md)を合わせてレビューする。

## 目的と既存Dataとの違い

分析担当者が「保存した売上データを商品別に集計し、単価変更の案を比較し、結論と計算根拠を残す」ためのEditor。
DataのGrid/Chartは同じレコードのviewとしてそのまま使う。Analysisは複数の保存版、処理順序、parameter、
実行結果、説明を一つの編集可能な計算書として持つ。入力Dataと結果Dataを二重編集するためのEditorではない。

代表操作は、(1)保存Dataを選びfilter→derive→aggregateして説明を添える、
(2)数量や係数のシナリオを2つ比較する、(3)入力の新版で再計算して差分を見て採用する、の3つ。
拒否例は、多対多joinの意図しない行増殖、削除された列を参照する式、計算中の編集後に届いた古い結果。
Python/Jupyter互換、SQL接続、ML学習、時系列予測、任意plugin演算、承認workflowは初期対象外。

## 能力matrix

| 能力                            | 宣言する段階・範囲                              | 状態 / 拒否方法                                               | 条件              |
| ------------------------------- | ----------------------------------------------- | ------------------------------------------------------------- | ----------------- |
| Local編集・Viewer               | A1：説明、Data入力、parameter、演算、結果の閲覧 | 実装予定                                                      | N01–N14           |
| Text / IME                      | A1：title、plain-text説明、式入力buffer         | 実装予定。rich textやHTMLは非対応                             | C01               |
| 選択・注釈                      | A1：step/parameter/resultのelement ID選択       | 選択は実装予定。永続注釈・cell regionは非対応で入口を出さない | N08、C02はN/A     |
| Headless / proposal             | A1：同じ操作data、prepare/preview/apply/reject  | 実装予定。任意コードや未宣言演算は拒否                        | C03               |
| Shared                          | 初期はlocal-only                                | 非対応。codec/admissionで拒否、local fallbackなし             | C04・S01–S06はN/A |
| Template / linked reuse / token | 初期は空のノートと固定fixtureのみ               | 非対応。catalog/authoring入口を登録しない                     | C05/C06はN/A      |
| Native JSON                     | A1：全run・閉包・retained versions              | 実装予定                                                      | N10、C09          |
| CSV・Dataコピー                 | A1：選択結果の静的表                            | 実装予定。recipeや精度を失う出力は明示/拒否                   | C07               |
| 表・chartの参照                 | A3：保存した検証済み結果を4 destinationへ       | 実装予定。未検証/古いbasisを現行結果として出力しない          | C07               |
| React TSX / Office / ipynb      | 初期対象外                                      | 非対応としてformat選択・APIで拒否                             | C08はN/A          |
| Offline / 復旧                  | A1：保持した入力からローカル再計算              | 実装予定。未保持入力・失効・超過を拒否                        | C09               |
| Browser / mobile                | A1：desktop編集、390pxで条件編集・実行・閲覧    | 実装予定。実機・他engineの保証は個別検証                      | N11、C10          |

## Native modelとidentity

以下は概念schema。実装時は未知propertyを含む入力を`unknown`から検証し、型assertionだけで受理しない。

```text
AnalysisDocument(schemaVersion=1)
  title, blocks[{id, kind: note|step|result, text? or targetId}]
  inputs[{id, name, sourcePin, selectedColumnIds, snapshotKey}]
  parameters[{id, label, type, unit?, defaultValue}]
  steps[{id, op, inputIds, configuration, outputFields[{id,type,unit?}]}]
  scenarios[{id, name, parameterValues}]
  outputs[{id, stepId, columns, presentation: table|chart, chartConfig?}]
  runs[{id, basisHash, basis, results, resultHash}]
  retainedSources[{key, pin, nativeContent, dependencies}]
```

`basis`は実行時のinput pins/selected fields、steps、parameter値、scenario ID、engine版・丸め規則を保持する。
inputのsnapshotを更新しても古いrunはその時のbasisと閉包を参照する。成功runは追加か明示削除のみ。
実行時刻・duration・Host job IDはprivateな実行記録に置き、計算content/hashに混ぜない。
同じbasisの結果は決定的だが、run IDは計算式のhashとは別の安定IDとして採用時に発行する。

- input/step/output/parameter/scenario/blockは独立した安定ID。名前や表示順を参照identityに使わない。
- select/filter/deriveの結果rowは元row IDを引き継ぐ。joinは左右row IDのtuple、aggregateはgroup keyの
  型付きcanonical tupleから決定的IDを作り、hash衝突時は拒否する。row indexによる対応はしない。
- 説明blockはplain textで、最大16 KiB。表示順と演算DAGの順序は独立。並べ替えても計算は変わらない。
- 空ノートは有効。参照されるstep/parameterの削除は、その参照を同じtransactionで修正しない限り拒否する。
- panel、選択、実行状態、開いているrun、スクロールはprivate。保存する表/Chart設定はoutputsに置く。
- 旧schemaはまだ存在しない。未知schemaは拒否。Artifact envelopeのschemaとdomainのschemaを混同しない。

## 表演算の初期subset

| 演算            | 初期の意味                                                        | 失敗・曖昧性の扱い                                                                   |
| --------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| select / rename | sourceの安定column IDから結果field IDを作る。renameは表示名のみ   | 存在しないcolumnは拒否                                                               |
| filter          | 型付き比較・and/or。nullの比較はunknown、filterでは除外件数を表示 | 文字列の数値/dateへの暗黙変換なし                                                    |
| derive          | scalar AST。数量×単価、ratio、条件分岐など                        | 未知parameter、型・単位違い、ゼロ除算はセルとstepを示す                              |
| aggregate       | groupBy、countRows、countNonNull、sum、min、max、mean             | nullは別group。sum等は有効値だけで計算し件数を併記。全nullはnull。meanは丸め設定必須 |
| sort            | 型別の昇降順、nullは末尾、同値は安定row ID順                      | locale依存collationは使わず、文字列はUnicode scalar順                                |
| join（A2）      | 明示keyのinner/left equijoin。1:1またはmany:1                     | 右側重複keyを拒否。null同士を結合しない。未結合件数を表示                            |
| scenario（A2）  | 同じDAG・同じsource pinsにparameter overrideを適用                | 未知/不足parameterを拒否。成功と失敗のscenarioを混ぜて優劣を断定しない               |

nullと0、空文字と欠落は区別する。必須列の欠落や演算errorがあればrun全体を失敗にし、
一部の成功行だけを完全な結果として保存しない。エラー行を除くにはfilter/cast方針をrecipeで明示する。
結合・集計の基底は選んだ保存版の全rowsであり、privateな検索・hidden列を計算条件にしない。
保存viewを入力にしたい場合はそのfilter/sort設定を明示的なstepとして取り込み、取り込んだ版を保持する。

型はtext、boolean、ISO date、decimal（unitを任意指定）。dateは暦日比較のみで、time zone付き時刻演算は後続。
Dataのrelation/selectは選択したprimitive値への明示mappingが必要。初期Data formula列は共通設計のとおり拒否。
joinはcross join、many:many、fuzzy、近傍結合を提供しない。外部URL・SQL文字列からデータを取らない。

## 実行・比較・更新

「実行」は入力bufferを確定し、DAG・型・上限を検査してWorkerへimmutable basisを送る。
結果の採用は`acceptRun`一回で、1 Undoで取り消せる。runを見るだけでは編集履歴を作らない。
現在結果と過去結果の比較は同じoutput ID、field ID、結果row identityで対応させ、追加/削除/値変更を示す。
group keyやjoin keyを変えた場合は再編成として表示し、行が似ているだけで差額を対応付けない。

sourceの新版は変更列・行数・型・欠落IDを検査し、新しいpinsと新しいrunを一緒に採用する。
型変更や列削除は明示mappingを要求する。以前の結果は過去runとして残す。新版を採用せず古い入力で
再計算することも有効であり、「最新の入力」とは表示しない。

| 操作案                       | read依存 / 原子単位                                | 拒否・Cancel                           |
| ---------------------------- | -------------------------------------------------- | -------------------------------------- |
| `setParameter`, `editStep`   | 対象IDと依存するDAG。1入力確定で1編集              | 型違い、参照切れ、readOnly             |
| `insertSteps`, `removeSteps` | 複数stepと接続を1transaction                       | cycle、上限、参照される削除            |
| `acceptRun`                  | target revision、basis、全source access            | 古い結果、取消、重複異内容             |
| `adoptInputVersion`          | old pinsとnew pins、mapping、検証済みcandidate run | source変更、欠落、未検証、stale target |
| `restoreVersion`             | 既存Artifact versionを現draftへ適用                | 保存前入力や権限をguard。旧version不変 |

式の編集中は文字bufferでUndoし、確定した式変更はSessionのUndoへ送る。IME中のEnterは実行に使わない。
非表示/切替/保存前もEditorInputsをflushし、composing中は保存・実行・出力を拒否する。
proposalの差分は入力版、parameterの前後値・単位、stepの追加削除、結果件数と集計値を返す。
AIのsummaryを検証結果として使わず、同じ操作dataから作ったpreviewだけを表示する。

## SurfaceとHost

デスクトップはノート本文と右側の入力/条件panel。stepカードには「入力→処理→結果件数」とerror位置を表示する。
実行結果には入力版、条件名、現在/過去/未検証、null/未結合件数を表示し、使用したDataのrowへ移動できる。
390pxでは一列にしてpanelをdrawerにする。DAGの細かなdragに依存せず、順序ボタンと選択式の接続を用意する。
keyboardで条件編集・実行・結果選択・Escapeで復帰できる。CanvasだけのUIにしない。

提案する公開入口は`analysis-core`（型、validator、evaluate、command、diff）、`analysis`（SurfaceとCSS）、
`analysis/sources`（Data adapter）、`analysis/references`（A3の描画adapter）。headless入口はReact/DOMをimportしない。
Hostはsession、storage、canEdit/canRead/canExport、保存版取得、Worker factory、source navigationを渡す。
token・接続文字列・network client・ユーザーのPython実行環境はcontentへ入れない。

参照Hostには`apps/playground/src/model.ts`、`apps/playground/src/App.tsx`と`app/import-artifact.ts`、
`apps/artifact-host/src/model.ts`のkind/content/validator/format routingを追加する。
独立Hostは新しい`analysis-host.html` entryを既存Vite設定へ追加し、packageのCSSとpublic APIだけで構成する。
実装時に実際の公開exportsと各routing箇所を再確認する。全domain unionに無条件追加しない。

## 保存・出力・上限

初期上限はinputs 8、steps 64、parameters 64、scenarios 20、outputs 16、成功runs 5、blocks 128。
1入力と1結果は10,000行×50列以内、全入力/全出力それぞれ200,000セル以内。
domain content全体（保持sourcesとrunsを含む）は2 MiB。`editor-host`のnative envelope 16 MiB制限も維持する。
このため行数以内でもbytes上限で拒否する。run削除は利用者が選び、容量確保のため無断削除しない。
全retained versionの検証・保存失敗・遅延保存・retryは既存Host契約に従う。

native JSONはrecipe・入力・過去結果を保持する。CSVは選択resultの全行をRFC 4180で出し、式に見える
文字列は無害化する。単位、null、decimalの表記と静的出力であることをmanifestに記録する。
Dataコピーは独立Artifact作成で、既存`putIfAbsent`を使うHostに限る。同request ID・異内容はconflict。
再出力は元Dataを黙って上書きせず、新規作成か明示した更新提案にする。
A3の直接参照は保存版に検証済みrunがある場合だけ。basisが違う過去runはユーザーが指定した履歴表示に限る。

## 実装段階とレビュー判断

| 段階 | 変更対象案                                                     | 完了の意味                                                          |
| ---- | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| A0   | `calculation-core`、`analysis-core`のmodel/validator/evaluator | decimal、DAG、source closure、determinism、異常入力をfixtureで検証  |
| A1   | `analysis`、独立/通常Host、save/native/CSV/Dataコピー          | 単一Dataの分析をUIとheadlessで完走。検証計画AN01–AN12               |
| A2   | join/scenario/update comparison                                | 複数入力、null・多対一検査、source版更新。AN13–AN16                 |
| A3   | 参照adapter、semantic diff、説明資料の通常導線                 | 保存結果→Document/Slide/Design/Whiteboard、captureと権限。AN17–AN19 |

推奨判断は「独立domain」「宣言演算のみ」「厳密decimal」「A1は単一入力」「結果を不変記録として保持」。
join、多対多、汎用コード、共有編集、rich textを同時に実装しない。将来Python/SQLを入れる場合は
Host capability・隔離・入出力manifestを別設計し、今のoperationを任意実行に置換しない。
計算式subset/上限を変更する時はAN02/AN03/AN13と共通数値fixtureを再レビューする。
engine版の互換readerを初期から増やさず、将来の旧runは明示的に再計算し、古い値を上書きしない。

### デモ後の操作改善

型付き式・比較表・入力復旧・結合診断のUI追加は
デモ課題の改善を参照してください。保存形式と演算の意味は維持し、
診断・検索・ページ切替は保存されないview stateとして扱います。
