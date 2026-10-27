# 計算・分析と設計積算の共通設計

**設計 v0.1。Analysis/Estimateの実装と受け入れは別に管理します。** 設計上の型名と実装APIの対応は[Analysis guide](../analysis-notebook/guide.md)とEstimate guide、検証済み範囲は各実装記録を参照してください。
対象は[計算・分析ノート](../analysis-notebook/design.md)と[設計積算](../design-estimation/design.md)。
共通化するのは有限の計算値と取得・適用の原則であり、両者のcontentや工程を統一しない。

## 価値と最初に通す仕事

保存済みのデータを選び、条件を変えて計算し、比較結果を説明資料に利用する。
設計では、保存済みCADの部品数量から見積を作り、設計変更前後の費用を確認して採用する。
工程は見積の後続段階でDataに公開し、Scheduleからその保存済みTimelineを参照する。
売上分析だけ、手入力数量の見積だけでも完結し、CAD・BIMや外部サービスを必須にしない。

## 現在あるものと追加する責任

| 既存の公開境界                                  | 再利用するもの                                                  | 今回追加するもの                                                             |
| ----------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `artifact-core` / `editor-core` / `editor-host` | draft、immutable version、hash、command、Undo、保存、提案の検査 | 各domainのvalidator・操作・差分adapter。第二の履歴・保存庫は作らない         |
| `structured-data`                               | 安定row/column ID、Grid/Form/Chart/Timeline、保存view           | 複数入力の計算recipe、実行根拠、シナリオ比較はAnalysis側                     |
| `cad-core`                                      | 保存部品の参照、assembly、BOMの数量規則                         | 積算用の安定した数量identityと重複計上の検査                                 |
| `bim-core` / `bim`                              | 要素ID、analytic数量、kernel評価結果                            | 採用する数量項目・計算根拠・単位の明示、価格との対応                         |
| `artifact-references` / `reference-adapters`    | 保存版の参照、固定/更新連動、capture、権限・閉包の検査          | 検証済み結果を描くdomain adapter。計算入力には画像埋め込みenvelopeを使わない |
| `schedule`                                      | Dataの保存Timelineをlaneとして表示、予定とrowの関連             | 工程計算はEstimate、編集する工程レコードはData。会議・予定を自動生成しない   |

初期package案は、純粋な`calculation-core`、`analysis-core`、`estimate-core`と、Reactを持つ
`analysis`、`estimate`。必要なsource/output adapterは各domainの公開subpathに置く。
`calculation-core`は両domainの小さな共通部品とし、汎用ジョブ基盤、DAGエンジン、DBを入れない。
Analysisの表演算DAGとEstimateの費目・作業計算は別に実装し、EstimateからAnalysisのrecipeを呼ばない。

## 数値・単位・丸め

既存Dataの`Cell`にはJS numberがあり、formulaも文字列である。これを変更して全Editorを巻き込まない。
追加domainでは次を共通の純粋関数として扱う。実装はTypeScriptの整数演算を第一案とし、新規依存は未選定。

| 項目           | 提案する契約                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| DecimalのJSON  | 正規化した10進文字列。指数表記、`-0`、NaN、Infinityを拒否。入力は有効数字34桁、小数12桁まで                                        |
| 内部演算       | 整数係数とscale。`+ - *`は正確に計算し、中間値は68桁・小数24桁以内。超過は`numeric-overflow`                                       |
| 除算・量子化   | `divide(a,b,scale,rounding)`と`quantize`を明示。scaleは0〜12、丸めはhalf-even / half-up / floor / ceil。ゼロ除算・暗黙の丸めは禁止 |
| 保存結果       | 34桁・小数12桁に収まらない結果は、recipeに明示した量子化がなければ拒否。表示の桁数変更は計算を変えない                             |
| 初期単位       | dimensionless、count、mm/cm/m、mm2/m2、mm3/m3、g/kg、minute/hour。変換係数は正確な有理数                                           |
| 次元           | 加減算は同じ次元。乗除算の次元を追跡し、比較対象に合わせて換算。`m + m2`、countと長さの加算は拒否                                  |
| 金額           | `currency`は3文字の大文字コードと小数桁0〜4を文書内で明示。単価はcurrency/数量単位。初期見積は単一通貨。為替・税制の自動推定なし   |
| 日・時間       | 工程のworkdayは長さのない独立単位。hourへの換算は明示した稼働時間が必要。暦日、経過24時間、稼働日を混同しない                      |
| Dataからの取込 | numberはfinite検査後、JSONの10進表現から変換。元から失われている桁は復元できない。厳密入力はtext列のdecimalを明示変換              |

型付きscalar式はliteral、parameter、field参照と、四則・比較・条件分岐・明示的cast/quantizeに限定する。
名前は表示に使い、参照は安定ID。式editorの文字列はparse後のASTを正本にする。JS、SQL、Python、
URL、関数名の任意呼出し、現在時刻、乱数、暗黙のlocale変換は初期対象外。
式のネスト16、1式256 node、文字列16 KiBまで。型・次元を先に検査してから評価する。

