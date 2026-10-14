# Audit #53–#73: local verification

The subsequent 2026-10-11 review fixes and their own checks are recorded in
[PR #52 follow-up](pr52-review-followup.md). The results below describe the original
2026-10-10 audit checkpoint.

2026-10-10、監査 #73の未修正20件（#53–#72）、#46 D23追加、PR #52レビュー7件を
既存の一つのPRへ追加した。Issue本文・全コメント、AGENTS.md、status、開発・受入契約を
確認し、最終再取得でも22対象の本文・コメント数に変更はなかった。
[設計・所有境界](../../issues-53-73-audit.md)、[public API / Host契約](../../embedding.md)
と併せて読む。参照デモ/未マージPR #37をPlatformの検証済み版として扱わない。

## 環境と再現

Linux、Node 20.20.2、npm workspace、固定Office fonts4書体のSHA-256検証。
Poppler `pdftotext`/`pdftoppm`で実PDFを抽出/描画。Production Vite build、Chromium desktop 1440×900 / mobile viewport 390×844、worker 1。
通常Playground、public packageのみの独立 `/embed.html` / `/graph-host.html`、
既存shared reference serverと隔離React export/previewを使用。
全browser fixtureでpageerror/console errorを失敗にする。

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run test:tooling
npm run check:files
npx playwright test --config playwright.audit.production.config.ts --workers 1
npx playwright test --config playwright.usability-regression.production.config.ts --workers 1
npx playwright test tests/e2e/issue2-document.spec.ts tests/e2e/issue2-export.spec.ts tests/e2e/issue2-review-viewer.spec.ts tests/e2e/reuse-view.spec.ts --config playwright.production.config.ts --project desktop --workers 1
npx playwright test tests/e2e/template-review.spec.ts tests/e2e/v2.spec.ts tests/e2e/editor-collaboration.spec.ts --config playwright.production.config.ts --project desktop --workers 1 --grep 'R4-3/4|design frames, text|EI-Q06'
```

## 最終結果

Lint / strict TypeScript / production build / file guardはPASS。
Unitは **1,114 / 125 files PASS**、toolingは **25 PASS**。
Production Chromiumは監査/レビュー追加 **21 PASS**、既存操作/React/Graph/shared/mobile回帰
**73 PASS**、Document/Viewer/reuse回帰 **14 PASS**、既存component作成 **3 PASS**。
重複を除いた対象は **111 browser cases PASS**。
日本語PDFの実clipboard copy、旧原本の対象行強調、チェックリスト出力も最終試行で確認。
代表screenshot（PDF2ページ目・検索選択・endpoint overlay・mobile chart/table）を目視した。
公開snapshotのsource-only exportは788 source files、manifestを含む789 filesの整合性/residual scanはPASS。
Actionsは起動していない。原証跡は `/tmp` / ignored `work/` に保持し、Gitには含めない。

## 対象と証拠

| 対象        | 検証                                                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #53/#54/#71 | 通常表UIのTab/ShiftTab、最終cell行追加、Add row同列focus、Undo、readonly切替ARIA、mobile。表command unitは一Txnと選択位置を確認。Pointer後はbrowserのselectionchange処理を待ち、editor/storeを直接操作しない                                                        |
| #55/#56     | 旧原本版を保存→行注釈→別fileとsource変更でHost選択解除/投稿不可→Host resolverがexact旧版名/revision/本文を表示→現在行へ明示再紐付け。unitはstale/他file投稿拒否                                                                                                     |
| #57/#59/#60 | 通常Document PDFを実出力し`pdftotext -layout`で日本語本文・表を抽出。見出し+図が2ページ目へ移動、プレビューと同じ2ページ。Fileで日本語検索→2ページ目、同ページの複数一致を順次移動、選択文字列/コピー用range、元bytes不変。画像と文字の位置をPDF reader描画でも目視 |
| #58/#65     | Fileの既存注釈を保持した置換確認→Cancel無変更→BOM付きUTF16LE取込み/原本bytes不変→旧注釈Orphan→Undo/Redo→版保存/reload→無効bytesの説明/Cancel無変更。unitはLE/BE/明示Shift-JIS/元bytes不変                                                                           |
| #61/#62     | date列なしのTimelineで共通date列追加/割当→入力→Undo。別barのpointer focusと選択、0移動はnative不変、drag直後keyboard移動・Undo/Redoは対象期間だけ                                                                                                                   |
| #63/#64     | 既存named Dashboardでwidget削除→Host最初のUndoはprivate編集→Redo→Save境界でnamed view確定→native Undo/Redo。別成果物への切替/reopen・browser reloadで最終projection復元。選択とSession履歴のreload永続化は宣言しない                                                |
| #66/#67     | Chartの絞込/hidden列でnative/Hostの範囲選択と件数、同じCSV、全件/全列の日本語/改行/quotes。target number/Select/Relationの全診断、対応ID・追加preview、Cancel、正常追加Undo。unitはhidden依存formula値/引用、mapping重複/未対応も確認                               |
| #68         | 独立HostがPPTX/DOCXを提供しない場合、各menuで無効理由。通常Document出力menuは開いても拒否せず、実入力compositionの拒否を別に検証。既存Office encoder自体の実Office受入は今回未実施                                                                                  |
| #69         | 実SVG pathを通常選択→endpointがstickyよりhit優先→候補表示→Escape/取消でnative無変更→接続先変更はnode geometry不変、Undoで元接続。拡大hit targetとoverlayを目視                                                                                                      |
| #70/#46 D23 | Hug presetの説明/固定size選択→exact geometry→Undo/Redoとcontrolled value。unitは子をfitする選択も確認。普通のPNG挿入→strict診断からnative Inspectorへ→HTML意味/img・日本語alt→保存/reload→実React ZIP出力、Detachなし                                               |
| #72         | 同一計算の系列名/値/集計対象列/record数をSVG aria-labelとkeyboard details集計表で確認。合計170と複数系列、狭いHostで表/CSV dialog。実screen reader利用は未実施                                                                                                      |

PRレビュー: singleton root overrideの移行はnative drawing本文/書式をunitで検証。
Rejected CommitInputのbuffer保持/Host flush拒否は独立Host browserとunit。
Host CSVはpending Form値73を確定して出力しUndoで40へ戻す。
Graphのnonblocking診断はmigration unitで許可、blocking拒否の既存unitも維持。
無効Formのnative importはlibraryへ成果物を増やさず拒否。
未使用componentの公開はsynthetic検証のみで、nativeへinstanceを作らず保存可能。
Slide Duplicateは合成composition中に拒否し、元slide/内容を保持。

D03（Document menu guard）、D04（native複製のlocal注釈ID remap/外部参照保持とreload）、
D07（Host nav CSSのscopeとReview操作）を通常UIで確認。
D21 Code保存/実行はHost拡張でPlatformにCode kind/runtimeがないためN/A。

## 条件IDと限界

今回の変更範囲に限定した判定。全Editorの再認定やnative IME合格ではない。

| 条件 | 判定・根拠                                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| N01  | PASS: 設計/所有境界と対象20件・追加/デモ4件のledger                                                                           |
| N02  | PASS: pure/native command・CSV target validator・source selection guardのunit。不正encoding/source/mappingは拒否              |
| N03  | PASS: native/versionとprivate viewを分離。Save/reopen/reload、native内容/元bytes不変のbrowser                                 |
| N04  | PASS: 表/日付/CSV/Design操作は既存command/Txn、Cancel/入力不正/drag取消で対象native不変                                       |
| N05  | PASS: private Dashboard→native history順、期間/表/置換/preset/appendのUndo/Redo、compositionの複製拒否                        |
| N06  | PASS: App/store/CSSをimportしない独立Hostのreadonly/capability/拒否buffer/選択通知                                            |
| N07  | PASS: 新しいkind/runtimeは追加せず、Host source creation/format能力に従う。通常保存/取込み/reload                             |
| N08  | PASS: stable file/row/node ID、source変更でclear callback、固定revision投稿guard/明示remap                                    |
| N09  | PASS: 既存guard/Session/authorityを維持。readonly/unavailable形式/rejected入力/誤sourceを拒否                                 |
| N10  | PASS: native/source roundtripとversion、取込み拒否でghost artifactなし、byte保持                                              |
| N11  | PASS: desktop keyboard/focus/Tab、狭いviewportのChart/CSV/表、representative screenshot目視。実機はNOT RUN                    |
| N12  | PASS: text layerは原本を改変/実行せず、既存PDF安全設定/上限を維持。新依存はMIT fontkitと固定OFLフォント、SHA/取得失敗を明示   |
| N13  | PASS: checked-in unit/browser/configと上記再現command。成果物/生ログはGit外                                                   |
| N14  | PASS: README/status/public Host契約/公開snapshot説明/この報告に範囲と未実施を記録                                             |
| C01  | 合成compositionとfocusはPASS。Native OS IMEはNOT RUN                                                                          |
| C02  | PASS: 固定source/region、旧版解決/Orphan/明示remap。OCR/text注釈region追加はN/A                                               |
| C03  | 既存shared経路の関連回帰。新規Graph/ビュー公開コマンドのshared能力は非対応、localへのfallbackなし                             |
| C07  | PASS: 実PDF reader抽出、日本語検索/文字位置、CSV quotingとtarget schema。Tagged PDF/図内OCR/実Officeは今回未対応またはNOT RUN |
| C08  | PASS: ordinary PNG/publication→厳格React export、既存独立preview/build/regeneration回帰。万能HTML変換は宣言しない             |

失敗した初回試行では、Hostのprivate Undoボタン接続漏れ、Whiteboard Escape伝播漏れと既存チェックリストのPDF glyph拒否を修正。
PM pointer直後のselectionchange待ち、menu確認、閉じたHost library、版再読込後のSession
履歴に関するテスト前提を正し、最終結果に途中失敗を混ぜない。

Native OS IME、real screen reader/device、Firefox/WebKit、実Office、全無関係suite、
production auth/durability、consumer試用はNOT RUN。PDF図/Mermaidはraster、Tagged PDF/OCRは
未対応、File検索は500pages/200万文字まで。選択とSession履歴はreloadしない。
Automatic Actionsはmanual-only。#22性能合格は保留、性能調整・追加測定は停止中。
PDF/PNG/ZIP/フォント/trace/生ログはGitに追加していない。

Document print/PDF checklist markers use `[x]` / `[ ]` for checked/unchecked state, so generated markers do not require glyphs absent from the fixed CJK font. Native checklist content is unchanged.
