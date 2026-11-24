# Extension の追加機能（add-on）

Extension の manifest は、必須の項目のほかに、版を完全一致で宣言する追加機能（`addons`）を持てます。
宣言しない package の manifest は変わりません。知らない add-on・知らない版の宣言は、登録の時点で断ります。
実装は `@editor-platform/extension-contract` と `@editor-platform/extension-runtime` にあります。

| add-on       | 版の token                       | package が渡すもの                      | Host が使う口                                             |
| ------------ | -------------------------------- | --------------------------------------- | --------------------------------------------------------- |
| `operations` | `operations@0-draft`             | `operations`（`checkInput`・`command`） | `ExtensionHandle.operations`（check・prepare）            |
| `create`     | `create@0-draft`                 | `create()`                              | `Registration.create()`                                   |
| `references` | `references@0-draft`             | `references`（`list`・`resolve`）       | `Registration.references`（list・resolve）                |
| `items`      | `items@0-draft`・`items@1-draft` | なし（manifest の宣言だけ）             | `readItems`（`@editor-platform/extension-runtime/items`） |
| `history`    | `history@0-draft`                | なし（manifest の data だけ）           | Host の session の `keepHighest`                          |

manifest が add-on を宣言することと、definition がその関数を持つことは一致していなければなりません（`items` と `history` は関数を持たない宣言だけの add-on です）。
片方だけのときは `install` が断ります（package の loader から登録するときも同じです）。

## create：最初の中身を作る

`create@0-draft` は、まだファイルの無い成果物を、その Editor の空の中身から始めるための口です。

```ts
manifest.addons = { create: { version: CREATE_ADDON } };
definition.create = () => ({
  /* 利用者のデータを含まない、空の中身 */
});
```

- `create()` は入力を取らず、Host の状態を読みません。何を作るか（題名・最初の要素など）は package が決め、利用者のデータを含めません。
- `Registration.create()` は package の関数を一度呼び、結果を JSON のデータとして写し、package の validator に通してから、凍結した写しを返します。validator が断れば `Invalid domain content` で止めます。登録を外した後・Host の pin の確かめに失敗したときも断ります。
- 返すのは中身だけです。どこに置くか、いつ保存するか、どの権限で作れるかは Host が決めます。返した中身は Host の session の最初の中身として開け、履歴には入りません。
- 作った中身の形式（artifactKind・schemaVersion）が Host の期待と合うかは、ほかの中身と同じく Host が開くときに確かめます。

宣言できる add-on を増やすときは、manifest の宣言（data）と package の関数を分け、data だけで Host が判断できる範囲を残します。

## references：保存版の値と図を提供する

`references@0-draft` は保存版の対象一覧と、その版の対象から計算した値または図を返します。
値は有限数、図はラベルと安全な画像データです。計算は Editor の adapter が行います。
Host は呼び出し前に参照元への権限と保存版を認証し、draft を渡しません。
登録時には宣言と adapter の一致を検査し、未知の add-on や版は拒否します。
サンプルの `counterReferenceExtension` は、保存版の counter の値を二倍にした数値と、カウントを十件ごとに一枠で示す PNG の図を提供します。
値の固定と更新の扱いは[参照契約](artifact-references.md)を参照してください。

## history：Undo で下げない値

`history@0-draft` は、文書の中の「下げてはいけない数」（例：発行した ID の番号の上限 `lastIssued`）の場所を宣言する data だけの add-on です（#64）。

```ts
manifest.addons = { history: { version: HISTORY_ADDON, keepHighest: ['/lastIssued'] } };
```

- `keepHighest` は JSON Pointer（RFC 6901）の並びで、1〜16 件、1 件 256 文字まで、重なり無し。配列の中は添字（`/groups/0/lastIssued`）で指す。
- Host は宣言を自分の session に渡します：`EditorHostAdapter.keepHighest`（`ArtifactEditor` が `EditorSession` の `keepHighest` に渡す）。package のコードは要りません。
- Undo/Redo は今までどおり 1 つの履歴の操作で前の中身を戻します。ただし宣言した場所では、今の値と戻す値の大きい方を残します。数は大きい方、平らな object（数の表）は key ごとに大きい方（戻す版に無い key も、数だけなら残す）。ほかの形や、どちらかに無い場所は戻す値のままです。
- 検証の callback（`undo(validate)`）が受け取るのも、`peekHistory` が返すのも、この調整のあとの中身です。
- 調整した中身は、すでに検証した版ではありません。`ArtifactEditor` は、`keepHighest` があれば Undo/Redo のたびに adapter の `validate` で調べます。通らなければ履歴も中身も変えずに断ります（`invalid-content`）。
- 守れるのは 1 つの session の中だけです。保存した版を開き直して Undo の履歴が無いときは、保存した値がそのまま上限です。