number入力のadapterはJSON数値の指数表記を通常の10進文字列へ展開してから桁数を検査する。
安全整数範囲を超える整数numberは既に丸められている可能性があるため拒否し、decimal textの入力を求める。
文字列の数値は宣言した書式だけを許し、通貨記号・桁区切り・localeを推測して解釈しない。

既存Dataのformula evaluatorは変更しない。初期Analysisの入力は通常列に限り、formula列は
`unsupported-source-formula`で対象列を示す。将来対応では式の意味と数値差を別途検証する。
出力表の厳密なdecimalは文字列で保持する。Chartだけで有限numberへ投影する場合も、軸の描画近似と
tooltipの正確な値を区別し、描画値を再計算に逆流させない。既存Dataのnumber列への任意変換は、元の有理数がbinary64で正確に表現可能な場合だけ許可する。それ以外はtext列を使う。

## 保存版の取得と結果の正当性

次の`SourcePin`は概念型であり、新しい共通Artifact envelopeではない。取得実装はHostが提供する。

```ts
type SourcePin = {
  artifactId: string;
  domain: 'data' | 'cad' | 'bim';
  versionId: string;
  contentHash: string;
};
```

1. 選択時にimmutableな保存版を取得し、domain validatorとcanonical hashを検査する。draftは入力にしない。
2. 使用するsnapshotと依存閉包をdomain content内で保持する。identityはartifactId/domain/versionId/hashの組。
   同じversionIdの異なるhashを拒否する。同じcontentHashでも別Artifactのidentityを混同しない。
3. 入力更新通知は「新しい版あり」を表示する。計算入力は固定したまま。新しい版で試算し、差分を確認して採用する。
4. 計算basisはsource pin、使用列・数量selector、recipe、parameter値、engine版・丸め規則をhash化する。
   同じbasisから同じ順序・値・診断を得る。表示設定、実行時刻、Host job IDはbasisに入れない。
5. 保存したrunはimmutableな計算記録。現在recipeとbasisが違えば「過去の条件の結果」と表示する。
   dirtyな式や入力bufferがある間も現行の結果として公開しない。

hashが合うことは数量や計算が正しい証明ではない。importした結果の検証状態はruntimeで`unverified`から始める。
Analysisの初期演算は保持入力から再計算して結果hashを照合する。BIMのkernel数量は同じ形状版とengineで
再評価するか、Hostが検証した取得経路を使うまで、参考値として閲覧できても正式な再集計・公開には使わない。
未知のengine版は、編集内容を保持して閲覧し、対応するengineへの明示再計算を求める。

## 非同期処理と採用

計算は初期からWorkerでキャンセル可能にする。実行中・失敗・取消・supersededはprivateな実行状態であり、
空の成功runを保存しない。結果採用はdomainの通常command一回にする。
開始時にSession revision、basis、permission generation、request IDを記録する。完了・採用時に全て再検査し、
途中の編集、Undo、permission失効、再実行、Editor close後に届いた結果は適用しない。
同request ID・同basisの重複完了はno-op、同ID・異なるbasisはconflict。失敗で以前の成功結果を消さない。

