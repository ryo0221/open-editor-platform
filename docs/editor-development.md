# 新しいEditorの開発ガイド

このガイドは、新しいドメインのEditorを設計・実装・統合するときに使います。[開発者ガイド](developer-guide.md)を入口とし、[受け入れ条件](editor-acceptance.md)を完了の判断に使ってください。個々の既存機能の詳細契約は、このガイドからリンクする文書が基準です。

## 1. 新しいEditorが必要かを判断する

| 追加したい機能                                 | 通常の追加先                                             |
| ---------------------------------------------- | -------------------------------------------------------- |
| 同じレコードを別の並び・集計・描画で見る       | Dataのprojection/view。別contentや複製レコードを作らない |
| SlideやDesignの新しい図形・Inspector操作       | そのドメインのmodel/commands/Surface                     |
| Hostが持つReact componentを配置・設定する      | React UIの登録契約。任意JSXの実行機構を追加しない        |
| 特定製品の承認・プロジェクト・AI実行を接続する | Host adapter / extension                                 |
| 独自の内容・操作・座標・保存上の意味を持つ     | 独立したnative modelを持つ新しいEditor                   |

例えば音声編集のclipと時間範囲は、Slideのページ/objectを名前だけ変えて表すべきではありません。一方、同じDataのレコードを時系列に並べるために独立したArtifactを作る必要はありません。新しいkindを決める前に、既存の[Surfaceの意味](surface-semantics.md)との違いを説明してください。

## 2. 対応範囲を設計書で固定する

[設計テンプレート](editor-proposal-template.md)を使い、最低限次を記載します。

- 利用者、代表的な操作、Editorが持つ独自の意味、既存Editorでは満たせない理由。
- `kind`、content schema、element ID、参照関係、単位・座標、モデルの不変条件。
- Local編集、Viewer、shared editing、template/reuse、外部形式、proposal、React連携の対応範囲。
- Hostが渡すprops/adapterと、Editorが返すcommand/selection/event。
- 各能力の受け入れ条件、制限、移行方針、想定規模と測定前のperformance budget。

対応機能は「実装予定」「実装済み・未検証」「検証済み」「非対応」を分けます。例えばlocal-onlyで始めることはできますが、shared modeに入れるUIやAPIは有効にしません。Viewer-onlyの場合も、編集・Undoなどを適用外とする理由を設計書に書きます。

追加のperformance測定・tuningは現在停止中です。測定の再開前にもfixture、上限、判定方法は設計できます。既存の100 ms等のbudgetは指定済みworkloadの条件であり、どの新ドメインにもそのまま適用できる性能保証ではありません。

## 3. Pure modelとpublic APIを作る

推奨する構成は`packages/<domain>/src/model.ts`、`view.tsx`、public entrypointです。これは構成例であり、汎用のEditor登録generatorが存在するという意味ではありません。

### Contentに保存するもの

JSONで表せるドメイン固有の値と安定IDを保存します。順序とidentityを分け、参照は範囲内に存在するIDへ結びます。数値はfinite・範囲・単位を検証し、最大要素数、入力サイズ、ネスト深度などの上限を定義します。削除時の参照の扱い、並べ替え、空の状態、端の座標も決めてください。

DOM/React object、function、認証情報、Hostの製品データ、同期token、private camera/panel状態はcontentへ入れません。明示的に保存するDataのnamed view定義と、その場だけの表示状態は別です。説明文字列だけで復元できない外部assetは、ID/hash・保存方式・欠落時の挙動を定義します。

### 入力検証と互換性

TypeScriptの型はimport JSONを検証しません。`unknown`からdomain validatorを通し、draftだけでなくretained versionのcontentも検証します。[Artifact Core](../packages/artifact-core/src/index.ts)の`deserializeArtifact`が調べるのは共通envelopeであり、新ドメインのcontentを自動検証するものではありません。

Native importでは各versionのcanonical SHA-256を確認し、未知のkind/schema、壊れた参照、不正なasset、上限超過を保存前に拒否します。Importの失敗でlibraryに半端なArtifactを残しません。新しいArtifact IDを割り当てる場合はannotation等のArtifact参照も再結合します。Native element IDは、参照の整合性を保つ方針で扱ってください。

