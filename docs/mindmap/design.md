# Mindmap Editor：設計書

設計版0.1、2026-11-21。状態は**設計レビュー前**。実装・検証は段階M1〜M5の別PRで行い、結果は検証報告へ記録する。この文書は[設計テンプレート](../editor-proposal-template.md)に沿い、[開発ガイド](../editor-development.md)と[受け入れ条件](../editor-acceptance.md)を併用する。

## 提案の情報

| 項目                      | 内容                                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Editor名 / kind / package | Mindmap / `mindmap` / `@editor-platform/mindmap-core`（headless）と`@editor-platform/mindmap`（Surface）                           |
| 設計の版 / 更新日         | 0.1 / 2026-11-21                                                                                                                   |
| 実装・レビューの担当      | 実装: Claude（coding agent）、レビュー: リポジトリ所有者とCodex                                                                    |
| 対象PR / 検証報告         | 設計: この文書のPR。実装: integration branch `feat/mindmap`へのM1〜M5。検証報告: `docs/verification/mindmap/README.md`（M5で作成） |
| 提案段階                  | 設計。M5でlocal機能受け入れを目標にする                                                                                            |
| 利用シナリオ              | paobub-dogfooding `projects/shinonome-ev-circular/PLAN.md`の段階B1（道具E1）。ドメインモデルはそのシナリオやPaoBubに依存させない   |

## 目的と代表操作

- 利用者と作業: 企画・調査・設計の担当者が、一つの問いから考えを枝として広げ、並べ替え、まとめる。複数人の観点（例：企画・財務・法務）を枝として足し、AIの提案を枝ごとに取捨し、図・文書・スライドへ持ち出す。
- 代表的な正常操作:
  1. 中心のトピックを選び、Tabで子、Enterで兄弟を足しながら続けて入力する（IME確定後のEnterだけが兄弟追加）。
  2. 枝をドラッグして別の親へ移す、または兄弟の順を変える。一つのdropが一つの編集で、Undoで元に戻る。
  3. 外部（AI等）が出した候補を、トップレベルの枝ごとに差分で見て、採用する枝だけを一つの編集として適用する。
- 想定する拒否・失敗操作:
  1. 枝を自分の子孫の下へ移す（循環）→ 拒否し、contentと履歴は変わらない。
  2. 上限（ノード数・深さ・文字数）を超える貼り付け・import → 全体を拒否し、部分的に入れない。
  3. 古いrevisionに対して作られた提案の適用 → staleとして拒否し、再提案を求める。
- 新しいnative domainが必要な理由: 意味の中心が「一つの根を持つ、順序付きの木」と「その木から決定的に計算する配置」にある。
  - [Structured Graph](../structured-graph-contract.md)は型付きProfileのnode/edgeと自由な座標（`presentation`）が意味の中心で、edgeに兄弟の順序がなく、根・左右の振り分け・木の不変条件（親は一つ、循環なし）を持たない。Profileとtree layoutを足して表すと、全ノードが位置を持つかどうか、edgeの順序、子の追加時の再配置という二つの意味が一つのcontentに混ざる。
  - [Whiteboard](../surface-semantics.md)は自由配置の図形とconnectorで、構造を持たない。手で描いたmindmapは表せても、Tab/Enterの入力、枝の折りたたみ、自動配置、枝単位の差分にならない。
  - 同じレコードの別の見え方（Structured Dataのprojection）では足りない。ブレインストーミングの枝はレコードになる前の考えで、レコードと一対一でない。レコード（例：工程定義の項目）の木を見せる用途は、Host側のprojectionとして別に扱う（後述「Hostのprojection」）。
- このEditorで扱わないもの: 自由配置の図形や矢印（Whiteboard）、型付きの関係（Structured Graph）、ノード間の任意の交差リンク、画像・添付ファイル、共同編集、承認やプロジェクトの状態（Host）、AIの実行（Host）。

## 能力matrix

