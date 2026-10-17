# iPhone素材・素材込みproject：更新した推奨アーキテクチャ

本人確定要件：iPhone撮影動画も対象、素材込みで保存。
#153の原本再選択方式・720p/Linux/48k限定は完成仕様から外す。
音声付き1080p MP4入出力、まずWindows Chrome/Edgeを推奨対象とする。
iPhone撮影ファイルの入力対応であり、iPhone/Safari上での編集対応とは分ける。
これは設計提案。新schema/API/依存・保存形式の製品実装は親の具体的確認前に行わない。

## 1. 一つの構成

既存Core/Extensionは小さいnative参照・有理編集時間・command/historyを所有し、
Hostが `原本 → 解釈/probe → ローカルdecode/render → 派生物` と資産保存を所有する。
全bytesをnativeへ入れない。64KiB/4096nodes/depth24は維持する。

Hostの資産はhashで識別するimmutable blob。元のFile名は表示用で権限やidentityにしない。
原本はbit単位で保持し、回転適用/SDR化/縮小/音声変換したものは別hashの派生物とする。
派生物に原本hash、処理profile/version、時間対応、色解釈、設定を関連付ける。
proxyと原本を同一sourceとしてすり替えず、previewとexportで解釈を共通にする。
破棄可能proxyと再現に必須な派生物を区別し、後者は保存closureへ含める。

UI工程は取込→編集→素材込みproject保存→scope/browserを破棄→project単体を開く→
再編集→音声付き1080p MP4実書出し→再decode。再選択を通常の再開条件にしない。

## 2. iPhone decodeと色の経路

第一候補はbrowser内ローカルworker。具体profileでnative WebCodecsの実decodeが通れば使用し、
HEVC非対応なら**固定source/buildとライセンスを確認したローカルWASM HEVC decoder**を評価する。
候補技術はFFmpegの必要部品だけを含む再現可能build。stock ffmpeg.wasmの導入や
新helperアプリ、remote変換を無断で行わない。WASMで成立することは現時点NOT RUN。
必要なread/frame資源制限、10bit planeアクセス、取消、Windows CSP/worker、streaming I/Oが
満たせない場合はiPhone対応gateがBLOCKEDであり、HEVCを拒否して対応済みとは言わない。

FFmpeg.wasm公式はwrapperとcoreのライセンスを区別し、大きなファイルの制限も記載する。
全量MEMFSへコピーする既成経路を4K素材へ無条件適用しない。限定buildでも依存/特許/再配布と
対応sourceの確認が必要で、MPL AAC候補の未解決provenanceをそのまま流用しない。[S1]
ローカルdecode候補を具体版へ固定する判断と製品への採用判断を分離する。

HDR出力維持ではなく、まず**利用者に明示した1080p SDR/BT.709 MP4への変換**を推奨。
原本HDR/Dolby Vision bytesはproject内へ残す。HLG/PQ、range、primaries、matrixを読み、
10bit/floatの段階でtone/gamut mappingし、その後8bit化・ditherする。単にBT.709タグを付け替えない。
回転matrix/SARをdisplay geometryへ一度適用し、出力の向きとtagsを整合させる。

Appleが説明するiPhone Dolby Vision8.4はHLG互換base layerを持つ。[S2]
確認済み8.4素材では「HLG互換層からSDR変換、Dolby動的metadataを再現する変換ではない」と
明示して利用者/親が承認する案。元metadataは原本で保持し、変換結果へ虚偽のDolbyタグを残さない。
これを全Dolby profile/全iPhoneの色一致保証にしない。動的metadataを反映した再現が必要なら
対応変換engine/ライセンスを別判断し、未実装を隠さない。HLG互換でないprofileは要追加経路。

色受入は実iPhone原本と信頼できるSDR reference、露出/肌/ハイライト/暗部/飽和色/gradientを
比較し、profileと許容を事前固定する。通常スクリーンショットだけでHDR色を認定しない。

## 3. VFRと44.1/48kHz

