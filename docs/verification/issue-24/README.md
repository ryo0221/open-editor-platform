# React UI W1–W5 最終受入（2026-10-18）

**U01–U14を受入。固定21登録・500 node・深さ4・390/1024/1400pxで95/95 Hard PASS。**
[測定前の固定条件](performance-protocol.md) / [全95条件のp95・最大値](performance.md) /
[公開契約](../../react-ui-contract.md) / [導入](../../react-ui-integration.md)。

## source・環境・証跡

計測sourceはlocal `ef64c123a1a682ec6f63dd4d053b5be543bef15a`、対応するsource commitは`bbf28de8d726a966338fe084302d2bb7a84e3a48`、
Git treeは`c80bd5b7c111c93c97f65a915a2e9ef9a448a1c4`。親履歴の異なるlocal/remoteは全tree一致を検査して対応付ける。
正式実行の前後でsource 1752 files、production build 157 files、
scale build・独立出力・fixture・固定条件 43 filesのSHA-256を照合し、すべて不変。
後続は受入文書のみ。初期契約はlocal `30d90f2b`で先行固定し、`90e1cce8`で定常/初期cold navigationの区別を初回測定前に明記した。以降のworkload/回数/Hardは変更していない。

Node20.20.2、React19.1.1、Playwright1.63.0、Chromium151.0.7922.173。
Linux6.18.55/glibc2.41、AMD EPYC9V74、visible CPU5/cgroup quota4 CPU、memory limit16GiB。
Cloud内のlocal結果であり、新しいActions成功とは扱わない。Actions dispatch・公開同期・deployは行わない。
fixture SHA-256は`681be52e24ef0a1f9e8e7992fba6d1c8e2671acb9426525da231acc47d186252`。

原証跡はGit外の`work/complete24/issue-24-evidence.tar.gz`に集約した。
5306 files、698336275 bytes、SHA-256 `c72f5682be678b82379ec40db281a91e223a267b4c54efc4cd1d2f4cc9ff8bc3`。
全warm-up/raw sample、p95/max、stdout、失敗、trace/PNG、CPU診断、実行source/build manifest、
独立TSX/元実装/CSS/画像/lockfileを含む。node_modulesと生成物はGitへ追加せず、archiveの外部uploadは未実施。

## 機能確認

| 確認                                | 結果                                                                                                                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全unit                              | 2,650 PASS / 256 files、既存optional skip9                                                                                                                                                          |
| lint / types / format / file policy | PASS。全体検査と変更後の差分検査を実施                                                                                                                                                              |
| production build                    | main / React preview / Artifact Host の3 build PASS                                                                                                                                                 |
| tooling                             | 65 PASS。p95再計算・不足sample/予算変更/不正値の拒否も検査                                                                                                                                          |
| production Chromium                 | 23/23 PASS。React UI/portability、既存7 Surface埋込・readonly・mobile navigation、履歴回復                                                                                                          |
| Firefox / WebKit                    | 各16/16 PASS（source62cf1e81）。最終差分のencoder Mapは5ファイルbyte一致と独立3幅/通常UIで再確認。商品/form/改訂formの3幅PNG完全一致、実入力/callback、共有・改訂・欠損/例外・mobile                |
| 独立500-node出力                    | 3/3 PASS。21元実装/18 Provider Card/全画像、500 class nodes、全499子nodeの座標/style一致、初期/操作後viewport PNG完全一致                                                                           |
| Design連携                          | source62cf1e81で5/5代表flow PASS。最終差分はencoderの等価なindex参照のみ。通常作成/明示改訂・import/再生成・競合/共有selective Undo/mobile。先行の機能checkpoint（4b92c738相当）では関連20/20もPASS |

500-nodeの出力先は独自node_modulesのReact/ReactDOMとpinned build依存だけを持ち、元実装をそのままimportする。
Editor依存・iframe・preview-only node属性がない。実input変更が他のcontrolled inputへ伝わり、callbackで利用先stateが変わる。
元5部品の商品/form/改訂formは通常Playgroundで確認し、500-node Hostは公開Surface/EditorSession/実IndexedDBと別originの公開ReactCompositionを使う。
500-nodeでPlayground全体の追加Host処理まで測定したとは主張しない。生成5ファイルは最適化前の出力とbyte単位で一致した。

## 性能判定

定常条件は5 warm-up＋20 measured sampleを各3 fresh invocation。nearest-rank p95で判定し、
最大値と全sampleを残す。初期表示は幅/反復ごと1 cold navigation、CLIは3 fresh processの最大値。
95条件はnative21、browser72、独立CLI2。sample総数2,115を独立auditorで再計算した。
下表は各条件の**3反復p95の最大**であり、sampleを混ぜたp95ではない。

| native操作       | 3反復p95最大 ms |
| ---------------- | --------------: |
| prop             |          40.950 |
| insert           |          43.349 |
| move             |          46.620 |
| undo             |           2.255 |
| native-roundtrip |          53.767 |
| tsx-export       |           9.196 |
| host-resolution  |           0.325 |

