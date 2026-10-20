# #280 Geo boundary background verification

2026-10-19 JST。対象は[宣言したlocal背景・保存ビュー・出力](../../geo-background-contract.md)。
Base: `71ac82ec2d9b840bd1eaf2ed29aceadb456bd883`。
最終コードのlocal checkpoint: `b36c483b861a288deaff716f9abeb9a1e617f6b5`、
Git tree `029186883dbd6ee7dd1d3dc9c83002c69880cdb6`。
GitHub Git Dataで同じtreeを作成し、全path/content/modeの一致を確認した。
本報告の確定だけを後続の文書差分とし、実行ソースとdelivery commitのmetadataを区別する。
過去のcheckpointの結果を最終ソースの結果として再掲しない。

## 環境・対象

Linux / Node 24.19.0 / npm 11.9.0 / Vitest 3.2.4 / Vite 6.4.1 /
Chromium 151.0.7922.173 / Playwright 1.63.0。
通常Host productionは1440×900・390×844、独立Geo Host productionは1280×900・390×844。
通常Hostは`playwright.geo.production.config.ts`、独立Hostは
`packages/geo-inspector/playwright.config.ts`を使用し、実際のproduction buildを実行した。

## 最終の実行記録

| 結果    | Command / 範囲                                                                                                                                  | 実際の結果・証拠                                                                                  |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| PASS    | `npm run lint`                                                                                                                                  | 最終toolingのBuffer importも修正後に通過                                                          |
| PASS    | `npm run build`                                                                                                                                 | strict typecheck＋通常/React UI/Artifact Host/Animation Hostの4 build。既存のchunk size警告は残る |
| PASS    | `npm test`                                                                                                                                      | **2,747 PASS / optional 9 skips / 266 files**。本体2,739＋独立Office corpus 8                     |
| PASS    | `npm run test:tooling`                                                                                                                          | **92 PASS**。純粋Nodeのpublic catalog bundle/実行検査を含む                                       |
| PASS    | `npm run check:files`                                                                                                                           | **2,361 files**、失敗なし。JSON data assetは全て1MB未満                                           |
| PASS    | `python3 scripts/geo-backgrounds/generate.py --check`                                                                                           | 3つのpinned原本SHA、同梱data・manifestの完全一致                                                  |
| PASS    | `npm run public:export -- --ref HEAD --out /tmp/editor-geo-background-public-snapshot`＋`public:check`                                          | local code checkpointで1,907管理file＋manifest。最終報告の文書差分も別途同じ検査を行う            |
| PASS    | `npx vite build --config packages/geo-inspector/vite.config.ts`                                                                                 | 独立production Hostをbuild                                                                        |
| PASS    | `npx playwright test --config playwright.geo.production.config.ts`                                                                              | **8 PASS**：新規背景3scenario＋既存Data→Geo→Slide fixed/followの1scenario、desktop/narrow各4      |
| PASS    | `npx playwright test --config packages/geo-inspector/playwright.config.ts packages/geo-inspector/tests/workspace.spec.ts --grep '#280\|UC1/AC'` | **4 PASS**：新規offline境界＋既存198地物編集/保存/PNG/Slide、desktop/narrow各2                    |
| PASS    | `git diff --check`、変更したsource/docのPrettier                                                                                                | 不要な証拠・build成果物をGitへ追加しない                                                          |
| NOT RUN | 全E2E / Firefox / WebKit / 実機 / OS IME / assistive technology                                                                                 | 今回の対象は上記Chromium viewport。全環境対応とはしない                                           |
| NOT RUN | 新規性能受入、CI、公開同期、deployment                                                                                                          | 既存停止を維持。local snapshot検査は公開操作ではない                                              |

生ログ・画像・PNG・native出力は`/tmp/editor-geo-boundar*`と
`/tmp/geo-inspector-evidence/results`に保存し、Gitへ追加しない。
`authorized-unit/tooling/files`、`final-build/lint/browser/independent-browser`のログが最終実行。
desktop/narrowのMapと出力画像を目視確認し、背景・地物・出典・線色操作が見えることを確認した。
生成dataは製品がオフラインで使用する配布assetであり、検証の生成証拠ではない。

## 必須・宣言条件

