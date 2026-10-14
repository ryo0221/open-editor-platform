# PR #40 review corrections — public Structured Graph Issue #3

2026-10-09、review対象head `3d091fe3b193a3f5c2c2e80dd5f4c2bbbd242c94` の
PR本文・全コメント・全inline reviewを確認。inline 9件とhuman commentの追加2件、
計11件を修正した。human commentが数えた8件と実際のinline件数には差があるため、
以下で個別に対応付ける。元の[初回記録](README.md)を残し、この記録を最新の機能確認とする。

## 指摘と対応

| Review comment ID | 問題                                               | 修正と回帰確認                                                                                                                                                                                                                                                                                                                         |
| ----------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4233926449        | Commitのhash待機中に最新draftを上書き              | Commit開始snapshotだけを版にし、完了時の最新draftへimmutable versions/baseVersionIdを反映して保存。busyはawait前に取得。production独立Hostでdigestを遅延し、編集→Undo→再編集→二重Commit→解放→export/reloadを確認。版は開始内容、draftは最新内容、versionは1件。                                                                        |
| 4233926456        | zero-column Dataの配置・row追加が拒否              | labelColumnIdを列なしではnullとし、最後の列削除後もpositionsを保持。全列削除→Graph移動/row追加→版保存/JSON→UndoをUnitで確認。                                                                                                                                                                                                          |
| 4233926458        | cycle検証のedgeごとの全走査                        | typeごとに接続数/隣接表を一度作り、反復DFSの強連結成分でcycle edgeを診断。1,000 nodes/4,000 edgesの境界、閉じたcycleと分岐をUnit確認。時間・benchmark・性能合否は測定しない。                                                                                                                                                          |
| 4233926462        | shared Data transactionがgraphViewを落とす         | Data codec rootにgraphViewを含める。2つのSharedEditorSessionとproduction独立browser contextsで、配置済みrowとlabel fieldの削除・selective Undo・peer edit保持・peer収束を確認。Graph Surfaceのshared登録は追加しない。                                                                                                                 |
| 4233926469        | 接続bufferが最新stampで古い入力を適用              | bufferに開始stamp/選択対象/dirtyを保持。cleanはsource/selection更新に追従、dirtyはstaleを表示してsubmit拒否、Reload connectionで再取得。production独立Hostのretarget/Undo/Redo/選択変更で確認。                                                                                                                                        |
| 4233926474        | 空・長いData IDを投影できない                      | 短いIDは可逆prefix、長いIDはcanonical JSONのSHA-256でbounded ID化。逆変換はcanonical rowsとの一致を用い順序非依存。空ID、507/508文字、長いUnicode、lone surrogate、属性/配置編集/並替えをUnit確認。元IDは保持。空row IDはDataの未設定表現と区別できないためrelation targetだけ拒否。                                                   |
| 4233926481        | semantic proposal previewがsidecar配置を失う       | 現projectionのlayoutをsemantic previewへ渡す。移動後のpreview/applyが配置を保持し、正本をpreviewで変えないことをDefinition Unitで確認。                                                                                                                                                                                                |
| 4233926487        | proposal previewの診断が旧sourceのまま             | 提案sourceからProfileとdomain diagnosticsを再計算。提案による診断発生/解消、原source/診断の不変、sidecar保持をUnit確認。                                                                                                                                                                                                               |
| 4233926493        | Positionの未知fieldをmoveが落とす                  | Positionはx/yのみを受け付ける。未知metadataを持つnative JSONの読込とmoveを拒否し、content/historyが不変であることをUnit確認。                                                                                                                                                                                                          |
| 5475802891・追加1 | 旧未解決relationで読込/修復できずlibrary全体が停止 | 読取のassertDataReadableと完全参照を要求するassertDataIntegrityを分離。guardは同じaddress/valueの旧不正参照を保持でき、新たな不正参照を拒否。段階修復/無関係な編集/UndoをUnit確認。production通常Hostで旧versionを含むDataを読み、値/versionsを保持し修復/Undo。別の不正構造recordは隔離・raw export可能で、正常Documentは利用を継続。 |
| 5475802891・追加2 | Dataの空文字relationをGraph enumが拒否             | null/省略/空文字を投影時だけnullへ正規化し、relation enumはbounded投影IDを使う。3表現すべてGraphを開き、無関係な属性編集でraw表現を保持、接続で元row ID、切断でnullになることをUnit確認。                                                                                                                                              |

## 最終検証

環境は初回と同じLinux、Node 20.20.2/npm 10.8.2、production Vite、Chromium、
desktop 1440×900/mobile 390×844。ブラウザのconsole error/pageerrorを失敗条件とする。

| 対象                                     | 結果    | 範囲                                                                                 |
| ---------------------------------------- | ------- | ------------------------------------------------------------------------------------ |
| lint / strict TypeScript / build         | PASS    | 全source、通常Host、独立Graph Host、既存React preview                                |
| Unit                                     | PASS    | **1,030 tests / 111 files**。今回10件追加、既存回帰を含む                            |
| Tooling                                  | PASS    | **25 tests**                                                                         |
| production Chromium                      | PASS    | **16 cases**。既存12にCommit競合/接続buffer/旧Data回復/shared Data metadataの4件追加 |
| format / file guard / public export scan | PASS    | 明示public policyに本記録を追加。生成物・log・画像はGit外                            |
| representative screenshots               | PASS    | 通常native desktop/mobile、独立native/Data mobile、Definition desktop                |
| performance / 実Framework利用側trial     | NOT RUN | 既存停止と責務分離を維持                                                             |

全repository E2E、他browser engine、native OS IME、実機/支援技術、実Framework Adapter、
production auth/durabilityの認定ではない。Graph shared/annotation/template/reuse/外部出力は宣言外。
既存Data sharedのgraphView互換性だけを確認した。#22性能合格は保留。
自動Actionsはmanual-onlyのまま起動しない。PRは修正Push後もレビュー/マージ待ち。

## 開発中の失敗と証跡

- 初回の追加shared UnitはdeleteRowsをmodel entryからimportして1 FAIL/102 PASS。
  公開views entryへ修正し103/103 targeted PASS、最終全Unit PASS。
- browser seedのrecursive型と、ArtifactへのHost注釈metadataのobject literal型で
  TypeScriptエラーが出た。browserにはJSON文字列を渡し、注釈はHostのenvelope拡張として
  構築するよう修正。最後のbuild/strict TypeScriptで確認した。
- 初回production browserは15 PASS/1 FAIL。旧Data fixtureが通常Host必須のannotations配列を
  省略しており読込後にUIで例外となった。fixtureを通常StoredArtifact形式に修正し、
  個別1 PASS後に対象16件を再実行した。browser errorの失敗条件は緩めない。
- logは `work/graph/review-*.log`、画像/traceは `/tmp/editor-platform-graph-results/`。
  生成物はGitに追加せず、上記公開fixture/コマンドから再生成する。
