# Geo boundary background contract (#280)

2026-10-19 JST。既存Geoのlocal表示への能力追加。新しいdomain、tile service、投影、
Session/store/Undo、製品依存を追加しない。対応は国境（全世界）、州県境（全世界）、
市区町村・区（日本）。同梱データは説明用の簡略境界で、現在の行政区域の網羅性、
境界の正当性、GIS topologyや面積・距離精度を保証するものではない。

## 宣言範囲と責務

| 能力                    | 対応範囲                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| local表示               | 通常Geoと公開workspace Surfaceでオン/オフ・線色。正距円筒SVGで利用者地物の下に描画                                |
| background data         | read-onlyの同梱delta-encoded geometry。native layers/features/source closureに含めない                            |
| 保存ビュー              | optional `NamedGeoView.backgrounds`に最大3件のID・版・SHA-256・enabled・colorだけを保持                           |
| PNG / fixed Slide image | 保存済みnative versionとnamed viewをcapture。背景ありのPNGと出典、版/hash/線色をreceipt/Slide notesへ保持         |
| Slide Geo reference     | 既存map reference adapterが保存ビューのexact背景pinを解決。固定版と元Artifactの更新は独立                         |
| データ出力              | GeoJSON/CSVには利用者のlayerだけを出力し、背景を混ぜない                                                          |
| オフライン              | network fetchなし。同梱JS/dataから解決。外部API・キー・タイルを使わない                                           |
| 欠落                    | exact ID/版/hashが無い、またはhash不一致なら背景を省き、UI/画像クレジット/receiptで理由を示す。latestへ置換しない |

一時的な背景切替・色変更・表示・解決はcontent/hash/historyを変更しない。
**「Save named view」は既存のnative view保存commandなので、明示保存時には他のview設定と
同様にcontent/hashと履歴が変わる。** 保存済みの過去versionは変更しない。
新規viewを保存しない単なる切替をnative編集と混同しない。

`@editor-platform/geo-core/backgrounds`は`bundledGeoBackgrounds`、
`defaultGeoBackgroundSettings()`、`createGeoBackgroundCatalog(entries)`、
`resolveGeoBackgrounds(settings)`を公開する。main pure entrypointは設定・型・validatorを
公開し、同梱データは専用entrypointから読む。カタログはtrusted Host/buildのデータであり、
任意第三者JSのsandboxではない。受け入れ時はdescriptor、有限JSON、hash、座標・閉じたring、
最大16MB・10,000 feature・500,000 vertex/depth 16を独立して検証する。
利用者nativeの200地物・1,000頂点・64KiBは変更しない。解決したgeometryはfreezeし、
geometry自体の編集・選択・focus/annotation対象化はしない。

カタログはmetadataとdataを検証済みJSONから所有する。ID/版/hashに加え、labelは1–128文字、
attributionは空白だけでない1–180文字、source/license URLは512文字以内のHTTP(S)絶対URL
（認証情報なし）を要求する。accessorを実行せず、欠落・不正なdescriptorはpin単位の診断と
省略にする。国の塗りはすべての背景線より先に描き、保存設定の配列順で境界線を隠さない。
nativeの出典上限16折返し行は維持し、背景の出典は別枠で追加する。小さい出力高さでは
footerの行高と文字を縮め、出典を削除せず地図領域を残す。

local拡張キットの`readonly-domains`と`controlled-animation`も背景entrypointを含む。
既存lockの`@noble/hashes` 1.8.0を閉じた依存集合へ追加し、元LICENSE・lock integrity・
tarball/installed inventoryを保持する。Geoのtracked JSONだけを明示staging・hash監査し、
背景をJSにbundleする。キットにはdata manifestとデータ利用条件も収録する。
これはlocalのoffline検証キットであり、npm公開や配布権限の追加ではない。
既存Animationの`reuse-core`依存も閉包に含めるため、baselineを含む全profileが
`reuse-core`と同じlock固定の`@noble/hashes`を収録する。

## Data pins / 出典・再現

[同梱manifest](../packages/geo-core/data/manifest.json)に全pin、原本URL/SHA、feature/vertex数と
簡略化許容値を記録する。[データ利用条件](third-party/geo-boundaries.md)を同梱する。

| ID / 版                                       | 元データと範囲                          | 同梱feature / 頂点数 | 利用条件                                           |
| --------------------------------------------- | --------------------------------------- | -------------------- | -------------------------------------------------- |
| world-countries / 5.1.2-display.1             | Natural Earth 5.1.2 110m admin-0        | 177 / 9,924          | Public domain                                      |
| world-regions / 5.1.2-display.1               | Natural Earth 5.1.2 10m admin-1         | 4,596 / 149,359      | Public domain                                      |
| japan-municipalities / 2017-9469f09-display.1 | geoBoundaries JPN ADM2、2017年、9469f09 | 1,742 / 67,031       | **CC BY-SA 2.0**（当該dataの実際のmetadataによる） |

日本データは候補一覧の一般的なCC BY 4.0という説明を流用せず、実データの利用条件を採用する。
OpenStreetMap / Wambacherを表示し、派生した日本データを同じCC BY-SA 2.0で提供する。
ライセンスの適用範囲は同梱dataで、private platform codeへの公開ライセンス追加ではない。

`python3 scripts/geo-backgrounds/generate.py --cache /tmp/geo-background-source --check`
でpinned原本を取得・SHA照合し、同梱データとmanifestの完全一致を確認できる。
原本をGitへ追加しない。生成は決定的なring simplification、6桁小数の整数化、delta encoding。
Natural Earthの微小なringも保持する。小島やholeを単純化し、topology検証済みとはしない。
SVG背景は出力pixelに丸め、連続する同一pixelを重複出力しない。拡大すると同じpinから
より細かく表示される。native座標・geometryは変更せず、利用者地物のserializerも従来どおり。

同じID/版を別geometryに置き換えない。将来の同梱更新は新版を追加し、旧pinを残す。
固定PNGは完成したbytesなので背景カタログ更新で変わらない。固定参照のnative snapshotは
同じ保存ビューpinを保持する。datasetが無いHostでは別版に代替せず欠落として示す。
renderer版、背景data版、native content hash、出力byte hashは区別する。

## 受入と制限

[検証記録](verification/issue-280/README.md)でN01–N14と対応するC条件、desktop/mobile、
通常/独立Host、PNG/Slide/データ出力、欠落、offlineを分けて記録する。
背景自体はprivate display、viewの保存は既存command/permission/Undoを使う。
共有Geo、独自任意backgroundのネットワーク配信、道路・建物・地名tile、住所検索、
現在の全行政境界への更新、性能受入、外部GIS readerの認定は対象外。
CI再開・公開同期・deploymentは行わない。