| 能力                                | 宣言する範囲・上限                                                                            | 状態     | 非対応の理由・拒否方法 / 関連条件                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------- |
| Viewer / local編集                  | 追加・編集・削除・移動・並べ替え・折りたたみ・色・印・メモ・リンク・配置の種類。Undo/Redo     | 実装予定 | N01–N14                                                        |
| Text / native IME                   | ノードの本文（1行）とメモ（複数行）。composition中のEnter/Tab/Deleteを通常commandにしない     | 実装予定 | C01。実OS日本語IMEは環境があればRUN、なければNOT RUNと記録     |
| Selection / annotation              | 選択はノードIDの`ElementAddress`（region無し）。Annotationはノード単位のanchorだけ（M4）      | 実装予定 | N08 / C02。ノード削除でorphan表示、別ノードへ結び直さない      |
| 外部proposal / headless             | `ProposedCommands`のpreview/apply/reject、トップレベル枝ごとの部分採用、headlessで同じcommand | 実装予定 | C03                                                            |
| Shared editing                      | なし                                                                                          | 非対応   | collaboration-coreの`Domain`に追加しない。shared入口を出さない |
| Template: whole / fragment / preset | なし                                                                                          | 非対応   | templates/reuseのunionに追加しない                             |
| Linked reuse / token / style        | なし                                                                                          | 非対応   | 同上                                                           |
| Native JSON                         | Artifact envelope（draft＋保持版）とcontent単体の候補JSON                                     | 実装予定 | N10                                                            |
| Native以外のimport/export           | 出力: 保存版のSVG/PNG、Markdownの箇条書き。入力: Markdownの箇条書き。lossは下表               | 実装予定 | C07。OPML・FreeMind・XMind・PPTXは非対応（拒否メッセージ）     |
| React preview / TSX / bridge        | なし                                                                                          | 非対応   | 該当しない                                                     |
| Large asset / offline / recovery    | assetを持たない。保存はHostの既存draft/version                                                | 非対応   | assetを持たないため。保存の失敗表示とretryはHost既存経路       |
| Browser / 実機 / accessibility      | Chromium desktop/mobile viewport、keyboardだけでの操作、ツリーのaccessible role               | 実装予定 | N11 / C10。実機touch・screen readerはNOT RUNとして記録         |

## Native model

```ts
type MindmapLayout = 'radial' | 'right' | 'tree';
type MindmapMark = 'question' | 'idea' | 'decision' | 'risk' | 'todo' | 'done' | 'star';

interface MindmapContent {
  schemaVersion: 1;
  id: string; // 文書ID
  rootId: string;
  layout: MindmapLayout;
  nodes: Record<string, MindmapNode>;
}

interface MindmapNode {
  id: string; // `n-`＋ランダムな英数字（16〜64文字）。根も同じ形式
  text: string; // 1行。改行を含めない
  children: string[]; // 順序付き。順序が意味を持つ
  side?: 'left' | 'right'; // 根の直接の子だけ。radialで左右の振り分けを固定
  collapsed?: boolean; // 保存する見た目（下記）
  color?: string; // 3/6桁hex。子孫は親の色を継ぐ（未指定時）
  marks?: MindmapMark[]; // 重複なし、最大4
  note?: string; // 複数行のメモ
  link?: { namespace: string; id: string }; // 不透明な外部参照（例 { namespace: 'owd-item', id: 'OP-01' }）
}
```

