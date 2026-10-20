# 可変テンプレートの直接編集（#27）

既存7 Editorのnativeモデル、カタログ、操作、版、共同編集、selective Undoを使う。
#24の外部React UIの取り込みとは独立。製品固有の生成・prompt・agent実行はHostに属する。
テンプレートを使わない自由作成・編集を引き続き利用できる。

| Editor      | ギャラリーで選ぶ単位                   | 正本と再配置の対象                                             |
| ----------- | -------------------------------------- | -------------------------------------------------------------- |
| Slide       | ページ・ページ内の部品・全体セット     | nativeページ/objects。寸法・順序・notesを維持                  |
| Whiteboard  | セクション・接続を含む図解・全体セット | native sections/nodes/connectors。所属と接続、無限Canvasを維持 |
| Design      | フレーム・複合部品・全体セット         | native elements/components。個別overrideを維持                 |
| Document    | 見出し付き本文・表・全体セット         | native意味構造。変更は既存の本文engine steps                   |
| Data        | 型付き列セット・ビュー・全体セット     | native columns/rows/views。列対応・型・式・参照を事前検証      |
| Review      | 表示・比較・注釈作成の設定             | 個人表示設定のみ。原本・既存共有注釈は変更しない               |
| File/Viewer | 表示・注釈作成の設定                   | 個人表示設定のみ。原本bytes/hash・既存共有注釈は変更しない     |

## 入力・直接編集・再配置

基本操作は選択→native描画のプレビュー→作成/挿入/設定適用→成果物上で直接編集。
本文の別フォームは任意の挿入前設定。Dataの既存列への対応付けは適用前に確認する。
Galleryのカードは代表的な本文を表示し、全体をクリックして大きなプレビューを開く。
Editor・用途の検索と再利用単位の絞り込みがあり、挿入ボタンにも追加する単位を表示する。
Slideの代表カードは複数ページの表紙だけを使わず、中身のある本文ページを選ぶ。

可変構成は既存のtyped listとrepeatを拡張する。同一比較定義に2件/3件、同一手順定義に
3件/4件を渡す。各項目に安定IDを要求し、追加・削除・並べ替えでIDを再採番しない。
件数は一覧の長さから導出。公開する配置はauto/horizontal/vertical。定義で最少/最大件数、
展開量、nativeの親・役割を宣言する。入れ子の可変repeatは対象外で、誤った参照を拒否する。
有限ページに収まらない場合は対象と別配置/ページ分割の案内を示し、省略/縮小で通さない。
追加例は5種×比較/手順の10定義。対応は各1〜6項目・1 repeat・`id`キー固定、可変repeatの
入れ子・chunk/page自動分割は非対応。一般契約の上限は12項目。Doc/Dataはnativeの流れを
用いる自動/縦配置、Canvasは自動/横/縦配置。Dataの追加列はtext/number/booleanで、
既存の型・数式・値・参照はnativeのまま保持する。

挿入後の本文・画像・スタイルはnative内容のみを正本とする。入力フォームの値を本文と
同期する第二の保存場所は作らない。既存ReuseStateのinstance/partsと正確なretained closureを
使い、項目とnative要素の対応、配置方針、直前の自動配置のgeometryだけを保持する。
再配置は現native内容へgeometryの差分を適用し、手動調整を保持する。
削除のプレビューには消える項目/要素を明記。外部の接続、所有外の子、列依存等を壊す
削除は拒否し、先に参照を直すよう案内する。古い準備結果は既存preconditionで拒否する。
Documentでは管理する見出しから次の同階層以上の見出しまでを意味上の項目として扱い、
その中へ直接追加した本文・画像も一緒に移動する。削除プレビューには追記した要素のIDも
表示し、既存engineのUndoで戻す。別の見出しを項目間へ差し込んで対応が崩れた場合や、
別の再利用部品が管理する本文を削除する場合は診断する。例の公開入力は見出し/本文に
限り、未使用の画像入力を置かない。画像はnative本文で追加する。
Canvasでは項目ごとに見出しを強調し、説明/画像の表示を切り替えられる。値はnativeの
typography/hiddenまたはDesign子部品のoverrideから読み、設定変更も同じnative操作へ
変換する。本文を消さずに表示だけを変え、Undoと再配置で保持する。共通色・フォント等は
既存のstyle/token編集を使う。Whiteboardの並べ替えは配置を変え、既存の接続先・ID・
ラベル・ポートを保持する。接続先の編集はnative Whiteboard上で行う。
管理中の役割の削除/差替えで対応が崩れた場合は対象を診断し、Undoまたは「構成の管理を
解除して自由編集」で回復できる。解除は本文・画像・配置を残す。
native JSONの読み込みでは、不正な原本・hash・役割対応を拒否する一方、自由編集で
native参照先だけがなくなった構成は読み込む。構成パネルに「要修復」を表示し、管理解除を
選べる。保存済みの過去版にもこの区別を適用し、そのnative内容・管理情報・hashを変更しない。

