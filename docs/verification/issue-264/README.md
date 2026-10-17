# #264 参照付き埋め込みの検証

PR #265マージ後の未対応3件の修正と検証は[追補](post-merge.md)を参照。

2026-10-16（JST）。基点main `5b79d01317cbdc893db43ad29ec066b25b74a3ff` と本変更。
初回提出の実装commitは`8dd50d99`、検証assertionと文書のcommitは`5620d6a`。
PR #265のレビュー後のコード修正・再検証は末尾の追補に記録する。
着手時にGitHubの最新main、#264本文、open PR一覧を照合した。重複するData/Graph→Slideの
参照埋め込み実装は見つからなかった。#74/#75のexact版をlatestへ読み替えない独立契約とした。

利用者の追加指定により、destinationをDocument・Slide・Design・Whiteboardへ広げた。
作成時に固定版／更新連動を選ぶ。sourceは保存済みData表／chart、Profile付きGraph。
[設計](../../artifact-reference-design.md)と[public API契約](../../artifact-references.md)を参照。

## 実施環境と結果

Linux、Node 24.19.0、npm 11.9.0、Chromium 151.0.7922.173。
desktop 1440×1000、狭いviewport 390×844（Chromiumのmobile/touch emulation）。
既存mobile回帰は390px／768px。実機iOS／Android、Firefox／WebKitはNOT RUN。

