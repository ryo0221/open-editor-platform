# 提案のdomain別の差分

外部操作の提案（`ProposedCommands`）を人が確かめるとき、座標やJSONの写しではなく、各Editorの意味で
「何が・どの値から・どの値へ」変わるかをHostへ渡す契約です。提案の生成・承認の単位・画面の配置と説明文は
Hostが決めます。Editorは全domainを1つのnodeモデルにまとめず、domainごとのadapterが自分のmodelを比べます。

## 入口

- `reviewProposedCommands(current, proposal, adapter)`（`@editor-platform/editor-core`）：
  `previewProposedCommands`と同じく下書きの写しで適用し、adapterで差分にします。下書き・版・履歴は変えません。
- `current`は`{ content, base: { artifactId, versionId?, revision? } }`。提案の読んだ版
  （`proposal.reads.target`、[提案の読んだ版](host-integration.md#proposal-freshness)）と`baseLocalRevision`があれば照合します。
  参照した成果物の版は照合しません。Host（`editor-host`）がプレビューと採用の時点で確かめます。
- 結果は凍結した値です。`status: 'ready'`は`changes`（内容）・`view`（保存した表示の設定）・
  `fallback`（意味の差分にできない項目のJSON）・`elementIds`（Surfaceで目立たせるID）と`preview`を持ちます。
  `status: 'refused'`は`reason`・`message`・対象の`elementIds`・`fallback`を持ち、差分は持ちません。
- 採用は今までどおりHostが同じコマンドを`transaction`（`origin: 'proposal'`）で実行し、1回のUndoで戻ります。
  プレビューから時間が経ったら、採用の直前にもう一度`reviewProposedCommands`を呼んで確かめます。

各変更（`SemanticChange`）は安定したID（`elementId`）・人が読む名前・native の項目（`property`）・前後の値・
単位（`units`）を持ちます。文章は変わった範囲（UTF-16の`range`）も持ちます。提案の`summary`（モデルの成功の宣言）は
差分に使いません。

## 断る理由

| `reason`             | 起きるとき                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `stale-version`      | 提案の`reads.target`が今の下書きの元の版と違う                                                                 |
| `stale-draft`        | 提案の`baseLocalRevision`の後に下書きが変わった                                                                |
| `missing-target`     | コマンドの`reads`が読む安定IDが、そのコマンドの直前の内容に無い（削除済みの対象。`transaction`は中の手順ごと） |
| `command-failed`     | 写しへの適用でコマンドが失敗した                                                                               |
| `unknown-units`      | adapterが値の単位・座標系を言えない（未知のtime zone・ISOでない日付・非有限）                                  |
| `unsupported-domain` | adapterが無い。写しの前後をJSONの`fallback`で返すが、差分としては出さない                                      |
| `no-change`          | 写しの前後で何も変わらない（要約が成功と言っていても）                                                         |

## 対応範囲

| Editor          | adapter                                                   | 差分にするもの                                                                                                                                                               | 単位・座標                                      | 不足・非対応                                                                    |
| --------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| Document        | `documentProposalDiff`（`@editor-platform/document`）     | block・listの項目・表の段落の文章の範囲、書式だけの変更、項目と段落の追加・削除（書式・属性も）・順序と位置（親の項目・表のセル）、blockの追加・削除・順序・属性、ページ設定 | 文章はUTF-16のoffset                            | 安定IDの無い表の`cells`は`blockId:cell:r:c`で比べる。`reuse`はJSONのfallback    |
| Structured Data | `dataProposalDiff`（`@editor-platform/structured-data`）  | recordのfieldの値、Timelineの開始・終了の組を1つの期間、recordと列の追加・削除・順序。保存したビュー（順序も。先頭が既定で開く）・Graphの配置は`view`に分ける                | 期間と日付の列はISOの日付                       | 見え方の切り替え（private view state）は提案に入らない。`reuse`はJSONのfallback |
| Whiteboard      | `whiteboardProposalDiff`（`@editor-platform/whiteboard`） | nodeの移動・大きさ・回転・文字・属性、接続線、Section（接続線・Sectionの順序も）。追加・削除はnativeのnodeの全体（画像の`src`・参照も）                                      | boardのpx（zoom 1の絶対座標、cameraに依らない） | nodeとSectionの非有限の座標は`unknown-units`。`reuse`はJSONのfallback           |
| Schedule        | `scheduleProposalDiff`（`@editor-platform/schedule`）     | 予定の期間（time zoneつき、終日は`all-day`）、件名・本文、会議・関連、既定のtime zone。追加・削除は予定の全体                                                                | IANAのtime zone                                 | 未知のtime zoneは`unknown-units`。参加者は持たない                              |
| ほかのEditor    | 無し                                                      | Slide・Design・React UI・Graph・Geo・CAD・Animation・Code Review・File Viewerは`unsupported-domain`。JSONを見せるが差分として出さない                                        | —                                               | Geo・CADは座標系・単位・表示変換をadapterで区別するまで対応しない               |

## 参照用Hostの使い方

- Playgroundの`External proposal demo`はDocument・Structured Data・Whiteboardで使えます。窓は`Proposed changes`に
  要素ごとの差分（文章は消した字と足した字、図形は`Move preview`の前後の枠）、`Display settings only`に保存した表示の
  設定を出し、断った提案は`Cannot apply:`と理由を出して適用できません。適用した後は変わった要素を選びます。
- Playgroundに依存しない独立のHost（`tests/fixtures/proposal-review/host.tsx`）は、公開entrypointだけで同じ判定を使い、
  画面の配置・承認の単位をHost側で決める例です。

検証の記録：#401。
