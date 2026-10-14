# Structured Graph Editor — public Issue #3

設計対象は `ryo0221/open-editor-platform#3`（2026-10-09の本文、コメント0件）。実装とPRの正本は editor-platform。設計テンプレートの目的・能力・モデル・履歴・Host・互換性・検証の項目をこの文書で固定する。検証結果は別の[報告](verification/open-issue-3/README.md)へ記録する。

## 目的と責務

型付きノード、関係、属性、参照整合性がnativeな意味になるため、Whiteboardの図形拡張ではなく `structured-graph` kindを追加する。同じDataレコードを見る用途はData projectionのままにする。

| 部品                    | 正本・責務                                                                      | 依存境界                                                                              |
| ----------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `structured-graph`      | schema/model/Profile検証、pure intent/command、local session、提案、Surface/CSS | artifact/editor core、neutral property inputsのみ。Data/Workflow/製品型をimportしない |
| `structured-data`       | レコード・列・単一relation、全表示に共通の変更検証                              | Graphをimportしない                                                                   |
| `structured-data-graph` | row/column IDからGraphへの投影とData commandへの逆変換、Data Graph view         | 両packageのpublic entrypointに依存する境界。Graph Artifactを作らない                  |
| `property-input`        | controlled string buffer、型・選択肢・readOnly・診断の中立UI                    | 行/ノード/保存/Sessionを知らない                                                      |
| reference Host/adapter  | 公開可能な架空Definition fixture、領域validatorへの接続、保存・layout sidecar   | Graph本体がimportしない。実Workflow Framework Adapterは利用側で作る                   |
| Host                    | 権限、StorageAdapter、版確定/公開/採用、外部実行/AI、overlay                    | Editorは業務状態を決めない                                                            |

## 能力matrix

| 能力                                              | 初期宣言                                                                           | 未対応入口                                              |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------- |
| local / Viewer                                    | native Graph、typed属性、接続/付替え/削除、明示layout、Undo/Redo                   | readOnlyはHost適用境界でも拒否                          |
| selection                                         | graph/node/edgeの安定ID、Host通知                                                  | annotationなし（既存Hostで入口を隠す）                  |
| headless / proposal                               | serializable intent batch、preview/apply、revision/profile/adapterの再検証         | AI/runtimeはHost所有                                    |
| native JSON                                       | draft・全version・hash検証、restore、schema 1のみ                                  | 未知schema/profileを拒否、旧versionを書き換えない       |
| external adapter                                  | canonical Session一つ、損失のない対象field編集、導出edgeはreadOnly、layout sidecar | 保存不能な操作を理由付き拒否                            |
| Data projection                                   | 同一DataのGrid/Form/Graph、single nullable row ID relation                         | 多値/入れ子/自由なedge属性を文字列へ埋め込まない        |
| Shared / template / reuse / Office / React export | 非対応                                                                             | Graphには入口を表示しない。既存domain unionへ追加しない |
| text                                              | controlled input buffer、submit一編集、Cancel/Escape、composition中shortcut抑制    | native OS IMEは別途NOT RUNを記録                        |
| browser                                           | Chromium desktop/mobile viewport、独立Host/通常Host                                | 実機、他engine、assistive technologyは実施範囲を別記    |

## Native model / Profile

`GraphDocument { schemaVersion: 1, id, profile: {id,version}, attributes, nodes, edges, layout }`。
Nodeは `{id,type,attributes}`、Edgeは `{id,type,from,to,attributes}`。graph/node/edge IDは文書内一意、配列順・表示名と独立。Native importと並替えで保持する。別Artifactへimportしてもelement IDはそのまま（Artifact IDだけHostが再割当）。

Layoutはnode ID→`{x,y}`、CSS pixel相当の論理単位、各軸±100,000、finite。Positionの未知fieldは拒否し、移動で黙って落とさない。camera/zoom/panel/selection/drag preview/overlayはprivate view stateでcontentへ入れない。空Graphを許可する。Node削除は関連edge一覧をpreviewし、明示cascadeで一transaction。cascade指定なしは接続がある場合拒否。