| 条件                                    | 判定             | 対応する証拠・限界                                                                                                                                    |
| --------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| N01/N02 domain・validation              | PASS             | 既存Geoを維持。14背景単体で全3datasetのhash/geometry、無効setting、corrupt/missing pin、dateline、world output上限を検証                              |
| N03/N04/N05 draft/version・原子性・Undo | PASS             | 表示/線色はcontent/hash/revision/Undo/Redo/入力状態を変更しない。明示view保存は既存native command。過去version/hashを維持                             |
| N06/N07 independent/ordinary Host       | PASS             | 上記4＋8 production Chromium cases。Playground store/CSSのない独立Hostを含む                                                                          |
| N08 selection                           | PASS             | 背景は利用者feature ID/role/buttonを持たず、pointer-eventsなし。利用者地物の個数を保持                                                                |
| N09 readonly/authority                  | PASS（限定）     | 背景geometryへの変更入口を設けず、private表示だけを変更。view保存・PNG capture/transferは既存Host境界を継続。新しい共有権限機能は宣言しない           |
| N10 native保存/import                   | PASS             | schema-1旧view読込、optional設定だけの保存、reload、通常Slide referenceのsnapshot pinとPNG bytesを確認。geometry本体はnative予算外                    |
| N11 keyboard/mobile/focus               | PASS（viewport） | 390pxとdesktop、checkbox/color/保存操作。色swatchの高さを確保し、画像を確認。実機・ATはNOT RUN                                                        |
| N12 untrusted input/asset               | PASS             | descriptor検証、独立budget、SHA照合、freeze、無通信。unknown exact pinは省略と診断。任意第三者JS sandboxではない                                      |
| N13/N14 regression/docs                 | PASS（対象限定） | 全units/tooling/build、上記browser回帰、source pins/利用条件・手順・public snapshot検査                                                               |
| C03 headless                            | PASS（限定）     | `@editor-platform/geo-core/backgrounds`がReact/DOMなしのNode bundleで全datasetを解決。新しいproposal/runtimeは追加しない                              |
| C06/C07 reference/output                | PASS（限定）     | 保存済みviewの固定Geo参照、固定PNG/Slide bytes一致、receiptの要求pin・適用pin・出典、CSV/GeoJSONへの非混入。既存follow経路も回帰                      |
| C09 offline/recovery                    | PASS（限定）     | app起動後にbrowser offlineへ切替えて操作/PNG。exact datasetの欠落時も地物を表示し、UI・画像・receiptで省略理由を保持。アプリ初回配信のPWA保証ではない |
| C01/C02/C04/C05/C08/C10                 | N/A / NOT RUN    | 背景のText/annotation/shared/template/React bridgeは非対応。道路/検索/tile、外部GIS reader、物理端末等は範囲外                                        |

## 失敗履歴と修正

- 初期世界全体SVGが既存2MiB projection上限を超えた。背景だけを出力pixelへ丸め、
  同一pixelの連続頂点を重複出力せず修正。データ本体とnative座標を変更せず、
  全世界＋3datasetの同時表示でも既存上限を維持する単体試験が通過。
- 日付変更線を跨ぐringのvisible copyを落とさないよう、描画と同じringごとのlongitude
  unwrapで範囲を求めた。両側のcopyを保持するsynthetic単体が通過。
- 最初の通常browser起動はNode JSON import attribute不足で停止した。
  JSON importに`with { type: 'json' }`を追加して通常/独立Hostを再実行し通過。
- Node bundle toolingの`Buffer` globalにlintが反応したため、`node:buffer`から明示importした。
- 最終再検証を通常sandboxで試みた際、child process/listenのEPERMにより
  unit 17 FAIL・3 errors、tooling 5 FAIL、file checkが停止した。
  追加権限の自動審査に容量不足/時間切れが発生したが、ユーザーの明示承認後に再試行し、
  必要なローカル通信・子プロセス権限で上記全units/tooling/files/browserを実行してPASSを確認した。
  制限下の失敗を機能修正で解消したという主張ではない。

## データと残る制限

国境177、州県境4,596、日本municipality/ward 1,742。
全元URL、SHA-256、簡略化、derived pinは[manifest](../../../packages/geo-core/data/manifest.json)に保持する。
日本の当該datasetは2017年・**CC BY-SA 2.0**であり、一般的なgeoBoundaries CC BY 4.0という
候補説明を流用しない。[データ利用条件](../../third-party/geo-boundaries.md)を表示/出力と併せて保持する。
旧pinを将来の同梱更新で別geometryへ置換しない。最新の行政区域・法的境界・測量精度や
同梱範囲外の網羅性、topologyの正しさは保証しない。保存ビューを明示保存する操作は
通常のnative編集なのでhash/Undoへ入るが、単なる表示切替は入らない。

## PR #297 レビュー修正

初回の N12 記録はdata JSONのproperty descriptor検証を含む一方、カタログmetadata自体の
検証が欠けていた。初回PASSをmetadataの欠落・不正URLまで検証済みという意味で用いない。
レビューで見つかった以下の5件を後続の修正として扱い、前節の初回実行とは区別する。

