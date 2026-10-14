# PR #40 further review corrections — public Structured Graph Issue #3

2026-10-10、対象head `d8ec5f230f3fbabe1187d28a541bdddfc3b0f936` の全コメントと
全inline threadを確認。human review `5476420775` のP2 4件とP3表示改善、
対応するinline 5件を重複なく修正した。前回指摘への修正確認と今回の追加指摘を区別し、
[初回](README.md)、[前回11件](review-40.md)、[追加6件](review-40-followup.md)は
歴史的な検証記録として保持する。

## 指摘と対応

| Review comment ID           | 問題                                   | 修正・回帰確認                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4235377233 / 5476420775・1  | 新規行のreadOnly/formula値が未検証     | 共通guardが新規rowを抽出し、readOnly値は公開makeRowの既定値とown-property表現、formulaは保存cellなしを要求。通常追加・既定値CSVは成功、不正CSV/headless・良否混合batchは原子的に拒否。旧既存行の保護値は保持。Unitでrevision/Undo/Redo不変と通常追加Undo、browserでCSV拒否と正常追記Undoを確認。                                                                                              |
| 4235377228 / 5476420775・2  | 有効なData列IDがGraph制約に違反        | dataFieldId/dataColumnIdを公開し、schema、属性、path、edge type、UI/label、formula診断、選択通知を統一。通常有効IDは保持、空/予約名/長いID/encoding namespaceをboundedなIDへ変換。元列IDと未表示値を保持。10種のIDとnamespace衝突、rename/reorder、属性/関係/UndoをUnit確認。通常browserで空・constructor・長いUnicode・literal prefixを混在させ、属性・関係の変更/Undo、Grid選択通知を確認。 |
| 4235377238 / 5476420775・3  | Add nodeの初期値が長さ・数値範囲に違反 | pure createGraphNodeが文字列長と数値両端を満たすscalar値を生成。complex/制約を満たせないenum/readOnly値は省略し、requiredは非blockingな未入力診断。短い/空文字、負数最大、両端、正の最小、optional/required、範囲違反拒否・編集・UndoをUnitと独立public Surface fixtureで確認。                                                                                                               |
| 4235377236 / 5476420775・4  | proposalのgraphとProfile/診断が不一致  | displayedProjection = proposalView ?? projectionの同じ結果からgraph/Profile/stamp/diagnosticsを渡す。previewの表示stampはproposal IDとbaseで区別し、clean Inspector入力も更新。採用には元proposal baseを使う。架空Hostに提案目的の入力を追加し、診断の解消・発生の両方向とRejectによる原本診断復元をbrowser確認。preview/rejectで正本・履歴不変。applyは元proposal baseのstale確認を維持。    |
| 4235377241 / 5476420775・P3 | whole-Profile readOnlyでも編集UIが有効 | propsとprofile.graph.readOnlyの論理和をSurface全編集入口へ適用。private drag/delete確認もreadonly移行時に終了。独立fixtureでpropsを渡さずProfileだけreadonlyにし、追加/移動/属性/接続のdisabled、keyboard変更なし、選択/閲覧/zoomを確認。保護を迂回できたとは扱わない。                                                                                                                       |

CSVの保護値は黙って削除せず、既定値と異なる値を含むbatch全体を拒否する。
既存legacy行の保護値を再計算/破棄しない。sharedの既存operation/authority/selective Undoを
このlocal新規行guardに置き換えず、過去行を復元するtrusted履歴を通常追加と混同しない。
Graph Surfaceのshared登録は引き続き宣言外。既存の同時row削除のorder:rows制約も保持する。

## 最終検証

Linux、Node 20.20.2/npm 10.8.2、Chromium desktop 1440×900/mobile 390×844、
1 worker。全browserケースはconsole error/pageerrorを失敗にする。

| 対象                                     | 結果    | 範囲                                                                               |
| ---------------------------------------- | ------- | ---------------------------------------------------------------------------------- |
| lint / strict TypeScript / build         | PASS    | 全source、通常/独立Host、既存React preview                                         |
| Unit                                     | PASS    | **1,059 tests / 114 files**。今回15件追加：Data guard 2、列ID 11、node初期値 2     |
| Tooling                                  | PASS    | **25 tests**                                                                       |
| Chromium functional cases                | PASS    | **24 cases**。前回20＋新規行CSV、任意列ID、bounded/readOnly Profile、提案診断の4件 |
| format / file guard / public export scan | PASS    | 本記録をpublic policyに追加、生成物はGit外                                         |
| representative screenshots               | PASS    | 通常native desktop/mobile、Data列ID、readonly Profile、提案診断                    |
| performance / 実Framework利用側trial     | NOT RUN | 停止・利用側責務を維持                                                             |

24件中23件はproduction Vite distの通常/独立Hostと既存shared Dataを使う。
残る1件は `tests/fixtures/graph/bounded-host.tsx` をpublic entrypointだけからesbuild
production modeで独立bundleし、生成JS/CSSをメモリ内でbrowserへ渡す。任意のtrusted
Profile制約とProfile単独readonlyを試す機能fixtureであり、通常Playgroundへの追加登録や
配布済みnpm packageの証明ではない。Desktop/mobile代表画像を目視確認した。

全repository E2E、他engine/実機/native OS IME/支援技術、実Framework Adapter、
production auth/durabilityは未検証。Graph annotation/templates/reuse/format-exportも宣言外。
性能調整/追加測定・自動Actionsは停止、#22性能合格は保留、公開repoへの同期は実施しない。
他PRや製品固有コードを含めない。PRは修正Push後も再レビュー・マージ待ち。

## 開発中の失敗と証跡

- 初期追加UnitでGraphSessionにないdiagnostics propertyを参照し、44件中2件FAILと
  TypeScript 3エラーになった。公開validateGraphを使うテストへ修正し、全Unit/buildで確認。
- 新規browser初回は4件中3件FAIL：desktopにないMore toolsを待機、水平SVG edgeの
  zero-heightに対するpointer locator、required欠落の非blocking field alertを誤って
  エラーなし条件に含めた。レスポンシブUIの存在確認、接続のkeyboard操作、診断と
  blockingエラーの区別へテストを修正。4件再実行はPASS。
- 画像確認で、診断が更新されてもclean Inspector値がbaseのまま残ることを検出した。
  preview表示stampを原本と分け、入力値と診断の一致・Rejectでの復元を両方向のbrowser
  assertionに追加。Unitでも元proposal baseによる採用とpreview stampの直接適用拒否を確認。
- file guardの初回はsandboxのspawnSync git EPERMで実行失敗。必要なsubprocess許可で
  再実行した。検査の除外・制約変更はしていない。
- public exportの初回は本記録の製品名による残存情報scanで拒否。製品名を含まない
  責務・範囲の表現へ修正し、scanner設定を変えずに再検査した。
- 生ログはignored work/graph/third-\*.log、browser画像/traceは
  /tmp/editor-platform-graph-results。dist、fonts、cache、export treeとともにGitへ追加しない。
