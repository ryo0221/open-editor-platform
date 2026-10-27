# 計算・分析ノートの利用とHost接続

`analysis`は保存したData版を入力とする独立したlocal Editorです。Dataのnumber/formulaの意味は変更しません。
Python、SQL、外部DB、共有編集、template/reuse、Office出力、CAD/BIM入力は登録していません。
実装と検証の区別、未実施条件は[検証記録](../verification/analysis-notebook/README.md)を参照してください。

## 通常の操作

1. PlaygroundでDataを作成・編集し、versionを保存します。
2. Artifact typeから「計算・分析ノート」を作ります。「保存済みDataの入力」で版と列を選び追加します。
   formula列は非対応です。select/relation列はprimitive mappingが必要なため、この初期UIでは拒否します。
3. Parameterを追加し、処理入力とselect/filter/derive/aggregate/sortを指定してstepを追加します。
   derive/filterは「式ビルダー」で列・Parameter・定数、四則演算、比較、論理、条件分岐、型・単位変換、明示丸めを選びます。入れ子の式も作成でき、型・単位をその場で確認できます。参照は選択した安定IDで保存します。「高度なJSON」も利用できます。既存derive/filterは「式を編集」→「式の変更を確定」で変更します。二項演算どうしを変更しても左右の部分式を保持します。「式を初期化」も未確定の変更になり、未確定stepは実行・保存・Undo/Redoを止め、確定または取消を求めます。
4. 「実行」でWorkerが計算します。成功結果の採用は1 Undoです。取消・失敗では前の成功結果を保持します。
5. 結果と入力版を確認して「保存」します。CSVは静的出力です。「通常Dataへ静的コピー」は独立した新規Dataを作り、
   decimalをtext列に保持します。CSVのmanifestには単位、null、空文字、精度と静的出力であることを記録します。
6. Document・Slide・Design・Whiteboardを開き、通常の「参照を埋め込む」から保存した分析結果を選びます。
   「現在の結果」はoutput IDに追従します。run IDを指定した履歴はその条件の結果です。更新連動でも未保存の変更は反映されません。

例（qtyとpriceがdecimal列の場合）:

```json
{
  "op": "multiply",
  "left": { "op": "field", "id": "qty" },
  "right": { "op": "field", "id": "price" }
}
```

aggregateはグループ列と集計方法、meanの桁数・丸めをフォームで指定できます。sortの昇降順、selectの列選択、結果表／Chart表示もフォームにあります。複数の集計列を1stepにまとめる場合やselectのrenameは高度な「条件JSON」を使います。確定時に全体を検査し、失敗時は元のcontentを保持します。
Chartは選んだ列の最初のdecimal列を棒にし、最初の列をラベルに使います。描画はnumber近似、表とtooltipは正確なdecimalです。
Chartを計算入力に戻すことはありません。decimal列がない場合、30列を超える場合、100件を超える場合は理由を表示し、結果表へ案内します。参照出力側の100行・30列・decimal列の制限は緩和しません。filter/aggregateで100件以内に絞って再実行してください。

ノートのtitle・説明・parameterには入力bufferがあります。Escapeで破棄でき、保存・Undo・切替の前に確定します。
IME変換中は実行・保存・出力を拒否します。OS native IMEの実機検証は未実施です。

## 複数入力・比較・更新

入力は最大8つです。joinは明示keyのinner/left、1:1またはmany:1だけを許し、右key重複を拒否します。
null同士は結合しません。未結合件数を結果に表示します。joinのUIでmany:1 / 1:1を選べます。「重複・未結合キーを調べる」で問題キーと安定行IDを確認し、元Dataへ移動できます。診断は1ページ200項目・各100行IDまで表示し、前後のページと種類（重複/null/未結合）による絞り込みで後続の問題も確認できます。診断の総件数は選択した種類に一致する件数です。停止したstepより後は未検査と表示します。診断は成功結果として採用・保存されません。

Parameterを変えて「現在のparameterを条件として保存」するとscenarioになります。「実行条件」から選び実行し、
「過去run」「比較元run」は実行番号・条件名・件数で表示されます。再実行に成功したら最新runへ表示を切り替えます。過去runを明示選択した場合は「過去結果を表示中」と表示します。比較表で変更前・変更後・差額・単位・件数・追加削除を確認します（詳細JSONも展開可能）。失敗したscenarioの部分結果は保存しません。