- Geoを含む両拡張キットで`@noble/hashes`を既存lockに固定してoffline pack/installする。
  元のMIT LICENSE、lock integrity、全file/tarball hashを保持し、任意の依存を許可しない。
  実ビルドで既存Animation→`reuse-core`の同梱漏れも判明したため、宣言済みの同依存を
  閉じた集合へ追加した。baselineも同じ依存閉包に合わせる。初回の停止ログは
  `/tmp/editor-geo-review-kit-readonly-1.log`に保持する。
- tracked Geo JSONのstaging、exact asset path監査、JSON moduleの型生成・bundleを追加する。
  data manifestとCC BY-SA 2.0等のデータ利用条件をキットへ保持する。
- 国の塗りを全背景線より先に描く。逆順の保存設定もnative配列を変更せず表示する。
- カタログmetadataとdataを検証したJSONから所有する。欠落attribution、不正URL、
  accessor等を省略診断にし、受入後の呼出側mutationを反映させない。
- nativeの出典上限16折返し行は維持しつつ、背景creditsは別枠にする。
  小さい出力ではfooterを収め、地図と全出典を残す。実際の通常Host/PNG/Slideには
  16行の既存出典と逆順設定を持つfixtureを使用する。

修正コードのcheckpointは`82d81f27d3363e7dd7f46b880275746a3e32ab45`。
全単体・tooling・build・3種類のキットはこのsourceを検証した。
その後`fc17790ff196eb933d8cc59dc182c2b15c7d5bf8`でbrowser fixtureだけを修正し、
型/lintと通常・独立production browserを実行した。実行sourceとdataは同一であり、
後続deliveryでは本検証記録と公開用のダミーURL表記だけを調整し、実装は変更しない。

| 修正後の検査                           | 結果・範囲                                                                                                                                                          | ログ / 証拠                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 全単体                                 | **2,770 PASS / optional 9 skips / 266 files**（本体2,762＋Office corpus 8）                                                                                         | `/tmp/editor-geo-review-all-unit.log`                       |
| tooling / packaging unit / file policy | **92 PASS / 7 PASS / 2,361 files**                                                                                                                                  | `/tmp/editor-geo-review-{tooling,packaging-unit,files}.log` |
| strict typecheck / lint                | **PASS**、browser fixture修正後にも実行                                                                                                                             | `/tmp/editor-geo-review-final-{typecheck,lint}.log`         |
| 4構成production build / 独立Geo build  | **PASS**、既存chunk警告あり                                                                                                                                         | `/tmp/editor-geo-review-{build,independent-build}.log`      |
| 通常production Chromium                | **8 PASS**、desktop/390px。16行の既存出典、offline切替、PNG/receipt/Slide bytes一致、逆順背景の固定参照、既存fixed/follow回帰                                       | `/tmp/editor-geo-review-final-browser.log`                  |
| 独立production Chromium                | **4 PASS**、desktop/390pxの背景と既存198地物編集・PNG/Slide                                                                                                         | `/tmp/editor-geo-review-final-independent-browser.log`      |
| `readonly-domains`                     | **12 platform＋1 third-party**をbuild/packし、独立Node Hostへoffline install・全file inventory照合・全公開entrypoint import・3背景のexact解決とdata terms保持を検証 | `/tmp/editor-geo-review-kit-readonly-{2,verify}.log`        |
| `controlled-animation`                 | **14 platform＋7 third-party**で同じoffline検査がPASS                                                                                                               | `/tmp/editor-geo-review-kit-controlled{,-verify}.log`       |
| `baseline`                             | **8 platform＋1 third-party**でoffline install・inventory・公開API・既存negative probesがPASS                                                                       | `/tmp/editor-geo-review-kit-baseline{,-verify}.log`         |

キットprovenance SHA-256（sourceは上記`82d81f27`）：

- readonly: `dce0621cfcc15960d648ed897b7c523fd306e50749c42a6aef2898c135df216d`
- controlled: `7c33ccfc8416a5f9a5b9ca396bde1ed9905d18c482f2116f7928b313ac66760d`
- baseline: `f9c512de2b33e2cfaf1b17e77a8e3c38514bd02cf28c1950fb3e687c0a8b0034`

