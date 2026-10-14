# Graph reading verification (#224–#228)

以下は当初の作者試験記録であり、失敗履歴を保持する。後続の通常設定全unit・全50件の
Graph browser試験は修正source `ee88d138b555ac8275ba04abc3f52fa54595bc2c` でPASS。

## 対象・環境

2026-10-13。Base `5a32d355ac107258a604e5a4d7a45d03f3b9efdb`、
`fix/issues-224-228-graph-viewing` の実装・test snapshot `5fb56fd50c73daa6dda9ae207ee3861c8a99328f`。
後続の低倍率zoom追補を含む最終snapshotはPRのheadを参照。
[設計](../../graph-reading-design.md) と [契約](../../structured-graph-contract.md) に従う既存Graphの表示能力追加。
Office/shared/annotation/template/reuse/React export能力は追加していない。

Linux cloud、Node 20.20.2、npm 10.8.2、system Chromium 147.0.7727.137。
Desktop 1440×900、mobile 390×844。独立public API Hostは13 nodes / 108 edges / 7種類、
負座標・長い日本語ラベル・ノード別寸法・非表示nodeのrequired診断を含む。
Playgroundのstore/CSSを使わず、bundleはメモリ、証跡は `/tmp` に保持する。
MobileはCSS `innerWidth` と設定幅390の一致も検査した。

## 実行記録

| Command / 対象                                                                                                      | 結果                                                                    |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `npm run lint` / `npm run build`（`tsc --noEmit`を含む）                                                            | PASS、最終実装で実行。通常Host・独立Graph Host・React previewをbuild    |
| `npm run check:files`                                                                                               | PASS、1091 files、failuresなし                                          |
| `npm run test:tooling`                                                                                              | PASS、25 tests                                                          |
| `npm test -- --maxWorkers=1 --testTimeout=30000`                                                                    | FAIL：130 files / 1167 tests、1164 PASS / 3 FAIL                        |
| 失敗したOffice 3 testsの単独再実行（下記）                                                                          | 2 PASS / 1 FAIL。I07自己export/importが60秒timeout                      |
| `npx playwright test --config=playwright.graph.production.config.ts --output=/tmp/graph-224-228-regression-results` | 初回39 cases：35 PASS / 4 FAIL。新規閲覧10 casesは全PASS                |
| 同config、最終実装で新規閲覧11＋失敗した既存4 casesを再実行                                                         | 15 PASS。desktop/mobile、console/page errorで失敗する共通fixture        |
| Source-only public snapshot export/check                                                                            | PASS：source `5fb56fd`、812 files export / 813 files manifest・残留検査 |

Office単独再実行:

```sh
npm test -- --maxWorkers=1 --testTimeout=30000 \
  --testNamePattern='enforces exact page and object limits|I07 imports the separate self-export corpus|accepts the exact XML/entry/expanded byte caps' \
  packages/slide-import/src/capabilities.test.ts \
  packages/slide-import/src/import.test.ts \
  packages/office-import-core/src/inspection.test.ts
```

最終browser再実行の `--grep` は
`ordinary native: create, edit|connection editor refreshes|protected new records|Definition proposal diagnostics|reading Host`。
最終outputは `/tmp/graph-224-228-buffer-browser-results`、raw logsは `/tmp/graph-224-228-*.log`。
全browser/cross-engine回帰を実施したとは扱わない。

## 条件ごとの判定