Artifact envelopeの`schemaVersion`とドメインcontentのschemaは別の契約です。移行は明示的・決定的に行い、旧versionのcontent/hashを書き換えません。旧schemaのreaderを残し、必要ならdraftの移行や旧versionのrestoreを新しい編集として適用します。

### Package境界

Model、validation、commands、serializationなどのheadless経路はReact/DOMを必須にしません。必要なpublic subpathを`package.json`の`exports`で公開し、利用側は`@editor-platform/<domain>`等のpublic entrypointからimportします。他packageの内部`src`を参照しません。

既存packageのpublic subpathは同じではありません。`/model`があると仮定せず、各`exports`を確認してください。Root barrelからviewもexportする場合、headless利用者がReactを読み込まずに使えるentrypointを別途用意します。依存関係は循環させず、独立したドメイン間で一方のcontent modelを共有モデルにしません。

## 4. 編集をcommandとtransactionにする

[Editor Core](../packages/editor-core/src/index.ts)の`EditorCommand<T>`はtrusted application codeの変更契約です。操作の結果は新しいcontentとして返し、入力や外部状態を変更しません。`immutableCommand`の最適化契約は、実際にreadonly inputを守れる場合だけ宣言します。

| 操作                                   | 期待する扱い                                                          |
| -------------------------------------- | --------------------------------------------------------------------- |
| 1要素のproperty変更                    | 対象IDを検証し、無関係な要素・field・IDを保持するcommand              |
| 複数選択の編集・貼り付け・fragment適用 | 一つのatomic transaction。失敗したら全体を適用しない                  |
| Drag / resize                          | 一時previewを表示し、確定で1編集。Cancelはcontent/historyを変更しない |
| Text input / IME                       | Editorの入力bufferとplatformの履歴の役割を決め、二重Undoを起こさない  |
| Camera・panel・選択の変更              | 編集履歴やversionに入れない                                           |
| Version restore                        | 現在draftへの新しい編集。過去のversionを変更しない                    |

Localでは`EditorSession<T>`がhistoryとrevisionを持ちます。Typingの`mergeKey`は適切な連続入力だけをまとめ、選択移動等でhistory groupを切ります。Sessionのsnapshot Undoへremote更新を流してはいけません。

Shared操作を宣言する場合、幾何計算などの入力に使ったread dependencyも設計します。`withCommandReads`で対象を示し、必要な場合は`['*']`でcontent全体をpinします。書き込み対象だけ検査して、計算に使った古い値を無条件に適用しないでください。

最低限、適用結果、入力の非破壊、無関係な値の保持、Undo/Redo、失敗/Cancelの無変更を確認します。Snapshot全体が同じことに加え、安定IDや参照、旧version hashも検査します。意図した挙動と別のfieldが一緒に変わる問題を、小さなassertionだけで見逃さないようにします。

## 5. Surfaceを独立して埋め込めるようにする

Surfaceには型付けしたcontent、command executor、selection通知、readOnly、必要なlayout/view propsを渡します。Propsはドメインごとに定義します。共通UIには[`EditorLayoutProps`](../packages/editor-ui/src/index.tsx)等がありますが、全Editorを登録する単一Surface interfaceはありません。

- Package自身がCSSを提供し、Playgroundのstylesheet・store・routerに依存しない。
- Containerの高さ、flexの`min-height: 0`、狭いcontainerでのpanel/overlay挙動を確認する。
- Icon buttonにはaccessible name、入力にはlabelを付ける。Toolbarやmenuのkeyboard移動、Escape、focus復帰を確認する。
- Modal、text input、canvas shortcutが競合しないようにする。IME composition中のEnter/Delete等を通常commandとして誤実行しない。
- Keyboard、pointer、touch、clipboardの各入口を、対応する範囲で同じcommand境界へ通す。
- Read-only時には編集UIとcommand入口を止める。テキスト選択、view移動等の許可される操作を明記する。

独立Hostはpublic packageと自身のcontainer CSSだけで構成します。[既存の埋め込み例](../apps/playground/src/embed.tsx)を参考にしてください。新Editorを既存`embed.tsx`へ追加するか、独立した別entrypointを用意し、そのentryがbuild・検証の対象になるようにします。通常Playgroundでしか動かない実装は、埋め込み対応として受け入れません。