| Command／対象                                                                                                                  | 結果 | 実施範囲                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run check:files`                                                                                                          | PASS | 1 MB file policy、生成物はGit外                                                                                                                              |
| `npm run test:tooling`                                                                                                         | PASS | 52 tests                                                                                                                                                     |
| `npm run lint -- --quiet`                                                                                                      | PASS | 全source／test                                                                                                                                               |
| `npm run typecheck`                                                                                                            | PASS | workspace全体                                                                                                                                                |
| `npm test`                                                                                                                     | PASS | 227 files、2366 passed、9 skipped                                                                                                                            |
| `npx vitest run packages/reference-adapters/src/references.test.ts`                                                            | PASS | 9 tests。最終追加assertionで通知更新とOffice拒否も確認                                                                                                       |
| `npm run build`                                                                                                                | PASS | 通常／React preview build、独立reference Host entryを含む                                                                                                    |
| `npx playwright test --config playwright.references.config.ts`                                                                 | PASS | dev、6 scenarios×desktop/mobile＝12 cases                                                                                                                    |
| `EDITOR_REFERENCE_PRODUCTION=1 npx playwright test --config playwright.references.config.ts --output=/tmp/issue264-production` | PASS | 同12 cases、配布buildをpreview serverで確認                                                                                                                  |
| 上記production commandに`-g 'Playground:'`を追加                                                                               | PASS | 後から通常Host scenarioを4 Surface×3 source表示へ拡張。desktop/mobileの2 casesを再実施                                                                       |
| `npm run test:e2e -- tests/e2e/issue2-embedding.spec.ts tests/e2e/issue2-mobile.spec.ts`                                       | PASS | 既存public Host／read-only／panel／mobileの3 cases                                                                                                           |
| 公開snapshotのexport／manifest／residual検査                                                                                   | PASS | `public:export -- --ref HEAD --out /tmp/issue264-public`と`public:check -- /tmp/issue264-public`。1630 source files＋manifest、新API／Host entry／文書を収録 |

9 skippedは既存のoptional Spatial WASM asset未生成に由来する。新規参照testにskipはない。
新しいOffice拒否／通知assertionは最終の対象unit実行で確認し、全unit件数に二重加算していない。
buildの既存chunk-size warningは継続。追加の性能測定・tuning、全production E2E、実Officeは未実施。

## 機能別の確認

| 項目               | 結果と証拠                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 通常UIでの挿入     | 4 SurfaceそれぞれにData表／chartとGraphを挿入。通常Playgroundと独立public-only Hostで確認                                        |
| 固定／連動         | 同じsourceの表を2件配置。source保存値95→80で連動側のみ80、固定側95、reload後も保持                                               |
| native viewの意味  | named viewのfilter、formula、chart sum aggregateをunitで確認。native`viewRows`／`displayCell`／`chartSvg`を使用                  |
| Graph              | UIでnode名とedgeラベルを編集・保存し反映。unitでlayout変更、native node/edgeとexact Profile保持、Profile欠落拒否                 |
| source編集と復帰   | 「元を編集」→source編集→保存→同じdestination element選択へ復帰。安定focus requestを使用                                          |
| proposal           | 独立Hostの決定的preview/rejectで保存元は変わらない。unitでは採用相当のcommand後もsource commitまでは95、commit後80               |
| 履歴の分離         | source refresh後にdestination native JSONが不変。配置とIDを保持し、挿入のUndo/Redoが独立して動く                                 |
| 遅延／通知         | 古いresponseが新しいrevisionを巻き戻さない。購読通知で再取得、unsubscribe。同source複数viewのcaptureは1 read                     |
| 失敗状態           | offlineは保持表示＋警告。forbiddenは保持描画も非表示。missing source、missing view/column/row/node、staleを別statusで扱う        |
| native閉包         | 4 native modelのJSON round trip、Document text-engine往復、source／依存hash、改竄、自己参照、循環JSON、2 MiB／64件上限をunit検証 |
| 保存版             | commit済みの過去version bytesとSHA-256はsource更新後も不変。保存／出力用captureはdestinationのUndoに入れない                     |
| 出力               | production UIでSVG＋`references.json`のZIPを読んでGraph v2のpinを確認。PPTX/DOCXは明示error diagnosticで拒否                     |
| 既存画像・snapshot | additive metadataのみ。既存chart/imageを暗黙にfollowへ移行しない。全unitと既存埋め込み/mobile回帰を実施                          |

production screenshotのDocumentでは95／80が同時に表示されること、狭いDesignとWhiteboardで
連動表80が描画されることを目視確認した。canvasでは2件を同じ初期位置に挿入しているため
前面の連動版が固定版を覆うが、nativeには両方残り、各々を移動できる。

## 受け入れ条件との対応

| 条件                       | 判定             | 範囲／限界                                                                                              |
| -------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------- |
| N01 独立domain／目的       | PASS             | 既存4 domainのimageにmetadataを追加。coreはdomain contentを共有しない                                   |
| N02 Model／validation      | PASS             | structural budgetとasync SHA-256／domain adapter検証                                                    |
| N03 Draft／version／view   | PASS             | runtime stateとnative保存版を分離、旧版不変                                                             |
| N04 Atomic command         | PASS             | 既存domain command／Document transaction、capture失敗で部分的結果を返さない                             |
| N05 Undo／Redo             | PASS             | 挿入と外部source更新が独立。2 Artifactのatomic Undoは宣言しない                                         |
| N06 独立Host               | PASS             | public APIのみ、Playground store／CSSなし、production buildで実証                                       |
| N07 通常Host               | PASS             | 4 Surfaceへの3 source表示をdesktop/mobileで実証                                                         |
| N08 Selection／event       | PASS             | source移動、element IDでの復帰、Graph edge keyboard選択                                                 |
| N09 Read-only／権限        | PASS（範囲限定） | source失効をunit/UI、既存destination read-only回帰。全非同期タイミングの権限試験はNOT RUN               |
| N10 Native保存／import     | PASS（範囲限定） | JSON／text-engine往復、閉包hash、reload。新機能の破損ファイルを通常import dialogから読むUI試験はNOT RUN |
| N11 Keyboard／mobile       | PASS（範囲限定） | overflow menu／Inspector到達、Graph edge Enter、390px。実機IME／全keyboard巡回はNOT RUN                 |
| N12 Untrusted input        | PASS（範囲限定） | 自己参照、循環、hash／Profile、上限。全境界値の組合せ試験はNOT RUN                                      |
| N13 回帰                   | PASS（範囲限定） | 上記unit／build／対象browser。全E2Eの結果とは呼ばない                                                   |
| N14 文書／公開収録         | PASS             | contract／README／statusと新API／Host entryを公開snapshotへ収録し、manifest／residual検査               |
| C01 Text／IME              | N/A／NOT RUN     | 新text engineなし。Documentの既存atom transactionを利用。新規IME手動試験なし                            |
| C02 Annotation             | N/A              | 新anchor typeを追加しない。element IDは既存契約                                                         |
| C03 Proposal／headless     | PASS（範囲限定） | public resolver＋通常command、決定的source proposal。AI providerはHost-owned                            |
| C04 Shared                 | N/A（非対応）    | trusted native codecが参照入りcontent／wire payloadを拒否。参照共有のS01–S06受け入れは宣言しない        |
| C05 Template               | N/A（非対応）    | Playground authoring入口を拒否。Design component化も拒否。既存copy templateは維持                       |
| C06 Linked reuse           | N/A（非対応）    | 既存exact library／token契約をlatest追従へ変更しない                                                    |
| C07 Format                 | PASS／NOT RUN    | native／SVG manifest／Office拒否を確認。新規参照のPNG/PDF/HTML実ファイル検査はNOT RUN                   |
| C08 React                  | N/A（非対応）    | 参照入りDesign→React変換を明示拒否                                                                      |
| C09 Resources／offline     | PASS（範囲限定） | bounded closure、offline cache、hash validation。実network fault／全quota境界はNOT RUN                  |
| C10 全browser／performance | NOT RUN          | Chromium emulationのみ。既存性能受け入れ保留・測定停止を維持                                            |

## 途中で修正した事項と証拠の所在

- 初回sandbox実行はnpm／local socket／child processでEPERM。許可されたnetwork付き検証環境で再実行した。
- 独立Hostの初期試験で、copyを返す`session.content`の参照比較、active kindのreload、
  DocumentのselectedId伝達を修正。Graph追加入力試験では毎renderのfocus request再生成により
  前のData選択へ戻る不具合を修正した。最終UI結果はこれらを修正した実装で再実施している。
- mobileの最初のfixtureはtoolbar overflowを開いていなかった。通常の「More editor tools」経由へ修正。
- dev回帰serverの起動ログにVite依存optimizerの`undefined.join`が一度出た。3回帰caseと
  browser-error fixtureはPASS。独立したproduction previewで参照12 caseもPASSした。

ログは`/tmp/issue264-*.log`、production画像は`/tmp/issue264-production/`に保存した。
これらはtask環境の一時ファイルで、public repositoryから取得できる証拠ではない。
上のcommandとchecked-in fixtureで再現できる。生成画像・export・build・fontsはGitへ追加しない。

本体のlocal対応を実装した結果であり、Claude拡張のMCP schema更新、公開upstream同期、
mainへのmerge、共有参照編集の完成を意味しない。未実施項目をPASSとしてIssueを閉じない。

## PR #265 レビュー指摘8件の修正・再検証（2026-10-16）

確認headは`5620d6a24e47b463135ad78e5212803e00e985ac`。通常コメント、inline threads、
review submissionの現在の本文と過去返信を確認した。未返信・未対応だった8件をコードで確認し修正。
固定／更新連動の作成時選択、保存成功したimmutable versionだけの伝搬、destination Undoの分離、
公開Host APIのsignatureは維持した。mainへのmerge、upstream同期、CI再開、性能測定は行っていない。

| 指摘（review comment ID） | 修正と回帰検証 |
| --- | --- |
| 4290441504 出力範囲 | Design selection/frames、Whiteboard selection/section、Slide current/selectedの描画対象だけをcapture/manifestへ渡す。非表示・範囲外sourceを取得不可にしてもSVG ZIPが成功し、manifest/read履歴にはincluded sourceだけが残る6シナリオ。native content不変も確認 |
| 4290441510 Design prototype | Canvasと同じ解決済みprojectionをprototypeへ渡す。開いたままsource保存95→80を反映し、native contentは不変 |
| 4290441514 Document resolver差替え | node viewのrender callbackを再実行して新resolverへ購読を切替。旧購読0、新購読1、権限失効後はimage srcを除去。ProseMirror DOMを再構築せず、native content不変 |
| 4290441520 optional undefined | objectのundefined fieldをcanonicalJsonと同じ省略規則で受け入れる。native view prune→commit→structuredClone→create/refresh/captureを検証。array undefinedとaccessorは拒否 |
| 4290441527 immutable revision矛盾 | 検証済みsource/domain/revisionごとにversion ID、content hash、依存id/hashを照合。保持閉包をread cacheで省略せず個別検証。fixed live captureとhistorical/import captureの双方で3種の矛盾を拒否。新しいlive版を読んだ後の古いfixed版は保持bytesのまま許可 |
| 4290441535 非active Slide | deck全pageの参照を購読。初期非active page、往復後のthumbnail、presentationの更新95→80を確認 |
| 4290441540 Document入力競合 | async capture後にdirty/composingを確認。HTML出力中の未確定captionと、印刷previewのfocus trap後に届くqueued IMEイベントを拒否し、入力bufferを保持。後者はbrowserの合成composition/inputイベントであり実機IME検証ではない |
| 4290441546 fit | 3 domainのnative drawingがreference.fitを読む。元のimageFitがfitでもcoverのSVGを生成。通常Inspectorの参照変更・解除時にもnative imageFitを同期し、3 Surfaceの解除後fillを検証 |

### 実施結果

Linux、Node 24.19.0、npm 11.9.0、Chromium 153.0.8010.0。
desktop 1440×1000、mobile/touch emulation 390×844。既存mobile回帰は390/768px。

| 検査 | 結果 |
| --- | --- |
| lint（`npm run lint -- --quiet`）／typecheck／変更TS/TSXのPrettier／diff whitespace | PASS |
| `npm run check:files`／`npm run test:tooling` | PASS／52 passed |
| `npm test` | 227 files、2375 passed、9 skipped（既存optional Spatial WASM） |
| 参照固有unit | 18 passed（既存9＋追加9、全unit内に含む） |
| `npm run build` | PASS、通常Host・独立reference Host・React preview。既存chunk-size warning継続 |
| reference Playwright dev | 40 passed＝既存6＋追加14シナリオ×desktop/mobile |
| reference Playwright production設定 | 40 passed。既存12ケースは配布build、追加28ケースはpublic APIをproduction modeでbundleした独立テストHost |
| 追加fixtureのviewport修正後 | dev/production設定のmobile各14ケースを再実行PASS（上記件数へ重複加算しない） |
| 既存`issue2-embedding.spec.ts`／`issue2-mobile.spec.ts` | 3 passed |
| ローカル公開snapshot export／manifest／residual検査 | PASS、1632 source files＋manifest（公開先への同期は未実施） |

`playwright.references.config.ts`に追加specを収録した。実行環境では通常のbrowser downloadが
失敗したため既存のChromiumを使用し、ViteのnetworkInterfaces制約に対して127.0.0.1へbindする
一時wrapperから同じtracked configを実行した。日本語fontをfontconfigで指定したproduction画像で、
desktop/mobileのprototypeとpresentationに80が表示されることを目視確認した。

初回全unitは既存テストが固定指定する`/usr/bin/chromium`未配置により6 fileが失敗した。
既存binaryをそのpathから利用可能にした後、最終全unitは上記件数でPASS。
テストHostでDocument imageを選択する準備、print dialogへfocusが移った後のqueued IMEイベント、
mobile viewport metaを修正して再実行した。既存回帰の一時設定で対象外mobile specが選ばれた試行は
中止し、上記2 specを明示した3ケースで確認し直した。これらの途中結果は製品の合格結果へ含めない。

全E2E、Firefox/WebKit、実機iOS/Android、実Office、PNG/PDF/HTMLの新規参照実ファイル内容検査、
性能測定はNOT RUN。共有参照編集・Office/React live-reference exportの非対応は変わらない。
生ログ・生成画像・出力・font・buildはGit外の作業領域に置き、公開repoの証拠とは扱わない。

## PR #265 追加レビュー6件（2026-10-16）

確認headは`ba078b6ea922712f58690d83e4010782f3bb7c0f`。前回8件は実装・返信済みであることを
照合し、03:49 UTCの追加レビュー6件だけを修正した。固定／連動、保存済み版だけの伝搬、
exact hash／依存閉包、destination Undoと公開Host契約は維持する。

| 指摘（review comment ID） | 修正・回帰の対象 |
| --- | --- |
| 4290738819 Design component内参照 | native validatorがcomponent template／elementsと再帰instance overrides内の参照を拒否。通常top-level参照は許可。JSON parseを通したimport形状で検証 |
| 4290738826 page間object ID重複 | 古いdeckのIDを変更せず、描画projectionをpage ID＋object IDで対応付け、captureをpageごとの順序で戻す。同IDの異なるsourceとgeometryをCanvas／全page SVG ZIPで検証 |
| 4290738833 resolver差替えと発見 | scopeに属するoption・選択・error・busyを分離し、差替え時に旧表示を破棄。旧listの遅延完了は無視。発見済み名とin-flight応答の両方をbrowserで検証 |
| 4290738838 画像置換 | Slide／Design／WhiteboardのReplace imageがsrcと参照解除を同一commandで適用。PNG表示、元source更新後も置換画像を保持、1回のUndoで元contentへ戻ることを検証 |
| 4290738839 read-only時の参照操作 | 4 SurfaceのReferenceInspectorをdisabled fieldsetの外へ移し、sourceを開く／再取得／発見はHost権限に委ねる。配置／mode／fit／固定／解除は無効のまま。native content不変も検証 |
| 4290738845 native JSON property名 | own JSON keyを参照IDの予約語制約から分離。`constructor`／`prototype`／`__proto__`／日本語のData列をcommit→structuredClone→create／refresh／captureし、保持hash不変を検証 |

### 追加修正の実施結果

Linux、Node 24.19.0、npm 11.9.0、Chromium 151.0.7922.173。
desktop 1440×1000／mobile touch emulation 390×844。

| 検査 | 結果 |
| --- | --- |
| lint／typecheck／変更TS・TSXのPrettier／diff whitespace | PASS |
| file policy／tooling | PASS／52 passed |
| `npm test` | 227 files、2377 passed、9 skipped（既存optional Spatial WASM） |
| 参照固有unit | 20 passed（前回18＋追加2、全unit内に含む） |
| `npm run build` | PASS、通常・独立reference Host・React preview、既存chunk-size warning継続 |
| reference Playwright dev | 56 passed＋SVG文字列assertion修正後の該当desktop/mobile 2 cases再実行PASS。合計58ケースを確認 |
| `EDITOR_REFERENCE_PRODUCTION=1 npx playwright test --config playwright.references.config.ts` | 58 passed。配布buildの既存12＋production modeでbundleした独立テストHostの46 cases |
| 既存独立Host／read-only／390px・768px mobile | `issue2-embedding.spec.ts`／`issue2-mobile.spec.ts`の3 cases PASS |

追加browser回帰は9シナリオ×desktop/mobileで18 cases。既存40 casesを合わせた58であり、
再実行を追加件数へ含めない。browser-error fixtureもPASS。重複IDのあるdeckについて、
desktop/mobile画像でactive pageの値95と固有geometryが維持されることを目視確認した。

初回の追加fixtureではData validatorの関数名／generic型、Documentの画像選択、SVGの
`font-weight=700`と値700の区別、値が入る`tspan`に合わせたassertionを修正した。
本体変更なしで該当testを再実行し、最終production一式もPASSした。
既存回帰用の一時configは初回cwdとprojectのtestMatchを継承して対象外specまで選択したため中止。
対象2 specをCLIへ明示した上記3ケースで確認し直した。中止試行を全E2Eの合格とは扱わない。

ログ・画像は`/tmp/issue265-r2-*`へ保存し、Gitには含めない。全E2E、実機mobile、
Firefox/WebKit、実Office、新規PNG/PDF/HTML実ファイル内容検査、性能測定はNOT RUN。
CI再開、merge、公開upstream同期は行っていない。

実装・検証commit `ebf7f6a4` のローカル公開snapshot export／manifest／residual検査はPASS。
1632 source files＋manifest。snapshot SHA-256は
`951f6afb28fa6c0f020b4d40943517245b402589dd66ed8653d518d5f7c25e7a`。
最初の制限sandbox実行はchild gitのEPERMで止まり、許可された検証環境で再実行した。
公開先への同期は行っていない。

## PR #265 追加レビュー4件（2026-10-16）

確認headは`74c3351a114fbf68916af32a7d74670590d5cbc3`。04:35 UTCの新規4件を照合した。
前回14件の修正・返信を再実行せず、新しい操作経路と追加の不変条件を修正した。

| 指摘（review comment ID） | 修正と回帰の対象 |
| --- | --- |
| 4290964460 通常Image fit | Slide／Design／Whiteboardの既存property commandが各参照のfitをnative imageFitと一緒に更新。複数参照＋通常画像の選択でsource／modeを維持。通常Inspectorからfill／fitを操作し、Canvas・SVG ZIP／manifest・Undoを検証 |
| 4290964464 version IDの再利用 | source/domain/version IDごとにrevision・content hash・依存id/hashを記録し、revisionが異なっても矛盾を拒否。create／refresh／live capture／historical importでGraphのrevision単独変更とProfile変更を検証。拒否後の正当な新versionと古いfixed版は受け入れる |
| 4290964466 resolver切替中の出力 | 4 Surfaceのcapture完了後に現在のresolverを照合。Document印刷previewはpage描画後にも照合。テストHostはresolverだけ変えたときcontent identityを維持し、内容変更guardで代用できない状態で検証。3 canvas SVGとDocument HTML／印刷の5シナリオでdownloadなし・native不変を確認 |
| 4290964468 Graphの余分な依存 | 必須Profile一件だけを許可。無関係なhash-valid依存を足したHost応答に対しcreate／refresh／capture／historical import／projectionを拒否し、余分なcontentを保持しない |

### SVG fitの描画確認で追加した修正

metadataとDOM属性のテストが通った後も、画像の目視でfillが領域全体へ反映されていないことを
確認した。ChromiumのSVG image documentは外側imageだけでなく自身のroot aspect ratioを使うため、
共通drawing rendererで描画用URIのrootをfit／fillへ合わせた。native source bytesとUTF-8の日本語は
保持し、raster imageのURIは変更しない。SVGをHTMLや実行コードへ変換しない。

3 Surface×desktop/mobileで画像elementそのもののPNGを比較し、通常のImage fit操作が描画を
変えること、SVG ZIP／manifestもcoverを使うこと、fitへ戻す操作とUndoを検証した。
SVG描画用URI・日本語・元bytes保持のunitを2件追加した。描画共通部の変更後に全unit／buildと
参照UI一式を再実行し、下記にはその最終結果を記録する。

### 追加4件・描画修正の検証条件

Linux、Node 24.19.0、npm 11.9.0、Chromium 151.0.7922.173。
desktop 1440×1000、mobile touch emulation 390×844。既存mobile回帰は390px／768px。

| 検査 | 結果 |
| --- | --- |
| lint／typecheck／変更TS・TSXのPrettier／diff whitespace | PASS |
| file policy／tooling | PASS／52 passed |
| 参照固有unit／SVG fit unit | 24 passed／2 passed |
| `npm run build` | PASS、通常・独立reference Host・React preview、既存chunk-size warning継続 |
| reference Playwright dev | 最終74 passed（描画修正後）。既存58＋今回8シナリオ×desktop/mobile |
| reference Playwright production設定 | 最終74 passed（描画修正後）。配布buildの既存12＋public APIをproduction modeでbundleした独立テストHost 62 |
| 既存独立Host／read-only／mobile | 配布build previewで`issue2-embedding.spec.ts`／`issue2-mobile.spec.ts`の3 cases PASS |

全browser-error fixtureもPASS。desktopのSlideとDesign、mobileのWhiteboardの画像を目視確認し、
画像element PNG比較で3 Surfaceのfit／fillの描画差も確認した。再実行の件数を重複加算しない。

参照unitの初回起動は自動承認reviewの期限切れで開始されず、許可された1回の再試行でPASSした。
描画unitの不要escapeをlintで修正し、unitを再実行した。描画変更後の全unit初回は
既存ZIP64のF01（32 MiB超）1件が5000 msでtimeoutし、2382 passed／1 failed／9 skipped。
同じ設定の単独実行では該当fileの30件PASS（F01は2960 ms）。全unitの最終再実行は別記する。

生ログ・比較画像・出力は`/tmp/issue265-r3-*`へ保存し、Gitへ含めない。全E2E、実機mobile、
Firefox/WebKit、実Office、新規PNG/PDF/HTML実ファイル内容検査、性能測定はNOT RUN。
CI再開、mainへのmerge、公開upstream同期は行っていない。

`npm test`の最終再実行は**228 files、2383 passed、9 skipped**でPASS。
設定・timeout・sourceを変更せず、browser suite終了後に単独で全unitを実行した。
問題だったZIP64 F01も同じ5000 ms設定で2804 msに収まりPASSした。

実装・検証commit `1d0b997dcf8eebc53580b15e9139d73ab06e03be` のローカル公開snapshotは
export／manifest／residual検査PASS。1633 source files＋manifest、snapshot SHA-256は
`793fcbdf85d5fa65a0b1d95df72eb7f2e88c253c24997fdc683ea98ef1ef0243`。
公開先への同期は行っていない。

## PR #265 履歴・入力・権限の追加レビュー4件（2026-10-16）

確認headは`846e568813ff876b60f345ce464c6f4fce9dd6b9`。05:11 UTCのレビュー、通常コメント、
inline thread、編集時刻と過去の返信を照合し、前回までの18件とは別の未対応4件を修正した。

| 指摘（review comment ID） | 修正と回帰の対象 |
| --- | --- |
| 4291136570 履歴importのidentity scope | Artifactごとに一つのdestination resolverを作り、draftと全immutable versionを順に検証。保存データの再読込も同じhelperを使用。draft対version／version対versionそれぞれで同revision・同version IDの矛盾をUI importから拒否し、正当な古い履歴のimport／reloadは許可 |
| 4291136578 疎なJSON配列 | descriptor walkの前に各indexがown propertyであることを確認。dependencies・target IDs・native contentの穴、部分的な穴、prototypeのindexを同期validatorで拒否。resolverはTypeErrorではなく検証errorを返す。通常のdense JSON配列は維持 |
| 4291136582 通常reference property | capability検出はschemaVersion/source/snapshotを持つ埋め込みenvelopeを識別し、通常のwebProps.referenceを許可。Designのnative／shared codec／template保存・展開を検証。実際の参照はsharedで拒否し、component templateのnative reference fieldも引き続き拒否 |
| 4291136587 権限再確認中のcache | loadingへの遷移でprojectionを即時破棄。snapshotはoffline確認後の再検証にだけ使う。fixed／followとforbidden／offlineの非同期unit、4 Surfaceの通知→待機→拒否／復旧・offline fallbackをdesktop/mobileで検証。native contentは変更しない |

### 今回の検証条件と実施結果

Linux、Node 24.19.0、npm 11.9.0、Chromium 151.0.7922.173。
desktop 1440×1000、mobile touch emulation 390×844。
追加unitは6件、追加browserシナリオは10件×desktop/mobileの20ケース。
最初のlintでは意図的な疎配列literalが`no-sparse-arrays`で拒否されたため、同じ不正入力を
index削除で作るfixtureに修正した。本体の検証規則やlint設定は緩和していない。

| 検査 | 結果 |
| --- | --- |
| lint／typecheck／変更TS・TSXのPrettier／diff whitespace | PASS |
| file policy／tooling | PASS／52 passed |
| 参照固有unit | 30 passed（既存24＋今回6） |
| `npm test` | 229 files、2389 passed、9 skipped（既存optional Spatial WASM）。browser suite終了後に全unitを実行 |
| `npm run build` | PASS、通常・独立reference Host・React preview、既存chunk-size warning継続 |
| reference Playwright dev | 94 passed（既存74＋今回20） |
| reference Playwright production設定 | 94 passed。配布buildの24＋public APIをproduction modeでbundleした独立テストHost 70 |
| 既存独立Host／read-only／mobile | 配布build previewで`issue2-embedding.spec.ts`／`issue2-mobile.spec.ts`の3 cases PASS |

browser-error fixtureも全対象でPASS。desktop Slideとmobile Documentの待機中の画像を目視確認し、
取得中の表示に切り替わり、以前の参照画像が表示されていないことを確認した。
追加20ケースの先行実行もPASSしたが、上表の94へ重複加算しない。

生ログ・画像・出力は`/tmp/issue265-r4-*`へ保存し、Gitへ含めない。全E2E、実機mobile、
Firefox/WebKit、実Office、新規PNG/PDF/HTML実ファイル内容検査、性能測定はNOT RUN。
CI再開、mainへのmerge、公開upstream同期は行っていない。

実装・検証commit `a055453298ddc69cc875d079700eb21a1e844282` のローカル公開snapshotは
export／manifest／residual検査PASS。1634 source files＋manifest、snapshot SHA-256は
`2b6b8815986d96d4d4a8e2aaf5a5ce8056e219cda9a6122b1059de42034021a0`。
公開先への同期は行っていない。

## PR #265 出力接続・Group描画の追加レビュー2件（2026-10-16）

確認headは`f91266a7305e7e2e34fe8a38fcc6e17e2fc2bd31`。通常コメント、inline thread、
review submissionと編集時刻を前回の22件・各返信・commitと照合し、05:38 UTCの新規2件を修正した。

| 指摘（review comment ID） | 修正と回帰の対象 |
| --- | --- |
| 4291276061 resolver未接続の出力 | 4 Surfaceの出力対象に参照があれば接続を必須にする。Slide SVG／PNG／PDF、Design・Whiteboard SVG／PNG、Document MD／HTML／PDF／印刷previewを診断付きで拒否し、downloadなし・native不変を確認。参照を持たない同じ画像はresolverなしのSVG／HTML出力とDocument印刷に成功する |
| 4291276069 Groupの継承状態 | Slide／WhiteboardのCanvas targetをpaint-order objectから作り、runtime側からsrcだけを重ねる。srcが同じならそのobject identityも保持。nested Groupの参照画像と通常要素がhide時に描画／hit targetから消え、sourceの保存版更新中も表示されず、再表示と2回のUndoで元のnative contentへ戻ることを検証 |

### 今回の検証条件

Linux、Node 24.19.0、npm 11.9.0、Chromium 151.0.7922.173。
desktop 1440×1000、mobile touch emulation 390×844。
追加browserシナリオは6件×desktop/mobileの12ケース。先行実行は12 passed。
初回typecheckはSlide fixtureのfactoryにindex引数が不足して失敗したため、既存signatureへ合わせた。
lint／typecheckの設定や本体validatorは緩和していない。最終結果は以下へ記録する。

| 検査 | 結果 |
| --- | --- |
| lint／typecheck／変更TS・TSXのPrettier／diff whitespace | PASS |
| file policy／tooling | PASS／52 passed |
| `npm run build` | PASS、通常・独立reference Host・React preview、既存chunk-size warning継続 |
| reference Playwright dev | 106 passed（既存94＋今回12） |
| `npm test` | 229 files、2389 passed、9 skipped（既存optional Spatial WASM）。browser suite終了後に全unitを実行 |
| reference Playwright production設定 | 106 passed。配布buildの24＋public APIをproduction modeでbundleした独立テストHost 82 |
| 既存独立Host／read-only／mobile | 配布build previewで`issue2-embedding.spec.ts`／`issue2-mobile.spec.ts`の3 cases PASS。mobileは390px／768px |

browser-error fixtureは全対象でPASS。desktop Slideのhidden Group、mobile Whiteboardの
復帰画像80、mobile Documentの未接続診断を目視確認した。Canvasの子のhit targetもDOMから
除外されることをassertした。先行12ケースを最終106へ重複加算しない。

生ログ・画像・出力は`/tmp/issue265-r5-*`へ保存し、Gitへ含めない。参照なしSVG／HTMLの
対照出力は実ファイルを確認したが、新規参照付きPNG／PDF／HTMLの実ファイル内容検査はNOT RUN。
全E2E、実機mobile、Firefox/WebKit、実Office、性能測定もNOT RUN。
CI再開、mainへのmerge、公開upstream同期は行っていない。

実装・検証commit `09c42643d3aa9007743aca284edd182c1f216cbc` のローカル公開snapshotは
export／manifest／residual検査PASS。1634 source files＋manifest、snapshot SHA-256は
`ea51e7c25e8a5172232b7c27fa3741d06d8e13b71d9b7be8ffbe7bca5b364d32`。
公開先への同期は行っていない。


## PR #265 出力範囲・確定境界のレビュー4件（2026-10-16）

確認headは`5bfc4294f11f3934bf2144b703263f9bb76900ca`。通常コメント、inline thread、
review submissionを照合し、07:05 UTCの新規4件のみを検証した。いずれも宣言済みの
機能で不正な保存や誤った出力へ到達するため対応し、過去の返信済み指摘は重複修正していない。

| 指摘（review comment ID） | 判断・変更・検証 |
| --- | --- |
| 4291801559 Documentのhidden参照 | HTML／PDF／印刷はhiddenを出力しないのに全blockを取得していた。可視blockだけ取得して元位置へ戻し、HTML／PDF manifestも可視範囲だけにする。hidden sourceを取得不能にしても出力成功、HTML内容とPDF添付manifestにincluded一件だけ、印刷preview一枚、native不変を確認。Markdownは既存のhiddenを含む仕様を維持し、同条件では取得不能を報告する |
| 4291801569 追加・複製時の上限 | 4 Surfaceのcommandを確定時のcontent全体で検証し、DocumentはPM state採用前にも検証する。64件からの追加、保持情報合計4 MiB超過、3 canvasの複製で拒否・native不変・Undoなしを確認。Documentは拒否後のPM画像数も元のまま。Host独自headless command向けにassertReferenceItemsを公開する |
| 4291801580 Dataのview ID衝突 | nativeに有効な重複／default IDが参照では別viewを指した。Data参照adapterの保存版検証で拒否し、通常Dataの読み込み仕様は変えない。重複／予約ID拒否、一意なnamed view成功、native validator受け入れをunitで確認 |
| 4291801589 テンプレートauthoring | 保存済み参照のIDをremapする経路は宣言上未対応。共通authoring選択境界で拒否する。4 domainのwhole／fragment／linked component拒否、無関係なfragment成功、元content不変をunitで確認。既存の普通のwebProps.referenceを許す回帰も維持 |

新規pure regression 7件は有効なfixtureで修正前実装に対して7件FAIL、修正後7件PASS。
初回fixtureのpurpose不足によるtemplate errorを修正してから、この前後比較を実施した。
新規browser 13シナリオ×desktop/mobileの26ケースは先行実行PASS。
初回typecheckのPDF stream lookupの型指定をinstanceofによる絞り込みへ修正した。
テスト側の型エラーを修正し、製品側のvalidatorや比較条件は緩和していない。

検証環境: Linux、Node 24.19.0、npm 11.9.0、Chromium 153.0.8010.0。
desktop 1440×1000、mobile touch emulation 390×844。既存のChromium実行ファイルと
日本語fontconfigを使用し、Viteの起動hostはこの環境で利用できる127.0.0.1を指定した。
最終検証結果は後記する。ログ・生成出力・画像はGitへ追加しない。

| 検査 | 結果 |
| --- | --- |
| lint／typecheck／変更TS・TSX・JSONのPrettier／diff whitespace | PASS |
| file policy／tooling | 2073 files PASS／52 passed |
| `npm test` | 230 files、2396 passed、9 skipped（既存optional Spatial WASM） |
| `npm run build` | PASS、通常・独立reference Host・React preview。既存chunk-size warning継続 |
| reference Playwright dev | 132 passed（既存106＋今回26） |
| reference Playwright production設定 | 132 passed。配布buildの24＋public APIをproduction modeでbundleした独立テストHost 108 |
| 既存独立Host／read-only／mobile | production previewで`issue2-embedding.spec.ts`／`issue2-mobile.spec.ts`の3 cases PASS。mobileは390px／768px |

browser-error fixtureは全対象でPASS。Documentのdesktop／390pxの拒否診断と、
可視blockだけの印刷previewを目視確認した。先行26ケースは最終132へ重複加算しない。
今回のDocument HTML本文・参照metadata、PDF添付manifestは実ファイルを検査した。
PDFの全描画品質、参照付きPNG実ファイル、全E2E、実機mobile、Firefox/WebKit、実Office、
性能測定はNOT RUN。CI再開、main merge、公開upstream同期は行っていない。

## PR #265 階層範囲・保持identity・保存切替のレビュー5件（2026-10-16）

確認headは`21a390b73ca3eaa13290ef3cc1a0d17709c70d9c`。既存checkoutのclean状態を確認し、
最新headへfast-forwardした。通常コメント、inline thread、review submission、編集時刻と
既存commitを照合し、21a390bで修正・返信済みの07:05 UTCの4件を重複対応せず、
07:50 UTCの未対応5件を修正した。

| 指摘（review comment ID） | 修正と検証 |
| --- | --- |
| 4292135134 親Groupに隠された参照 | 3 canvasのpaint orderから実効可視IDを取り、captureとmanifestを描画範囲へ揃える。Slideはpageごとに元の配列順へcaptureを戻す。hidden=falseの子を隠したnested Groupと取得不能sourceでSVG出力成功、manifestはincludedだけ、source read一件、native不変を検証。可視画像が参照なしならresolver未接続でも成功 |
| 4292135144 Host HTML | Surface内のvisible-block captureを公開captureDocumentReferencesへ抽出し、PlaygroundのdocumentTextExportも同じhelperを使う。MarkdownはincludeHidden=trueを維持。helper unitでhidden source未取得・元位置保持・native不変を確認し、通常Host UIでもHTML本文／manifestとIndexedDB record不変を確認 |
| 4292135155 resolver key | revisionと依存id/hashの組をkeyへ含め、observeのdedupが異なる保持closureを共有しないようにする。Graphのrevision／依存IDだけ異なる参照を両順序でobserveし、ready projectionの共有を拒否。正当な参照だけreadyになる |
| 4292135166 JSON内のreference属性 | schemaVersion/mode/fit/source/snapshotのenvelope discriminatorをJSON検証とcapability検出で共用。正当なGraph Profileの普通のobject属性をcreate／refresh／captureで受け入れ、hash・native bytesを保持。実際の参照envelopeは再帰参照として拒否 |
| 4292135174 非同期保存のdestination切替 | 独立Hostで開始時のkind・resolver・history配列を照合し、切替後のsave／native exportを拒否。実Hostでhash取得を遅延させてSlide→Documentへ切替え、両domainの履歴・draftをbyte比較、保存数とreload、downloadなしを検証 |

追加unitは7件、追加browserは6シナリオ×desktop/mobileの12ケース。
新規unitを含む参照44件は先行実行PASS。最初のbrowser先行実行は10 passed／2 failedで、
Host HTMLのimport fixtureに現行native validatorが認めないhidden画像を含めていた。
通常Host検証は有効なhidden paragraph＋可視参照へ直し、該当desktop/mobileの2件がPASS。
製品側のnative validatorは変更していない。hidden参照の直接注入は共通API unitと既存Surface
テストで検証するものであり、hidden画像のnative import対応を意味しない。

検証環境: Linux、Node 24.19.0、npm 11.9.0、Chromium 151.0.7922.173。
desktop 1440×1000、mobile touch emulation 390×844。最終結果は以下へ記録する。

| 検査 | 結果 |
| --- | --- |
| lint／typecheck／変更TS・TSXのPrettier／diff whitespace | PASS |
| file policy／tooling | 2075 files PASS／52 passed |
| 参照固有unit（4 files） | 44 passed。今回のidentity・Graph属性・Document captureの7件を含む |
| `npm test` | 231 files、2403 passed、9 skipped（既存optional Spatial WASM）。browser suite終了後に単独実行 |
| `npm run build` | PASS、通常・独立reference Host・React preview。既存chunk-size warning継続 |
| reference Playwright dev | 144 passed（既存132＋今回12） |
| reference Playwright production設定 | 144 passed。配布buildの30＋public APIをproduction modeでbundleした独立テストHost 114 |
| 既存独立Host／read-only／mobile | production previewで`issue2-embedding.spec.ts`／`issue2-mobile.spec.ts`の3 cases PASS。mobileは390px／768px |

browser-error fixtureは全対象でPASS。Slide desktopとDesign／Whiteboard 390pxで、可視のincluded表だけが
描画され、hidden Group配下の画像が出ない画面を目視確認した。新規12ケースの先行実行とHost修正後の
2ケースは最終144へ重複加算しない。Host HTMLは実ファイル本文・metadataとIndexedDB record不変、
3 canvasはSVG ZIPのmanifestとsource read範囲を検査した。遅延save／JSON出力は実際の独立Hostを使い、
両destinationのlocalStorage履歴・draftのbyte一致とreload後の保存数を確認した。

ログ・生成出力・画面は`/tmp/issue265-r7-*`へ保存し、Gitには追加しない。今回追加した祖先hiddenの
PNG／PDF実ファイル内容検査、PDF全描画品質、全E2E、実機mobile、Firefox/WebKit、実Office、性能測定は
NOT RUN。通常Hostからのhidden画像native importは前記のとおり未対応で、今回の検証もその対応を
主張しない。CI再開、main merge、公開upstream同期は行っていない。

実装修正commitは`f04948e350129e24660f302301faf5639826f54e`。
同commitのlocal public snapshot exportとmanifest／residual checkは**1637 source files＋manifest**でPASS。
snapshot SHA-256は`7b0fcb7943ec1e2979195d9ee4bf5714895465ffb44b56156dff959c5a89f72c`。
出力先は`/tmp/issue265-r7-public`。公開先への同期・pushは実行していない。
この検査はlocal snapshotの収録・整合性・残留検査であり、別checkoutの全runtime再検証を意味しない。

## PR #265 応答受理・依存identity・import自己参照のレビュー3件（2026-10-16）

確認headは`f9f7209bd6a15cbfde51aaf99c5e58c9c423d0f6`。既存checkoutはcleanで、fetch後のheadも
一致した。通常コメント・inline thread・review submissionと編集時刻、過去の返信・commitを照合し、
08:47 UTCの新規3件だけを対応した。

| 指摘（review comment ID） | 修正と検証 |
| --- | --- |
| 4292636463 拒否応答によるidentity汚染 | private verifyで閉包だけを検証し、権限・refresh世代・保持版逆行とwatermarkを通過後にrevision／version ID／依存identityを同期的にまとめて記録。create／refresh／captureのrollbackと取得後権限失効、破棄したrefresh応答の後に正当な過去固定版の描画・captureと次の保存版取得が成功することを確認 |
| 4292636472 依存版の不変性 | source domain＋依存IDのhashをGraph Artifact／revision／version IDと独立に保持。同じProfile ID/versionの内容変更はcreate／refresh／capture／公開validate／履歴captureでstaleにする。正当な旧Profile保持、新Profile versionの採用、同一Profileを使う別Graphも検証 |
| 4292636480 importの自己参照 | 元Artifact IDを保持し、draftと全versionの参照履歴をそのID scopeで検証。Slideのdraft／保存履歴×fixed／follow×desktop／mobileの8ケースでimportを拒否し、既存Artifact名・IndexedDB全recordのbyte一致・reload後の不変を確認 |

追加unitは13件。初回はfixtureの空Data rowとランダムGraph IDで失敗したため、明示したrowと
固定view IDへ修正した。製品validatorや期待する拒否条件は緩和していない。修正済みfixtureを
変更前headのcoreへaliasして13件すべてが期待した挙動差でFAILすることを確認し、実装変更後は
新規13件を含む参照unit **57 passed**。既存の「拒否したversion IDの後で正当版へ回復する」unitは、
同じProfile IDを別内容へ変更しないよう、回復版に元のProfile依存を使うfixtureへ更新した。

先行UIは新規8ケースすべてPASS。desktopのdraft/fixedと390pxのhistory/followの拒否診断を
目視確認した。生成ログ・画面と変更前coreの検証用コピーはGit外へ保存する。
最終検証結果は後記する。

検証環境: Linux、Node 24.19.0、npm 11.9.0、Chromium 151.0.7922.173。
desktop 1440×1000、mobile touch emulation 390×844。既存回帰は390px／768pxを確認した。

| 検査 | 結果 |
| --- | --- |
| lint／typecheck／変更TS・TSXのPrettier／diff whitespace | PASS |
| file policy／tooling | 2076 files PASS／52 passed |
| 参照固有unit（5 files） | 57 passed。新規13件を含む |
| `npm test` | 232 files、2416 passed、9 skipped（既存optional Spatial WASM）。browser suite終了後に単独実行 |
| `npm run build` | PASS、通常・独立reference Host・React preview。既存chunk-size warning継続 |
| reference Playwright dev | 152 passed（既存144＋今回8） |
| reference Playwright production設定 | 152 passed。配布buildの38＋public APIをproduction modeでbundleした独立テストHost 114 |
| 既存独立Host／read-only／mobile | production previewで`issue2-embedding.spec.ts`／`issue2-mobile.spec.ts`の3 cases PASS |

browser-error fixtureは全対象でPASS。productionでも自己参照import拒否のdesktop画面を目視確認した。
先行8ケースは最終152へ重複加算しない。log・download・画面は`/tmp/issue265-r8-*`、変更前coreと
alias検証configはignoredな`work/issue265-r8-red/`へ保存し、Gitへ追加しない。
一時的にgitのcredential helperが未設定でfetchが失敗したため、既存のgh認証をcommand単位の
helperとして使用して再取得し、head不変を確認した。credential値の読み出しや新規発行はしていない。

追加のPNG／PDF実ファイル内容検査、PDF全描画品質、全E2E、実機mobile、Firefox/WebKit、実Office、
性能測定はNOT RUN。公開Hostのsignature、native保存版のbytes／hashとlocal Undoの責務は維持する。
CI再開、main merge、公開upstream同期は行っていない。

実装修正commitは`3c5c40f73ff428d879ef53e345bb2674e2ad59a6`。
同commitのlocal public snapshot exportとmanifest／residual checkは**1638 source files＋manifest**でPASS。
snapshot SHA-256は`6df9c70f62016568698eae8887171b9e3e962d65a93c0581494aa3c159ec94b7`。
出力先は`/tmp/issue265-r8-public`。公開先への同期・pushは実行していない。
この検査はlocal snapshotの収録・整合性・残留検査であり、別checkoutの全runtime再検証を意味しない。

## PR #265 public入力・配置callbackのレビュー4件（2026-10-16）

確認headは`74701512d5c8730b01fc8d8ca4134807043af2f3`。既存checkoutのclean状態とfetch後のhead一致を
確認した。通常コメント・inline thread・review submissionと編集時刻、既存commit・返信を照合し、
10:22 UTCの未対応4件だけを対象とした。

| 指摘（review comment ID） | 判断・修正と検証 |
| --- | --- |
| 4293542400 差替えた保持閉包の未検証 | keyに宣言hashだけでなく保持snapshot・依存の実データを含め、異なる閉包で以前のready projectionを共有しない。followのrefresh／captureも最初に保持閉包を検証し、正常なlive sourceで不正な保持データを無言で置換しない。Graph content／Profile bytes改変×fixed／follow×両observe順の8 unitと、4 Surface×両mode×desktop／mobileの16 UIケースを検証 |
| 4293542408 非同期配置callback | Design通常参照挿入は明示boundsを渡すため、frame移動だけで旧frame座標から計算するという具体例はコードと一致しない。共通ReferenceToolsが待機前のinsert callbackを使う点は修正し、既存のscope／identity／入力guardを維持して最新callbackを呼ぶ。通常Designの明示座標を確認する対照ケースと、frame位置を計算するpublic Hostをfixed／follow×desktop／mobileで検証（計8）。移動後の配置・既存要素不変・二回のlocal Undoを確認 |
| 4293542420 継承参照の上限回避 | aggregate validatorでown referenceがないのにprototypeに存在するitemを拒否する。4 domainの65 inherited itemsとnative validator拒否、正常なown参照、accessorを評価しないことをunitで検証 |
| 4293542424 native target ID | target IDを一般のnative文字列として長さ・型・一意性で検証する。3種のObject-prototype名をview／row／column IDに使うDataを両modeでcreate／refresh／captureし、default viewへの範囲指定も含めnative閉包とhashを保持。空・過大・非文字列・重複・疎配列の拒否を維持 |

新規unitは20件。変更前coreへのalias実行では**19 failed／1 passed**で問題を再現した
（元から拒否する不正IDの対照1件だけPASS）。修正後の参照unitは**6 files、77 passed**。
保持閉包の先行検証でawaitが増えたため、既存の遅延応答unitは一回のmicrotask待ちではなく
Host readが開始したことをpollしてから応答順序を制御するfixtureへ修正した。
その修正前の先行unitは76 passed／1 failed（完了callback未設定）だった。

最初のtypecheckとUI bundleはfixtureのAPI名とcapture結果の型指定で失敗し、publicなpatchDesignと
src付き入力へ修正した。次のUI先行16件は6 passed／10 failedで、Documentの選択とinspectorの前提、
hidden子のため編集不能なframeを使っていたfixtureが原因だった。通常の制約は緩めず、配置用sceneから
hidden子を除き、Documentはinline診断で確認するよう修正した。両modeへ拡張後は23 passed／1 failedで、
Reactへ配置状態が届く前にsourceをreleaseするfixtureの競合だったため、frame変更のrenderをflushしてから
取得を再開するよう修正した。最終先行UIは**24 passed**。最終結果へ重複加算しない。

生成物・log・画面はGitへ追加しない。最終検証結果は以下へ記録する。

検証環境: Linux、Node 24.19.0、npm 11.9.0、Chromium 151.0.7922.173。
desktop 1440×1000、mobile touch emulation 390×844。既存回帰は390px／768pxを確認した。

| 検査 | 結果 |
| --- | --- |
| lint／typecheck／変更TS・TSXのPrettier／diff whitespace | PASS。最終fixture・既存unitの変更も対象lintで確認 |
| file policy／tooling | 2077 files PASS／52 passed |
| 参照固有unit（6 files） | 77 passed。新規20件を含む |
| `npm test` | 233 files、2436 passed、9 skipped（既存optional Spatial WASM）。browser suite終了後に単独実行 |
| `npm run build` | PASS、通常・独立reference Host・React preview。既存chunk-size warning継続 |
| reference Playwright dev | 176 passed（既存152＋今回24） |
| reference Playwright production設定 | 176 passed。配布buildの38＋public APIをproduction modeでbundleした独立テストHost 138 |
| 既存独立Host／read-only／mobile | production previewで`issue2-embedding.spec.ts`／`issue2-mobile.spec.ts`の3 cases PASS |

browser-error fixtureは全対象でPASS。先行UI画像でDocument 390pxの改変拒否診断と旧画像の非表示、
独立Host desktopで移動後のframe内へ配置した画像を目視確認した。log・download・画面は
`/tmp/issue265-r9-*`、変更前coreとalias検証configはignoredな`work/issue265-r9-red/`へ保存する。
今回の変更に対する追加のPNG／PDF実ファイル内容検査、PDF全描画品質、全E2E、実機mobile、
Firefox/WebKit、実Office、性能測定はNOT RUN。公開Hostのsignature、保存成功したimmutable versionだけの
伝搬、参照先更新がdestinationのlocal Undoを変更しない責務は維持する。
CI再開、main merge、公開upstream同期は行っていない。

実装修正commitは`6af3364306429157719460533865303111951fa5`。
同commitのlocal public snapshot exportとmanifest／residual checkは**1639 source files＋manifest**でPASS。
snapshot SHA-256は`bfd5fa283344411ce4617ceb673c82260025a06d5f6071c1d691cd58dce7b297`。
出力先は`/tmp/issue265-r9-public`。公開先への同期・pushは実行していない。
この検査はlocal snapshotの収録・整合性・残留検査であり、別checkoutの全runtime再検証を意味しない。


## PR #265 初回保持identity・同時保存・IME・ページ復帰のレビュー4件（2026-10-16）

確認headは`8a7bc28ce656a089fe767921469c086e2d0d93df`。既存checkoutはcleanで、fetch後も一致した。
通常コメント・inline thread・review submissionの本文と編集時刻、過去の返信・commitを照合し、
20:29 JSTの新規4件だけを対象とした。

| 指摘（review comment ID） | 修正と検証 |
| --- | --- |
| 4294175921 fresh resolverの保持identity | followのrefresh／captureで検証した保持閉包を保持し、権限・世代・逆行の検査を通過した後、live応答より先にimmutable identityとして記録・照合する。保持版はlive watermarkを進めない。fresh resolverの同revision／version ID／依存ID矛盾を両経路で拒否し、元閉包のbyte不変・拒否後の正当版への回復・新Profile版の受理を確認 |
| 4294175925 参照元の同時保存 | 独立Hostで呼出し時のcontentをcloneし、revisionの割当からhash・永続化・公開までをqueueで直列化。95→80→65の保存がrevision 1→2→3と一意のversion ID／正しいhashを持つこと、80の永続化失敗時は公開せず次の65をrevision 2として保存することを実UIで検証。固定95・連動65の描画、native capture、destination bytes不変、local Undoが最後の配置を戻すことも確認 |
| 4294175932 IME変換開始中のnative出力 | 独立HostのJSON出力完了guardへcomposingを追加。Document captionの値を変更せずcompositionstartだけを送るケースで保存とJSON出力を拒否し、downloadなし・保存履歴とdraft不変を確認。compositionend後の再実行成功も検証 |
| 4294175938 Slideの復帰page scope | ReferenceHost.openの既存二引数を保ち、optionalな第三引数にpage IDを渡す。ElementAddressにもoptional pageIdを追加し、通常Hostと独立Hostの復帰点・Slide focusで保持する。同じobject IDを持つ二pageの第二pageから元へ移動して戻り、第二pageの参照が選択されることを両Host・両modeで検証 |

新規unitは8件。変更前coreへのalias実行は**6 failed／2 passed**で、矛盾を拒否する6件が期待した
挙動差を示し、正当な新版を受け入れる対照2件は元からPASS。修正後の参照unitは**85 passed**。
新規UIは8シナリオ×desktop/mobileの16ケース。先行16件は8 passed／8 failedで、source Undo後の
可変sessionを保存済みlocalStorageから読んでいた点と、mobile drawerを開いたまま画像をクリックした
fixtureが原因だった。Undo後はnative exportでsessionを読み、ページ選択後はnavigatorの明示close buttonと
Canvasの通常Select Allで選択するよう修正した。修正途中の再実行は12 passed・1 interrupted・3未実行、
mobile限定の確認もbackdrop中央がdrawerに遮られたため1 interrupted・3未実行で停止した。
修正後のmobile復帰4件はPASS。製品側の選択・保存・Undo条件を緩和していない。

検証環境: Linux、Node 24.19.0、npm 11.9.0、Chromium 151.0.7922.173。
desktop 1440×1000、mobile touch emulation 390×844。
最終結果は以下へ記録する。

全unitの初回実行は通常sandboxで行い、ローカルlistenとffmpeg／Python／browser等の起動が
EPERMで失敗した。結果は12 files failed／221 passed、17 failed／2276 passed／160 skipped、
listen EPERMのunhandled error 3件。画像decodeやbrowser bootstrapの失敗・timeoutも含む。
テスト・期待値は変更せず、ローカルserver／child processを実行できる追加network権限付きの
既存検証環境で再実行した。**233 files、2444 passed、9 skipped**（既存optional Spatial WASM）でPASS。初回失敗をPASS扱いにしない。


| 検査 | 結果 |
| --- | --- |
| lint／typecheck／変更TS・TSXのPrettier／diff whitespace | PASS。最終のbrowser fixtureも対象lintで確認 |
| file policy／tooling | 2077 files PASS／52 passed |
| 参照固有unit（6 files） | 85 passed。新規8件を含む |
| `npm test`（追加network権限付き） | 233 files、2444 passed、9 skipped（既存optional Spatial WASM）。browser suite終了後に単独実行 |
| `npm run build` | PASS、通常・独立reference Host・React preview。既存chunk-size warning継続 |
| reference Playwright dev | 192 passed（既存176＋今回16） |
| reference Playwright production設定 | 192 passed。配布buildの54＋public APIをproduction modeでbundleした独立テストHost 138 |
| 既存独立Host／read-only／mobile | production previewで`issue2-embedding.spec.ts`／`issue2-mobile.spec.ts`の3 cases PASS。mobileは390px／768px |

browser-error fixtureは全対象でPASS。追加16ケースの先行確認を最終192へ重複加算しない。
Document 390pxのIME変換中の拒否診断と、通常Hostのdesktop／390pxで第二pageへ戻った参照選択を
目視確認した。log・download・画面は`/tmp/issue265-r10-*`、変更前coreとalias検証configは
ignoredな`work/issue265-r10-red/`へ保存し、Gitには追加しない。
今回の変更に対する追加のPNG／PDF実ファイル内容検査、PDF全描画品質、全E2E、実機mobile、
実機IME、Firefox／WebKit、実Office、性能測定はNOT RUN。composition検証はChromium上のイベントで
行ったもので、実機IME受け入れを意味しない。既存二引数Host契約は接続可能なまま、page scopeを
optionalに加算した。保存成功したimmutable versionだけの伝搬、exact閉包とhash、destinationの
local Undoの責務は維持する。CI再開、main merge、公開upstream同期は行っていない。


実装修正commitは`7e3c1d6630173ec17498312c80860d33f558ed03`。
同commitのlocal public snapshot exportとmanifest／residual checkは**1639 source files＋manifest**でPASS。
snapshot SHA-256は`1e4271402ec28c58bab0fad65895aa4fa7bdf6dfdca13ee3a31df2a708c9f443`。
出力先は`/tmp/issue265-r10-public`。公開先への同期・pushは実行していない。
この検査はlocal snapshotの収録・整合性・残留検査であり、別checkoutの全runtime再検証を意味しない。


## PR #265 Document表示能力・保存履歴・command境界のレビュー3件（2026-10-16）

確認headは`81e6ac7169774be2cabbd67785f8088d5081116a`。既存checkoutのclean状態とfetch後のhead一致を
確認した。通常コメント・inline thread・review submissionと編集時刻、過去の返信・commitを照合し、
21:50 JSTの未対応3件を修正した。前回の棚卸しreviewに挙がった4件は修正・返信済みで重複対応しない。

| 指摘（review comment ID） | 判断・修正と検証 |
| --- | --- |
| 4294826487 Documentのfit切替 | 既存のDocumentは幅と元の縦横比でeditor／HTML／PDF／printを描画し、crop用の固定高さを持たない。対応していないcontain／cover controlをDocumentで非表示にし、幅調整と自然比率を表示する。3 canvasのfitは従来どおり。固定／連動×保持metadataのcontain／cover×desktop／mobileの8 UIでcontrolなし・幅変更・実画像の自然比率・HTML幅／高さ指定なし・metadata保持・Undoを確認。既存版やhashは書き換えない |
| 4294826495 不正な保存versionの読込 | IndexedDBの全versionを各domainのvalidContentで検証してから参照履歴を走査する。4 domain×schemaVersion／fit改変×desktop／mobileの16 UIで読込エラー、健全な別Artifactの表示、IndexedDB全recordのbyte不変、保持recordのnative JSON export、reload後も同じ拒否と保存内容を確認 |
| 4294826504 不正envelopeのcommand適用 | local sessionで変更前のdomainからnative validatorを選び、参照検出がfalseでもcommand結果を検証する。4 domain×schemaVersion／fit／source改変×local／proposalの24 unitで適用を拒否し、content・revision・Undo／Redoの不変を確認。追加4 unitで正常commandのUndo後にも不正結果を拒否し、Redoが失われず正常結果を復元できることを確認 |

新規unitは28件。変更前Host modelへのalias実行では**28 failed**で、すべて「拒否されずthrowしない」
挙動差を確認した。修正後は**28 passed**。新規UIは12シナリオ×desktop/mobileの**24 passed**。
先行typecheckはfixtureのproposal contextに必須transactionIdを省略して失敗し、明示して修正した。
次のtypecheckはPlaywrightの深いnative型の引数serialize型展開で失敗し、browserへのseed引数を
同じJSON内容の文字列として渡すfixtureへ直した。検証条件・製品validatorを緩めていない。

検証環境: Linux、Node 24.19.0、npm 11.9.0、Chromium 151.0.7922.173。
desktop 1440×1000、mobile touch emulation 390×844。先行画面でDocumentの幅320／自然比率と
fit control非表示、390pxで不正履歴の診断・健全Artifactの表示を目視確認した。
最終結果は以下へ記録する。


| 検査 | 結果 |
| --- | --- |
| lint／typecheck／変更TS・TSXのPrettier／diff whitespace | PASS |
| file policy／tooling | 2078 files PASS／52 passed |
| 参照unit／Host境界unit | 85＋28 passed（最終全unit内）。新規28件を含む |
| `npm test`（追加network権限付き） | 234 files、2472 passed、9 skipped（既存optional Spatial WASM）。browser suite終了後に単独実行 |
| `npm run build` | PASS、通常・独立reference Host・React preview。既存chunk-size warning継続 |
| reference Playwright dev | 216 passed（既存192＋今回24） |
| reference Playwright production設定の対象回帰 | 42 passed。今回の24＋4 Surfaceの通常埋め込み8＋通常Hostの4 Surface統合2＋read-only8。配布buildの26＋public APIをproduction modeでbundleした独立テストHost 16 |
| 既存独立Host／read-only／mobile | production previewで`issue2-embedding.spec.ts`／`issue2-mobile.spec.ts`の3 cases PASS。mobileは390px／768px |

browser-error fixtureは全対象でPASS。先行24ケースは最終216へ重複加算しない。
本番は今回の変更・4 Surfaceの通常経路・read-onlyへ対象を絞って検証した。前回headの全192件の
production結果は前節のまま保持し、今回headの全216件をproductionで実行したとは扱わない。
log・download・画面は`/tmp/issue265-r11-*`、変更前modelとalias検証configはignoredな
`work/issue265-r11-red/`へ保存し、Gitには追加しない。

今回の全216ケースのproduction再実行、追加のPNG／PDF実ファイル内容検査、PDF全描画品質、全E2E、
実機mobile／IME、Firefox／WebKit、実Office、性能測定はNOT RUN。Documentの固定高さcropは未対応。
既存nativeのfit metadata・immutable versionとsource hashは保持し、公開Host signatureは変更しない。
保存成功した版だけの連動とdestination local Undoの分離を維持する。
CI再開、main merge、公開upstream同期、PR／Issueの終了操作は行っていない。


実装修正commitは`b9d28609a7adcdab2a03c9e0d353652ded3e01a7`。
同commitのlocal public snapshot exportとmanifest／residual checkは**1640 source files＋manifest**でPASS。
snapshot SHA-256は`bb684ed2d00f9836e70a25b625c2f123491e0b34c8658da6d4f2a874a0edea8e`。
出力先は`/tmp/issue265-r11-public`。公開先への同期・pushは実行していない。
この検査はlocal snapshotの収録・整合性・残留検査であり、別checkoutの全runtime再検証を意味しない。


## PR #265 作成待機・Document復帰・独立Host移動と権限のレビュー4件（2026-10-16）

確認headは`dd95094e8d43e84337558340af554f68bfaa9325`。既存checkoutのclean状態とfetch後のhead一致を
確認した。通常コメント・inline thread・review submissionの本文と編集時刻、過去の返信とcommitを
照合した。22:22 JSTの新規inline 3件に加え、review本文にだけ記載されたDocumentの1件も対象とした。
過去の自分の対応報告からは再実行していない。

| 指摘（review ID／comment ID） | 判断・修正と検証 |
| --- | --- |
| review 5548361706 Documentのimage復帰 | focusAddressでembedded nodeをNodeSelectionとして選択し、Hostへ選択を通知する。dispatch前にeditorへfocusし、React node viewの初期layoutとimage読込後も対象の表示位置を合わせる。両Host×固定／連動×desktop／mobileの8 UIで、離れた別imageを含む長文Documentから戻って正しい選択・全体の縦方向表示・Inspector caption・native content不変を確認 |
| 4295109296 作成待機中の選択変更 | source・mode・再取得をbusy中は無効にし、開始済みの古い発見要求も無効化する。固定／連動×desktop／mobileの4 UIで遅延listとreadを個別に止め、選択表示が変わらず指定したsource／modeで配置され、完了後に操作可能となりUndoも機能することを確認 |
| 4295109307 独立Hostの復帰先kind | source編集中はdestination kind selectorを無効化する。4 Surface×desktop／mobileの8 UIで移動中にkindを保持し、戻るとselectorが有効になり元のSurfaceの参照が解決済みとなることを確認 |
| 4295109319 失効後のsource移動 | 現在権限をHost.openより先に検証する。編集中の失効ではsource editorも隠し、command／proposal適用と保存queue開始・hash後の永続化直前も検証する。Data／Graph×固定／連動×desktop／mobileの8 UIで移動拒否・保存byte不変・権限回復後の移動、さらに4 UIで編集中／hash待機中の失効・保存公開拒否・元の保存値95保持を確認 |

新規UIは16シナリオ×desktop/mobileの32ケース。先行実行は**24 passed／8 failed**で、
Documentのnode選択は復元されたがfocus前のdispatchではProseMirrorがscrollしなかった。
focus順序の修正後は8 passedだったが、画面の目視確認でReact imageの読込前の高さに合わせて
scrollされ、画像が下端に少しだけ見える場合を見つけた。初期layout／image load後の表示調整と、
image blockの上下端がDocument scroll viewport内に入る検証を追加した。
その確認では6 passed／2 failedで、通常Host desktopの表示位置がなお境界に残ったため、
画像loadの次frameで中央へ合わせるよう修正し、8 passedを確認した。
途中の全dev suiteはこの追加修正のため停止し、**79 passed／1 interrupted／168未実行**だった。
途中結果を最終の全件PASSとして扱わない。

検証環境: Linux、Node 24.19.0、npm 11.9.0、Chromium 151.0.7922.173。
desktop 1440×1000、mobile touch emulation 390×844。
通常Host desktopのimage全体とInspector caption、390pxの復帰選択と、権限失効時の元editor非表示・
保存無効・拒否診断を目視確認した。最終結果は以下へ記録する。


| 検査 | 結果 |
| --- | --- |
| lint／typecheck／変更TS・TSXのPrettier／diff whitespace | PASS。buildの型検査も最終コードで実行 |
| file policy／tooling | 2078 files PASS／52 passed |
| `npm test`（追加network権限付き） | 234 files、2472 passed、9 skipped（既存optional Spatial WASM）。全browser suite終了後に単独実行 |
| reference Playwright dev | 248 passed（既存216＋今回32） |
| reference Playwright production設定の対象回帰 | 50 passed。今回32＋4 Surfaceの通常埋め込み8＋通常Hostの4 Surface統合2＋read-only8。配布buildの38＋public APIをproduction modeでbundleした独立テストHost 12 |
| 既存独立Host／read-only／mobile | production previewで`issue2-embedding.spec.ts`／`issue2-mobile.spec.ts`の3 cases PASS。mobileは390px／768px |
| `npm run build` | PASS。通常・独立reference Host・React preview。既存chunk-size warning継続 |

browser-error fixtureは全対象でPASS。先行確認のケースを最終248へ重複加算しない。
productionは今回の変更と4 Surfaceの通常経路・read-onlyに対象を絞った。現在の全248ケースを
productionで再実行したとは扱わない。log・download・画面は`/tmp/issue265-r12-*`に置き、
Gitには追加しない。
最終file policyの通常sandbox実行は子プロセス`git ls-files`のspawn EPERMで失敗した。
scriptや判定を変更せず、子プロセスを利用できる追加network権限付き環境で再実行し、
2078 files・違反0を確認した。先行file policyも同権限付きでPASSしている。

今回の全248ケースのproduction再実行、追加のPNG／PDF実ファイル内容検査、PDF全描画品質、全E2E、
実機mobile／IME、Firefox／WebKit、実Office、性能測定はNOT RUN。Documentの固定高さcropは未対応。
public Host signature・native schema・immutable versionのbytes／hash／依存閉包は変更しない。
保存成功したimmutable versionだけの伝搬とdestination local Undoの分離を維持する。
独立Hostの権限selectorは認証のない参照policyであり、製品の認証／RBACや永続化保証ではない。
CI再開、main merge、公開upstream同期、PR／Issueの終了操作は行っていない。

local public exportの初回は、UTF-8の本文をUTF-16LEでも検査する際の偶然の一致で
`personal-name`判定となり拒否された。検出ruleは維持し、同じ意味の文書表現へ直した。
出力が作られなかったため初回checkもENOENTとなった。これらをPASS扱いにしない。


実装修正commitは`05821276decb874a260829a7f6be20e381aa0a83`。
同commitのlocal public snapshot exportとmanifest／residual checkは**1640 source files＋manifest**でPASS。
snapshot SHA-256は`24cccbd3fe82d0a039def7c62add28f23dae603aaae4ea663db51787a3ac6244`。
出力先は`/tmp/issue265-r12-public`。公開先への同期・pushは実行していない。
この検査はlocal snapshotの収録・整合性・残留検査であり、別checkoutの全runtime再検証を意味しない。