入力の新版を保存しても既存pinは変わりません。「新版で試算」で新しいrunと差分を作り、明示的に採用します。
列IDが変わった場合は入力ごとの「新版の列対応」で対応先の安定IDを選びます。「新版の列mapping」のJSON指定も利用できます。mappingの編集状態は入力の安定IDと現在の入力版ごとに分離し、別入力や次の入力版へ流用しません。表示名や行番号で推測しません。
型変更は診断して拒否します。同じ型の列へ明示mappingするか、条件を明示的なcastに直して再試算してください。
失敗時は「過去run」から成功runを選び「この成功runの入力版に戻す」で現在の入力版・列対応だけを復旧できます。説明・処理・parameter・旧run・保持版は残り、復旧は通常の1 Undoです。現在の条件と整合しない復旧は全体を拒否します。復旧後は現在の条件で再実行してください。旧runとその入力は保持されます。5run・2 MiBの上限を超えたときは、条件JSONで不要なrunを明示削除します。

結果表は50件ごとのページ切替と検索を備えます。検索は表示だけに作用し、CSV・通常Dataへのコピーは全件です。出力範囲と全件数を結果欄に表示します。decimalの桁区切りは文字列に対する表示処理で、number変換や保存値の丸めは行いません。null・空文字・欠落・0は区別し、原値をtooltipで確認できます。入力版・run IDは詳細にまとめています。CSV・Dataコピーは静的、Chartは近似描画であることを結果欄にも常時表示します。

## 公開APIと責任

- `@editor-platform/calculation-core`: decimal・単位・型付きscalar AST、JSON検査、SourcePin、採用ticketの小さな純粋関数。
- `@editor-platform/analysis-core`: native型、`assertAnalysis`、`evaluateBasis`、`calculateRun`、`verifyAnalysis`、
  `replaceAnalysis`、`duplicateAnalysisStep`、`moveAnalysisStep`、`restoreAnalysisInputs`、`inspectAnalysisJoins(document, scenarioId?, { offset?, code? })`（200項目単位のページ位置と種類の絞り込み）、`analysisDiff`、`runDiff`、静的出力。
- `@editor-platform/analysis`: `AnalysisSurface`、`AnalysisController`、Worker factory、package CSS。
- `@editor-platform/analysis/sources`: `analysisSources`、保存版を検査する`retainData`。
- `@editor-platform/analysis/references`: `createAnalysisReferenceAdapter`。Hostのscopeごとに新しいinstanceを作ります。

Surfaceは`AnalysisPort`、保存済みsource候補、入力boundary登録、保存・履歴・選択・元データ移動callbackを受け取ります。
Portは現在content/revision、permission generation、canEdit/canRead/canExport、input guardと通常command実行を提供します。
認証・offline許可・token・外部処理はHostの責任です。local参照Hostは自身の保持データを明示的に許可します。
接続Hostは失効時にgenerationを更新し再描画してください。保持snapshotを権限回避に使いません。

`restoreAnalysisInputs`は入力IDで過去runと照合し、入力版・列対応だけを変更するpure関数です。適用には通常のguard付きcommandを使用してください。`AnalysisController.inspect(scenarioId?, { offset?, code? })`は入力buffer・source権限・revision/generationを再検査する読み取り専用の結合診断です。診断の取得中に編集・失効した場合は破棄します。

`AnalysisController.prepare`は変更しない候補を返し、`apply`は候補の内容・revision・generation・入力・権限を再検査します。
既存の`previewProposedCommands`と`transaction`を使い、採用は1 Undoです。Host側の外部proposalも同じcommandを使用できます。
固定source pinはdomain内で検査し、既存`ProposalReads`へ架空の現在版を返しません。

`EditorHostAdapter.preflight`はload/save/native exportでdraftと全retained versionを検証する任意hookです。
`ReferenceAdapter.prepare`はresolverのlive/retained検査で呼ぶ非同期hookです。`validate/project`は同期を維持します。
Analysis参照は保持入力からWorkerで再計算してからruntime cacheへ登録し、未準備の同期projectionを拒否します。
cacheはsnapshotの実内容とHostのgenerationに結び付けます。JSONのverifiedフラグは受理しません。

未知engineのrunは読み込んだ原本を保持して閲覧できます。正式出力には対応engineによる明示的な再計算が必要です。
未知engineを含む参照snapshotはpreflightで拒否します。旧engineの互換実行器は追加していません。

## 実行・検証

```sh
npm ci
npm run fonts:fetch
npm run build
E2E_SUITE=analysis.production npx playwright test
```

独立Hostは`/analysis-host.html`。Playground state/CSSを使用せず、public packagesとpackage CSSだけを使います。
Artifact Hostは`npm run artifact-host:dev`の通常一覧から開けます。

入力/結果は10,000行×50列、全入力/全出力各200,000セル、domain全体2 MiB、native envelope16 MiB。
参照表示は100行×30列、64参照、source2 MiB/closure4 MiBの既存制限を維持します。
性能測定、Actions、公開同期、配布は今回の実装によって再開しません。