入力をCFR認定して排除する方式から、全sampleのPTS/DTS/durationに基づくVFR表示区間へ拡張。
原本の非ゼロorigin/edit/B-frame時刻を保持し、宣言したsequence/output cadenceから
有理source時刻を求めて一意の表示区間を選ぶ。原本を暗黙25fps変換しない。
出力fpsは明示値で、VFR入力からのframe保持/間引きと末尾durationを説明・検証する。
4K/60fps入力を1080pへ変換する場合も原本を変更せず、解像度とcadenceは別設定とする。

44.1/48k原音を保持し、出力sample rateは明示設定。source sampleCountは有効decode結果を使う。
29.97fpsの1frameは48kで1601.6samples、44.1kで1471.47samplesなので、v0整数audio区間だけでは
通常linked編集を満たせない。有理audio区間/migration、位相を保持するband-limited resampler、
グローバル出力sample格子を具体化して親reviewへ出す。AAC priming/tailとresampler delayは
別の量として検査し、相殺用の推測offsetを使わない。previewとexportのA/V対応を共通化する。
#115 Opus BLOCKEDは別に維持。native/WASM AACは各々の実ファイルgateを通す。

音声track数だけで拒否/全mix/先頭選択しない。Apple TN3177に沿い、track enabled、
alternate_group、fallback association、codec/channel layout/言語を読む。Spatial Audioと
stereo AACが同一alternate groupなら一方だけを使い、確認済みstereo fallbackを明示選択する。
選択track IDと解釈profileを保存し、UIに「編集・出力stereo、Spatial原本保持」を表示する。
AAC48k stereoだけをiPhone一般対応としない。複数group/曖昧な関連は選択を求め、同groupを
二重再生しない。空間音声の再編集/再出力は未対応として分け、原本metadataを捨てない。[S5]

Auto FPSが暗所でframe rateを下げる設定や、機種によるSpatial Audio/HDR既定をfixtureに
反映する。撮影設定のfps表示からCFRと決めない。シネマティック等は検出・原本保持と
通常の平面映像への明示変換、固有metadata編集の未対応を区別し、無制限にscopeを広げない。[S6]

## 4. 素材込みproject bundleと権限境界

**推奨案：version付きmanifest＋native snapshot/retained versions＋content-addressed原本を
含む、ZIP64 STORE中心の単一portable project file。** 名前/拡張子/schemaは未固定。
大容量mediaを再圧縮せず、incremental read/hash/writeする。既存fflateがZIP64を満たすとは
仮定せず、writer/reader候補と追加依存は別確認。zip実装を先に入れない。

概念closure：project root manifest → 含めるimmutable native version/hash → 参照asset hash →
元bytesと再現必須派生物/profile。defaultはprojectで保持する全versionのclosureを含める案。
過去versionを外すなら明示操作とし、容量のため黙って切捨てない。live Undo stackを保存したと
称さず、既存retained-version意味論を使う。GCは全retained root・進行中save leaseから到達しない
資産だけを対象にする。出力MP4は別成果物で、native/project Saveのreceiptと区別する。

manifestは各entryのpath/type/length/SHA-256、native schema/profile versions、root/hashと
必須closureを列挙。未知schema、hash/size不一致、重複entry/path、絶対path/../symlink、
外部URL、entry数/総量/展開量超過を拒否する。checksumだけでhash確認を代替しない。
小さいnative上限とHost bundle上限は別。ZIP64だから無制限とはしない。

取込ではworkerでclosure全体を検証してprivate stagingへ置き、権限・base revision・Inputs・
source/clip/容量を最後に再確認して1commandで登録。失敗や取消でdangling sourceを残さない。
Host資産stagingとCore commitに跨るprotocolは新しい重要境界：blobはimmutableで先に準備し、
commit失敗分は未参照として破棄、成功後も必要leaseを保持する。途中成功をUIに見せない。

保存では既存SaveCoordinatorのcaptureを基準にnativeとclosureを固定し、全資産をpinする。
別編集が進んでもcapture/hashを取り替えない。親が承認するHost保存adapterへproject stagingを
接続し、全参照hash/sizeのcapture→資産write→staging再読hash/size検証→manifest確定を行う。
全closure成功と権限/取消の最終確認後だけ保存を完了する。metadataだけの64KiB receiptを
素材保存の証明として流用しない。
Mediabunnyのclose callbackや「nativeだけ保存済み」でproject成功receiptを発行しない。

