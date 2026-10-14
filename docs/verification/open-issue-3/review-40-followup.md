# PR #40 additional review corrections — public Structured Graph Issue #3

2026-10-09、対象head `b2a7599423971800b5c0aaa8f159571813a7e35d` の全コメントと
全inline threadを確認。human review `5476126891` の5項目とinline 5件を対応付け、
重複を除いた6項目に対応した。human reviewが今回の回帰と断定していないshared配置も、
位置情報の独立性を改善し、既存の同時行削除制約と区別して記録する。
[初回実装](README.md)と[前回11件の修正](review-40.md)を歴史的記録として残す。

## 指摘と対応

| Review comment ID          | 問題                                                    | 修正と回帰確認                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4235123271 / 5476126891・1 | Definition objectのclear/null/removeが未宣言の子を消す  | 宣言した子だけを再帰merge。未宣言の子を消すnull/remove/置換はbatch全体を理由付き拒否。通常編集・Undo、明示null/remove、hidden子の上書きと別変更を混ぜた拒否、declared-only objectのclear/remove/UndoをUnit確認。production独立Hostでconfig編集→Undo→空入力拒否→Cancel→exportの原値保持を確認。                                                                                    |
| 4235123253 / 5476126891・2 | readOnly列を解除・rename・削除できない                  | 公開column factoryが作る不変commandの内部schema intentを共通guardへ引き継ぐ。Host権限と保護値の検証は継続し、任意type名や解除＋値変更では回避できない。double guard、Grid/Form/Graph/headless拒否、解除・rename・削除・Undo、Host readOnly、shared authorityのschema先行混合payload拒否をUnit確認。通常Field settingsで有効化→各viewでdisabled→解除→値変更→Undoをproduction確認。 |
| 5476126891・3              | 非同期native importが新しい正本・権限・取込順序を上書き | file読取/hash検証後、install直前に権限、対象ID、revision、artifact bytes、Save/Commit状態、request順序、mountを再確認。待機中の編集/Undoは許可し、古いimportを拒否して現在の履歴を保持。productionでFile.textを制御してreadOnly変更、編集、編集→Undoで同じbytesへ戻る場合、二つの取込の逆順完了、最新結果のexport/save/reloadを確認。                                             |
| 4235123258 / 5476126891・4 | Data History Compareが配置だけの変更を無視              | view追加/削除、label field、安定row IDごとの位置追加/移動/削除を、cell変更とは別のpathで表示。Unitで各差分と無変更、immutable版/hashを確認。production通常Compareでrows/columns/labelが同一の二版における位置変更を表示。camera/zoom/selectionは対象外。                                                                                                                          |
| 4235123247 / 5476126891・5 | DataとGraphでpositionの受け入れ条件が異なる             | Dataも位置をfinite・±100,000のx/yだけに限定し、view未知fieldも拒否。追加metadata、欠落軸、非finite、array、範囲外をUnitで拒否し、正本/revision/履歴/raw exportを保持。通常importの拒否で現在Dataが不変であること、正常配置の投影/移動/保存/比較をproduction確認。旧不正構造recordは前回の隔離/raw export経路で保持する。                                                          |
| 4235123238                 | sharedがgraphView全体を一つの書込resourceにする         | label/view設定とrow別positionを独立した変更にする。whole-view読取のaggregate invalidationは残し、全削除やview作成Undoがpeer位置を消す場合は拒否。別行の移動×削除を両順序、位置×位置、selective Undo、peer追加後のview削除/作成Undo、元入力不変をUnit確認。既存shared browser二contextの行/列削除・peer収束・Undoも再確認。                                                        |

列schema intentは内部WeakMapでありpublic APIや通信上の認証情報ではない。
公開factory commandの参照を通常Host/wrapperでも保持する。任意commandへの一般的な
readOnly免除は追加しない。sharedの権限・precondition・selective Undoは既存authorityが担う。

同じrevisionから別行を同時に二つ削除する場合、従来の `order:rows` 前提条件で二つ目は
`stale-precondition` になる。位置の有無の両方で回帰確認した。root/graphViewの全置換は
除去したが、この既存順序制約を解消したとは主張しない。Graph Surfaceのshared登録も追加しない。

## 最終検証

初回と同じLinux、Node 20.20.2/npm 10.8.2、production Vite、Chromium、
desktop 1440×900/mobile 390×844、1 worker。browser console error/pageerrorを失敗条件とする。

| 対象                                     | 結果    | 範囲                                                                                                |
| ---------------------------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| lint / strict TypeScript / build         | PASS    | 全source、通常Host、独立Graph Host、既存React preview                                               |
| Unit                                     | PASS    | **1,044 tests / 112 files**。今回14件追加（Definition 2、Data schema 1、配置/比較 6、shared 5）     |
| Tooling                                  | PASS    | **25 tests**                                                                                        |
| production Chromium                      | PASS    | **20 cases**。前回16にDefinition clear、Field settings往復、配置import/Compare、遅延importの4件追加 |
| format / file guard / public export scan | PASS    | 本記録を明示public policyに追加。生成物はGit外                                                      |
| representative screenshots               | PASS    | 通常native desktop/mobile、独立Data mobile、Definition desktop、配置だけのCompare                   |
| performance / 実Framework利用側trial     | NOT RUN | 既存停止と利用側責務を維持                                                                          |

全repository E2E、他engine/実機/native OS IME/支援技術、実Framework Adapter、
production auth/durabilityの認定ではない。Graph shared/annotation/template/reuse/外部出力は
宣言外。自動Actionsはmanual-only、性能調整/追加測定は停止、#22性能合格は保留。
公開repoへ同期しない。PRは修正Push後も再レビュー・マージ待ち。

## 開発中の失敗と証跡

- 追加テストのoptional graphView、command推論、unused importでTypeScript/lintが失敗。
  テスト型を明示して最終検査を通した。
- 最初の全Unitは1 FAIL/1,043 PASS。既存回帰が期待する小文字のread-only診断へ修正。
  次の全Unitはview作成Undoのpeer位置保護で1 FAIL/1,043 PASS。whole-view resourceの
  invalidationを追加し、targeted shared 15 PASS、全Unit 1,044 PASSを確認した。
- 初回追加browserは3 PASS/1 FAIL。importの表示labelとaria-labelを取り違え、locatorが
  待機した。公開aria-labelへ修正し遅延import個別PASS、対象20件PASSを確認した。
  後にCompare fixtureを両版とも既存layoutを持つ条件に強め、最終対象を再確認した。
  この強化時はSave後のfocusをnodeへ戻さず二度目の矢印が移動にならなかったため、
  二版のhash一致で個別1 FAIL。nodeを再選択する実操作へ修正した。
- logは `work/graph/followup-*.log`、画像/traceは `/tmp/editor-platform-graph-results/`。
  生成物をGitへ追加せず、公開fixtureと次のコマンドで再生成する。

```sh
npm run lint
npm run build
npm test
npm run test:tooling
npm run check:files
npx playwright test --config playwright.graph.production.config.ts
```