|   幅 |  props |   挿入 |   移動 |   Undo |
| ---: | -----: | -----: | -----: | -----: |
|  390 | 74.500 | 86.000 | 76.100 | 71.900 |
| 1024 | 78.700 | 90.200 | 74.200 | 73.200 |
| 1400 | 84.400 | 86.800 | 73.600 | 72.100 |

上の編集Hardは100ms。browser幅切替500ms、pure export/native往復500ms、Host解決100ms、
実IndexedDB保存1000ms、cold表示/reload5000msも全幅・全反復で通過した。詳細は全95行の記録を参照する。

| 独立CLI          | 全3値 ms                     |  最大 ms | Hard ms |
| ---------------- | ---------------------------- | -------: | ------: |
| typecheck        | 1456.886, 1326.316, 1383.718 | 1456.886 |   10000 |
| production-build | 831.545, 839.105, 843.098    |  843.098 |   15000 |

努力目標未達は36条件。全値と超過差、次の改善候補をperformance記録へ記載した。
努力目標だけの調整は0回。50msを達成したとは読み替えない。Nativeは同一の復旧後instanceで再測定した未変更前版3反復に対する20%回帰も全7操作でPASS。[比較契約](native-regression-protocol.md)と全差分を参照する。browser/CLIの20%回帰は比較前版がなく未判定。

## 修正と保持した境界

- loaderの所有immutable証明、診断/fingerprintのWeakMap、検査済み不変JSONの件数/深さを再利用する。
  mutable/shallow-frozen/外部deep-frozenを所有証明と混同しない。出現ごとの値/容量上限、descriptor、hash、schema、global ownershipと現在の環境を検査する。
- 編集は変更nodeをcopy-on-writeで所有し、検査済みbaseのmetadata/未変更nodeを保持する。
  内部node編集はnew node/rootsをコピーする。公開の未知object inputは完全native cloneを維持し、Proxyのガードも検査する。
  parse経路はbyte/descriptor/schema/hash/全体上限を検査したJSON.parseの私有graphを所有し、二重cloneを省く。ASCII/非ASCIIの正確なUTF-8上限も検査する。
  完全clone後に保持できるのはdescriptor検査済みで全arrayが標準prototypeの不変dataだけ。frozenなarray subclassのhookを実行せずcloneで除き、現在のschema/hash/全体上限の検査を省略しない。callerの挿入データ/診断変更、失敗batch、同node連続変更、環境変更、全体所有制約の20 ownership＋4 budget guardを通す。
- 完全なprimitive string値をkeyにする64件・8,192文字以下のdigest cacheはhash bytesを変えず、変わったsourceは別値として再検査する。objectは毎回canonical hashを計算し、独立cryptoによる2 guardでUTF-8/境界/変更/evictionを確認した。
- `prepareReactUiComposition`はexportと同じschema/semantic/runtime/output-path検査で所有構成を返す。rendererはその結果を使い、未使用のexport fingerprintと二重のruntime検査を生成しない。
- node/component lookupとbounded class-name cache（4,000 IDs、長さ160以下）で同じ出力を再利用する。
  Surfaceは公開content snapshotを一度admitし、statusだけの再描画を減らす。runtime/依存/権限・messageのsource/origin/版は引き続き検査する。
- `EditorSession.undoView` / `redoView`は既存の正本/履歴/同期validator/再入防止を共有し、legacy undo/redoはcaller-owned copyのままとする。凍結/clone/検証が失敗すれば履歴を動かさず、通常React UIと規模Hostは不変viewを描画する。他domain/共有のauthority経路は変更しない。
- 公開ReactPreviewBoundaryのresetKeyで新request時に例外から復帰し、正常なDOMは維持する。
  通常の登録/Design対応preview経路にも適用した。DOM同一性、故意例外後のUndo/restartを実操作で検査する。
- Inspectorのbinding draftは保存内容のobject参照ではなく確定binding/node/契約をbasisにする。
  別propを編集しても未適用の選択が残る。追加ガードは旧buildのChromiumで失敗し、修正後に3 engineで成功した。

## 失敗と実行上の制約

最初の390px診断はprops/挿入/移動/Undoが約274–313msで4 Hard未達だった。
複製・hash・再描画を順に修正し、途中の6系列の全rawも保存した。部分的な1幅/1反復を正式合格に代用しない。
最初の正式source `b2d2502f`はnative2回目の挿入p95=118.760msで100msを超えた。
そのsourceの実行1/2、全175 sampleずつ、source/build manifestを`native-formal-failed-b2d`へ保管して停止し、
内部node編集の全体コピーを削減した。次のb451版も挿入で約101msとなり、全3反復をnative-formal-failed-b451へ保存した。完全検査/native clone後の不変plain nodeを保持して履歴との二重保持を減らし、採用sourceで全3反復を完遂した。
次の60347363版はnative全21 Hardとbrowser第1反復の3幅を通過したが、native往復/Host解決の前版比較がそれぞれ約69.94%/22.57%悪化したため保留した。全rawとmanifestをnative-formal-failed-603へ残し、parseの二重複製と同じimmutable sourceのdigest再計算を削減した。