## コピー・リンク・公開版

独立コピーと原本へのリンクを区別する。どちらも通常編集は配置済みnativeに適用する。
リンクの採用元はID/version/hashで固定。原本の新しい版を自動反映せず、影響のプレビューを
経て明示採用する。旧公開版・旧配置・保存済みnative importを上書きしない。
新しい版は既存カタログへ公開し、第二のライブラリ/保存/履歴基盤を作らない。
配置済み構成の採用版と公開先の最新番号は別に扱う。公開先のアーカイブ済み版も含めて
次版を採番し、v1採用のまま二度保存するとv2・v3を公開する。既存版は上書きせず、
同時に異なる内容が同じ番号へ公開された場合はカタログの`version-conflict`で拒否する。
構成は共通styleとは分離する。Dataの型/式はstyleでは変更しない。
新版の保存は管理対象の静的フィールド、先頭項目の見た目/書式、各項目の現在本文を
新しいrecipeへ取り込む。先頭項目の見た目が追加項目の標準となり、配置済みの個別差分は
nativeに残る。原本更新の採用は同じ役割・配置先の定義だけに限定し、既存の本文・画像・
書式を保って配置と今後の追加項目へ反映する。役割の変わる新版は別挿入として扱う。
Designの部品定義が変わる更新は、新版の部品グラフを別のnative component IDへ保持する。
既存カードは旧定義と個別overrideを参照し続け、更新採用後の追加カードだけが新版を使う。
子のIDはcomponent内のscopeで維持する。追加がない採用でも新版定義を保存し、後の追加・
再読込で利用する。旧・新版が混在する構成を原本として公開するときも、先頭カードが実際に
参照する部品定義から見た目を取り込む。
自由に追加した管理外の要素・任意の接続グラフ・既存Dataレコードを可変recipeの公開へ
取り込むことはしない。管理外の内容は従来の全体テンプレート/部品保存を使う。

画像未指定の任意枠はIDを持つnative非表示要素として残す。初版への画像入力は表示して
挿入され、挿入後の画像設定・表示はnative Editorと構成パネルで変更する。明示して表示した
枠に画像がない場合、Officeの既存asset診断を回避しない。Officeは可変recipe/リンク情報を
保持しないため、既存の損失警告を確認して出力する。構成の継続編集にはnative JSONを使う。