- Content schemaは1から始める。Artifact envelopeの`schemaVersion`とは別の契約で、envelopeは既存のArtifact Coreのまま。未知のschema（2以上）は理由付きで拒否する。
- 木の不変条件: 根は一つで親を持たない。根以外の全ノードはちょうど一つの親の`children`に一回だけ現れる。根から到達できないノード、循環、重複を拒否する。`side`は根の直接の子だけが持てる。
- IDの発行: 新しいノードのIDは、command（純関数）の外でHostが渡すID発行関数（既定は`crypto.getRandomValues`による128 bitのランダム値）で作り、commandの引数として渡す。contentに通し番号の`nextSeq`を持たないので、Undoでcontentを戻しても発行済みのIDが巻き戻らず、Undoで消したノード・削除したノードのIDが別のノードに再び使われない。そのため、contentとは別に保存されるannotation（`Annotation.anchor`）や保持版の旧参照が、新しいノードへ黙って結び付かない（orphanのまま残る）。発行したIDが現在のcontentに既にあればcommandは拒否し、発行関数を呼び直す。Redoは記録した同じIDで再適用する。テストでは決定的な発行関数を差し込む。
- 複製・貼り付け・importでのID: Markdown importと貼り付けは常に新しいIDを発行する。Native candidate（AIの提案や段階的な詳細化）は既存IDを保ったまま差し替える。
- 座標を保存しない: 位置は`layout`・木の順序・`side`・`collapsed`・文字の大きさから毎回決定的に計算する。手でずらした位置は持たない（Whiteboardへ書き出してから自由に動かす）。
- 保存する見た目とprivate view stateの境界: `layout`・`collapsed`・`color`・`marks`は版とhashに含む（共有した図の見え方として保存）。camera（pan/zoom）・選択・編集中のbuffer・hover・Viewerでの一時的な展開は保存しない。Read-onlyのViewerでは折りたたみの切替をprivate stateで上書きでき、contentを変えない。
- 上限（入力サイズの機能上限。性能の保証ではない）: ノード2,000、深さ16、一つの親の子200、本文200文字、メモ4,000文字、`link`の各文字列128文字、canonical UTF-8で512 KiB。
- Validator: `unknown`から検証し、未知field・不正なhex・非有限値・上限超過・壊れた木を拒否する。draftと全保持版に同じvalidatorを通す。
- 空状態: 新規作成は根一つ（本文「中心のテーマ」）で、根の削除は拒否する。根の本文を空にすることはでき、表示では仮の文字を出す。
- `link`は不透明なmetadata。存在確認・権限・意味の解釈はHostが行い、Editorは表示と編集だけを行う（Fiction Mapの`worldEntityRef`と同じ扱い）。
- Assetは持たない。

## 自動配置

`mindmap-core`の純関数`layoutMindmap(content, measure, options)`が、表示するノードごとの矩形と枝の線を返す。結果は保存しない。

- `right`: 根を左に置き、子を右へ広げるtidy tree。兄弟の順は上から下。
- `tree`: 根を上に置き、子を下へ広げる組織図型。
- `radial`: 根を中央に置き、根の子を左右に振り分ける（`side`があれば従い、なければ順に交互）。左右それぞれをtidy treeとして配置する（全周の放射状ではなく左右対称の型。一般的なマインドマップの見た目に合わせる）。
- 折りたたんだノードの子孫は配置しない。子の数を印で表示する。
- 文字の大きさは`measure(text, level)`で受け取る。Surfaceはブラウザで計測し、headless（SVG出力・テスト）は決定的な推定幅を使う。保存版のSVGは推定幅を使うので、画面とSVGの改行位置が完全には一致しない場合がある（既知の制限として記録する）。
- 同じcontentと同じmeasureからは同じ配置になる（テストで固定する）。

## 操作と履歴

