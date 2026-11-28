# 工程定義の Editor の設計（工程0）

状態：**提案（2026-11-28、#99）。U1〜U6 は 2026-11-28 の Ryo さんのレビューで、すべて A（U4 は暫定）を推奨として受けた。**保留 H4（新しい kind か、今の構造化グラフ・表の Profile／テンプレートか）は、2026-11-28 に Ryo さんが「Structured Graph ＋ OWD adapter」を選んだ。新しい kind は作らない。この文書は、その形での構成・足りない部品・段階・決めてほしいことを置く。採用後の仕様は [Structured Graph 契約](structured-graph-contract.md) と、新しい package の README へ反映する。

横断の決定は [tokiwa-ecosystem 0002](https://github.com/ryo0221/tokiwa-ecosystem/blob/83391488b67db97cd250cb9a43296d84a6fa8014/docs/decisions/0002-phase-assignment-contract.md) の「6. 工程0と工程定義の Editor」と段階4にあり、ここでは繰り返さない。親の追跡は [tokiwa-ecosystem #12](https://github.com/ryo0221/tokiwa-ecosystem/issues/12)。

## 1. 目的と代表操作

Project を始めるとき（工程0「進め方」）に、人と AI が工程・成果物・達成条件・依存・役割を洗い出し、工程定義（[open-workflow-definitions](https://github.com/ryo0221/open-workflow-definitions)、以下 OWD の format 1 の JSON）を作り、直せるようにする。

利用者は Project の進め方を決める人（PM・設計リーダーなど）と、その人に候補を出す AI。

代表的な正常操作：

1. マインドマップで洗い出した枝を選び、「工程にする」「成果物にする」「達成条件にする」で定義に足す。枝には定義の ID への対応（`link`）が付く。
2. 工程の流れ図で工程を足し、`after` の矢印をつなぎ、まとまり（`sections`）へ入れる。一覧で成果物の章立てと達成条件の文・確かめる人を書く。
3. 既存の定義（例：`product-design-engineering@1.1.0`）を開き、工程を一つ足して条件を書き換える。差分と OWD の `check` の結果を見てから、Host に保存する。

想定する拒否・失敗操作：

1. 工程の `after` で循環を作る。断らずに、Graph の循環の診断と OWD の `check` の両方を出す（保存してよいかは Host が決める。§6）。そのため OWD 用 Profile の `after` は `allowCycles` を既定の許可のままにし（`false` にすると Graph が commit を断る）、循環は adapter の診断（`blocking: false`）として出す。
2. 使われている成果物を、確認なしに消す。参照している工程・条件の一覧を出し、明示の cascade が無ければ断る。
3. 承認済みの版（Host が読み取り専用で渡す）を編集する。すべての入口を無効にし、headless でも断る。

## 2. いまあるもの

| もの                                                       | 状態                                                                                                                                           | この設計での扱い                                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Structured Graph（`structured-graph`）                     | 型付きのノード・関係・属性、Profile、循環・接続数の検証、Section、自動配置とパレット、診断、提案の preview／apply／reject                      | 工程の流れ図に使う。Profile と adapter だけを足す                                         |
| 外部 adapter（`GraphAdapter<S>`）                          | 正本は Host が持ち、Graph は投影して編集を正本の command に変える。未宣言の欄を保持する。参照実装は `apps/graph-reference` の架空の Definition | OWD 用の adapter を作る（§3）                                                             |
| presentation sidecar                                       | 配置・形・塗りを正本の外に保存する。**Section は持てない**（`sections: true` は `presentationMode: 'source'` とだけ組める）                    | OWD の `sections` を Graph の Section にするため、sidecar に Section の枠を足す（§4、U3） |
| `property-input`                                           | 型・選択肢・readOnly・診断を持つ中立の入力                                                                                                     | 一覧の欄に使う                                                                            |
| Mind Map（`mindmap-core`）                                 | 枝の `link: {namespace, id}`、先頭 ID と link を項目として読む（OP-09）、提案（OP-06）                                                         | 枝と定義の ID の対応に使う（§7）                                                          |
| 要素の参照（`artifact-references` の `ItemReferenceHost`） | 候補の一覧・状態・移動                                                                                                                         | マインドマップの枝の候補を Host から受け取る口に使う                                      |
| Structured Data の Grid                                    | Data のレコードを表にする。Graph へは Data → Graph の投影だけ                                                                                  | 使わない（U5）                                                                            |
| OWD の `check(definition): string[]`                       | 定義の検査。結果は文の配列で、要素の ID は文の先頭にある（「工程 concept: 成果物が無い」など）                                                 | Host から受け取って診断にする（U2・U4）                                                   |

足りないもの（この設計で足すもの）：

1. OWD の定義を Graph に投影して書き戻す adapter。
2. 入れ子の欄の編集。成果物の章立て（`outline`、4 段まで）と、条件の `rules`・`approvers` は、今の Graph のフォームでは JSON の入力欄になる。
3. 一覧とマトリクスの見方。Graph は図だけで、OWD を表にする投影と、引用と網羅のマトリクスが無い。
4. Section を持つ sidecar。
5. マインドマップの枝から定義の要素を作り、対応を付ける入口。

## 3. 構成

新しい kind を作らず、OWD の JSON を正本にする。Host（PaoBub、OEP では参照 Host）が JSON を持ち、Editor は投影して command を返す。

```text
Host（PaoBub／参照 Host）
  正本：OWD format 1 の JSON（read / execute、revision、readOnly）
  注入：check(definition) → string[]、マインドマップの枝の候補、sidecar の保存
        │
        ▼
@editor-platform/workflow-definition
  ./model（React なし）
    型 OwdDefinition（format 1 の読み取りと検証。未知の欄は保持）
    WorkflowDefinitionIntent → prepare → EditorCommand<OwdDefinition>
    owdGraphAdapter: GraphAdapter<OwdDefinition>（Graph の intent を上の intent に変える）
    diagnostics（Editor 自身の構造の検査 ＋ 注入された check の結果の対応付け）
  ./view（React）
    WorkflowDefinitionSurface：タブ「流れ」「一覧」「マトリクス」「定義の情報」
      流れ = GraphSurface（owdGraphAdapter）
      一覧・マトリクス・章立て = この package の部品（property-input を使う）
```

- 三つの見方は、同じ `OwdDefinition` と同じ intent の経路を通る。定義を変える編集は、どの見方からでも一つの command で、Host の Session の Undo に一つずつ入る。見方ごとの Undo は作らない。配置・形・塗り・枠の大きさだけの変更は、今の Graph 契約のとおり sidecar に入り、定義の Undo には入らない。配置と所属を一緒に変える操作は §4 の「配置と所属を一緒に変える」に従う。
- package は `structured-graph`・`property-input`・`artifact-core`・`editor-core`・`artifact-references` の public entrypoint だけに依存する。`structured-graph` から workflow を import しない今の境界（契約の「Data/Workflow/製品型をimportしない」）は変えない。
- Playground には参照 Host（架空の定義の fixture、メモリ上の保存、sidecar、マインドマップの候補）を置く。kind の一覧には足さない。

## 4. 投影（流れ図）

| OWD                                                | Graph                                                           | 編集                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `phases[]`                                         | node type `phase`（`id`・`name`・`purpose`・`icon`）            | 追加・属性・削除（cascade の確認）                                      |
| `sections[]`                                       | Section type `section`（`id`・`name`・`icon`）。`phases` は所属 | 追加・所属・削除。Section の入れ子は使わない（`contains.sections: []`） |
| `deliverables[]`                                   | node type `deliverable`（`id`・`name`・`form`）                 | 追加・属性・削除。`outline`・`view` は一覧の章立てで編集                |
| `acceptance[]`                                     | node type `acceptance`（`id`・`text`・`checkedBy`）             | 追加・属性・削除。`rules`・`approvers` は一覧で編集                     |
| `roles[]`                                          | node type `role`（`id`・`name`・`text`）                        | 追加・属性・削除                                                        |
| `phase.after`                                      | edge `after`（先に終える工程 → この工程）                       | 接続・付替え・削除。循環は Graph の診断                                 |
| `phase.deliverables`                               | edge `makes`（工程 → 成果物）                                   | 接続・付替え・削除                                                      |
| `phase.acceptance`                                 | edge `ends-with`（工程 → 条件）                                 | 接続・付替え・削除                                                      |
| `acceptance.target`                                | edge `checks`（条件 → 成果物、出る数 1）                        | 付替え。切断はできない（必須）                                          |
| `deliverable.uses`                                 | edge `uses`（成果物 → もとにする成果物）                        | 接続・削除                                                              |
| `acceptance.approvers.roles`                       | edge `approved-by`（条件 → 役割）                               | 接続・削除。`count` は一覧                                              |
| `id`・`version`・`title`・`purpose`・`strictCites` | Graph の属性                                                    | 「定義の情報」タブ                                                      |
| `items`・`rules`                                   | Graph に出さない                                                | マトリクス（§5）                                                        |
| `gates`・`placements`・`format`                    | Graph に出さない                                                | 保持だけ。この段では編集しない（「定義の情報」で読むだけ）              |

- 流れ図の既定は「工程とまとまりと `after` だけ」を見せる（`visibleEdgeTypes` とノードの絞り込み）。「成果物と条件も見る」で全部を出す。絞り込みは表示だけで、検査は全体にかかる（Graph 契約のとおり）。
- 配列の順：OWD の `phases` の順は「工程の順」（`sections` の並びの規則に効く）。新しい工程は、つないだ先の工程の後ろに入れる。順の変更は一覧での明示の操作にし、矢印の操作からは変えない。
- 配置・形・塗り・Section の枠は sidecar に置き、OWD の JSON に入れない（OWD は道具に依らない）。今の sidecar は Section を持てないので、sidecar schema 3 として `presentation.sections` を足し、`sections: true` を `sidecar` とも組めるようにする（U3）。これは Structured Graph 契約の変更で、旧い sidecar schema 2 は schema 3 として読む。
- **配置と所属を一緒に変える**：Section を編集できる Surface のドラッグは `[move-node, set-node-section]` の一つの batch を作る（`graphNodeDropIntents`）。今の `GraphBinding` は、sidecar の配置と正本を変える操作の混在を「Sidecar presentation and semantic edits require separate transactions」で断るので、schema 3 を足すだけではまとまりへのドラッグが失敗する。WD1 で次のように決める。
  - `GraphBinding` の Host の口に任意の `commitWithPresentation({command, presentation, base})` を足す。Host は stamp（source の revision と sidecar の revision）を確かめ、定義の command と sidecar の書き込みを**両方とも適用するか、どちらも適用しない**。Host の Undo には一つの記録として入り、Undo／Redo で定義の所属と sidecar の位置が一緒に戻る・進む。片方の書き込みに失敗したら Host は両方を元に戻し、Surface は理由を示して位置も元に戻す。
  - 混在 batch の分け方は Binding が持つ：`move-node`・`resize-section` などの見た目は sidecar へ、`set-node-section` などの意味は adapter の `prepare` へ。どちらかが断られたら batch 全体を断る。
  - この口を持たない Host では、Surface に新しい設定 `sectionDrop: 'move-only'` を渡す。ドラッグは位置だけを動かし（sidecar、今の規則どおり定義の Undo に入らない）、所属は変えない。まとまりの枠の上で離したときは「まとまりを変えるには工程の設定の『まとまり』を使う」と示す。所属の変更は Inspector の `Node section` と一覧の欄の明示の操作（定義の command、一つの Undo）だけになる。
  - 既定の Graph（native・Data・今の adapter）の動作は変えない。新しい設定と口は、それを宣言した adapter にだけ効く。
- 工程を消すと、`sections.phases` と他の工程の `after` から同じ command で外す。成果物・条件は、参照する工程・条件があると cascade の確認が要る（Graph の `delete-node` と同じ形）。どれも一つの Undo。

## 5. 一覧とマトリクス

**一覧**（タブ「一覧」）：工程・成果物・達成条件・役割の四つの表。欄は `property-input` で、他の要素を指す欄（`after`・`target`・`uses`・`approvers.roles`・`rules`）は ID の候補から選ぶ。成果物を選ぶと章立ての木を編集できる（`heading`・`describe`・`item`・`repeat`・`children`、4 段まで）。工程の並べ替えはここで行う。

**マトリクス**（タブ「マトリクス」）：

| マトリクス   | 行 × 列                            | セル                                                   |
| ------------ | ---------------------------------- | ------------------------------------------------------ |
| 工程と成果物 | 工程 × 成果物                      | 作る（`makes`）・確かめる条件の数                      |
| 引用         | 項目の種類 × 項目の種類（`items`） | その組を許す `cites` の規則の ID（`min` は規則に一つ） |
| 網羅         | 項目の種類 × 引用する種類          | その組を含む `covered` の規則の ID（`exempt`）         |
| 条件と規則   | 達成条件 × 規則                    | `acceptance.rules`                                     |

- 項目の種類（`items`）と規則（`rules`）の追加・削除・`idForm` の編集も、このタブの表で行う。
- マトリクスは描画と選択だけを持ち、編集は一覧と同じ intent になる。上限は OWD の今の定義の最大（項目の種類 36、規則 72）の数倍を見込み、行・列 200 までにする。
- **規則はセルではなく `rule.id` が単位**。OWD の規則は一つで複数の組を持つ。例：`requirement-cites-source` は `to: [use-case, regulation, benchmark], min: 1` で、「三つの種類からの引用を合わせて 1 件以上」という意味になる。これをセルごとの `min: 1` の規則に分けると「それぞれの種類を 1 件以上」に意味が変わる。`covered.by` も、集合のどれかからの引用で満たす。そこで次のようにする。
  - セルは、その組を持つ規則を選ぶ入口にする。同じ規則のセルは同じ色と ID で示し、選ぶとその規則の全部のセルを強調する。
  - 編集は規則ごとの intent `set-rule {id, rule}` で、`from`・`to` の集合と共通の `min`（cites）、`of`・`by` の集合と `exempt`（covered）を一つの command で書き換える。規則の ID と、`acceptance.rules` からの参照はそのまま残す。
  - 空のセルを押すと「既存の規則（同じ `from` の cites、または同じ `of` の covered）にこの種類を足す」か「新しい規則を作る（ID を入力）」を選ぶ。OWD の「組ごとに規則は 1 つ」に反する作り方（同じ組を二つの規則に入れる）は、その場で断る。
  - 規則の削除は、`acceptance.rules` から参照されていれば cascade の確認が要る（参照も同じ command で外す）。
  - 試験：既存の定義の複数対象の規則（`product-design-engineering` など）を読み、無関係な編集をして書いた結果で、規則の `to`・`by`・`min`・`exempt` と ID と参照が変わらないこと。

## 6. 検査と診断

二つの検査を分ける。

1. **Editor の構造の検査**（`./model`、常に動く）：JSON の形（型・未知の欄の保持・ID の形 `^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$`）、ID の重複、存在しない ID を指す参照を**新しく作る**操作。これに当たる intent は batch 全体を断る。既存の壊れた参照は保持して診断を出し、直す操作と無関係な編集はできる（Data の relation と同じ扱い）。ID の重複は OWD の `check` と同じ名前空間ごとに見る：工程・まとまり・成果物・達成条件で一つ、項目の種類・規則・役割はそれぞれ別。実在の定義では `concept` が工程と項目の種類の両方にあるので、全部を一つの集合で見ると既存の定義を断ってしまう。Graph に投影するノードの ID は種類の前置き（`phase:concept`・`role:pm` など）を付けて OWD の ID と分け、書き戻しで前置きを外す。
2. **OWD の `check`**（Host が注入）：「工程に人が確かめる条件が無い」など、定義として完成しているかの検査。未完成の下書きは普通なので、**断らずに診断として出す**。保存してよいか、版にしてよいかは Host が決める。注入が無い Host では「この Host は工程定義を検査しない」と出す。

`check` の結果は文の配列なので、先頭の語（工程・成果物・達成条件・規則・役割・まとまり・項目）と ID で要素に対応付ける。読めない文は定義全体の診断にする（U4）。OWD の文の書き方は OWD の版ごとに変わりうるので、対応付けは OWD の版を pin した試験で守り、将来は OWD に ID と欄の道筋を持つ結果を足すよう提案する。 schema が成り立たないときの `check` は JSON Pointer の形（`/phases/0/after` など）の文を返すので、この形も道筋から要素に対応付け、試験に含める。対応付けられない文は消さずに定義全体の診断に出す。

ID の付け方：ID は人が読む英小文字の語（`concept`・`process.complete`）で、日本語の名前からは作れない。新しい要素は名前と一緒に ID を入力させ、形と重複をその場で示す。既存の ID の変更は明示の「ID を変える」操作にし、その ID を指す全部の欄を同じ command で書き換える（Undo で全部戻る）。

## 7. マインドマップとの対応

- 対応はマインドマップの枝の `link: {namespace: 'owd:<定義の id>', id: <要素の id>}` に持つ。定義の側に対応表は持たない（正本は一か所。0002 の「ノードから定義の ID への対応を明示的に持つ」）。
- 定義の Editor の「マインドマップから足す」は、Host が `ItemReferenceHost` と同じ形で渡す枝の候補（題・link の有無）を並べる。枝を選んで種類を選ぶと、名前を枝の題にした要素を足す（ID は入力）。続けて Host へ「この枝に link を付ける」要求を返し、Host がマインドマップの提案（OP-06）として適用する。二つの成果物の編集なので、それぞれ別の Undo になる。片方だけ通ったときは Host が「対応が付いていない」と示す。
- **Mind Map 側の口が要る**。今の提案（OP-06）の操作の種類（`add`・`rename`・`reorder`・`move`・`delete`・`collapse`・`color`・`marks`・`note`・`layout`）と `MindmapNodeFields` には `link` が無く、parser は未知の操作を断る。そこで WD4 で `mindmap-core` に次を足す。
  - command `setNodeLink(id, link | null)`：link の設定・置き換え・解除。`link` の各部 1〜128 字の今の上限を守り、中心の枝にも付けられる。一つの Undo。
  - 提案の操作 `link`（`{kind: 'link', id, link: {namespace, id} | null}`）と、その parser・dispatch・差分（`mindmapDiff`）・表示。今の提案と同じく `before` の fingerprint で古い提案を断り、readOnly では断る。
  - Mind Map の Surface でも、枝の設定で link を見る・外すことができる（付けるのは Host の候補から）。
- 二つの成果物は別々の Undo なので、片方だけが通ったり、どちらかを Undo したり、定義の側で ID を変えたり要素を消したりすると、対応がずれる。定義の Editor は、Host から受け取った枝の候補の link と今の定義の ID を毎回照らし合わせ、「対応が付いていない」「対応先が無い」を示す（自動で直さない）。ID を変える操作のあとは、Host に「link を新しい ID に置き換える」要求を返す。
- link の無い枝から、暗黙に要素や必須の条件を作らない。AI の候補も、定義の intent の提案（preview／apply／reject）として出し、人が採用するまで定義に入らない。

## 8. Host との境界

| Editor が持つ                                                                      | Host（PaoBub）が持つ                                                                                                                             |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| OWD の JSON の編集、構造の検査、`check` の結果の表示、差分の表示（今の版と下書き） | 承認、版の固定と適用、派生元の版と digest、白紙からの作成の入口（[paobub #405](https://github.com/ryo0221/paobub/issues/405)）、定義の共有・由来 |
| sidecar の形                                                                       | sidecar の保存                                                                                                                                   |
| マインドマップへの link の要求                                                     | マインドマップへの適用、AI の実行                                                                                                                |

承認済みの版や権限の無い利用者には、Host が readOnly で渡す。Editor は UI だけでなく `prepare` でも断る。

## 9. 能力

| 能力                                 | 範囲                                                                     | 状態     |
| ------------------------------------ | ------------------------------------------------------------------------ | -------- |
| Viewer / local 編集                  | 三つの見方、Undo／Redo は Host の Session                                | 実装予定 |
| 外部の提案 / headless                | 定義の intent の batch の preview／apply／reject、`./model` だけで使える | 実装予定 |
| Native JSON                          | OWD の JSON そのもの。読み書きは Host                                    | 実装予定 |
| 共同編集・テンプレート・形式別の出力 | 非対応（入口を出さない）                                                 | 非対応   |
| 親の工程と子の定義の境界の対応       | 定義二つにまたがる。0002 の段階4の後半で別に設計する                     | 非対応   |
| `gates`・`placements` の編集         | 保持と表示だけ                                                           | 非対応   |
| Browser                              | Chromium の desktop／mobile の幅                                         | 実装予定 |

想定規模は今の OWD の定義の最大（`fiction-manga`：工程 13・成果物 22・条件 57、関係 約200）で、Graph の上限（ノード 1,000・関係 4,000）に収まる。追加の性能の測定は止まっているので、この設計では fixture と上限だけを決め、測定しない。

## 10. 段階

| 段  | 中身                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 依存 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| WD1 | Structured Graph：sidecar schema 3（Section の枠）、`sections: true` と `sidecar` の組み合わせ、旧 sidecar の読み替え、配置と所属を一緒に変える Host の口 `commitWithPresentation`（両方か無しか、一つの Undo）と、口が無い Host での `sectionDrop: 'move-only'`、失敗時の無変更の試験、契約と変更の記録の更新                                                                                                                                                   | なし |
| WD2 | `workflow-definition/model`：OWD format 1 の型と読み取り、intent と `prepare`、名前空間ごとの ID の検査と投影の前置き、ID の変更と cascade、規則ごとの `set-rule`、構造の検査、`check` の結果の対応付け（先頭の語と ID・JSON Pointer）、`owdGraphAdapter`（`after` は循環を許して診断）。架空の定義の fixture と、pin した OWD の版（commit SHA）の schema・`check.mjs`・生成済みの `schema-validator.mjs`・定義の写しで、読み・書き・保持と複数対象の規則の試験 | WD1  |
| WD3 | `workflow-definition/view`：流れ・一覧・章立て・マトリクス・定義の情報、Playground の参照 Host（保存・sidecar・readOnly）                                                                                                                                                                                                                                                                                                                                        | WD2  |
| WD4 | `mindmap-core` の `setNodeLink` と提案の操作 `link`（parser・dispatch・差分・readOnly・古い提案の拒否）、Mind Map の Surface の link の表示と解除、定義の Editor の「マインドマップから足す」入口と link の要求、対応のずれの表示、AI の提案の preview                                                                                                                                                                                                           | WD3  |
| WD5 | 検証：#99 の受入（マインドマップから新しい定義を作る例、既存の定義を直す例）。Section の追加・所属変更（ドラッグと明示の操作）・削除、規則の編集、マインドマップへの link の設定・置換・解除のそれぞれで、失敗時の無変更・Undo／Redo・readOnly・古い提案の拒否。壊れた参照、循環した下書き、`check` 無しの Host、desktop／mobile。結果は `docs/verification/issue-99/`                                                                                           | WD4  |

承認と版の固定は PaoBub 側で確かめる（#12 の受入6）。PaoBub への組み込みは、OEP の版を上げる PaoBub の作業として別に起こす。

## 11. 扱わないこと

- 新しい kind、OWD の JSON とは別の保存形式。
- 工程定義の承認・版・公開・委託の状態を Editor に持つこと。
- 名前の一致や文章からの、マインドマップと定義の自動の対応付け。
- 親の工程と子の定義の境界の対応（段階4の後半）、`gates`・`placements` の編集、共同編集。

## 12. 決めてほしいこと

| #   | 問い                                      | 推奨                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | adapter と見方をどこに置くか              | A：OEP の新しい package `@editor-platform/workflow-definition`（どの Host でも使え、Playground で試せる）。B は PaoBub の中に置く                                                                                                                         |
| U2  | OWD の `check` をどう呼ぶか               | A：Host が注入する。OEP は OWD を実行時の依存にしない。試験だけ、OWD の commit SHA を記した schema・`check.mjs`・生成済みの `schema-validator.mjs`・定義の写しを fixture に置く（OWD は MIT。出どころを書く）                                             |
| U3  | OWD の `sections` を Graph でどう見せるか | A：sidecar schema 3 に Section の枠を足し、Graph の Section にする。配置と所属を一緒に変える操作は Host の口 `commitWithPresentation` で一つの記録にし、口が無い Host では移動と所属変更を分ける（WD1）。B は Graph には Section を出さず、一覧だけで扱う |
| U4  | `check` の結果を要素に対応付ける方法      | A（暫定）：文の先頭の語と ID、schema 不成立のときの JSON Pointer で読み、OWD の版を pin した試験で守る。読めない文は全体の診断に出し、消さない。あわせて OWD に、ID と欄の道筋を持つ結果を足す提案の issue を起こす                                       |
| U5  | 一覧をどう作るか                          | A：この package の軽い表（`property-input`）。規則の編集は `rule.id` と対象の集合を単位にする。B は Structured Data の Grid に外部 adapter を足す（Data の契約の大きな変更になる）                                                                        |
| U6  | マインドマップとの対応をどこに持つか      | A：マインドマップの枝の `link`。Mind Map に link の設定・置換・解除の command と提案の操作を足し（WD4）、定義の Editor は Host に要求を返す。別々の Undo なので、対応のずれを毎回照らし合わせて示す                                                       |