提案のUI/headlessは[既存の提案境界](../host-integration.md#proposal-freshness)に接続する。
`ProposalReads.references`の現在版検査だけでは、同一Artifactの複数の過去版を入力にした計算を表せない。
固定pinはdomainのprepare/apply検査で全組を照合し、既存helperへ偽の「現在版」を返さない。
最新を前提に生成する提案は既存`ProposalReads`にも現在版を記録する。どちらもtargetのlive revisionと
全入力の現在の閲覧権限を採用直前に検査する。認証・権限policyそのものはHost所有。

## 入力保持・権限・portable

- sourceを読めない場合は`missing` / `forbidden` / `offline`を区別する。オンラインでの失効を保持snapshotで回避しない。
- 閲覧・再計算・CSV/参照出力の開始と完了でアクセスを検査する。失効時は由来する表・集計・結果も隠す。
- ローカルHostは自身の保持データについて許可を決める。接続Hostのoffline利用はHostの明示policyが必要。
  offlineだけを根拠に過去の許可を無期限に継続しない。
- native exportは入力・価格・過去runを含むことを列挙し、Hostのexport権限と保持/持出policyを確認する。
  複製済みのファイルを後から遠隔失効できるとは説明しない。
- 閉包はdomain内で重複排除し、削除は現在recipeと残すrunから未参照のものだけ。過去Artifact versionは改変しない。
- JSONの全retained versionを検査し、欠落依存・未知schema・循環・不正hash・容量超過はimportを原子的に拒否する。
  importでは元Artifact IDを用いて自己参照も検査する。新IDの割当で外部source IDを書き換えない。

## 他Editorへの出力

結果の保存とData/Slide/Scheduleの更新は別の操作であり、複数ArtifactにまたがるUndoを作らない。
初期は選択した結果を通常Dataへ明示的にコピーして保存できる。コピーは独立した成果物であり、更新連動とは呼ばない。
後続で`analysis` / `estimate`のReferenceAdapterを登録し、保存した検証済み結果の表・chartを直接参照する。
adapterは宣言済み同期`project`を維持し、描画中に計算やkernel実行を始めない。

新しい参照adapterを登録するだけでは非同期の結果検証は接続できない。参照Hostにはdomainごとの
`prepareAnalysisReference` / `prepareEstimateReference`（提案名）を追加し、非同期read/import/captureの
前処理でWorkerの再計算や数量検証を完了させる。同期`validate/project`は検証済みのruntime cacheだけを使う。
cache keyはcontentの実bytes hash、basis、結果hash、engine版、Hostのアクセスscope/generationを含める。
保存JSONの`verified: true`等を信用しない。cache欠落時は未準備として拒否し、Hostが前処理後に再実行する。
固定版・保持参照・native importの全versionにも同じ前処理を行う。source閉包があっても検証engineがなければ
参考表示に留め、正式captureは拒否する。この接続までをA3/E4の受け入れ範囲とする。

新domainの閉包にも既存のsource 2 MiB、参照closure 4 MiB、表100行×30列、64参照の制限を適用する。
大きな計算結果は表示範囲・集計を指定する。切り捨てず拒否し、通常の編集上限を下げない。
保持するData等に埋め込み参照や未対応reuseがある場合は、初期のsource admissionで拒否して再帰参照を作らない。
既存ReferenceResolverのvalidatorとcaptureを通すことを受け入れ条件とし、私的な画像差替え経路を作らない。
CSVはrecipe/閉包を保持しない静的出力、Office参照出力は既存どおり非対応。明示的な参照解除後の出力は別能力。

## 最初の実装順と判断

1. 数値・source境界のfixtureを両domainで共有し、decimal・単位関数だけを実装する。
2. AnalysisのData単一入力とEstimateの手入力数量を、各々作成→編集→再計算→Undo→保存→native往復まで通す。
3. CADの部品表を見積へ接続し、設計変更の明示採用と見積比較を通す。
4. Analysisの複数入力・シナリオ、BIM数量、参照付き説明資料を個別に追加する。
5. 見積から工程案をDataへ公開し、Scheduleのlaneで比較する。外部予定への反映は別作業。

各段階は独立した実装PRにする。CADの解析・最適化や汎用コード実行を前提にしない。
最初の推奨判断はlocal-only、型付き演算のみ、固定入力と明示採用、単一通貨、工程はfinish-to-startのみ。
人とAIの全入口に同じvalidator/commandを使い、AI実行・承認・複数Artifactの配送・再試行台帳はHostへ置く。
新kindはpre-1.0/schema 1から始め、存在しない旧形式の互換layerは作らない。既存domainのreaderは変更しない。
将来の破壊的変更は明示し、保存済み旧version/hashを無言で変換しない。

本設計の完了は機能の受け入れではない。追加の性能測定・自動CI・公開同期はこの設計によって再開しない。
詳細な能力matrix、実装箇所、fixture、受け入れ条件と性能計画は各domainの文書を参照する。

## レビューで確定する判断

以下は実装担当が黙って選び直さないための判断点。いずれも推奨案を本文に織り込んでおり、未決を理由に
設計PRの作成を止めない。実装に入る前に、採用案と変更が必要な受け入れ条件をレビューで記録する。

| ID  | 推奨案                                | 比較した案 / 選定理由                                                 | 変更時の見直し             |
| --- | ------------------------------------- | --------------------------------------------------------------------- | -------------------------- |
| D01 | Analysis/Estimateは独立domain         | Dataのschemaにrecipe/金額根拠を詰め込む案では、viewと計算根拠が混ざる | N01–N03、全native fixture  |
| D02 | 共通化はdecimal・単位・scalar式に限定 | 汎用計算platformを先に作る案は運用runtimeまで広がる                   | package依存、AN02/ES02     |
| D03 | 固定入力と明示的な新版採用            | 常時再計算・自動上書きでは確定見積と過去の説明が変わる                | AN15/ES14/参照capture      |
| D04 | local-onlyから開始                    | shared同時対応にはcodec・selective Undo等の別設計が要る               | C04/S01–S06                |
| D05 | decimal、小数通貨桁、line単位丸め     | JS numberと表示丸めだけでは費用差の再現に不足                         | AF2/EF3、CSV/Data adapter  |
| D06 | 型付き演算のみ、実行基盤はHost        | 任意Python/SQLは隔離・依存・再現性・費用管理を追加する                | N12、Host契約、engine版    |
| D07 | 工程正本はData、Estimateは計算条件    | 第二のtask trackerを作る案は進捗と担当の同期問題を増やす              | ES24–ES27、receiptの永続化 |
| D08 | A3/E4で非同期検証preflightを明示追加  | 既存同期adapterだけで未検証runを受理する案は根拠を保証できない        | AN12/18、ES19/21           |
