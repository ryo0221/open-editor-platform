# DesignページM1aの検証

2026-10-26、#537後続。Sourceは `2bc8e600` のM0/review修正を含む `feat/authoring-m1-vector` の変更。[設計](../../design-page-artwork.md)・[Host契約](../../authoring-contract.md)が基準。M1全体ではなく、既存schema3 pathを再利用するlocal線画・吹き出し・vector capture subset。

## 固定対象と環境

Node 24.19.0、Linux、Vitest 4.1.12、Playwright 1.63.0、Chromium。独立Hostは1440×900と390×844のdevice emulation、通常Playgroundも同じdesktop/mobile。実機、OS native IME、Firefox/WebKit、assistive technologyはNOT RUN。固定Office fontは既存SHA-256 checkを維持。

- 独立Host: 既存4ページ×2コマへcubic線画、尻尾付き吹き出し、各ページのlineを追加。点座標変更、Undo/Redo、保存→reload、旧schema2版保持、M0 capture拒否→明示vector capture→4ページPNG/manifestを確認。
- 通常Host: Pagesからpage/panelを新規作成→cubic追加→既存点編集でanchor移動→balloon追加→1 Undoでgroup/path/textを全除去→Redo→保存→reload。stable path/anchor/element IDを確認。
- Headless: public APIのnative transaction、入力所有、missing/wrong/locked panel、readOnly、不正preset/bounds/文字数、元確定版不変、source attributionとcrop診断、headless bundleを検証。

## 実行結果

| Command / 対象                                                                                                                                                                         | 結果                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `npx vitest run packages/design/src/page-artwork.test.ts packages/design/src/pagination.test.ts packages/design/src/pagination-review.test.ts packages/design/src/path-native.test.ts` | 4 files / 40 tests PASS                                                                 |
| `npm run typecheck`                                                                                                                                                                    | PASS（M1 public API/Surface/Host実装を検査）                                            |
| 差分 `npx eslint`                                                                                                                                                                      | PASS                                                                                    |
| `npx vite build` / `npx vite build --config vite.artifact-host.config.ts`                                                                                                              | PASS、既存chunk-size warningあり                                                        |
| `E2E_SUITE=authoring.production npx playwright test --grep 'M1'`                                                                                                                       | 4 PASS（独立Host/通常Host × desktop/mobile）。console/pageerrorを失敗条件とする         |
| `npm run test:tooling`                                                                                                                                                                 | 117 PASS                                                                                |
| `npm run check:files` / Prettier / new doc linksとpolicy inclusion                                                                                                                     | PASS                                                                                    |
| 全unit/全browser/性能                                                                                                                                                                  | 今回のM1差分ではNOT RUN。M0の全体unit結果は元の検証記録を参照し、再実行したと主張しない |

初回の新規unitは点編集APIをcommandとして呼んだtestの誤りで1 FAIL。既存のpure `moveDesignPathPoint` と `replaceDesignPath` commandの正しい組合せに修正し、40 PASS。宣言した機能のFAILを隠して受け入れていない。

## 条件・限界

N01/N02: 既存Designのschema3/pathとpaginationを利用し新kind/modelを追加しない。M0 captureは既存拒否を維持し、vector opt-inでのみnative path/legacy vectorを出力。manifestにcapability/artworkを追加し、外部vectorのprovenanceを保持する。新規手描きpathに架空licenseを付けない。

N03–N05/N10: native Session/ArtifactEditorの唯一のUndo/versionを使う。balloonはgroup/path/textの一編集。保存/reloadと旧版bytes/hash、cloneの独立ID、拒否後不変を確認。

N06–N09/N11/N13: package CSSとpublic APIsの独立Host、および通常Playgroundで宣言subsetを検証。readOnlyはHost mutation境界、point/input guardsは既存Surfaceを使う。screenshotsを目視確認。上記viewport以上の実機保証をしない。

C01: 既存native text engineを利用。新しいIME・text runtimeは追加しない。OS native IMEはNOT RUN。C03–C06: structured path proposal、shared、template/reuse/React bridgeは今回非対応で既存拒否を維持。Story参照、CAD投影、縦書き/ルビはM1の後続。

C07: PNGに実際のline/cubic/balloonを描画し、ZIPのsource manifestと4ページを検査。PDFは既存raster adapterを利用し、M1では新しいPDF fidelityやtext-search対応を宣言しない。M0のPDF4ページ検査とは分ける。

上限は既存path/pagination上限と4096px/辺・合計6400万pixel。balloon textは2万UTF-16単位。上限はperformance保証ではなく、追加の性能測定/tuningは行わない。Raster/筆圧/トーン/PSD、日本語出版組版/EPUBはこのM1a実装に含めない。N2の設計は[別文書](../../document-publishing-design.md)。

## 証拠・公開範囲

Logsは `/tmp/authoring-m1-*.log`、screenshotsは `/tmp/editor-platform-authoring-results/`。生成物をGitへ入れない。公開readerからローカル証拠は参照できないため、上記commandとfixtureで再現する。新規文書をpublic policyへ明示収録し、リンクを確認した。snapshot生成/公開同期、deployment、production認証/永続化保証は実施していない。
