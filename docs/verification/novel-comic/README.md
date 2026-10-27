# 長編Document・Designページ構成の検証（#536 / #537）

2026-10-26。Source: `1ada7d2a` をbaseとする本変更。対象は `document` のN0/N1、`design` のM0 local/native subset。[設計](../../novel-comic-design.md)・[Host契約](../../authoring-contract.md)を基準とする。N2/M1/M2、製品公開、性能受入を完了したと主張しない。

## 環境・固定fixture

Linux cloud、Node 24.19.0、npm 11.9.0、Vitest 4.1.12、Playwright 1.63.0。BrowserはChromium、desktop 1440×900 / mobile 390×844（iPhone 13のChromium emulation）。OS native IME、実機、Firefox/WebKit、実Office/EPUB readerはNOT RUN。フォントは既存manifestの4つのSHA-256を `fonts:fetch` / `fonts:check` で検証したもの。

- Document: 3章×heading/朝/夜の2シーン。各章は別Artifact、同じparagraph IDでもArtifact IDで区別。既存native engine edit、proposal、selection、確定版、reload、Hostの章順を操作する。
- Design: 4 root page frames×2 panel frames、horizontal textとellipse、Hostがsource/licenseを指定する埋め込みPNG。native IDがpage/panel identity。reading orderはz-orderと独立。
- 独立Hostは `apps/artifact-host/authoring.html`。public packagesと自身のCSSだけで作り、Playground state/CSSをimportしない。通常Hostは既存PlaygroundのDesignSurfaceで新規作成する。
- PNG/PDFは保存済みexact versionのcapture。DOCXは3つの確定版を順に合成する。全て派生出力で、元原稿や確定版を置き換えない。

## 実行と結果

| 検査             | Command / 対象                                                                                                | 結果                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 追加API          | `npx vitest run packages/document/src/sequence.test.ts packages/design/src/pagination.test.ts`                | 12 PASS                                                                                                  |
| lint             | `npm run lint`                                                                                                | PASS（全体lintと最終変更fileの追加lint）                                                                 |
| 型               | `npm run typecheck`                                                                                           | PASS                                                                                                     |
| production build | `npm run build`                                                                                               | PASS（Playground / React UI / Artifact Host / Animation Host）。既存chunk-size warningあり               |
| Host最終build    | `npx vite build --config vite.artifact-host.config.ts`                                                        | PASS。manifest/proposalの最終差分を反映                                                                  |
| file policy      | `npm run check:files`                                                                                         | PASS                                                                                                     |
| tooling          | `npm run test:tooling`                                                                                        | 117 PASS                                                                                                 |
| desktop/mobile   | `E2E_SUITE=authoring.production npx playwright test`                                                          | 8 PASS。通常Designと独立Host。browser console/pageerrorを失敗条件に含む                                  |
| 全unit           | `npm test`                                                                                                    | 初回全体: 448 files PASS / 4 FAIL / 8 SKIP、4281 tests PASS / 4 timeout / 126 SKIP。5秒timeoutは下記参照 |
| 未実施           | OS native IME、実機、Firefox/WebKit、実Office、EPUB/PDF text fidelity、大規模性能、production auth/durability | NOT RUN                                                                                                  |

初回のsandbox内実行では `spawnSync git EPERM`、ネットワーク/子プロセス制約でtooling/unitが失敗。通常権限で再実行した。依存宣言testでは新Hostのcanvas-ui依存不足を発見し、workspace manifest/lockを修正後PASS。初回browserはfavicon.icoの404によりconsole検査で4 FAIL / 4 PASSとなった。機能assertionは通っていたが、data faviconを追加後の8件でconsole errorなしを確認。最終追加unitでimage nullの拒否不足を発見し、構築時の検証を追加して12 PASS。追加した通常UIのUndo/Redo testはmobileで既存メニューを開かず1 timeout（同runは7 PASS）。mobileのMore artifact actionsを開く操作へ修正し、desktop/mobileの通常UI 2件を再実行して2 PASS。最終8シナリオの全対象がPASSであることを確認した。