初回のbrowser再現fixtureはnativeに出典だけを加えて原本closureを欠いていたため、
既存の`GeoSourceMissing`整合性検査でimportが拒否された（4 FAIL / 4 PASS）。
`/tmp/editor-geo-review-browser.log`と`/tmp/editor-geo-review-browser-results/`に保持する。
fixtureへ正しい原本bytes/hash・source version/pin・resource closureを加え、Host側の
検証を緩めずに上記8＋4件を再実行してPASSを確認した。
`/tmp/editor-geo-review-final-browser-results/`の生成`fixed-map.png`、desktop/narrow Mapと
逆順のSlide参照を目視確認した。境界線・利用者の地点・native出典・背景出典を保持する。
キットは独立Nodeでの梱包/入出力検証であり、新しいinstalled browser/Animation編集・
実機・AT・全E2E・性能・CI・公開同期・deploymentの受入を主張しない。

## マージ前のPNG bytes追加修正

スレッド外のレビュー本文にあったデータURLの指摘は、上記5件のinline対応時に見落としていた。
`9fd2218bdfd844fa246425955f8d11cce92d2984`で、Slide向けデータURLを`toBlob()`の
確定bytesからbase64化するよう修正した。canvasを`toDataURL()`で再エンコードせず、
download・receipt hash・Slideの画像を同じbytesから作る。

- 専用unitでは別のencoder結果を返すcanvasで修正前の不一致を**2 FAIL**として再現。
  `/tmp/editor-geo-merge-png-before.log`に保持する。修正後は68/70,001 bytesの入力で
  roundtrip・receipt hash・2回目のencoder不使用を確認し、背景37件と合わせて**39 PASS**。
  `/tmp/editor-geo-merge-png-unit.log`。
- strict typecheck＋通常/React UI/Artifact Host/Animation Hostの4 build、独立Geo build、
  lintは**PASS**。ログは`/tmp/editor-geo-merge-{build,independent-build,lint}.log`。
- 通常Hostのoffline PNG→receipt→Slideと、独立Hostの198地物編集・保存・PNG→Slideを
  desktop/390pxで再実行し**4 PASS**。`/tmp/editor-geo-merge-{browser,independent-browser}.log`。
  新しい実PNGも目視確認し、通常HostではSlide内のbytesとの完全一致を検証した。
- file policyは**2,362 files、失敗なし**（`/tmp/editor-geo-merge-files.log`）。
  全単体2,770件・tooling92件・3種キット・通常/独立12件の前段記録を、今回の
  PNG追加修正後に全件再実行したという意味では用いない。上記が追加修正の検証範囲。

## 最新mainのセキュリティ修正との統合

作業中にmainへ入ったPR #298（`458533c3a819d830ee5745b9e620128c6a1e236f`）を取り込み、
`docs/status.md`の追加節だけの競合を両方の記録を保持して解消した。
README/lockは自動統合し、最新の依存pin・notice・セキュリティゲートを保持する。
統合コードcheckpointは`eeb6387adcf1a5d48a39de0fccbaba72f49dec02`、
treeは`c8a4a9ba71b254dc33d4c733188bb1e0b78ce155`。
Node 24.19.0、Vitest 4.1.11、Vite 6.4.4の新しい依存環境で再検証した。

- `npm ci --ignore-scripts`は専用の`/tmp` cacheでPASS。初回は既定cacheへのmkdirで
  ENOENTとなったため、失敗を`/tmp/editor-geo-main-npm-ci.log`に残し、
  `/tmp/editor-geo-main-npm-ci-retry.log`で再実行を記録した。
- **全単体2,772 PASS / optional9 skips / 267 files**（本体2,764＋Office corpus8）。
  `/tmp/editor-geo-main-unit.log`。
- **tooling107 PASS、packaging unit7 PASS、file policy2,365 files失敗なし**。
  `/tmp/editor-geo-main-{tooling,packaging-unit,files}.log`。
- strict typecheck、lint、4構成production build＋独立Geo buildは**PASS**。
  `/tmp/editor-geo-main-{build,independent-build,lint}.log`。
- 通常production8件＋独立production4件のdesktop/390pxは**12 PASS**。
  `/tmp/editor-geo-main-{browser,independent-browser}.log`。実PNGも目視確認した。
- 統合code checkpointからのlocal public exportは**PASS**。毎回の必須ゲートでnpm
  （dev/optional/peer含む）と3件のOSV照会が通過した。
  `/tmp/editor-geo-main-code-public-export.log`。snapshot SHA-256:
  `33d36a10c5566e8e6788e90ab253b470638137a889c694e719749c0a62434083`。

後続deliveryは本検証記録の追記だけとし、最終文書も新しいsecurity gate付きの
local export/checkで確認する。公開repositoryへの同期・CI dispatch・deploymentや、
新たな性能受入は実行しない。
