# Video 取込から実ファイル書出しまで：第一完成範囲の承認案

**最新確定要件：iPhone素材を対象、素材込みproject保存。**
[更新アーキテクチャ](iphone-media-project-architecture.md)を優先。再選択前提を完成仕様にしない。
以下の回答待ち・限定profile記述は先行検討の履歴であり、製品承認ではない。

未承認の隔離評価案。720p/Linux/48k限定を実用完成範囲として承認されたものではない。
[1080p・44.1/48kHz・Windows候補と依存/承認境界の追補](completion-dependency-review.md)を優先する。
本人の素材/端末/保存方式の回答待ち。新しい契約・依存・Host grantは実装していない。
基準 runtime `082c698740cf30f78ec4f9a293e663633ba86f0a`、test/docs
`c466b02dfce4a8f7a882d62739cf4bf71e814faa`。main は
`5a32d355ac107258a604e5a4d7a45d03f3b9efdb`。#149 docs
`4b444ec0be76dad99916b10d2d83d5605e84ee27` と #115 docs
`0a77a8bb56e255a8f56a3939a6f8a26a5758e509` を read-only 照合。
#149/#115 の未レビュー実装を取り込んでいない。

## 推奨する一案

**音声付きローカル MP4/H.264＋AAC-LC 取込 → 既存projectへ原子的追加 → 編集 →
native保存 → reload/missing → 同じ原本を再選択・照合 → MP4/H.264＋AAC-LC書出し →
保存された実ファイルを再decodeして映像・時間・音声を確認。** 最初に映像のみの縦断工程を
通し、次に音声を同じ工程へ追加する。映像のみをユーザーの全目標達成とは報告しない。

| 段階 | 受入範囲                                                                         | 完了と言える条件                                                               |
| ---- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| A    | 音声なし、または利用者が明示選択した映像のみ。MP4/H.264の無音出力                | 取込・編集・native保存再開・原本再接続・実MP4出力・再decodeが全てPASS          |
| B    | H.264＋AAC-LC 48kHz mono/stereo入力、リンク音声編集・再生、MP4/H.264＋AAC-LC出力 | Aに加え、frame/sample境界・priming/tail・channel・切り出し・同期・再接続がPASS |

初回は単一有効visual trackと非重複clip、rate1、単一有効audio trackを対象候補とする。
既存trim/split/move/ripple/linked/Undo/Redoを基盤にするが、v0整数audio境界のままで
通常の29.97fps linked編集が完了したとはしない。後述の有理音声区間案を先にレビューする。
多重映像合成、音声mix/音量/効果、sample-rate変更、非unit rate、Animation合成、字幕、HDR、
VFRは初回profileでは理由付き拒否。既存Coreの表現力を縮小せず、export profileで判定する。

出力はMP4一形式。H.264はbrowser WebCodecs、AACはその環境で通過したnative encoder、
非対応環境では**承認・機能gate済みの固定ローカルWASM AAC**を使用する案。
どちらも不可ならexport開始前に拒否し、WebM/OpusやMOVへ黙って変更しない。
最初のrender設定案は1280×720、H.264 4Mbps、AAC-LC 48kHz/128kbps、fpsはsequenceと同じ。
sourceはaspectを保ち中央fit、余白は黒。sequence fpsやsource PTSを書き換えない。
新規projectのfpsは明示選択し、24/25/30・24000/1001・30000/1001から始める候補。
設定はHost export jobの明示値で、未承認のwidth/heightをnativeへ無断追加しない。

## この案を推奨する根拠と他codecとの比較

現環境で新規に実行した localhost/Chromium151 Linux `isConfigSupported` は、
H.264 encode (avc1.42001f,720p25,4Mbps) true、VP9 encode true、AAC-LC encode false、
AAC-LC decode true、Opus encode/decode true。実ファイルencode/decodeではないため
codec gateのPASSではない。記録 `/tmp/video-completion-codec-capabilities.json`。
WebCodecs仕様は特定codecの実装を必須としていない。[S1]

| 出力案               | 利点                                             | 今回の判断                                                                  |
| -------------------- | ------------------------------------------------ | --------------------------------------------------------------------------- |
| MP4/H.264＋AAC       | 本人が使う配布用動画として一つの工程を完成できる | 推奨。native非対応時の固定WASM AAC評価と別codec gateが必要                  |
| MOV/H.264＋PCM s16le | AAC encoder不要で出力PCM一致を判定しやすい       | 技術的な比較候補。大きい出力・再生互換の制約がありMP4目標の代替完了としない |
| WebM/VP9＋Opus       | browser encode照会は対応                         | #115必須FAIL未解決。安易なfallbackにしない                                  |
| MKV/VP9＋PCM         | Opus/AACを使わない別候補                         | 追加形式を増やし、MP4目標から外れるため選ばない                             |