上限は1,000 nodes、4,000 edges、属性単位64 KiB、文書全体2 MiB UTF-8、JSON depth 12、string 16,384文字、collection 4,096 entries。ID/type/Profile IDは1〜512文字。Graph/Node/Edgeの未知structural fieldは拒否し、private camera等をnativeに保存させない。JSONはplain object/array/finite primitiveのみ、accessor/function/cycle/prototype pollution keyを拒否する。assetや認証情報の専用保存欄は設けない。文字列はテキストとして描画し、コード/URL解決/外部通信を実行しない。

Profile schema 1はdata schemaとUI schemaを分離する。data schemaはboundedなstring/number/boolean/enum/array/object、required/readOnly、数値範囲、string length。UI schemaはlabel/description/order/labelField。scalarは型付きinput、array/objectはschema検証付きJSON textareaを使う初期範囲。JSON Schemaの完全実装、recursive form builder、`$ref`/remote resolution、code/HTML rendererではない。未知属性はJSONとして保持しフォームでは変更しない。Profile登録はHostの信頼境界。Profile ID/versionとcontent schema/Artifact envelope/外部Definitionの公開版を混同しない。

required欠落は未完成draftのdiagnostics（公開/版保存はHostが判断）。存在する値の型不正、未知type、接続先欠落、上限違反はcommit拒否。edge typeごとにfrom/to型、self/parallel/cycle、max incoming/outgoingを宣言する。接続数と隣接表はtypeごとに一度集計し、cycleは反復DFSの強連結成分から該当edgeだけを診断する。未宣言の禁止は固定しない。readOnly field/typeはUI以外でも差分検証で拒否する。診断はscope/element ID/field path/code/severityを持ち、投影stampと一緒に返す。

## 閲覧表示 (#224–#228)

