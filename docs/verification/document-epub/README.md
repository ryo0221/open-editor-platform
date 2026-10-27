# Document水平EPUB N2aの検証

2026-10-26、#536後続。Source baseはM1aの `0070b68a1fa761755ac4fe6f2d729105a54a601f`、その上の `feat/document-epub-subset` の変更を対象にする。[段階設計](../../document-publishing-design.md)・[Host契約](../../authoring-contract.md)が基準。日本語出版組版全体の受け入れではない。

## 対象と環境

Node 24.19.0、Linux、Vitest 4.1.12、Playwright 1.63.0、Chromium。production buildの独立Hostをdesktop 1440×900とmobile 390×844のdevice emulationで検証する。通常Documentのschema/toolbar/text engineは変更しない。3章×2シーンのnative確定版を使い、EPUB表示名はArtifact.name、本文見出しは日本語。

- API: exact version/hash/順序、出典とID対応、入力/metadataの所有、XML escape、書式/CSS、hidden除外、元draft/version不変、ZIP先頭の無圧縮mimetype、再encodeの決定性、opaque plan、同意・error・不正metadata・link/ruby/HTML・欠落/破損version・中止・headless bundleを検査。
- 独立Host: metadata error拒否、Hold composition拒否、未同意download無効、保存後stale、再prepare、章逆順のEPUB/report、原稿/旧版不変を検証。
- 独立reader: test-only epub.js 0.3.93で実際のdownloadを読み、第1章表示→TOCの第3章へ移動し、日本語本文を確認。desktop/mobile screenshotsを目視確認。製品runtimeの依存にはしない。

## 結果

| 対象 / command                                                                                                                                                                          | 結果                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `npx vitest run packages/document-export/src/epub.test.ts packages/document/src/sequence.test.ts packages/document-export/src/plan.test.ts packages/document-export/src/encode.test.ts` | 4 files / 39 tests PASS                                                                  |
| `npm run typecheck` / 差分ESLint                                                                                                                                                        | PASS                                                                                     |
| `npx vite build --config vite.artifact-host.config.ts`                                                                                                                                  | PASS、既存chunk-size warningあり                                                         |
| `EPUB_READER_ROOT=/tmp/epub-reader E2E_SUITE=authoring.production npx playwright test --grep 'N2'`                                                                                      | 最終4 PASS（Host操作2 + 独立reader2、desktop/mobile）。console/pageerrorを失敗条件とする |
| EPUBCheck 5.4.0、Java 21、unit fixtureのEPUB                                                                                                                                            | PASS: 0 fatals / 0 errors / 0 warnings / 0 infos                                         |
| `npm run test:tooling`                                                                                                                                                                  | 117 PASS                                                                                 |
| `npm run check:files` / Prettier / new doc links / policy inclusion                                                                                                                     | PASS                                                                                     |
| 全unit/全browser/通常Hostの再受け入れ/性能                                                                                                                                              | 今回の差分ではNOT RUN。既存N1/M1の検証結果を再実行したと主張しない                       |

初回typecheckはopaque brandの型変換とReact useRef初期値の2件でFAIL。修正後PASS。初回reader testはTOCが本文見出しであると仮定したassertionで2 FAIL。契約どおりArtifact.nameを使うassertionへ修正し、reader 2 PASS。上表は最終N2全4件を再実行した結果。file policy検査はsandboxの子プロセスEPERMで一度停止し、同じ読み取り検査を権限付きで再実行。失敗ログもGit外に保持する。

## 再現

```sh
npx vitest run packages/document-export/src/epub.test.ts packages/document/src/sequence.test.ts packages/document-export/src/plan.test.ts packages/document-export/src/encode.test.ts
npx vite build --config vite.artifact-host.config.ts
npm install --prefix /tmp/epub-reader --no-audit --no-fund --package-lock=false epubjs@0.3.93
EPUB_READER_ROOT=/tmp/epub-reader E2E_SUITE=authoring.production npx playwright test --grep 'N2'
```