| 利用者の操作                               | Command / 対象・read依存                                 | Atomic単位・Undo                                        | 拒否・Cancelの条件                                        |
| ------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------- |
| 子を足す（Tab）・兄弟を足す（Enter）       | `addChild(parentId, index?, text)`・`addSibling(id)`     | 1回で1編集。追加と同時に本文入力へ                      | 親が存在しない、上限、根の兄弟                            |
| 本文の入力                                 | `setText(id, text)`、`mergeKey`は`text:<id>`             | 同じノードの連続入力を1グループ。選択移動・確定で区切る | composition中は確定しない。Escapeで入力前に戻す（無変更） |
| 削除（Delete）                             | `deleteSubtree(id)`                                      | 子孫ごと1編集                                           | 根                                                        |
| 移動・並べ替え（ドラッグ、Alt+↑↓、Alt+←→） | `moveNode(id, newParentId, index)`、read依存は祖先の連鎖 | drop確定で1編集。ドラッグ中はpreviewのみ                | 循環、上限、根。Escapeでドラッグ中止（無変更）            |
| 折りたたみ（Space）                        | `setCollapsed(id, bool)`                                 | 1編集（保存する見た目）                                 | 子がない。Read-onlyではprivate state                      |
| 色・印・メモ・リンク                       | `setStyle`・`setMarks`・`setNote`・`setLink`             | Inspectorの確定で1編集                                  | 不正なhex・上限。未確定のInspectorは保存/切替をblock      |
| 配置の種類                                 | `setLayout(layout)`                                      | 1編集                                                   | 未知の値                                                  |
| 箇条書きの貼り付け・import                 | `insertOutline(parentId, index, outline)`                | 全体で1 transaction                                     | 上限・深さ超過は全体を拒否                                |
| 提案の採用                                 | `proposalCommand(current, candidate, acceptedBranches)`  | 採用した枝の全変更で1 transaction                       | base revisionの不一致、対象の削除、権限                   |

- Local history: Hostの`EditorSession`を使う。camera・選択・private展開は履歴に入れない。
- 入力buffer: 本文の編集はSurface内のinputが持ち、確定（Enter/Tab/blur）で`setText`を1回発行する。未確定の入力は`EditorInputs`へ登録し、保存・書き出し・Artifact切替をblockする。
- Read-only: Surfaceは編集UIとkeyboard commandを止める。Headless・proposalの入口もHostの権限で拒否する（UIのreadOnlyだけに頼らない）。
- Proposal: 外部（AI等）は、既存IDを保った候補の`MindmapContent`とbase revision・`reads`を出す。`mindmap-core`は現在のcontentと候補の差分を、トップレベルの枝（根の直接の子）ごとにまとめる（根の本文・`layout`の変更は「全体」グループ）。利用者が枝ごとに採用/不採用を選ぶと、採用した枝の変更だけを反映した一つのcommandを作り、既存の`ProposedCommands`（`reviewProposedCommands`・`ProposalDiffAdapter`）の経路でpreview/apply/rejectする。今の`ProposedCommands`は任意のcommandを部分的に採用する仕組みを持たないため、部分採用はこのドメインの候補contentの段階で行い、editor-coreの契約は変えない。Previewはlive contentを書き換えない。適用直前にbase revision・対象の存在・権限を再検証する。異なる枝をまたぐ移動は両方の枝が採用されたときだけ適用し、片方だけなら理由付きで採用不可にする。
- Shared: 非対応。
- Annotation（M4）: anchorはノードID。ノードの移動・改名ではanchorを保つ。削除でorphanになり、表示で知らせる。

## Surface・Host・保存

