# Extension の追加機能（add-on）

Extension の manifest は、必須の項目のほかに、版を完全一致で宣言する追加機能（`addons`）を持てます。
宣言しない package の manifest は変わりません。知らない add-on・知らない版の宣言は、登録の時点で断ります。
実装は `@editor-platform/extension-contract` と `@editor-platform/extension-runtime` にあります。

| add-on       | 版の token           | package が渡すもの                      | Host が使う口                                  |
| ------------ | -------------------- | --------------------------------------- | ---------------------------------------------- |
| `operations` | `operations@0-draft` | `operations`（`checkInput`・`command`） | `ExtensionHandle.operations`（check・prepare） |
| `create`     | `create@0-draft`     | `create()`                              | `Registration.create()`                        |

manifest が add-on を宣言することと、definition がその関数を持つことは一致していなければなりません。
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