全unitの4 timeout（各5000ms）は `video-metadata/src/visual-timeline.test.ts` の390px drag、`document-import/src/import.test.ts` のunknown feature除去、`react-ui-tooling/src/index.test.ts` のReact array return、`office-adapters/src/adapters.test.ts` のWebP decode。並行buildによる負荷との切り分けのため、build終了後に同4fileを `npx vitest run --maxWorkers=1 ...` で再実行。再実行は4 files / 85 tests PASS。初回失敗は消さず保持し、全体一括PASSとは報告しない。`npm test` は失敗で後段の独立Slide corpusに進まないため、同corpusは別途実行し8 PASS（追加API 12件と合わせた最終runは3 files / 20 tests PASS）。

## 条件ごとの証拠

| 条件        | 判定・確認内容                                                                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N01         | PASS: Document分割案の比較、Hostとdomainの責務、M0と後続の差を設計に記載                                                                                                     |
| N02         | PASS: unknown/duplicate/dangling metadata、方向、unknown page/ruby、native/schema/hashの拒否。headless esbuildでReact/DOM/CSS不在を確認                                      |
| N03         | PASS: 元確定版のcontent/hash全体を保存/reload/順序変更後も比較。private selectionと出力は原稿を変更しない                                                                    |
| N04         | PASS: native command/transaction、panel subtree transform、batch内のmissing targetで全変更拒否                                                                               |
| N05         | PASS: proposalは1 Undo、Redo復元、delete/Undo/recreateでIDを取り違えない。native Surfaceの既存履歴を利用                                                                     |
| N06         | PASS: public entrypointsのみの独立HostでDocument/Designの編集・保存・出力。production entryをbuild                                                                           |
| N07         | PASS: 新kindは追加せず既存factory/Surface/lifecycleを利用。通常Designで4ページ新規作成→操作→保存→reload                                                                      |
| N08         | PASS: paragraph IDのfocus/selection通知、page/panel IDとreading orderのreload、削除/復元を確認                                                                               |
| N09         | PASS: Host permissionをpropose/accept/execute/saveで再検証。readOnly時の新Pages操作はdisabled。headless拒否後不変                                                            |
| N10         | PASS: 全retained versionのnative/hash検証を既存loadHostArtifact経路で利用。不正paginationをretained versionへ入れると拒否。保存失敗とretryで原稿/版が保持される              |
| N11         | PASS（宣言viewport範囲）: desktop/mobileでnative Pages、Inspector geometry/text、save/reload、semantic review、出力。screenshotを目視確認。実機/ATはNOT RUN                  |
| N12         | PASS: JSONはdata。未知操作/fieldを拒否。native drawingのみのSVG、外部image/referenceをM0 captureで拒否。画像のsource/licenseはHostの自己申告でライセンスの正当性を保証しない |
| N13         | 上記コマンドと初回の失敗を記録。全体unitのtimeoutを全体成功として扱わない                                                                                                    |
| N14         | PASS: 対応範囲、API、後続能力、上限、出力差と責務を契約/statusに記載                                                                                                         |
| C01         | 既存native text engine再利用。unconfirmed input/Host composition faultを拒否。OS native IMEの検証はNOT RUN                                                                   |
| C02         | 既存Document resolveDocumentAddressを利用し、改稿によりanchorが消えた場合Orphanを確認。ページ専用annotation modelは追加しない                                                |
| C03         | PASS: preview無変更、reject/stale/permission/composition、採用/Undo。M0外のproposal dataは拒否、semantic fallbackがあればHostは採用を拒否                                    |
| C04/S01–S06 | 新規paginationは非対応。legacy isDesign/shared/template入口が拒否する。既存Document共有subsetの拡張や新規共有受入は行わない                                                  |
| C05/C06     | paginationのtemplate/reuse/React経路は非対応。独自catalogを作らず拒否。N1結合もreuse contentを拒否                                                                           |
| C07         | PASS（生成物検査）: DOCX ZIP/XML内の章順/本文、PNG signatureと4entry、ZIP内manifestのexact version、PDF readerで4pagesを確認。実Officeでのreflow/editや出版組版はNOT RUN     |
| C08/C09/C10 | React bridge、巨大asset、offline durability、実機/全browserを新規宣言しない。captureの入力/px境界を性能保証と混同しない                                                      |