実行サービスの再接続でPID namespaceが更新された。旧boot IDは未記録だが、Node/CPU/OS/cgroup quota/メモリ上限は同じで、最初は旧nativeの比較上限を保守的に適用したが、同一instanceを証明できなかったため未変更b451 bundleを現環境で3回再測定した。source・計測本体・fixture・Hard・20%率・回数は維持し、[再測定基準](recovered-native-baseline.md)を候補版の正式測定前に固定した。旧2系列の失敗（初回8.896988ms、確認3.033516ms）は残し、旧数値と新しい全3反復を混合しない。採用した全正式反復は再接続後に実行し、途中のsource/測定値を混ぜていない。環境記録もarchiveへ含める。
6363442e版もnative全21 Hardを通過したが、Undoの3 p95最大2.990582ms（上限2.958815）、Host解決0.923626ms（上限0.918656）で比較未達となりnative-formal-failed-636へ全3反復を残した。Hostのexact ref照合ではhash再計算と線形検索をなくし、全fieldの比較と拒否条件を保った。Undo自体のnative clone/履歴処理は変更せず、次の固定3反復で再確認した。この僅差も測定のばらつきとして保持し、旧値を削除しない。
15cc6917版はnative21 Hard/7回帰を通過したが、browser第1反復の1024/1400px Undoが103.9/105.9msで未達となり、全3幅のrawとnative3反復をbrowser-formal-failed-15ccへ残した。既存履歴の不変viewを通常React UI Hostにも導入し、同じ正本からのコピー/admissionを減らした。native測定は従来どおりcopyを返すsession.undoを使い、操作・回数・予算は変えていない。
0f8f3957版はnative21 Hard/7回帰とbrowser第1反復の全3幅を通過したが、第2反復390pxの挿入116.6msで未達となった。全native3回とbrowser6条件をbrowser-formal-failed-0fへ保存した。通常UIの10挿入/10UndoをCPU診断し、data/byte検査と一時割当の重複を確認した。診断pathを失敗時だけ生成し、外部inputを完全cloneしてからschema検査する順へ整理した。最初に検査したJSONの値/予算をnative cloneが保つprivate経路の重複走査を減らし、新規graphを組み立てる内部node編集ではコピー後のaggregate検査を維持した。arrayの継承methodを呼ばずにcloneするガードと正確なerror pathも検査した。CPU診断は受入latencyに代用しない。
36bffa28版はnative21 Hard/7回帰とbrowser第1反復全3幅を通過し、第2反復1024px propsのみ111.6msで未達となった。全native3反復とbrowser6条件をbrowser-formal-failed-36bへ保存した。プレビューは既存のCSS生成器を使っていたが、使わないexport planのfingerprintまで計算していた。同じ完全preflightをprepareReactUiCompositionへ共通化し、描画では全体hashと重複runtime検査を省いた。TSX encoder/出力5ファイルは変えていない。
最終62cf1e81の初回native3反復は全21 Hardを通過したが、Undo第2反復のp95 8.896988ms（他の2反復1.882354/2.185309ms）で前版比較を超過した。native-formal-failed-62cfへ全75 Undo値を含む3反復を保存した。コードを変更せず、固定の全3反復を一度だけ確認再実行した。旧値の除外/入替えや3反復のpoolingを行わず、失敗した初回も受入の再現性に関する制約として残す。
復旧後の基準に対するefa8d559版はnative21 Hardを通過し、TSX出力だけp95最大12.467056ms（上限12.240305ms、+22.223%）で比較未達となった。native-formal-failed-efa8へ保存し、500 nodeで毎回繰り返していた部品一覧検索をsort済みindex Mapへ置換した。5生成ファイルのbyte一致と全登録を使う独立出力で確認した。
型宣言・テスト設定の失敗、404、iframe外まで撮影した初回画像も成功結果で上書きしていない。

最終候補62cf1e81の通常Chromium初回は22/23成功し、改訂formのcallback後画像だけ4画素・最大1階調差で未達だった。失敗PNG/traceをproduction-fix15に保存し、code/style/比較閾値を変えずに単独再実行したproduction-fix15-retryでは23/23が完全一致した。微小なraster差を機能不一致と断定せず、単独の同一検査で確認した経緯を残す。

Firefoxの初回起動設定はChromium executableを継承して失敗し、設定を分離した。
1280×720のheadless Firefoxではnested scroll下端のApplyにnative pointerが届かないケースを再現した。
ready待ち/hover/祖先transform/仮想screen拡大は改善せず、通常の中央scrollで同じnative clickが届いた。
E2Eはこの通常scrollを明示する。force click/JS event dispatch/エラー無視は行わない。viewportや性能条件は変更しない。
Cloud Firefoxは既存sysroot/設定、WebKitは同じwrapperとnosseで起動する。実機/OS IME/全ブラウザ版は未検証。

利用側固有の21部品登録/catalog adapter/実材料試用、任意npm実行、内部実装のvisual編集、TSX双方向同期、
全面RSC/SSR、公開hostingは対象外。本番auth/durability/組織policyは引き続きHost/Platformの責務。
今回の合格はこのsource/fixtureに限り、他domainの過去の性能checkpointを測定し直した扱いにはしない。
