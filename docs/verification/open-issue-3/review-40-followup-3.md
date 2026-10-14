# PR #40 latest review corrections — public Structured Graph Issue #3

2026-10-10、対象head `6f5f289709d4f29d9b822355595bb96fcd2be07e` の本文・全コメント・
全inline threadを確認。human review `5477004155` の4件と追加Definition境界2件、
重複するinline 5件を修正した。[初回](README.md)、[初回レビュー](review-40.md)、
[追加](review-40-followup.md)、[前回](review-40-followup-2.md)は歴史的記録として保持する。

## 指摘と対応

| Review comment ID              | 問題                                               | 修正・回帰確認                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5477004155・1                  | 保護列の値を持つ保存行を版から復元できない         | 公開restoreDataVersionがHost所有Artifactのversion・Artifact ID・hash・構造を検証し、revision/全Artifact/accessを取得後と適用時に再検査。private intent付き不変commandだけexact保存contentを復元。偽装名/command copy/不正CSV・新規行は拒否。Unitで欠落/重複/異Artifact/hash/kind、権限変更、版bytes変更、revision stale、二重guard、Undo/Redoと版不変を確認。browserで通常編集→保護→版保存→行削除→復元→Undo/Redo、readOnly UIと版不変を確認。 |
| 4235611178 / 5477004155・2     | native object textareaで未知子を書換え・消失できる | UI/pure intentがdeclared childをrecursive mergeし、共通guardもroot/nested/array内の未宣言member差分を拒否。unknown overwrite/null/remove/lossy array/混合batchは原子的に拒否。初期node/edge metadataと削除後の元node復元は保持できる。Unitでheadless/intent/Undo/Redo、browserで宣言子編集とunknown overwrite/clear拒否・履歴不変を確認。                                                                                                     |
| 4235611172 / 5477004155・3     | Data重複optionsがGraph enumで拒否される            | Graph投影enumだけ先頭順で重複排除。元列options、元ID、未表示値を変更しない。Unit/browserで有効投影・選択値編集・Undoと原本不変を確認。                                                                                                                                                                                                                                                                                                        |
| 4235611185 / 5477004155・4     | 16 MB超過Fileをtext後に拒否する                    | 公開readGraphArtifactFileがFile.sizeをtext前に確認。直接文字列も文字数のcheap gateとUTF-8 byte gateを維持。Unitで超過/不正sizeにtext未呼出、通常/上限metadataの読取、ASCII/UTF-8超過を確認。browserで超過metadata未読取とcontent/revision/Undo保持、上限metadataの正常読取を確認。                                                                                                                                                            |
| 4235611162 / 5477004155・追加1 | 導出IDが512文字上限超過・native nodeと衝突する     | 通常prefix IDを維持し、長い/衝突IDだけSHA-256へ変換、native node/root namespaceと照合する。元Definition IDは保持。rootとの衝突は明示拒否。Unitで512文字、prefix/実際のhash namespace占有、retarget/Undo、browserで長いIDとprefix衝突の操作を確認。                                                                                                                                                                                            |
| 4235611169 / 5477004155・追加2 | 未解決mapped参照を黙って省略する                   | output/target/componentが未知先・異型値なら投影/prepareを理由付き拒否。原本を再解釈・変換しない。Hostはsurfaceを表示できない状態でも元sourceとexportを保持。Unitで4種の不正参照とcontent/revision/history保持、browserで診断・元export・Undo不変を確認。Graph内修復は宣言しない。                                                                                                                                                             |

復元APIのreadは信頼されたHostによる現在Artifactの取得であり、remote commandから
注入する認証情報ではない。共有Dataは既存authority/operation/selective Undoを使う。
通常CSV/headless新規行のreadOnly既定値/formula保存値なしのguardは緩めていない。
未知子を含まないnative属性の通常clear/removeと既存readonly制約も維持する。

## 最終検証

Linux、Node 20.20.2/npm 10.8.2、Chromium desktop 1440×900/mobile 390×844、1 worker。
全browserケースはconsole error/pageerrorを失敗にする。

| 対象                                     | 結果    | 範囲                                                                                                       |
| ---------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| lint / strict TypeScript / build         | PASS    | 全source、通常/独立Host、既存React preview                                                                 |
| Unit                                     | PASS    | **1,082 tests / 116 files**。今回23件：version restore 9、native/File境界7、重複options 1、Definition境界6 |
| Tooling                                  | PASS    | **25 tests**                                                                                               |
| Chromium functional cases                | PASS    | **29 cases**。前回24＋今回5、desktop/mobile回帰                                                            |
| format / file guard / public export scan | PASS    | 本記録をpolicyに追加、生成物はGit外                                                                        |
| representative screenshots               | PASS    | native retained object、protected Data restore、Definition refusal、既存native desktop/mobile              |
| performance / 実Framework利用側trial     | NOT RUN | 停止・利用側責務を維持                                                                                     |

29件中28件はproduction Vite dist、残る1件は既存のbounded/readOnly Profile fixtureを
public entrypointだけからesbuild production modeで独立bundleした機能fixture。
サイズ境界テストは小さい有効JSONとFile.size override/mocked text counterを使い、
実際の16 MBファイルをbrowserへ渡した測定ではない。文字列byte超過はUnitで別確認。
Definitionのbrowser入力はtrusted Host storage fixtureであり、通常Definition import UIや
未知参照のGraph内修復は提供しない。代表画像を目視確認した。

全repository E2E、他engine/実機/native OS IME/支援技術、実Framework Adapter、
production auth/durabilityは未検証。Graph shared/annotation/templates/reuse/format-export
も宣言外。性能調整/追加測定・自動Actionsは停止、#22性能合格は保留、公開repoへの
同期は実施しない。他PRや製品固有コードを含めない。修正Push後もPRは再レビュー待ち。

## 開発中の失敗と証跡

- targeted Unit初回95件中1件FAIL。ランダムな初期Graph IDを別fixtureと比較したため、
  serialized入力との比較へ修正した。
- native初期metadataの回帰追加時にoptional引数を誤った関数へ追加し、全体初回は
  Unit 54件FAIL、TypeScript 7エラー、lint 1エラー。正しいguard signatureへ修正し、
  全Unit/build/lintで再確認した。
- package-lock-onlyのoffline初回はregistry metadataがcacheになくENOTCACHED。
  既存resolved hash dependencyのworkspace dependencyを明示してlockを更新し、
  offline lock-only整合確認は成功。依存のversionや既存integrityは変更しない。
- 全29 browser初回はPASS。画像確認でDefinition拒否診断が空キャンバスの下にあることを
  検出し、空surfaceを出さず診断をviewport内へ移した。viewport assertionを追加し、
  build/browser回帰で再確認した。
- 生ログはignored work/graph/fourth-\*.log、browser画像/traceは
  /tmp/editor-platform-graph-results。dist、fonts、cache、export treeをGitへ追加しない。