## items：中身の項目とつながりを宣言する

`items@0-draft` は、保存した中身のどこに ID の付いた項目があり、どの欄が別の項目を指すかを、データだけで Host に伝える口です。Host は package のコードを読み込まず・動かさずに、項目の一覧・項目どうしのつながり・版の間の差を作れます。

```ts
manifest.addons = {
  items: {
    version: ITEMS_ADDON,
    collections: [
      { at: 'assumptions', id: 'id', title: 'name' },
      { at: 'scenarios', id: 'id', title: 'name', refs: ['assumptionIds'] },
    ],
  },
};
// 名前の頭に ID を書く木：nodes は ID → 枝の object
manifest.addons = {
  items: {
    version: ITEMS_ADDON,
    collections: [
      {
        at: 'nodes',
        id: { field: 'text', from: 'leading-token' },
        refs: ['link.id'],
        layout: ['side', 'collapsed'],
      },
    ],
  },
};
```

- `at` は中身の中の場所（`.` でたどる。空なら中身の全体）。配列なら要素、object なら値の 1 つずつが候補です。ID の無い要素は項目にしません。
- `id` は ID の欄の名前か、`{ field, from: 'leading-token' }`。後者は「その欄の文字の頭に ID がある」という意味で、どの文字を ID と見るかは Host が自分の ID の形で決めます（package は正規表現を渡しません）。
- `title` は題の欄。`leading-token` のときは省けて、欄の文字から ID を除いた残りが題になります。
- `refs` はその項目が使う別の項目の ID を持つ欄（文字か文字の配列）。`layout` は見た目だけの欄で、Host が比べるときに除きます。
- 宣言の形は登録の時点で確かめます（知らない欄、`leading-token` 以外の読み方、`__proto__` などの道筋、重なった道筋は断ります）。
- `readItems(addon, value, leadingId)` は宣言で中身を読み、`{ items, problems }` を返します。形の違う中身は投げずに `problems` に入れます。上限は `ITEMS_LIMITS` です。

### items@1-draft

`items@1-draft`（`ITEMS_ADDON_V1`）は、組み込みの Graph／Data の分析の項目（[分析間の要素参照の設計](analysis-references-design.md) U1・U6）のために、コレクションへ三つの欄を足した版です。`items@0-draft` の宣言はそのまま有効で、意味は変えません（0-draft の宣言にこの三つの欄を書くと断ります）。

- `where`：要素を欄の値で絞ります（例：`{ type: 'cause' }`）。1〜8 個の道筋 → 文字・数・真偽。
- `rootRefs`：中身の根からの道筋。そのコレクションのすべての項目が、そこにある ID を引きます（例：図の属性 `attributes.problemRef`）。
- `merge: { equal }`：同じ ID の要素を 1 件の項目にまとめます（FMEA の行から故障モードを多対一で投影する）。`equal` の道筋と、そのコレクションの `refs` の道筋が全要素で同じときだけ 1 件で、項目の `body` はその道筋だけを持ちます。違えばその ID は重複です。
- 1-draft の `readItems` は、項目ごとに `elements`（その ID を持つ要素の key、内容の順）を返し、二つ以上の項目が同じ ID を名乗るとき（merge の無い 2 要素、merge で食い違う要素、二つのコレクション）は `items` から外して `duplicates`（`same-id`／`merge-mismatch` と、食い違った道筋）に入れます。項目の同一性は ID で、`elements` は移動と表示のための対応です。
- 版の交渉：Host が読める版の一覧を渡し、`itemsDeclarationFor(declaration, hostVersions)` はその版を読める Host にだけ宣言を返します（0-draft に落として一部だけ渡すことはしません）。0-draft だけを読む Host は 1-draft を「unsupported items add-on version」で断ります。
- 組み込みの宣言：Graph は Profile schema 3 の node type `items` から `graphItemsDeclaration(profile)`、Data は schema 3 の表の `items`（列 ID で書く）から `dataItemsDeclaration(data)` で作ります。
