# Structured Graph の変更の記録

Structured Graph は互換を守る保存形式です（2026-11-14 から。[互換性の約束](../structured-graph-contract.md#互換性)）。
保存形式を変えるときは schema の番号を上げ、古い番号の読み込みを残します。

## 互換を守る形式へ（schema 3）

- **変更：** Graph は schema 3 になりました。中身は schema 2 と同じで、Section につなぐ線（#594）を含む形式に番号を付け直したものです。
  新しく作る・保存する Graph は schema 3 です。
- **追加：** `upgradeGraphDocument`・`readGraphDocument`。schema 1（位置は `layout`、Section 無し）と schema 2 の Graph を、入力を変えずに
  schema 3 として読みます。`graphSchemaVersion`・`readableGraphSchemas`。
- **追加：** `upgradeGraphProfile`・`readGraphProfile`。Profile schema 1 を、Section の型が無い schema 2 として読みます。`graphProfileSchemaVersion`。
- **変更：** presentation sidecar の schema 1（`positions`）を schema 2 の node presentation として読み、次の変更で schema 2 に書きます。
- **変更：** 読めるより新しい schema は「Graph schema N is newer than this version reads」で断ります（Profile も同様）。
  これまでの「schema 1 is not supported by this preview」の拒否は無くなりました。
- **変更：** Playground は古い schema の下書きを開く・取り込むときに schema 3 へ移し、保存済みの版は書き換えません。版の復元・参照・
  Data の参照元の一覧でも古い版を読みます。参照 Host（`graph-host.html`）の native も同じです。
- **互換：** これより前の版は schema 3 の Graph を「Invalid Graph schema…」で断ります。

## 線を Section につなぐ（#594）

- **変更：** edge の `from`・`to` に Section の ID を書けます。このときは schema 2 のままでした（後に schema 3 として区別。上の「互換を守る形式へ」）。
  Section につながる線を持つ Graph は、この版より前では読めません。
- **追加：** Profile の edge type の `connection.fromSections`・`toSections`（つなげてよい Section の型）。既定はつなげません。
  許されない Section への線は診断 `connection-section` になります。`graphEndpointKind`。
- **変更：** `delete-section` に `cascade`。Section 自身につながる線があると `cascade: true` が要り、その線も一緒に消えます。
  線の無い Section は従来どおり消せます。Surface の削除の確認はその本数を示します。
- **変更：** Surface は線を Section の枠の辺へ引き、端点を枠へドラッグしてつなぎ直せます。Inspector の接続の両端に Section が出ます
  （関係の種類が許すとき）。たたんだ Section では線をその箱やまとめた線へ引きます。参照 SVG と `arrangeGraph` も Section の端点を扱います。
- **変更：** Playground の図の Profile（`diagrams`）の `Connects to` が Environment・Network・Layer・Unit につなげます。
  参照 Profile `relationProfile` は変えていません（Section の型の一覧を edge に書くと、その型を消した Profile が不正になるため）。

## ノードのアイコン（workflow-definitions #8）

- **追加：** Profile の node type に `ui.icon`（型の既定）と `ui.iconBy`・`ui.icons`（属性の値 → アイコン）。
  ノードの左上の角にバッジとして重なり、Palette と参照 SVG にも出ます。アイコンは組み込みの名前（`graphNodeIcons`）から選び、
  path data や URL は受け取りません。Graph には保存せず、schema は 2 のままです。
- **追加：** `resolveGraphNodeIcon`・`graphNodeIconPath`・`isGraphNodeIcon`。
- **変更：** 参照 Profile `relationProfile` の Entity が category（Resource・Topic）でアイコンを変え、Person に人のアイコンが付きます。

## Host に合わせた文言・道具・色（#564）

- **変更：** ツールバー・Inspector・削除の確認・パレットの見える文言が `locale` に従います（`ja`・`en`）。
  既定は従来どおり `ja` なので、`locale` を渡していない Host では日本語になります。英語の画面を保つには `locale="en"` を渡します。
  `aria-label` で付けた名前（`Node type`・`Relation type`・`Connection from` など）は locale によらず英語のままです。
- **追加：** `GraphSurface` に `labels`（`GraphSurfaceLabels` の一部を Host の文言に差し替える）と `graphSurfaceLabels`（`ja`・`en` の辞書）。
- **追加：** `GraphSurface` に `toolbar`。`false` でツールバーと表示の操作を隠し、
  `{ source, palette, addNode, addSection, arrange, properties, delete, zoom }` の各項目を `false` にするとその項目だけを隠します。
  `readOnly` と違い、点の移動・Inspector での編集・キー操作は残ります。
- **追加：** `.ep-graph` の色を `--ep-graph-*` の CSS 変数で受け取ります。既定値は従来の色です（[埋め込み](../embedding.md#structured-graph-local-mode)）。

## ドロップで所属を変える（#448）

- **変更：** ノードをドラッグして Section の枠の中に離すと、その Section（入れ子なら最も内側）に入ります。
  移動と所属は 1 回の Undo です。どの枠にも無い所に離すと所属から外れます。schema は 2 のままです。
- **追加：** `GraphSurface` に `sectionDropOutside`（既定 `'clear'`、`'keep'` で枠の外へ離しても所属を残す）。
- **変更なし：** Inspector の `Node section` と `set-node-section`。readOnly の Section と `contains` が断る所属は変えず、移動だけを入れて理由を示します。

## 図の作成支援（#396 Phase 3）

- **追加：** `arrangeGraph`（Section ごとに中身を関係の向きで並べ、枠を広げる自動配置）と、道具の `Arrange diagram`。
  所属と内容は変えず、配置だけを 1 回の Undo で変えます。schema は 2 のままです。
- **追加：** Profile の node type の `ui.group`（用途の名前）。どれかの型に書くと、用途ごとに形と塗りを並べた `Palette` が出て、
  選んだ Section の中へノードを足せます。
- **追加：** Section settings の `Fit section`。
- **追加：** Playground の `Graph template`（Relation map・System architecture・Flowchart・Blank diagram）と構成図の Profile `diagrams`。
  業務の語彙はこの Profile とテンプレートにだけあります。

## Section（#396 Phase 2）

- **追加：** 意味を持つまとまり（Section）。`sections`・`presentation.sections`・`node.sectionId` に保存し、
  Profile の `sections` に型（属性・既定の塗り・readOnly・`contains`）を書けます。schema は 2 のままで、
  Phase 1 で予約していた欄を使い始めます。Section の無い Graph と Profile はそのまま読めます。
- **追加：** intent `add-section`・`set-node-section`・`set-section-parent`・`move-section`・`resize-section`・
  `set-section-style`・`delete-section` と、属性の `scope: 'section'`。入れ子は 8 段まで。
- **追加：** 画面で Section を足し（ノードを選んでいれば囲んで）、動かし、大きさを変え、たたみ、
  確かめてから消せます（中身は親へ移ります）。たたむのは表示だけで、内容と版は変わりません。
- **追加：** 参照の SVG に Section の枠と名前が出ます。
- **変更：** `GraphSurface` に `sectionEditing`（既定 `true`）。Section を保存できない source では `false` を渡します。
  `sections: true` を宣言しない adapter は Section の intent を「This source cannot represent Graph sections」で断ります。
- **変更：** Playground の版の保存は、警告（範囲の外に描かれたノードなど）では止めません。

## schema 2（#396 Phase 1）

- **breaking：** `GraphDocument` と Profile は schema 2 になりました。`layout` は
  `presentation.nodes`（位置・形・塗り）に、外部 adapter の layout sidecar は
  `PresentationSidecar`（schema 2）に置き換わります。schema 1 の Graph・Profile・sidecar は読まず、
  「Graph schema 1 is not supported by this preview」の理由で断ります。Playground に保存した schema 1 の
  Graph も開けませんが、成果物の一覧に残り、エクスポートはできます。
- **breaking：** `GraphBinding` の options は `getLayout`/`setLayout` から `getPresentation`/`setPresentation` に、
  `GraphAdapter` は `presentationMode`（`sidecar`・`source`・`none`）の宣言を持つようになりました。
- **追加：** ノードの形（Rectangle・Rounded rectangle・Ellipse・Diamond・Cylinder・Hexagon・Cloud）と塗り・線。
  Profile の node type に既定の `ui.shape`/`ui.style` を書けます。intent は `set-node-shape` と `set-node-style`。
  線は形の輪郭で止まり、ラベルは塗りに対して読める色で出ます。
- **予約：** `sections`・`presentation.sections`・`sectionId` は後の Phase のための欄で、今は空でなければ断ります（Phase 2 で使い始めました）。
- Data の Graph view は形と塗りを保存せず、種類の既定の形で描きます。

### schema 1 の Graph を移すには

schema 1 から schema 2 への変換器は用意していません。旧版の Playground で native JSON を書き出し、
新しい版で Graph を作り直してください。手で移す場合、Graph の JSON は `schemaVersion` を 2 にし、
`sections: []` を加え、`layout` を `presentation: { nodes: <layout>, sections: {} }` に置き換えます。
Profile は `schemaVersion` を 2 にし、`sections: {}` を加えます。内容が変わるので版の hash も変わり、
旧版の保存した版はそのままでは取り込めません。

設計は [図解の設計](diagram-design.md) と ADR 015、
契約は [Structured Graph 契約](../structured-graph-contract.md) を参照してください。