## 6. 選択・annotation・外部提案の契約を接続する

`ElementAddress`はArtifact ID、element ID、必要なregionを持ちます。現在のregionはtext/cell/lines/page/canvasです。新しい時間軸などを既存regionへ誤った意味で詰め込まず、まずelement単位の選択を提供するか、public unionと利用側の処理を明示的に拡張します。

Annotation対応を宣言するなら、座標単位、text範囲、source version、削除や移動後のanchor mappingを定めます。File/Reviewの固定sourceのanchorを、mutable draftの座標として扱いません。Anchorが消えた場合はorphan/outdatedを表示し、別の要素へ黙って結び直しません。

外部操作の実行はHostが担当します。`ExternalOperationRequest`にArtifact/version、selection、入力を渡し、Editorは`ProposedCommands`をpreview/apply/rejectします。Previewでlive contentを書き換えず、apply前にbase revision・対象・権限を再検証し、一つの通常transactionで採用します。`previewProposedCommands`だけでstale判定まで実装済みになるわけではありません。参照したArtifactがあるなら、提案の`reads`に対象と参照元のexact Version IDを記録し、preview開始時とapply直前に`checkProposalReads`（Host Sessionでは`previewHostProposal`／`applyHostProposal`）で再検証します。Shared proposalはshared authorityの経路を使います。

外部入力はデータです。Importしたfunctionや文字列をそのままcommandとして実行しません。UIとheadlessで同じvalidation/command経路を使い、どちらにも利用できる代表操作と失敗結果を検証します。

## 7. Hostと機能別の登録を追加する

`Artifact<T>.kind`はstringですが、参照Hostと機能別packagesにはclosed unionがあります。汎用の`registerEditor()`一回で全機能が有効になる構成ではありません。

| 接続箇所                                                                                 | 追加・確認するもの                                                                  |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`apps/playground/src/model.ts`](../apps/playground/src/model.ts)                        | `Kind`、`Content`、`kinds`、`makeArtifact`、`validContent`                          |
| [`apps/playground/src/App.tsx`](../apps/playground/src/App.tsx)                          | Surface表示、command routing、library、draft/version、import/export、selection      |
| 独立Host / Vite entry                                                                    | public APIのみでの起動、package CSS、build対象                                      |
| [`collaboration-core/src/contracts.ts`](../packages/collaboration-core/src/contracts.ts) | Shared対応する場合の`Domain`・wire/codec/anchor契約                                 |
| [`collaboration-adapters`](../packages/collaboration-adapters/src/index.ts)              | Codec、通常command変換、text/annotation/assets、adapter exports、reference Host接続 |
| [`templates/src/types.ts`](../packages/templates/src/types.ts)                           | 対応する場合の`Domain`/`NativeContent`、author/apply/preview経路                    |
| [`reuse-core/src/contracts.ts`](../packages/reuse-core/src/contracts.ts)                 | 対応する場合のdomain、native adapter、token/style/instance検証                      |
| Tests / Playwright config                                                                | Unitの検出対象、desktop/mobile specs、独立Host、必要なproduction/cross-browser対象  |

全unionへ無条件に追加せず、対応している機能だけを接続します。現在、templates/reuseのnative domain集合はReact UIを含まないなど、集合ごとの対応範囲は異なります。`as any`やdefault branchの無条件acceptで未実装を通してはいけません。

保存はHostの`StorageAdapter`経由で行い、失敗時は「未保存」とretry経路を示します。遅延した保存結果で新しいdraftを上書きしないようにします。Commitは確定対象のcontentとparentを記録し、view操作ではversionを作りません。

## 8. 対応を宣言する機能の追加条件

### Shared editing

[通常Editorの統合契約](editor-collaboration-integration.md)と[coverage](editor-collaboration-coverage.md)を基準に、`DomainCodec<T>`と通常操作の変換を実装します。Wireはserializable operationであり、functionを送るものではありません。Local commandが存在してもshared codecが未対応なら理由付きで拒否します。

Authorityがpermission、precondition、最終content、対象assetを検証し、transactionはatomicにします。Computed operationのread dependency、deleted target、stale revision、重複request、schema mismatchを扱います。Textには適切なengine/step/rebase経路を接続し、whole snapshotで他者の文字を上書きしません。