Mediabunny公式はMP4/H.264/AACとMOV/PCM組合せを説明する。[S2,S3]
AAC extensionはFFmpeg AACのWASM実装であり、native codecとは別の追加依存。[S4]
固定版の隔離評価承認を求め、無承認でインストール/実行しない。FFmpeg CLIは既存の
独立ローカル検証だけに使い、browser製品exportを外部CLI/remote処理で代行しない。

#115はpatched短音声1/17sampleに必須6FAILが残る。FFmpeg再decodeは313/329sample、
Chromiumは1/17sampleで不一致。77PASS/25FAILには原実装の期待FAIL19も含まれるが、
必須6FAILは別でありOpus BLOCKEDを維持する。原AV17PASSも全gate通過ではない。
これはAAC全体がBLOCKEDという証拠ではない。AAC入力・出力のpriming/trailing padding、
edit-list、短入力、非packet倍数、A/V同期を独立gateとし、必須FAILならAAC採用を止める。
Mediabunny1.61.3の未patch MP4経路の評価は、#115 Opus patch採用を意味しない。

## 追加依存・ライセンス・対象環境（評価承認を依頼）

- `mp4box@2.4.1` root公開API：raw CTS/DTS/timebase/edit/sample tableのprobeとdemux。
  #149候補を継承。BSD-3-Clause。[S5]
- `@noble/hashes@2.4.0` 公開sha2 subpath：原本の増分SHA-256。MIT。[S6]
- `mediabunny@1.61.3` 未patch公開API：MP4 muxと出力読取の評価候補。
  MPL-2.0。固定versionのoutput-format/sourceも確認対象。[S7]
- `@mediabunny/aac-encoder@1.61.3`：native AAC非対応時のローカルWASM評価候補。
  registryと固定sourceのMPL-2.0宣言を確認。peerはmediabunny ^1.0.0。FFmpeg組込部分の
  正確なsource/build対応・LGPL等のnotices/再リンク要件は別に調べる。宣言だけで認定しない。[S9]
- browser WebCodecsとWorkerを使用。backend/remote encodeなし。AAC以外のWASM codecは追加しない。

固定tarballのintegrity・公開exports/types・実LICENSE/noticesを取得後に確認する。
後続のread-only tarball検査結果は追補を参照。導入/実行は未実施。
root manifest/lockの変更は具体的承認後に#76へpatch提案する。
MPL対象ファイルの扱い、binary配布時のsource/noticesは配布前の確認事項であり、
root LICENSEを変更しない。OSSライセンスとcodec特許の判断は別。[S8]
この技術案はライセンス免除・製品配布の許可を認定しない。公開/リリースは保留。

最初の受入対象は固定Linux/Chromium151、reference/independent両Hostの1280/390。
Safari/iOS/Firefox・他OS・物理touch・OS IMEはNOT RUNのまま。OS名だけで対応を保証せず、
jobごとの具体的config照会に加え実encode/再decodeの機能gateを通す。
native AAC非対応時だけ承認済みWASM経路を明示選択する。両方不可なら開始前に拒否し、
別codec/remoteサービスへ自動fallbackしない。AAC可否はpriming検証と別である。

## 保存と原子的取込

素材bytesは永続化しない案を推奨。nativeは既存SaveCoordinatorでacknowledged保存し、
reload後は編集内容を保持したmissing状態とする。利用者が同一原本を再選択して初めて
decode/exportを有効にする。filenameだけで繋がず全体SHA-256/size/track/profileを照合。
原本を保管する必要をUIで説明する。復旧不能な旧blob URLや権限をnativeへ保存しない。
OPFS/IndexedDBへの素材保存、素材bundle、新しい同期/履歴基盤は追加しない。

#149の小さいsource interpretation schema/profile＋明示migration案を採用候補とする。
回転、SAR、色の既知/不明、選択track、音声を落とす明示選択、time mapping profileを
保存する。全sample index/packet/FileはHost private。未知fieldをv0へ無断追加しない。
旧nativeを推定profileで上書きせず、既存readerを保持して明示migrationをレビューする。

