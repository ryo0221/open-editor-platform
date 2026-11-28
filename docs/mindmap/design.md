# Mind Map 設計

`mindmap` は、一つの中心テーマから枝を広げ、順番と親子を組み替えながら論点を整理する Editor です。テンプレートから作られた外部 Editor（mindmap-editor 0.1.5）の形式・操作をそのまま本体の種類として取り込みました。0.1.5 が保存した JSON は変換せずに開けます。

## 利用者と代表操作

| ID    | 操作                                   | 拒否する場合                                                               |
| ----- | -------------------------------------- | -------------------------------------------------------------------------- |
| OP-01 | 中心だけの地図を作り、子・兄弟を足す   | 中心の兄弟、存在しない親、上限超過、未適用の入力がある間                   |
| OP-02 | 兄弟の並べ替え、子孫ごとの移動         | 中心の移動、自分や子孫の下への移動、中心の直下へ左右なしで移す             |
| OP-03 | 左右・右向き・下向きの配置、畳む・拡大 | 未知の配置、葉を畳む                                                       |
| OP-04 | 名前・色・印・メモを一度に適用         | 長さ超過、5 個目の印、不正な色、入力中に枝が変わった・消えた（入力は残す） |
| OP-05 | 子孫ごと削除、Host の Undo/Redo        | 中心の削除                                                                 |
| OP-06 | 外から届いた枝の操作の提案を適用       | 形の合わない手順（何番目のどの操作かを示す）、基準の内容が変わった後       |
| OP-07 | 読み取り専用で開く                     | 変更の入口はすべて無効                                                     |
| OP-08 | 0.1.5 の JSON を取り込む               | 未知の形式・版、切れた親子、循環、容量超過（全体を拒否）                   |
| OP-09 | 枝名の先頭 ID と link を項目として読む | ID のない枝は項目にしない                                                  |
| OP-10 | 保存版の地図全体・枝を図として引用     | 保存版にない枝、不正な保存版                                               |
| OP-11 | 保存版どうしの枝の差を見る             | —                                                                          |
| OP-12 | SVG・PNG・Markdown・native JSON に出す | PNG にできない大きさ（SVG を案内）                                         |

Whiteboard は自由平面の図形とコネクターを扱い、根が一つで兄弟の順序を保存する木を保てません。Structured Graph は型付きの関係を扱い、兄弟順・子孫ごとの移動・左右の指定を一つの木の操作として持ちません。そのため独立した kind にしています。

## Package

| Package                         | 内容                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `@editor-platform/mindmap-core` | React なし。`model`（型・検証・作成）、`commands`、`proposals`（提案の schema と command）、`diff`、`items`、`layout`、`export` |
| `@editor-platform/mindmap`      | React の `MindmapSurface` と種類の定義 `./kind`                                                                                 |

Playground は `kinds/office.ts`・`records.ts`・`surfaces.ts` に登録し、保存版の比較（`mindmapDiff`）と引用（`reference-adapters` の `mindmapReferenceAdapter`）につなぎます。

## Content

`{ artifactKind: 'mindmap', schemaVersion: 1, id, rootId, layout, nodes }`。`nodes` は ID をキーにした枝で、`children` が表示順です。

- 枝 ID は `n-` と 32 桁の 16 進、文書 ID は `d-` と 32 桁。Surface は一度使った ID を同じ地図で再発行しません。
- 根は一つ、根以外の親は一つ、循環なし、すべて根から到達できる。`side` は中心の直接の子だけ。
- 上限：枝 2000、子 200、深さ 16、名前 200 字（改行なし）、メモ 4000 字、印 4（重複なし、7 種）、link の各部 1〜128 字、全体 512 KiB。
- 色は `#rgb` か `#rrggbb`。画面はパレットから選び、パレットにない保存値は「いまの色」として残す。
- 座標は保存しません。配置は `layoutMindmap` が木から計算し、画面・SVG・引用で同じ位置を使います。Surface の畳みは表示だけで、保存された `collapsed` は提案の `collapse` で変えます。

## 操作と履歴

すべての編集は `@editor-platform/editor-core` の command で、適用の前後に検証し、入力を変えず、変化のない command は拒否します。名前・色・印・メモの同時適用は `editMindmapNodeFields` の一つの command（Undo 一回）です。

枝の `link`（他の成果物の要素への対応）は `setMindmapNodeLink(id, link | null)` で付ける・置き換える・外す（中心の枝にも付けられる。Undo 一回）。Surface の枝の情報は link を見せて外せますが、付けるのは Host が渡す候補からです（#99 工程定義の Editor の「マインドマップから足す」）。

外部提案は `mindmapProposalDeclaration`（閉じた JSON schema、手順 100 件まで）に従うデータです。`mindmapProposalCommand` が手順を同じ command に変え、一つの command にまとめます。足す枝の ID は省略か仮の名前（`new-1` など）でよく、新しい ID に置き換えます。操作の種類 `link`（`{kind: 'link', id, link: {namespace, id} | null}`）は宣言 1.1.0 で足しました。`before` に内容の指紋（32 桁）があれば照合し、作った時点の内容と違う内容には適用しません。Playground の提案レビューへの接続は今回の範囲外です。

## 対応しないこと

- 共同編集、テンプレート・再利用、コメントのスレッド。Playground では local-only として登録しています。
- 自由配置、親子以外の線、画像・添付。
- 文字としての引用（数値の生きた引用は値だけを扱うため）。引用は図だけです。
- 外部 Editor 版（mindmap-editor リポジトリ）の改修・廃止と、各製品 Host での差し替え。

検証の結果は [verification.md](verification.md) にあります。