Shared Undoはactor/sessionの自分の操作を対象とし、他者の変更を消しません。Reconnect、pending/confirmed、Cancel、permission revocation、expiryの通知を処理します。未確定変更や入力bufferが残っている状態のsave/export/restoreは、既存契約に従ってguardします。Private camera/panelを共有contentにしません。

独立browser contextのpeer、通常Surface、headless経路、故障transportで検証します。Reference Hostのin-memory authorityを、production auth/durability対応と説明しないでください。

### Template / linked reuse / token

[Template契約](template-contract.md)と[Reuse契約](reuse-contract.md)を読み、native dataに対して既存command/transaction/proposalを使います。新しいUndo、catalog、agent runtimeを追加しません。

Whole creationは安定request IDとatomic `putIfAbsent`で重複実行を処理します。同じIDで異なるrequest内容はconflictとし、既存Artifactを上書きしません。FragmentのID/reference remapとCancelの無変更を確認します。

Linked reuseはexact version/hashとdependency closureを保持し、更新はpreviewと明示的な採用で行います。Local override、slot/variantの所有権、missing definition、削除、衝突、retained payloadを扱います。Unknown token mode、壊れたalias、cycleを黙ってdefaultへ落としません。Untrusted importではdraftとretained versionの再利用定義も検証します。

### Native以外のimport/export

対応するformat、要素、text/style/asset、loss、warning/rejectionの範囲を宣言します。Native JSONの完全性と、外部形式の近似表現は別の条件です。黙って欠落させないでください。

Office対応では[export契約](office-export-contract.md)と[bounded import](office-import.md)を確認します。ZIP内のXMLやbyte生成のunit結果だけでrender/edit fidelityを保証せず、宣言する互換範囲の実際のopen/render/editを別に検証します。外部readerを未実施ならその制限を残します。Untrusted HTML/SVG/URL/assetは検証・sanitization・sandbox・サイズ上限を通し、import参照から任意の外部取得を開始しません。

### React / Design bridge

[React UI契約](react-ui-contract.md)と[Design/React契約](design-react-contract.md)が該当します。Component原本、build、isolated preview、runtimeはHost所有です。実在する登録実装、typed inputs/slots/bindings、宣言済みsemantics/routesを使用し、unsupportedを診断します。Metadataだけのpreflightを実際のpreview/exportの代わりにしません。Regenerationでは独立した編集を保持し、競合を拒否します。

## 9. 検証から受け入れまで

1. Pure modelの正常/異常入力、境界値、command、Undo、旧schema/importを検証する。
2. Production buildに含まれる独立Hostと通常Hostで、代表操作・保存・reload・read-onlyを確認する。
3. Desktopと狭いcontainer/mobile viewportで操作し、keyboard/focus、clipboard、IME、scrollを対応範囲で確認する。
4. 宣言したshared/template/reuse/format等の条件を検証する。
5. [受け入れ条件](editor-acceptance.md)のIDごとに[検証報告](editor-verification-template.md)へ結果と証拠をまとめる。
6. [文書の記載方針](documentation-guide.md)に従って契約・利用ガイド・statusを更新する。READMEは概要・起動・主要な導線が変わる場合に更新する。

Playwright specは[共通fixture](../tests/e2e/fixtures.ts)を使い、console/page errorで失敗させます。[Playwright設定](../playwright.config.ts)ではmobile projectが`*-mobile.spec.ts`を対象にしています。Specを追加しただけでproduction/CI/cross-browserの[名前付きスイート](../tests/playwright/suites.ts)にも含まれるとは限らないため、`E2E_SUITE=<name> npx playwright test --list`で実際の検出・実行対象を確認します。

Screenshotを保存するだけでなく、panel、focus、overflow、表示内容を確認します。合成composition eventはOSのnative IMEの証拠ではなく、mobile viewportは物理端末の証拠ではありません。何を実施したかを正確に書いてください。

未対応機能を隠して受け入れを通すより、local-only等の範囲を明示して段階的に追加します。機能受け入れ、performance受け入れ、production deployment・製品側のtrialは別の判断です。