## 段階の判定・制限

N0の比較/Host契約とN1 local APIs、M0のDesign native構成・local editing・出力経路を実装。N1の結合はparagraph/headingの互換subsetであり、表/画像/HTML/reuseを黙って落とさず拒否する。本文は連続し、章改ページを強制しない。M0の吹き出しはshape + horizontal text、PDFはraster。Whiteboardへ同じmetadataやcommandを二重実装しない。

N2（縦書き/ルビ/EPUB）、M1（受入済みvector subsetの拡張/Story reference adapter/日本語組版）、M2（Raster brush/筆圧/トーン/タイル/専用Editorの選択）は未実装・別設計。native IME実機、実Office、性能/releaseの受入は完了しない。大規模の追加計測/tuning、外部製品への組込、公開snapshot生成/同期、deploymentは実施していない。

## 証拠の所在・再現

Raw logsは `/tmp/novel-comic-*.log`、screenshots/tracesは `/tmp/editor-platform-authoring-results/`（初回失敗の記録は同runのログにも保持）。Gitへ生成物を入れない。これらはこの実行環境のローカル証拠で公開readerからは取得できないため、上記commandとfixturesで再現する。manifest/出力の生成は各testがその場で行い、原稿/version/hashとの一致をassertする。

新規契約/設計/本記録をpublic export policyに明示的に収録した。今回の作業は公開snapshotを生成しないため、fresh dependency-security gateの実行や公開済みという主張はしない。実際のexport/syncには通常の必須ゲートが引き続き必要。

## Codex review follow-up（2026-10-26）

`6672be3a` に対する2件のP2を修正。native Duplicateでelement IDとともにpage/panelの読み順および画像のsource/licenseをremapし、出力対象外やimage-source errorを防ぐ。要素copy/cut/pasteはpagination metadata付きclipboardが未対応のため変更前に明示拒否。captureは描画と同じ実効appearanceを参照し、共有styleに隠れたwritingMode/ruby/rotationを拒否する。

追加した `pagination-review.test.ts` は画像/コマ/ページのDuplicate→capture→Undo/Redo、上限拒否時の原稿/history不変、共有style経由の未対応文字機能/rotationを検証。関連4 filesのunit 41 PASS。通常のEdit selection経路でclipboardの無変更と5ページへのDuplicate→保存→capture→Undo/Redoを独立Hostのdesktop/mobileへ追加し、`E2E_SUITE=authoring.production npx playwright test --project=host-desktop --project=host-mobile --grep 'native Duplicate'` は2 PASS。型/lint/file policyとHost production buildもPASS。結果ログは `/tmp/novel-comic-review-*.log`。

### 追加レビュー: inherited runs / native image replacement

`05c32697` の2件のP2を修正。簡易台詞commandはraw runsに加え実効appearanceのrunsを検査してnative text preparationへ誘導する。nativeモデルcommandで画像src/参照元が変わると旧出典metadataをatomicに除去し、Hostによる再登録までcaptureを拒否。明示的なimage proposalでは新しいsource/licenseを同じtransactionで登録し、crop/fit/opacity等のsource不変操作は出典を保持する。Undoは元画像と出典を一緒に復元する。

共有styleの書式付き台詞の拒否、patch/update/explicit画像更新、source不変を再現するunitを追加。関連4 filesで43 PASS。通常Inspectorの画像置換→保存→capture拒否→Undo→元画像/出典/capture復元のdesktop/mobile E2Eを追加し2 PASS。typecheck、差分lint、Host production buildもPASS。追加結果は `/tmp/novel-comic-review2-*.log`。
