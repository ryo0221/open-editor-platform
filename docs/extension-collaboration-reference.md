# 外部 Editor の共同編集を試す

参照 Host は1つの成果物をループバックで開く。タブごとに独立した接続を発行し、共有の下書き・操作結果・本人の Undo 履歴・保存した版を指定の SQLite ファイルに記録する。実行には Node.js 24 を推奨する。

カード例の共有配布版をテンプレートの `npm run build:shared` で作る。ローカルで自分がビルドした例では、出力を点検したうえで `pins.json` を Host の信頼設定として指定できる。受領したパッケージの導入時は、管理者が別に管理する承認済み pin を渡す。

```sh
npm run collaboration:external -- \
  ../open-editor-template/dist/shared/package.json \
  ../open-editor-template/dist/shared/pins.json \
  ../open-editor-template/fixtures/example.json \
  /tmp/cards-reference.sqlite
```

表示されたアドレスを2つのブラウザーで開く。別カードの名前を同時に編集すると両方に反映される。「元に戻す」は自分の接続が確定した編集を対象とする。同じ欄が競合すると、後から送った人のダイアログに入力と理由が残る。「この版を保存」は、画面で見た revision と保存先の親版を指定する。

## 製品 Host の接続

- Node 用の公開入口は `@editor-platform/extension-runtime/shared-draft`。UI パッケージを `verifyExtensionPackage` で検証し、別の codec pin 検索関数を渡して `SharedDraft.open` する。既存 DB は成果物・パッケージ pin が一致したときに開く。
- 接続の `principal()`・`readable()` は、実行時点の認証、対象成果物への権限、接続の有効性を Host が返す。参照 Host はローカルの参加者に全カードの編集を許可する。製品側には利用者・Room の認証と scope の発行が必要になる。
- `submit`、`undoRedo`、`receipt`、`save` が確定・再照合・指定版保存を扱う。`previewProposal` と `adoptProposal` は提案時に読んだ条件を保持する。移行は明示的な管理権限で `previewMigration` し、比較後に `commit` または `cancel` する。
- codec は各評価につき別プロセスの QuickJS で実行する。この参照実装の編集遅延にはプロセス起動時間も含まれる。ブラウザー側の予測は確定時に再計算する。

[設計と受入条件](extension-collaboration-design.md)