| 条件                                                | 結果・証拠                                                                                                                                                      |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N01 / N14 目的・文書                                | PASS：design、contract、embedding、README/status、public policyに範囲・互換性・制限を記載                                                                       |
| N02 / N12 入力・安全性                              | PASS：display 5 unit tests＋既存Graph unit。hex/dash境界、未知field/URL/誤scope拒否。新しい通信/コード実行なし                                                  |
| N03 / N08 view・selection                           | PASS：camera/filters/panel/寸法でcanonical content/SHA-256/revision/Undo不変。全Graphの診断と非表示対象の選択通知                                               |
| N04 / N05 / N07 / N10 編集・保存                    | PASS（関連回帰）：Graph/Dataの属性・接続・gesture・Undo・proposal・native versions/import/reload。今回保存契約は変更なし                                        |
| N06 / N09 / N11 独立Host・readonly・keyboard/mobile | PASS：Host/Profile readOnly、Inspector切替、初期/再Fit、実寸ports、長いラベル名、密なラベル非重複、deferred focus/selection、CSS幅390。desktop/mobile画像も確認 |
| N13 再現可能な検証                                  | Graph関連の最終15 casesはPASS、全unit commandはFAIL（下記Office I07）。全リポジトリunit合格を宣言しない                                                         |
| C01 / C10 native IME・他engine・実機・screen reader | NOT RUN：今回実施なし。accessible nameの機械検査はscreen reader実機の検証ではない                                                                               |
| C02 / C04–C09                                       | N/A：Graphのannotation/shared/template/reuse/Office/React export/大容量assetを追加していない。既存の入口非提供を維持                                            |
| C03 proposal/headless                               | 新しいproposal能力はN/A。既存Graph command/adapter/revision guardはunit/関連browser回帰で確認                                                                   |

## 初回失敗と修正

- 最初のnetwork/tooling/file policyはsandboxのEPERMで失敗。必要なnetwork/子processを使用できる設定で再実行し成功した。
- 初回buildは新規fixtureの属性unionとrevision出力の型エラーで失敗し、修正した。
- 最初のfull unitはbuild/lint同時実行中に既存templateの5秒timeoutが発生したため中断。最終full runは1 worker/30秒設定で実行した。
- 新規browser初回は6 PASS / 2 FAIL。fixture selectの明示aria-label不足を修正。画像でmobile viewport meta欠落（CSS幅980）も見つけ、metaとCSS幅assertionを追加した。
- 関連browser39 casesでは、線の選択名変更、readonly proposal previewの旧input検査、既存CSV拒否の旧button検査、通常nativeの45秒timeoutで4 FAIL。選択名は従来どおりに戻してtitle/descriptionで全文を提供し、readonly値の検査へ変更した。CSVは現行のreadOnly mapping診断とdisabled Importを確認するようtestを修正し、CSV実装は変更していない。4 casesは最終再実行で全PASS。Inspector/readonly切替で属性・定義bufferを保持する追加ケースもPASS。
- Full unitのOffice境界2件は30秒timeout。単独再実行でPASSした。I07自己export/importは最初GIFの `ASSET_UNAVAILABLE`、単独再実行では60秒timeoutが残った。Officeの実装・fixture・testはbaseから変更していない。

## 未解決事項・判定

`packages/slide-import/src/import.test.ts` の
`I07 imports the separate self-export corpus as editable native elements with source text order` はFAIL。
変更したGraph表示とは別の既存Office corpus検証で、この環境では単独実行でも60秒以内に完了しなかった。
この結果は未解決としてPRへ記載し、全unit成功とは扱わない。

今回のGraph閲覧能力は対象desktop/mobileで検証した。任意フォントのラベル幅は保守的推定で、
空きのないラベルはhover/focus/selectionで表示する。全ラベルの同時表示は保証しない。
Performance測定・tuningは停止中、正式performance受け入れは保留。最大1,000 nodes / 4,000 edgesの性能保証は追加しない。
Raw evidenceは一時cloud環境外から恒久参照できない。生成画像・ログ・bundle・exportはGit外に保持し、specと再実行手順を残す。

低倍率zoom追補: Fit後25%以下の視点でZoom outが拡大へ逆転しないように修正した。
build/typecheck/lintを再実行してPASS。`--grep "readonly tools, full labels"` の
desktop/mobile 2 casesは、縮小率が下がるassertionを含めてPASS。
証跡は `/tmp/graph-224-228-zoom-browser-results`、logは `/tmp/graph-224-228-zoom-*.log`。