source＋video clip（Bではaudio clip/linkも）を一つのcommand/transactionで登録する。
probe/hash/codec確認中はprivate候補だけ。commit直前に権限・lease・base revision・Inputs・
track lock・全体profile/capacityを再検査し、失敗/取消なら一部登録も履歴追加もゼロ。
既存assetと同一hashは参照の整合性を確認して再利用し、衝突を黙って上書きしない。
sequence延長が必要なら同じ候補commandの変更として明示し、別の中間commitを作らない。
Undo/Redoはnativeだけ。再接続はrevision/historyを増やさず、Redo後bytesがなければmissing。

現082c actual-media Hostは read/edit grantだけでSaveがない。#76の既存保存adapter・
scope・Save grantへの接続patchが必要。共有Host APIの承認なしに新しい実装を固定しない。
64KiB・4096 nodes・depth24を維持。source/clipだけでなくviewとreceipt付き保存envelopeを
事前検証する。上限超過で削除/切捨て/部分保存に逃げない。

## 時間・画像・音声と暫定resource profile

#149の全CTS走査によるCFR認定、B-frameのDTS/CTS分離、raw tick保存を継承する。
入力fps候補は24/25/30・24000/1001・30000/1001。sourceとsequenceを混同せず、
frame選択はsample表示区間とclip半開区間の交差で行う未承認案。source PTSを要求時刻へ
付け替えない。単一rate1の連続edit＋必要な先頭空白のみ対応候補。
WebCodecsの整数µs化は累積加算せず有理時刻から毎回導出し、丸め規則と誤差上限を
事前にレビューする。container tickと照合できない時刻を暗黙許容しない。
出力末尾がframe途中なら最終frame durationを残区間に制限し、勝手にsequenceを延長しない。

映像は8bit SDR BT.709を初回候補とし、タグ不明は「BT.709として扱う」の利用者選択を
必要とする案。HDRを黙ってSDR扱いしない。rotation0/90/180/270、SAR1:1を対象候補とし、
回転を一度だけrenderへ適用して出力matrixはidentity。非正方SAR/任意matrixは理由付き拒否。
映像のlossy encodeは元画素とのbyte一致を要求しないが、色/四隅/clip識別と許容誤差を
事前固定したfixtureで判定する。未指定色を「色一致検証済み」と称さない。

### 29.97fpsと整数sample境界：v0をそのまま採用できない理由

30000/1001fpsの1frameは48kHzで8008/5=1601.6samples。
現v0のaudio `sampleIn/sampleOut`とsliceは整数sampleを要求するため、通常の1frame
linked trim/splitを拒否する。このままB完了とはできない。暗黙丸め、25fps変換、
音声の黙削除、リンク解除で検査を避けない。

**推奨するdomain設計案（schema/API未固定）:** audio clipの編集区間を有理source時間・
有理sequence時間として保持し、整数sampleはmedia側の格子として分離する。
既存整数v0は厳密に同値な有理区間へ明示migrationする。source sampleCountは整数のまま。
trim/split/rippleはvideo/audio共通の有理cutを1transactionで使い、source時間を丸めない。
これならsplit直後の左右区間は完全に連続し、連続playbackの音声phaseも同じに保てる。

出力audioはグローバル格子 t=n/48000、0<=t<sequence duration で生成する案。
各tからsourceの有理sample座標へ写し、clip境界がsample途中ならsample値生成でphaseを扱う。
同rate・rate1でも移動/trimでfractional phaseが生じ得るため、これはレンダラ上の
fractional-delay処理を必要とする。最初の評価案は線形補間（隣接sample2点、端は片側保持）、
gapは0。これは明示的な信号処理であり「音声無変換/原PCM bit一致」と主張しない。
品質のため別補間が必要か、端点規則、1sample未満の出力格子誤差を本人/レビューで確定する。
PCM phase oracle・split前後の連続性・移動後の位置を先に試験し、決まる前にmodelへ固定しない。

AAC-LC入力は48kHz mono/stereo、rate1、非重複を最初の候補とし、sample-rate変換/mixは別scope。
入力の有効sample範囲とencoder出力のpriming/tailはcontainer metadataを根拠に扱う。
期待波形はこの明示render規則で生成したPCM。AACはlossyなのでbyte一致を要求せず、
位置・channel・sample数・同期と事前固定の波形許容を検証する。失敗後に許容を拡大しない。
AAC packet格子へnative cutをsnapせず、再encodeで任意cutを表す。codec delay/末尾処理を
通過できない場合BはBLOCKED。有理時間を丸めて合格にしない。
新音声scheduler/Host境界とこのschema変更は個別設計レビューが必要。

以下は**承認待ちの防御的機能上限案**で、実測性能保証や既存Core上限ではない。