- Entrypoint: `@editor-platform/mindmap-core`（model・validator・commands・layout・outline・proposal-diff・SVG出力。React/DOM不要）と`@editor-platform/mindmap`（`MindmapSurface`とpackage CSS）。
- Props: `content`、`execute(command)`、`readOnly`、`selection`/`onSelectionChange`（ノードID）、`inputs`（`EditorInputs`）、`measure`の差し替え（任意）。Camera・panelはSurfaceのprivate state。
- 描画: SVG。ツリーは`role="tree"`/`treeitem`、`aria-expanded`、`aria-level`を付ける。
- Keyboard: 矢印で移動（配置の向きに合わせる）、Tab子、Enter兄弟、F2または文字入力で編集、Delete、Space折りたたみ、Alt+矢印で移動、Ctrl/Cmd+Z/Shift+Z（Hostの履歴）、Escape。Composition中のEnter/Tab/Deleteは通常commandにしない。
- Pointer・touch: クリック選択、ダブルクリック編集、ドラッグ移動（drop先の候補を表示）、背景のドラッグでpan、wheel/pinchでzoom。狭いcontainerではInspectorを下のpanelにする。
- Clipboard: 選択した枝をMarkdownの箇条書きとしてcopy、箇条書きのpasteを`insertOutline`へ通す。
- Playground登録（M3）: `apps/playground/src/model.ts`の`Kind`・`Content`・`kinds`・`makeArtifact`・`validContent`、`App.tsx`のSurface表示・command routing・保存/版/restore・import/export・selection。
- 独立Host（M2）: `apps/playground/src/embed.tsx`へ追加するか、別のVite entryを作り、public packageとそのCSSだけで起動する。Build対象に含める。
- Hostが持つもの: 認証、永続化、権限、AIの実行、`link`の解決、承認・プロジェクトの状態。
- 保存: 既存の`StorageAdapter`のdraftと明示的な版。Restoreは現在draftへの新しい編集で、旧版のcontent/hashを変えない。遅延した保存結果で新しいdraftを上書きしない（既存経路）。
- Native import: draftと全保持版のcanonical SHA-256とdomain validatorを通し、どれかが失敗すれば全体を拒否する。新しいArtifact IDを割り当て、ノードIDは保つ。

## 機能別adapterと互換性

- Closed union: Playgroundの`Kind`だけに追加する。collaboration/templates/reuseには追加しない。
- 外部format:

| 形式              | 方向 | 保つもの                                           | 失うもの・扱い                                                                     |
| ----------------- | ---- | -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| SVG（保存版から） | 出力 | 配置・本文・色・印・枝の線。折りたたみは状態どおり | メモ・リンクは出さない。選択・cameraは出さない。改行位置は推定幅                   |
| PNG（保存版から） | 出力 | SVGと同じ                                          | Hostのrasterizer/フォント環境による                                                |
| Markdown箇条書き  | 出力 | 本文・階層・順序。メモは子の引用行                 | 色・印・リンク・`side`・`collapsed`・`layout`は失う（警告に件数を出す）            |
| Markdown箇条書き  | 入力 | 本文・階層・順序                                   | 新しいIDを発行。見出し・表・リンク記法は本文の文字として扱う。上限超過は全体を拒否 |

- ほかのEditorへの持ち出し: Document・Slide・Designへは保存版のSVG/PNGを既存の画像挿入で使う。版に結ぶ固定参照（artifact-references）と、Slideで枝ごとに登場させるアニメーションは、それぞれ道具E5・E4の段階で別に設計する（この設計の範囲外）。Whiteboardへの変換（自由に動かせる図形とconnectorへの書き出し）はM5の候補とし、時間が足りなければ後続に回す。
- 既存Hostへの影響: 新しいpackageとPlaygroundのkindの追加だけで、既存のpublic API・schemaは変えない。

## Hostのprojection（工程定義の項目を木で見る）

Open Workflow Definitionsの`as: "mindmap"` view（`items`・`parent`・`layout`・`colorBy`・`colors`）は、Hostが持つ項目のレコードを木として見せるprojectionで、このEditorのnative contentではない。

- `mindmap-core`は、Hostが`{ id, text, parentId, color?, marks? }[]`から読み取り専用の`MindmapContent`を作る純関数`mindmapFromRecords`を提供する。親が見つからない・循環するレコードは根の直下の「未分類」に集め、診断を返す。
- Host（PaoBub）は、これを`MindmapSurface`の`readOnly`で表示し、ノードの選択を項目を開く操作へつなぐ。項目そのものの追加・親の変更をmindmapから行う経路はこの設計では提供しない（Hostの項目編集を使う）。
- Native mindmapのノードは`link`で項目を指せる。ブレインストーミングの枝（native）と、確定した項目（Hostのレコード）を別に保つ。

## 安全性とperformance計画