unitは `/tmp/epub-validation/fixture.epub` を生成する。W3C/epubcheckの公式release 5.4.0をGit外に展開し、次を実行した。validatorも製品依存に含めない。

```sh
java -jar /tmp/epub-validation/epubcheck-5.4.0/epubcheck.jar /tmp/epub-validation/fixture.epub --json /tmp/epub-validation/epubcheck-report.json
```

reader testは `EPUB_READER_ROOT` が未指定なら明示skip。epub.jsの古いNode向けXML依存は隔離したtest-only install内にあり、readerはChromiumのDOMで既知fixtureだけを読む。repository manifests/lockへ追加しない。

## 契約・限界

N01/N02: 新kind/content/schemaや編集runtimeを増やさず、publicな純粋export adapterを追加。N03–N05/N10: capture後はnative正本・選択・Undo・確定版を変更せず、source version/hashとID mappingを出力に保持。派生basisはlocal-draftであり、架空のsaved versionを作らない。

N06–N09/N11/N13: public packagesのみの独立Hostでprepare/report/consent/downloadを接続。保存版/章順変更をstaleとして拒否する。入力中は既存flushとcomposition guardを使う。C01: native text engineを変更せず、Hold compositionは障害注入でありOS native IME受け入れではない。C03–C06: shared/template/reuse/外部AIは新規対応しない。C07: ZIP/package/XMLのvalidatorと独立readerを別に確認。

paragraph/heading/inline formattingの水平reflow subsetのみ。link・画像・表・HTML・reuse・未知field・ruby・縦書きは拒否。hiddenは警告付きでreading contentから除外。fontは埋め込まず、reader固有の書体・改行・page数を保証しない。metadataはXML-safeな有界値、creator最大16名。入力上限は128章/2000blocks/100万UTF-16単位、entry合計16MiB（無圧縮）。新たな性能保証・測定・tuningは行わない。

AbortSignalはprepare前/await中とencode前をunitで確認。Hostのgeneration guardは中止後のdownloadを防ぐ設計であり、この小fixtureでCancelボタンの処理途中クリックを受け入れ試験したとはしない。同期ZIPの途中に割り込む保証はない。実機reader、OS native IME、Firefox/WebKit、assistive technology、縦書き/ルビ/font混在、配信/DRMはNOT RUN/非対応。日本語組版はN2b以降。

## 証拠・公開範囲

logsは `/tmp/document-epub-*.log`、validator/reportは `/tmp/epub-validation/`、screenshotsは `/tmp/editor-platform-authoring-results/`。生成物をGitへ入れない。公開readerからローカル証拠は参照できないためcommandとfixtureで再現する。新規文書をpublic policyへ明示収録し、静的なリンク/残留チェックを行う。snapshot生成/公開同期、deployment、production認証/永続化保証は実施しない。

## PR #550のレビュー対応

Ready後、`aac7725b` に対するCodexの2件を修正した。EPUB encode直前とdownload直前に現在のHost/IME input guardを再検証する。拒否時はcaptured plan/reportと同意を保持し、入力確定後に同じ保存版で再試行できる。guard callbackは最新renderのものを参照する。inlineの `bold: false` はnativeのnormal_weightと同じ `font-weight:400` を出力し、太字blockからの明示解除を保持する。

再現unitを追加し、関連4 files / 40 testsを `--maxWorkers=1` でPASS。初回はbuild並行中に既存DOCX `D10 logical cell boundary 50000` が5秒timeout（39 PASS / 1 FAIL）。build終了後に同じ4ファイルを1 workerで再実行し、初回の失敗も保持する。typecheck、差分ESLint、Host production buildはPASS。

`EPUB_READER_ROOT=/tmp/epub-reader E2E_SUITE=authoring.production npx playwright test --grep 'N2'` はdesktop/mobile合計6 PASS。既存4件に、preview/同意後のHold composition拒否、compositionイベント中の拒否、downloadなし、report/同意保持、compositionend後の再試行で同一report入りEPUBを取得する2件を追加した。synthetic compositionイベントでありOS native IMEの実機受け入れではない。証拠は `/tmp/document-epub-review-*.log`。