| 資源            | 最初の提案値/挙動                                                                       |
| --------------- | --------------------------------------------------------------------------------------- |
| 原本            | 512MiB/file、接続project合計1GiB、各素材30分まで                                        |
| video           | coded/displayとも最大1920×1080相当（回転縦1080×1920含む）、最大30fps                    |
| sequence/export | 最大10分、1280×720/sequence fps、output最大512MiB。超過は書出し全体失敗                 |
| sample/index    | 選択全track合計200,000 entries/source、moov最大16MiB、probe構造読取累計64MiB            |
| read/hash       | hashは全L bytesを逐次、chunk1MiB・未完read1。probe予算とhash全量を分離                  |
| decode/encode   | job1、video decoder1/encoder1、application保持VideoFrame最大4、encoded queue最大8       |
| audio           | PCM処理chunk最大4096samples/channel、保持chunk最大4。全PCMを一括保持しない              |
| output          | browser download用buffer最大512MiB。copy分は別に存在し得る。OOM/失効/書込失敗は未完扱い |

frame4枚だけでも1080p RGBA約32MiB相当。これらはdecoder/GPU/browser内部heapの厳密な
上限保証ではない。parser内部保持を固定sourceで監査し、上限前に無制限allocateする場合は
導入gateを止める。worker取消/close/URL解放、job間資源解放を機能faultで検証する。
全量arrayBuffer、全PCMや全decoded frame保持を避ける。CPU時間/速度計測は保留を維持。

## ExportのHost stagingと成功判定（新境界の提案）

MP4 muxは位置付き再書込を行う。`StreamTarget`のdataはarrival順に指定positionへ書き、
単純chunk連結しない。公開docsと固定1.61.3のtarget/outputを確認する。[S10]
`finalize`も`cancel`も下流closeするため、close=成功/公開としてはならない。

最初のHost案は容量制限付きprivate memory staging。StreamTargetのWritableStreamは
位置付きstage writerへだけ接続し、download先/ユーザー原本へ直結しない。position/length/
終端のsafe integer、上限、重複範囲を検証して順次上書きし、awaitでbackpressureを保つ。
closeは「mux writer終了」の印だけで、Blob URL作成・download・成功receiptは行わない。

Host jobを staging→finalizing→ready または aborted として管理する案。正常な
`await output.finalize()`完了と全write/drain成功、構造再読検証、取消flagなし、最新scope/
権限/leaseの再確認が揃ったときだけreadyへ進めて、完成ファイルを利用者へ提供する。
失敗/取消/revokeは先にabortedを不可逆設定し、`output.cancel()`のclose callbackや
遅れて完了したfinalizeがreadyへ戻せないようにする。stagingの破棄・URL解放を必ず行う。
すでにcloseされたwriterへabortを呼べば十分とは考えず、Host job側のabortとdiscardで保証。
出力後に利用者が受け取ったファイルは取り消せないため、提供直前の再検査を境界にする。

native Saveのadapter receiptとexport job結果は別。download開始をdisk耐久保存完了と
表示しない。UIは「書出し準備完了/ダウンロード開始」を区別し、実ファイル保存成功は
試験でbrowser download completion→再open→全decodeまで確認する。外部送信なし。
position上書き、範囲外write、backpressure中取消、cancelがcloseする場合、finalize中revoke、
最後のwrite/close失敗、二重終了、古いjobの遅延完了をfault試験で通す。

## 実際に完了を判定する試験

1. 一般ファイルpickerから既知hash allowlist外のMP4を新規/既存projectへ追加。2素材を
   trim/split/並替/move/ripple/リンク編集し、1commit・Undo/Redo・不変sourceを比較する。
2. 実Saveをacknowledgedまで待ち、保存JSONを再読・hash確認。ページとscopeを破棄して
   missing再開、誤原本は拒否、同じbytes再選択で再開する。元原本hash/sizeは全工程不変。
3. 明示exportから実download bytesを受け取り、fileをclose後に再openする。UI成功表示や
   in-memory buffer生成だけで完了としない。別FFmpegで全decodeし、browserでも再読取する。
4. frame数、container tick/PTS、表示duration、切替/末尾/黒gap、識別パターン、回転四隅を
   期待編集から独立生成したoracleと照合。8秒25fpsなら200frame、終端後の余計なframeなし。
   H.264はlossyのため識別・色許容を事前固定し、再decode画素の単純hash一致で代替しない。
5. Bはchannel別impulse/非packet倍数/非ゼロorigin/短入力1・17・648・960・961・48123sample、
   cut seamと無音gapを含め、FFmpeg/browser双方の期待render PCMとの波形許容・sample数・開始/末尾・A/V対応
   を照合する。duration×sampleRateで架空のsampleCountを作らない。必須一件FAILでB BLOCKED。