第一保存先候補は利用者が明示選択したWindowsローカルfile handle。権限はHostで管理し、
Core/native/bundleへcapabilityを埋めない。File System Accessではwrite中のstagingと
close/abortの意味を確認し、失敗/取消/revokeで以前の完成fileを保持する。[S3]
完了済み保存を後からrevokeで取り消せるとは約束しない。close中の取消はcommit point前後の
結果を分離し、不明結果を「保存なし」と断定しない。既存Save結果の扱いを親reviewする。

OPFSは必要なら一時staging/cacheに限定する候補。OPFSだけをportable保存完了にせず、
quota/eviction/クラッシュを扱う。原本＋派生物＋旧完成bundle＋新staging＋作業中copyの
同時disk使用量を見積もり、容量不足/中途枯渇で旧完成fileを破壊しない。全量RAM展開でなく
stream/disk stagingを評価する。自動永続cache/別同期基盤は無承認で追加しない。
新sessionはbundle単体からclosureを検証し、元の選択fileなしで再decode可能にする。
古いnative-only作品は原本を一度供給して初回bundleへ移す明示migration。過去hashを書換えない。

## 5. 受入matrixと重要判断

未検証のfixture候補：iPhone実機原本のMOV/H.264 SDR、HEVC8/10bit SDR、HEVC HLG、
確認済みDolby8.4、縦横rotation、CFR/VFR・混在fps、1080p/4K・30/60fps、44.1/48kmono/stereo。
機種/iOS/撮影設定・転送方法・原本hashを記録し、転送時の自動H.264変換を原本と混同しない。
Appleも転送経路で変換が起き得ると説明する。[S4]
特殊profile/スロー撮影/ProRes/空間動画は個別行とし、未検証を全iPhone対応に含めない。

Windows Chrome/Edgeそれぞれで、native HEVCあり/なしの両経路、明示SDR変換、リンクcut、
素材込みsave→元file/cache/権限handleを利用不能にする→空Hostの別sessionへbundleだけを
持ち込む→reopen→再編集→MP4保存→独立全decodeを通す。
bundle破損/欠落/quota/中断/revoke/close競合/migration/旧版closureのfaultも必須。
実iPhone原本・Windows実機がここにはないため、全行NOT RUN。生成fixtureだけで代替認定しない。

親に先に確認する契約は次の3群：

1. **media処理profile**：HEVCローカルWASMの隔離評価、8.4 HLG層からの明示SDR化、
   出力cadence/色/音声renderと具体fixture。Windows以外・未対応profileの正確な表示。
2. **Host資産/保存**：portable ZIP64案、closureとretained versions、file handle権限、
   staging/capture/commit point、失敗・取消の結果。実素材サイズからbudgetを決める。
3. **製品契約/依存**：source解釈と有理audio migration、atomic source+clip、新Host adapter、
   codec/archive追加依存とライセンス。方向承認だけでschema/APIを採用しない。

原本/asset数/総bytes、sample index、VFR最大密度、decoder/encoder frame数、staging/quota、
bundle closure/entry数を独立budgetにする。前案512MiB/10分を本人の要件と称さない。
性能測定・main merge・公開/リリースは引き続き保留。今回の変更は文書のみ。

## 一次資料

- [S1 ffmpeg.wasm概要/ライセンスと制約](https://ffmpegwasm.netlify.app/docs/faq/)
- [S2 Apple Dolby Vision/HDR技術資料](https://developer.apple.com/av-foundation/Incorporating-HDR-video-with-Dolby-Vision-into-your-apps.pdf)
- [S3 File System Access](https://wicg.github.io/file-system-access/)
- [S4 Apple HEVC/転送](https://support.apple.com/en-us/116944)

- [S5 Apple TN3177 alternate audio groups](https://developer.apple.com/documentation/technotes/tn3177-understanding-alternate-audio-track-groups-in-movie-files)
- [S6 Apple Auto FPS/音声/HDR設定](https://support.apple.com/guide/iphone/change-video-recording-settings-iphc1827d32f/ios)