- 入力はすべてdata。本文・メモはtextとして描画し、HTML/Markdownとして解釈しない。SVG出力は文字をescapeし、外部参照（URL・画像）を含めない。
- 依存: 新しい第三者依存を足さない予定（tidy treeは自前の実装）。アイコンは既存の`lucide-react`。
- 固定fixture: 小（12ノード、深さ3）、中（300ノード、深さ6、折りたたみ混在）、上限（2,000ノード、深さ16）。それぞれradial/right/tree。
- 追加のperformance測定・tuningは停止中。上記のfixtureで配置・描画が機能的に動くことだけを確かめ、時間の計測値は性能の主張にしない。

## 実装・検証計画

Integration branch `feat/mindmap`（mainから）に段階PRを入れ、全段階の後にmainへの受け入れPRを一つ出す。

| 段階 | 変更対象file/package                                                               | 完了条件ID                              | 検証scenario・環境                                                                       |
| ---- | ---------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------- |
| M1   | `packages/mindmap-core`（model・validator・ID・commands・layout・outline・SVG）    | N02 N04 N05（headless） C07（Markdown） | unit: 正常/異常/境界、木の不変条件、Undo、IDの非再利用、配置の決定性、Markdown往復とloss |
| M2   | `packages/mindmap`（Surface・CSS・keyboard・IME guard・pointer）、独立Host entry   | N06 N08 N09 N11 C01                     | Playwright desktop/mobile: 独立Hostで代表操作、composition中のEnter、readOnly            |
| M3   | Playground登録、保存・版・restore・import/export・SVG/PNG                          | N03 N07 N10 C07                         | Playwright: 新規→編集→保存→reload→版→restore→native import（壊れた版の拒否を含む）       |
| M4   | proposal（枝ごとの差分と部分採用）、annotation（ノード単位）、`mindmapFromRecords` | C02 C03                                 | unit＋Playwright: preview無変更、部分採用、stale拒否、orphan表示、projectionの診断       |
| M5   | 文書（README・status・利用ガイド）、検証報告、回帰、（候補）Whiteboardへの変換     | N12 N13 N14                             | lint/typecheck/unit/build、関連Editorの回帰、条件IDごとの結果                            |

- 各段階のPRは、範囲・検証・既知の制限を書き、Codexのレビューで範囲内の指摘が0になったらintegration branchへ入れる。
- PaoBub側（OWDの`as: "mindmap"`をこのSurfaceで表示し、mindmapの成果物をこのEditorで開く）はPaoBubのリポジトリで別に行い、受け入れK1（PaoBubの成果物から開き、編集・保存・再読込）で確かめる。
- Actions CIは停止中のため、実行したcommand・環境・結果を各PRに記録する。

## 設計レビューで残す判断

- 合意を求める範囲: 新しいkind `mindmap`（Structured Graphの拡張にしない）、座標を保存しない自動配置、`collapsed`・色・印を保存する見た目にすること、local-only。
- 意図的に先送りするもの: 共同編集、template/reuse、OPML等の外部形式、ノード間の交差リンク、画像の添付、全周の放射状配置、Slideでの枝ごとの登場（E4）、版への固定参照（E5）、mindmapからHostの項目を直接編集する経路。
- 未決定・リスク: 画面とSVGの改行位置の差（推定幅）、実OS IMEと実機touchの検証環境。
- 機能受け入れを妨げる条件: N01–N14と宣言したC01・C02・C03・C07・C10のうち適用される条件にFAILかNOT RUNが一つでも残れば、その範囲をlocal機能受け入れ済みにしない（[受け入れ条件](../editor-acceptance.md#段階ごとの受け入れ)）。例えば実OS日本語IMEがNOT RUNなら、C01を宣言から外すのではなく、受け入れ済みと説明しない。integration branchやmainへprototypeとして入れるかどうかは、露出範囲・未検証の条件・影響を明記した別の判断として扱い、受け入れとは混同しない。Performance・releaseも別の判断。
- 見直す契約: 候補contentの段階での部分採用で足りない場合はC03とproposal-reviewの契約を、projectionの要件が増えた場合はHost統合の契約を見直す。
