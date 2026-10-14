# Editor usability — Issues #42–#51

2026-10-10、新規10件の本文・全コメント（各0件）とAGENTS、status、開発・受入契約を
確認した。実装は最新main `09a7875` から一つのbranch/PRにまとめる。監査用の製品・
業務定義は転載せず、公開fixtureと既存domain command/Sessionで確認する。

## 実装する範囲

| Issue | 変更する利用体験                                                              | 正本・検証の境界                                                                           |
| ----- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| #42   | ノード本体の移動、選択edgeの端点drag、候補と拒否理由、keyboard form維持       | gesture中はprivate preview、確定は既存intent/adapter経由の1編集。Cancel/stale/readonly拒否 |
| #43   | Graphから元レコード・Fields・Host所有の型/属性/関係定義へ移動                 | projectionの元IDへ通知。型変更はmigration preview/validation、所有元・非編集理由を表示     |
| #44   | 未確定入力をHostへ通知し、保存前に検証・確定。選択/表示切替でも保持           | IME中はflush拒否。無効/stale入力は保存を止めて対象を表示。正本/履歴とbufferを分ける        |
| #45   | 描画と同じ文字layout/fit/rotation/zoomで直接編集。拡大編集は任意              | 共通Canvas text engine、同じdomain text command。paste/selection/合成IME/input Undoを確認  |
| #46   | Make componentからsemantics/props/slots設定、診断の設定誘導、React出力/再利用 | native公開commandと既存converter/publicationを使用。missing-refの二次診断を調査            |
| #47   | canvas焦点のMod-Z/RedoはHost履歴、入力中は入力履歴                            | 共通Host history contract。過去Inspectorのbrowser Undoをcanvasへ流さない                   |
| #48   | ノードを避けるedge経路、方向に合うport、type/labelと両端の強調                | routingは描画のみ。native content/layoutに経路を保存せず、移動・retargetで再計算           |
| #49   | 参照候補は現在の表示名、diagnosticはcode/argsとlocaleで表示                   | 内部IDは値/詳細として保持し、renameにも追従                                                |
| #50   | スライド複製を元の直後へ挿入し、新ページを選択                                | native IDをremap、1回の文書Undo。保存/reload確認                                           |
| #51   | 明示名を尊重し、本文抜粋と本文検索から選択・pan・強調                         | 検索はprivate view、本文変更に追従しcontent/historyを変えない                              |

## Hostと互換性

参考デモは未マージPR #37とSite overrideを含む。mainにはそのHost/packageがないため、
本PRでは他PRを統合せず、必要な汎用契約を既存core/UIと通常・独立Hostへ接続する。
Data Grid/Form/Graphは一つのData正本、Canvasは各domain正本を維持する。新しい履歴・
catalog・認証・業務modelを作らない。Host所有Profileや登録React実装を無断で変更しない。
未対応shared経路をlocal snapshotへfallbackせず、既存authority/selective Undoを維持する。

## 検証計画

10件を通常UIの操作・保存・reload・Undo/Redo・readonly・Cancel/invalidへ対応付ける。
production desktop/mobileとpublic APIだけの独立Host、関連既存回帰を確認し、console/
pageerrorを失敗にする。画像は目視する。Unit、lint、strict TypeScript、build、tooling、
format/file guard/public export scanを行い、実施した範囲・初期FAILを記録する。

性能測定・調整と自動Actionsは停止、#22性能合格は保留。試用・実Framework・実機/native
OS IME・production auth/durabilityは別判定。生成画像/ログ/export/dist/fontsはGit外。
本書は設計・計画であり、未実施の条件をPASSとする検証結果ではない。

## 実装・検証への対応

Host契約は[embedding](embedding.md#pending-inputs-and-keyboard-history-44--47)、
Graph定義・routingは[Graph contract](structured-graph-contract.md)へ反映した。
Canvasはdrawing projectionとProseMirrorのdisplay-only wrap/fitを共有し、同じnative text
commandへ戻す。native版にsoft wrapを加えず、toolbarは倍率外、入力自体は元のworld
transform内に置く。拡大入力も同じbufferで、第二のtext editor/historyを作らない。

DesignのMake componentはnative definition/instanceを維持し、公開設定wizardへ進む。
単一templateは同じ見た目のnative一部品definitionとしてHTML意味を設定する。props/slots
の参照と許可先を確認し、既存公開版を上書きせず、converterと既存Host publicationを
通す。未公開componentで変換graphが作れないときの二次missing-ref診断を抑え、主原因を
公開設定へ案内する。成功時の厳密なReact検証は継続する。元TSXはHost所有のまま。
shared Hostが受け付けない公開commandは設定画面にも非編集理由を表示する。

スライド複製はcopy/native IDをcommand作成時に固定し、preview/実行で一致させる。
Whiteboardの本文検索・抜粋・結果へのfitはprivate viewで、明示名とnative本文を保持する。
実際のPASS/FAIL/NOT RUNは[今回の検証報告](verification/issues-42-51/README.md)へ記録する。