6. native保存失敗、容量超過、readonly、dirty/IME、古いrevision、読取失敗、decode/encode失敗、
   flush/finalize中取消/revoke、download中断を注入。成功表示・部分native登録・遅延commitなし。
   編集中exportは開始時のimmutable captureを使い、結果にそのrevision/hashを記録する。
7. 両installed Hostのdesktop/mobile UIで全工程を通し、browser errorsなし・スクリーンショット
   確認。代表の利用者素材は親から指定してもらい、生成fixtureだけで一般素材受入とはしない。

## Touch引継ぎと現在の状態

最新c466b02はruntime082cを変えていない。b3b0802 harness固定paced
（move/end80ms、次tap前300ms、tap hold120ms）では両Hostのoutside→Undo/Redoと
Undo→cancel→Redoの4/4 PASS。結果hash
`0e73116ba48b3ff85ff3ca48d293173d781d3d27703eb457e069817f4aab54b5`。
元unpaced4FAILと未到達tailのNOT RUNを保持する。共通DOMでもclick欠落が再現し、
現時点で修正すべきVideo固有バグの原因は確定していない。synthetic click救済は加えない。
この環境に親の082c kit/consumers/raw結果はないため、今回はdoc/harness照合のみPASS、
新規touch再実行はNOT RUN。旧33件のlegacy E2Eは別の集合であり、この4件と合算しない。

今回PASS：shell/git接続、accepted source/docsと#149/#115照合、公式資料、browser capability
照会、文書のformat/diff/file guard。新規取込/export/音声/永続media実装・単体/型/lint/build/
E2E・実codec encode/decodeはNOT RUN。設計文書だけの変更で既存の実装PASSを流用しない。

## 本人にまとめて確認する判断

本人への判断は次の3点にまとめる。

1. **音声付きMP4の実用範囲**：A→Bの順でMP4/H.264＋AACの全工程を完成する。
   Bは有理音声区間/migrationとfractional-phase renderを具体化してレビューする。
   上記の形式/色/音声/暫定resource上限を第一profile案として評価し、最終仕様を確認する。
2. **browserとcodec不足時の経路**：固定Chromium/Linuxを最初の受入対象とし、native H.264、
   AACはnativeまたは承認済みローカルWASM。四つの固定依存の隔離評価を許可するか。
   native/WASMとも未認定なら明示拒否。別codec/remoteへの自動切替なし。
3. **保存再開方式**：native保存＋原本を利用者が再選択する方式で進めるか。
   素材込み永続保存は別設計とし、今回無断追加しない。

承認は性能測定・mainマージ・配布/リリース・remote処理の許可を含まない。
承認後もsource interpretation/atomic command/音声schema/#76保存・export APIの具体的差分を
レビューし、codec小試験→A→Bの小draft PRに分ける。既存v0の制約を先に黙って変えない。

## 一次資料

- [S1 WebCodecs](https://www.w3.org/TR/webcodecs/)
- [S2 Mediabunny codec/container対応](https://mediabunny.dev/guide/supported-formats-and-codecs)
- [S3 MOV出力](https://mediabunny.dev/guide/output-formats#quicktime-file-format-mov)
- [S4 AAC extension](https://mediabunny.dev/guide/extensions/aac-encoder)
- [S5 MP4Box2.4.1 LICENSE](https://raw.githubusercontent.com/gpac/mp4box.js/v2.4.1/LICENSE)
- [S6 noble2.4.0 LICENSE](https://raw.githubusercontent.com/paulmillr/noble-hashes/2.4.0/LICENSE)
- [S7 Mediabunny1.61.3 LICENSE](https://raw.githubusercontent.com/Vanilagy/mediabunny/v1.61.3/LICENSE) / [固定output-format](https://raw.githubusercontent.com/Vanilagy/mediabunny/v1.61.3/src/output-format.ts)
- [S8 FFmpeg license/legal](https://ffmpeg.org/legal.html)

- [S9 AAC1.61.3固定README/build](https://raw.githubusercontent.com/Vanilagy/mediabunny/v1.61.3/packages/aac-encoder/README.md) / [固定manifest](https://registry.npmjs.org/@mediabunny/aac-encoder/1.61.3)

- [S10 書出しtarget仕様](https://mediabunny.dev/guide/writing-media-files#streamtarget) / [1.61.3 target](https://raw.githubusercontent.com/Vanilagy/mediabunny/v1.61.3/src/target.ts) / [1.61.3 output](https://raw.githubusercontent.com/Vanilagy/mediabunny/v1.61.3/src/output.ts)