Designの複合部品内の文字は既存native override操作で編集する。編集中に同じ文字・書式が
他者に変更された場合は適用を拒否し、private入力を残して診断する。入力をコピーして
キャンセルし、現在のnative内容を確認してから編集し直す。normal canvas textの既存共有
engineを置き換えない。入れ子のinstance内も、描画された文字をダブルクリックして編集できる。
`overrideInstance(elementId, partIds, patch)`へ階層ごとのnative IDを配列で渡す。
従来の単一part ID文字列も利用できる。配列は1〜16階層で、単一要素の部品定義では
末尾に`root`を指定する。区切り文字を含むIDを分解せず、定義・別instanceを変更しない。
配列経路は各階層の非表示/lockを検証し、隣接する既存overrideを保持する。
`locked`/`hidden`だけのpatchは末端の状態を解除できる。祖先の状態は引き続き検証し、
文字や見た目の変更を混ぜたpatchでlockを迂回できない。
nativeのoverride mapは置換なので、継承している同階層のoverrideも現在値として保持する。
単一要素部品のCanvas編集後にInspectorや従来の文字列part APIで変更する場合も、
同じ有効な文字・色へ反映する。既存root値に隠れるフィールドは同時に更新し、
未変更の書式は保持する。Inspectorの平文入力は古いrich runsをクリアする。
共有style/rootによる有効なlock/hiddenも直接文字編集の対象を生成する前に検証する。
共有時は既存のoperation/authorityで適用し、対象instanceと祖先・参照する部品定義・style・遷移先frameの
準備後の変更を拒否する。別instanceや無関係な定義・styleの変更とは競合させない。
同一instanceのoverride mapは一つの競合単位で、文字単位の共同マージは宣言しない。
16階層を超える文字には直接編集対象を生成せず、headlessの過剰な経路も拒否する。
[テンプレート契約](template-contract.md)も参照。

## 人・AI・検証

可変Designの収まりは、定義のplaceholderだけでなく、配置するinstanceの有効な本文・
書式・clipで検査する。収まらない本文は挿入/再配置の準備時に拒否し、元のnativeを保つ。
通常フォームでは安定した項目IDの診断を現在の入力欄へ対応付け、並びと診断がずれない。
広い枠が必要なら原本の新しい版を作り、既存の公開版は変更しない。

Hostは同じ公開TemplateDefinition/InputFieldから用途・安定ID・件数・制約を取得する。
UIとHostの双方が同じprepare/diagnostics/proposal/applyを使い、外部操作は承認済み
transactionの適用に限る。再送は既存receipt、共同編集はauthorityとselective Undoを使う。
Review/Viewerの個人設定は本文Undoに入れず、共有注釈の操作と分離する。

公開APIは`structureTemplates`/`TemplateCatalog.list/getVersion`で定義を取得し、
`prepareInstantiation`/`prepareInsertion`と既存のapplyを使用する。挿入後は
`readStructure(content, instanceId)`から安定IDと現在本文の表示名を取得する。
`prepareStructureChange({state, identity, instanceId, items, layout, relationship,
appearance, definition, requestId})`の`items`は既存項目には`{id}`だけ、新規項目には
定義の必須入力も渡す。既存本文・画像・型の書換えを入力から要求すると診断になる。
`appearance`はIDとemphasized/descriptionVisible/imageVisibleの任意booleanで、
定義にnative表示対象が宣言された場合に使える。省略した項目設定は現nativeを保持する。
`definition`を渡す原本更新はlinkedかつ新しい版に限定し、prepareのnotices/previewを
確認して適用する。構成パネルとHostの公開は
`publishStructureVersion(content, instanceId, catalog)`を使う。公開先の最新番号を確認し、
native内容の所有済みsnapshotから新版を作って既存`CatalogAdapter.put`へ保存する。
`captureStructureVersion(content, instanceId, nextVersion?)`と
`createStructureVersion(old, changes, nextVersion?)`は保存前の定義を作る低水準APIである。
番号を省略した場合は採用版+1なので、連続公開には公開先を確認する上記APIを使う。
構成recipeは既存ReuseStateに正確なclosureを保持するため、元カタログのないnative
importでも編集できる。本文の既存編集APIによる自由作成も引き続き選べる。

Editorごとの実装・検証状況はdocs/status.mdに分けて記録する。実資料の試用は利用側で行う。
その比較結果をEditorの自動試験で代用しない。#22の未達3条件と性能停止は継続する。
GitHub Actionsは利用時間切れのため停止中。生成画像・ログ・exportはGitに追加しない。