`GraphSurface` / `NativeGraphSurface` の `showInspector`、`initialView`、
`fitOnFilterChange`、`nodeSize`、`visibleEdgeTypes`、`highlightAdjacent` は
private表示設定。[埋め込み](embedding.md#structured-graph-local-mode) に型と既定値を記載する。
readOnlyでは編集道具を表示せず、属性値・選択・camera操作を提供する。
Host独自パネルは既存の選択通知で接続する。ノードの実寸を描画・Fit・routing・
端点hit判定で共有する。`nodeSize` 未指定なら幅200pxで折り返し、改行と長い連続文字を
保持して全文に必要な高さ（最小70px）を表示から算出する。title／accessible nameは補助とする。
明示寸法は固定し、内容が切れても勝手に拡張しない。表示から算出した高さをnativeへ保存せず、
配置済みnodeを自動移動しないため、高さ変更で重なった場合は従来の経路拒否を示す。

ノードと辺の絞り込みは描画だけに作用し、検証・診断は全Graphで行う。
絞り込みで選択対象を消去せず、隣接強調は全Graphの直結関係に基づく。
ラベルはノードと既配置ラベルを避け、空きがないものは線のhover/focus/selectionで表示する。
Edge Profileの `ui.edgeStyle` は3/6桁hex色と最大8個の正のfinite dash長（各64以下）だけを許す。
未知field、任意CSS/URL、辺以外へのedgeStyleは拒否する。
既存のProfile schema 1は追加指定なしで有効。Profileの変更は既存のHost版管理に従う。
Graph content、確定version、hash、編集履歴には表示設定を保存しない。

## Session / command / external adapter

Native object属性も宣言した子だけをrecursive mergeする。root/nested/array内の未宣言
memberは読取・宣言済み編集・Undoで保持する。任意headless commandも共通guardで
未宣言memberの上書き・追加・消失を拒否し、null/属性削除/array置換による消失は
batch全体を原子的に拒否する。新規node/edgeの初期metadataや削除後の元node復元は
保持できるが、配置済み要素の未宣言値は編集できない。

Nativeは `GraphSession` が既存 `EditorSession<GraphDocument>` を所有する。通常Hostは既存Artifact Sessionへ同じ検証済みGraph commandを流す。trusted arbitrary commandも最終content・readonly差分のguardを通す。Intent batchは入力をcloneしpureに評価、成功時だけ一編集。move gestureはprivate preview→pointerupで一batch、Escape/cancelは無変更。

外部は `GraphAdapter<Source>` と `GraphBinding<Source>`。Hostが `read()`（content/revision/readOnly）とcanonical `execute(command)` を渡す。AdapterがProfile/project/prepare/domain diagnosticsを提供する。GraphBindingはsource Session/Undoを持たず、毎回再投影する。stampはsource revision・canonical fingerprint・adapter ID/version・Profile全体・layout sidecarをpinし、apply時に最新readとcommand inputで照合。外部更新/対象削除/版変更/権限剥奪/layout更新は古いpreviewのapplyを拒否する。proposal previewは正本と履歴を変えず、採用は一command。semantic previewも現sidecar配置を渡し、提案sourceからProfile・domain diagnosticsを再計算する。変更bufferのstaleも同じ境界で拒否する。

外部layout sidecarはHost所有、schema 1/source ID/adapter・Profile pins/source revision/node ID位置を保存する。欠落IDは無視して決定的初期位置を使い、未知schema/pinは拒否する。配置専用batchだけsidecarへ適用し、semantic batchとの混在は原子性を保証できないため拒否。Definitionの値/順序/版/semantic Undoには入れない。sidecarに別のデータ編集Undoは作らない。runtime overlayはpropsのみ。

参照Definition Adapterは `apps/graph-reference` に置く。実Framework型ではなく架空の公開fixture（phases/shapes/gates/components/global settings + 未表示field）を使用。object編集は宣言した子だけをmergeし、未宣言の子を保持する。未宣言データを失うnull化・属性削除・array置換はbatch全体を理由付き拒否し、正本と履歴を変えない。未宣言データを含まない属性のclear/removeは可能。phasesの配列順を示すedgeは導出readOnly、順序変更は明示操作。ProfileとAdapterの差替え、domain診断mapping、immutable原本とdraftの分離を検証する。実 `parseDefinition` は利用側注入validatorの例であり、このrepoに業務検証を転載しない。

## Structured Data

架空Definitionの導出edge IDは通常のprefix IDを保ち、512文字超過またはnative node
namespaceとの衝突時だけcanonicalなtype/source/saltのSHA-256へ変換する。入力の
512文字IDやprefix/hash namespaceを占めるnodeも元IDを変更せずに扱う。graph root ID
との衝突は入力境界で明示拒否する。output/target/componentに未知先・異型値があれば
投影を理由付き拒否し、関係を黙って落とさない。独立Hostは投影失敗時も正本表示と
元Definition exportを残す。Graph内修復や未知参照の自動解決は宣言しない。

既存 `relation` cellは同一Dataの単一row IDまたはnull/空。node IDは507文字以下なら空row IDを含め `node:${rowId}`、超過時はcanonical JSON文字列のSHA-256を用いた `node-hash:` ID。edge IDは `edge:${rowId.length}:${rowId}${columnId.length}:${columnId}`、512文字超過時はcanonical `[rowId,columnId]` の `edge-hash:` ID。namespaceとbounded digestでGraphのID制約を満たし、元row/column IDは変更しない。長いIDの逆変換は `dataRowId(nodeId, source)` でcanonical sourceと照合し、順序に依存しない。target変更・列名/順序変更でもedge IDは不変。属性key=column ID、relation属性・enumは投影node IDを使い、適用時にrow IDへ戻す。null/省略/空文字は投影上だけnullに揃え、無関係な編集では正本の表現を保持する。空row IDは通常属性・配置を編集できるが、Dataの空文字が未設定を表すためrelation targetには使えない。edge type=relation column ID、方向source→target、outdegreeはその列で1、incomingは上限内自由、self/cycle可。全Data rowsを投影してfilter外targetも保持し、絞込はviewだけ。選択通知はnodeを元rowへ、edgeを元row/column cellへ変換する。

Node属性はtext/number/boolean/date/select列に対応。formula/readOnly列は表示専用。新接続は既存の空relation cell、切断はnull、付替えは同じsource/column cell。node type/global/edge attrsの任意変更はDataに表現できないので拒否する。Graphから新rowを作る場合も既存Data commandとdefault値を使う。

Dataの読取境界は `assertDataReadable`：構造・finite cell・view設定を検証し、旧未解決relationはraw値のまま読み診断・修復できる。Dataの共通適用境界は `guardDataCommand` / `DataSession`。Grid/Form/Graph/headless/proposal/通常Hostが最終構造、readonly field差分を検証し、新たな不正relationは拒否する。既存の不正参照は同じrow/column/valueだけ保持でき、段階的な修復・無関係な編集・Undoを可能にする。Graph投影など完全な参照を要する処理には `assertDataIntegrity` を使う。Graph画面なしでも適用guardは有効。通常Hostのlibrary loadは一recordの失敗を隔離し、元recordのexportと他Artifactの利用を継続する。既存のrequired/type診断は通常Dataのdraft契約を維持する。relation先削除は `deleteRows` の明示cascade（関連cellをnull、required/readOnly relationなら拒否）または普通の任意commandなら新たなdangling参照を拒否。relation列の変更/削除は参照を持つ場合拒否し、先に明示切断する。未対応多値は構造validationで拒否。

readOnly列の値はGrid/Form/Graph/headlessで保護する一方、権限を持つHostの明示schema command (`updateColumn` / `removeColumn`) は解除・rename・削除を許可する。公開factoryが作る不変commandの内部intentを共通guardへ引き継ぎ、任意commandのtype名だけでは許可しない。解除と保護値の書換えを同一commandに混ぜる操作は拒否する。解除後の別commandで値を編集でき、schema変更も同じUndoの対象。sharedではauthorityの権限/preconditionを使い、schema intentを通信上の認証情報として扱わない。

`StructuredData.graphView?` はschema 1のlabel column ID（列なしはnull）とnode positionsのみ（recordコピーなし）。旧保存データでは列があってもlabelがnullの場合があるため、読取・適用はこの状態も許可し、投影では先頭列へfallbackする。draftやimmutable versionを読み込み時に書き換えない。non-nullの存在しない列IDは引き続き拒否する。新規の最初の列追加はlabelを同じcommandで設定し、最後の列削除はnullへ戻す。DataもPositionのx/y以外のfield、欠落軸、非finite/範囲外値を読取・保存・投影・変更の共通境界で拒否し、未知値をmoveで落とさない。配置はData contentのview設定として同じSession/Undoで保存し、rows/values/refs/orderを変えない。History Compareはviewの追加/削除、label field、row IDごとの位置変更を表示する。最後の列を削除しても既存positionsを保持し、zero-column Graphの配置・行追加を許可する。

shared Data codecはlabel/view設定とrow IDごとのpositionを分け、Gridのrow/label column削除・関連view修正・selective Undoを同一transactionで伝える。別行の配置変更と行削除は互いの位置を上書きしない。view全体の削除や作成Undoはpeerが追加した位置を消す場合に競合として拒否する。既存の `order:rows` preconditionは維持するため、同じrevisionから別行を二つ削除する操作は配置の有無にかかわらず二つ目がstaleになる。これは既存Data sharedの互換性でありGraph Surfaceのshared登録ではない。旧schema 1/2でこの省略可能な追加fieldを読む。Graph未対応旧readerで再保存するとviewを落とす可能性を互換性の制限として記録。camera等はprivate。

Formのdraftはレコード別、Graph属性のdraftは対象別に保持する。標準HostのEditorInputsでSave/export/表示切替前に検証・flushし、IME/invalid/staleでは停止する。Gridの既存cell bufferはblur/submit方式で、独自JSON設定を含む全widgetのflush対応を意味しない。Grid/Formのsubmitは開始時のrowとcolumnsをpinし、変更済みのbufferを拒否する。Form/Graphのclean bufferは正本更新やUndo後に自動更新、dirty bufferはstaleとしてCancelによる再読込を要求する。Graph接続formは編集開始時のstampと選択対象を保持し、sourceまたは選択変更後のdirty submitは拒否する。Reload connectionで最新値を明示再取得する。文書UndoはHostで処理し、入力中のCtrl/Cmd-Zは未確定bufferに留める。別viewで確定した編集をbufferから再適用しない。

列IDもGraph用に安定変換する。通常の有効IDは保持し、空・予約名・長いIDと変換namespaceを含むIDは `dataFieldId` でboundedなIDにする。Profile schema/UI/label、属性path、relation type、診断、選択通知で同じ変換を使い、`dataColumnId(fieldId, canonicalData)` で元の列を解決する。元DataのID、未表示値、列の順序に依存しない対応を保持する。

新規行のreadOnly cellは公開 `makeRow` と同じ既定値・own-propertyの保存表現、formula cellは保存値なしに限定する。共通guardで通常追加、CSV追記、headlessの不正batchを原子的に拒否し、正本・revision・Undoを変えない。読取済みの既存行にある保護値はそのまま保持する。

保存版復元は通常追加から分け、公開 `restoreDataVersion(versionId, read)` がHost所有の
Artifactから唯一のversion、Artifact ID、content hash、readable構造を確認する。取得時と
実行直前の権限・revision・全Artifact bytesをpinし、検証済みcontentだけを復元する
不変commandを作る。private WeakMapのintentは共通guardへ引き継ぎ、コマンド名や
spread copyで保護値の例外を作れない。既存SessionのUndo/Redoを使い、保存済み版と
hashを変更しない。Hostが注入するreadは信頼境界であり、remote payloadを認証するAPI
ではない。CSV/通常新規行/headless guardとshared authorityは維持する。

select optionsの重複はGraph投影enumだけを先頭順で重複排除し、元Dataのoptions、ID、
未表示値は変えない。Grid/Formの既存draft互換性を維持する。

公開pure `createGraphNode` は文字列長・数値上下限内のscalar初期値を生成する。complexまたは制約を満たすenumがない属性は省略し、required欠落は不完全draftの診断とする。範囲違反はcommitしない。Surfaceの実効readOnlyはpropsと `profile.graph.readOnly` の論理和で、追加・移動・接続・属性変更を無効にし、選択・閲覧・zoomを保持する。

Definition提案の表示は `proposalView ?? projection` の一つの投影からgraph/Profile/stamp/diagnosticsを渡す。解消・新規発生する診断がpreviewに対応し、rejectで原本診断へ戻る。preview/rejectは正本・履歴を変えず、採用時のstale確認は元proposalのbaseを使う。

## Surface / Host / 実装・検証順

Native browser importは `readGraphArtifactFile` でFile.sizeが16,000,000 bytes以下かを
File.textより先に検査する。負数・非整数・非finite sizeも拒否する。文字列入力用の
`readGraphArtifact` は独立してUTF-8 byte上限を確認し、size metadataだけを信用しない。

Canvasは依存を追加しないSVG edge + DOM node。React Flowの高度なports/layoutは初期に不要、全グラフを受け取るpublic contractを独立させる。描画libraryを後で交換してもcanonical modelは変えない。Surfaceはpackage CSSとtyped propsだけ。container min-height/overflow、モバイル縦配置、accessible inputs、node/edge selection、keyboard Delete/arrow/Escape、pointer/touch dragを検証する。

1. Pure model/Profile/commands/GraphSession/GraphBindingと拒否・pure・stale・proposal・履歴テスト（N02–N05/N09/N12/C03）。
2. neutral property inputs、Graph Surface、Data guard/adapter/view、架空Definition Adapter（N01/N08/C01/C07）。
3. Playgroundのkind/factory/validator/Surfaceと保存/import/restore、独立 `graph-host.html` のproduction entry（N06/N07/N10）。StorageAdapter失敗を表示し、export/retry導線を用意する。独立HostのCommitは開始時snapshotを版にし、hash待機中の編集/Undoは最新draftに保持してその状態を保存する。二重Commit/Saveは処理中拒否する。Native importはfile読取/hash検証の後、最新権限・target ID・revision・draft/versionsのbytes・Save/Commit状態・request順序を再検査する。待機中の編集/Undoは許可し、変更後の古いimportを拒否して現在の正本/履歴を保持する。二つのimportは後から開始したrequestだけを採用し、unmount後の完了を無視する。独立Hostは明示Save方式で、source切替/reload前にSaveする参照例。production durabilityはHostの責務。
4. desktop/mobile代表操作、Dataを跨ぐ履歴、既存Data/embedding回帰、lint/typecheck/unit/build/files/tooling（N11/N13）。README/status/報告へ結果を反映（N14）。

性能計画：公開fixture（3〜8 nodes）、将来workload G100（100 nodes/300 edges）/G1000（1,000/4,000）、属性平均1 KiB。将来budgetはattribute/connect/undoのp95 100 ms、cold first editable 2 s、drag commit 100 ms（固定Chromium desktop、20 warmup/100 samples/3 repetitions、失敗sampleはfail、network除外）。現時点は計画のみで測定しない。#22性能合格の保留と追加測定・調整停止を解除しない。利用側trial/production release/実Workflow統合は別判定。

## #42–#49の操作・所有定義の追加

ノード本体と移動handleをpointerで動かす。選択edgeのfrom/to handleは各ノードのcardinal
portに置き、gesture中はprivate previewとvalid/invalid候補を表示する。Cancel/Escape/
pointer cancel/readOnlyは正本を変えず、drop時にbase stampとdomain guardを再確認する。
Dataのfrom変更は旧cellの解除と新cellへの設定を同じcommandで行い、既に関係がある
新sourceは拒否する。接続formによるkeyboard編集も維持する。

描画経路はノードの矩形を避けるorthogonal routeで、左右・上下・self portを選ぶ。
重なるnative node等で経路を作れない場合は中を通すfallbackを使わず、重なり解消を示す。
type/labelと矢印を表示し、選択時は両端と線を強調する。routeをnative JSONへ保存しない。
選択handleは他edgeのhit領域より前面に置く。移動・付け替えで描画を再計算する。

Graph共通の元データ/定義メニューはHost所有元と選択型を示す。Dataは元レコード/Form/
Fieldsへcallbackし、独立GraphはProfile定義を閲覧・編集する。変更できないHostは理由を
表示する。editable ProfileはGraphDefinitionSourceをHostの既存Sessionで所有し、source/
accessを再確認してpreviewGraphDefinition/prepareGraphDefinitionを使う。値の移行とProfile
version変更は同一履歴・保存で、未知属性を保持し、無効値/関係/field削除は適用しない。
Host受領requestのpreviewを信頼せず、現在のsourceから再生成する。native Graph自身が
全業務定義を所有したり、独立sourceを平らな表へ変換したりしない。

参照候補はstable IDと現在の表示名を分ける。診断はcode/argsを保ち、ja/en formatterで
対象名・理由・次の操作を示す。ID/元pathは詳細と正本に残す。公開APIとHost接続は
[embedding](embedding.md)、今回の判定は[検証](verification/issues-42-51/README.md)を参照。
