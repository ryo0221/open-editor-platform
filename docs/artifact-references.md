# 参照付き埋め込み

Dataの表／chartとGraphを、Document・Slide・Design・Whiteboardへ配置するpublic API。
作成時に**固定版**と**更新連動**を選ぶ。既存の画像・ChartSnapshotは固定のコピーのまま。
設計は[設計書](artifact-reference-design.md)、実施結果は[検証報告](verification/issue-264/README.md)。

## 通常の操作

1. 元のData／Graphを「Save version」で保存する。draftの自動保存だけでは更新対象にならない。
2. 埋め込み先の「参照を埋め込む」→「参照元を再取得」で保存済みArtifact／viewを選ぶ。
3. 「固定版」または「更新連動（保存済みの変更）」を選んで配置する。
4. Inspectorの「元を編集」で移動し、変更をversionとして保存する。
   「埋め込み先に戻る」で元のelementへ復帰する。連動版の表示だけが更新される。

配置の取得待機中は参照元・更新方式・再取得を無効にし、先に開始した発見の遅延結果も破棄する。
Documentへ戻る際はimage blockを選択し、その位置までスクロールする。選択・復帰はnative contentを
変更しない。独立Hostでは元の編集が終わるまで埋め込み先の種類を切り替えられない。

Slide・Design・Whiteboardでは位置、サイズ、image fitを、Documentでは幅／captionを編集する。
Documentの画像はeditor・HTML・PDF・印刷とも元の縦横比を保つ。高さを固定したcropには未対応で、
contain／coverの切替controlは表示しない。既存nativeのfit metadataは互換性のため保持するが、
Documentのcrop表示を意味しない。値やnodeの
第二の編集正本は作らない。Inspectorから再取得、参照先変更、mode変更、現在版の固定、
画像への参照解除ができる。これらの変更は埋め込み先だけの通常command／text transaction。
外部sourceの更新表示はlocal Undoへ入らない。2 ArtifactをまとめたUndoではない。
Slide／Design／Whiteboardの「Replace image」は参照を解除して画像を置換する一つのcommand。
Undoすると参照と元画像が一緒に戻る。読み取り専用のdestinationでも、Hostが許可するsourceへの
移動・再取得・発見は利用でき、配置・参照変更・固定・解除は無効のままとする。

## Public packages

| Package／entrypoint                          | 担当                                                   |
| -------------------------------------------- | ------------------------------------------------------ |
| `@editor-platform/artifact-references`       | envelope、validator、resolver、exact capture、manifest |
| `@editor-platform/artifact-references/react` | 作成／Inspector、購読、描画用projection                |
| `@editor-platform/reference-adapters`        | `dataReferenceAdapter`、`graphReferenceAdapter`        |
| 各domainの既存entrypoint                     | image object／block／nodeにoptional `reference`を保持  |

coreはData・Graph・埋め込み先のcontent modelをimportしない。domain adapterはpublicな
native関数を使い、共通の永続node modelを作らない。Dataは`viewRows`、`displayCell`、
`chartSvg`を使うため、named viewのfilter／sort／formula／series／aggregateを引き継ぐ。
`viewId: 'default'`はnative default viewを意味する。Graphは保存されたProfileとlayoutを保持し、
Profileのlabel fieldとnative edge routingを使う。

```ts
import { ReferenceResolver } from '@editor-platform/artifact-references';
import { nativeReferenceAdapters } from '@editor-platform/reference-adapters';
import { insertObject } from '@editor-platform/slide/model';

const references = new ReferenceResolver(host, nativeReferenceAdapters, deckArtifactId);
const ref = await references.create(
  {
    artifactId: dataArtifactId,
    domain: 'data',
    target: { kind: 'table', viewId: savedViewId, columnIds: ['name', 'hours'] },
  },
  'follow',
); // 'fixed'も明示して選べる

execute(
  insertObject(pageId, 'image', {
    reference: ref,
    src: references.project(ref.snapshot, ref.source.target).src,
    imageFit: 'fit',
  }),
);
// <SlideSurface references={references} ... />
```

Documentでは`makeBlock('image')`と既存text transaction、Design／Whiteboardでは既存の
image挿入commandへ同じmetadataを渡す。描画srcは再生成可能なcache。native sourceと
exact pinを省略した画像コピーは参照付き埋め込みではない。`columnIds`／`rowIds`／`nodeIds`
はpublic APIで表示範囲を絞るための安定ID。通常UIの初期選択は保存済みview全体。
targetのview／row／column／node IDはnativeの文字列として検証し、`constructor`、`prototype`、
`__proto__`という名前だけで拒否しない。空・512文字超・重複・非文字列のIDは拒否する。
参照作成のawait後はscope・選択identity・権限・未確定入力を確認し、最新renderのinsert callbackを
呼ぶ。Hostが配置位置を計算する場合、待機中に受け取った配置文脈をそのcallbackで使える。

## Host契約

`ReferenceHost`の実装はHostが所有する。

- `list()`は閲覧可能な保存済みArtifact／viewを返す。
- `read(source, signal)`は**確定したimmutable versionだけ**を返す。単調増加の正整数revision、
  version ID、canonical SHA-256、native content、必要依存を含める。draft、未採用proposal、
  承認待ちcandidateを返さない。取得時に権限を検証し、abort signalを扱う。
- `checkAccess(source)`は固定版の閲覧にも現在の権限を適用するHost向け。認証のないlocal
  Hostでは省略可能。取得の前後でも確認する。権限更新時も通知する。
- `subscribe(notify)`は保存成功と削除／権限／接続の変化を通知し、unsubscribeを返す。
  保存失敗時には変更を公開しない。resolverは古い応答、同revisionの矛盾、逆行を拒否する。
  独立reference Hostは呼出し時のsource contentを保持して保存を直列化する。hash待機中の
  次の保存へ同じrevisionを割り当てず、永続化に失敗した版は公開せず次の保存を続行する。
- `open(source, destinationElementId, destinationPageId?)`は入力flush後のsource navigationと、
  Artifact＋element IDの復帰点を保持する。Slideはpage内でIDが一意のため、第三引数のpage IDも
  保持し、復帰時の`ElementAddress.pageId`へ戻す。既存の二引数Hostは引き続き接続できる。
  移動を拒否したときは元の画面へ留まる。
  現在の閲覧権限もHostの移動境界で確認し、権限失効中に元のeditorを開かない。
  独立Hostは失効した編集中sourceも隠し、source commandと保存queueの開始・永続化直前でも
  現在権限を検証する。hash待機中に失効した版を保存・公開しない。これは参照Hostのpolicy実装で、
  Platformへ認証や組織RBACを追加するものではない。

Graphの依存は`id: profile:<profile-id>:<version>`、`contentHash`、native Profile content。
依存はそのProfile一件だけとし、無関係な依存を保持・出力しない。
同じresolverのsource domain内で同じ依存IDは、Graphのrevision／version IDやArtifactが
変わっても同じhashを保つ。Profileを変更する場合は新しいProfile versionと依存IDを使う。
Profile欠落、版不一致、hash改竄は描画前に拒否する。新domainのadapterはtrusted codeとして
注入する。任意の未検証HTML／SVG／JSをadapterへ変換して実行してはいけない。

`ReferenceError.status`は`missing-source`、`missing-target`、`forbidden`、`offline`、`stale`、
`unsupported`、`error`を区別する。offlineだけは保持snapshotを警告付きで表示できる。
権限失効では保持描画も隠す。取得できない状態を成功扱いにしてexportしない。
権限再確認の開始時に以前のprojectionを隠し、非同期の確認中も画像を表示しない。
offlineが確認された場合だけ、検証済みの保持snapshotから警告付きの描画を復元する。

## 保存・出力・旧版

保存／出力前にEditorInputsをflushし、`resolver.capture(items)`を**一度**呼ぶ。保存では全page、
範囲を指定した静的出力では実際に描画するpage／elementだけを渡す。非表示elementと範囲外の
参照をcaptureやmanifestへ含めない。同じsourceの複数viewには一回のreadで得た同一版を使う。
返ったitemsで保存用の別contentを組み立てる。capture中の入力／destination変更は採用を拒否する。
source更新だけでdraftを書き換えたり、Undo履歴へcaptureを挿入したりしない。
capture完了時にもdirtyとcomposingの両方を確認する。値変更のないIME変換開始でも、
保存・native JSON出力を拒否し、変換確定後の再実行を案内する。
Surfaceから参照付きのSVG／PNG／PDF／HTML／Markdown／印刷previewを出力するには、
`references`の接続が必要。未接続では保持srcやmanifestを未検証のまま出力せず診断を返す。
参照のない出力は従来どおりresolverなしで利用できる。
DocumentのHTML／PDF／印刷はhidden blockをcapture／manifestから除外し、取得したblockを
元の位置へ戻して出力用contentを作る。Markdownは既存のhidden blockを含む出力仕様を維持する。
SurfaceとHostのHTML出力は公開`captureDocumentReferences(content, resolver)`を共用する。
Markdownでは第三引数を`true`にする。保存・native JSONのcaptureは全contentを検証する。
Slide／Design／Whiteboardはpaint orderで導出した親Groupのhiddenも出力範囲へ適用し、
描画されない子のsourceを取得・manifest化しない。Slideのcapture結果はpage内の元位置へ戻す。

過去版の表示／出力とnative import検証には`capture(items, false)`を使い、保持版と依存のhashを
確認する。`forDestination(id)`でimport先／別Artifactの検証scopeを作る。immutableな既存versionは
変更しない。native JSONは閉包とhashを保持し、参照sourceがない環境でも固定版を検証できる。
保持閉包は各参照を個別に検証し、同じsource／revisionでversion ID、content hash、依存閉包が
矛盾する場合は拒否する。古い固定版を表示することはlive版の逆行とは扱わない。
同じsource／version IDについてもrevisionとcontent／依存hashを照合し、revisionを変えた
version IDの再利用を拒否する。矛盾した応答は正当な新versionのrevision枠を消費しない。
Hostのimport／保存データの再読込はArtifactごとに一つのdestination resolverを作り、
同じscopeでdraftと全immutable versionを検証する。version単位でidentity記録をリセットしない。
live取得では閉包の検証後に権限・refresh世代・保持版とwatermarkの逆行を確認し、受理した
revision／version ID／依存IDだけを一度に記録する。拒否・権限失効・破棄した遅延応答が
正当な過去の固定版を矛盾扱いにしない。公開`validate`と履歴captureは保持版として検証・記録し、
live watermarkを進めない。
fresh resolverのfollow解決でも保持閉包を検証し、権限・世代・逆行の検査後、live応答より先に
その保持identityを記録して照合する。同じrevision／version ID／依存IDの矛盾を、初回取得でも
受理しない。保持版を記録するだけではlive watermarkを進めない。
native Artifact importは、IDを新規発行しても参照元IDを書き換えないため、export時の元Artifact IDで
draftと全versionの自己参照を検証する。拒否時は既存Artifactや保存履歴を変更しない。
native contentのoptionalなundefined object fieldはcanonical hashと同じ省略規則で扱う。
配列内のundefined・欠損index（疎な配列）、accessor、非JSON値は拒否する。
native JSONのown property名は参照IDの制約と区別し、Dataの`constructor`等も保持する。
runtime keyにはrevisionと依存ID／hashも含め、異なる保持identityを購読時に同一視しない。
keyには宣言hashだけでなく保持snapshotと依存の実データも含める。propsから閉包が差し替わると
以前のready描画を使わず、固定版・更新連動とも保持閉包のhashを検証する。live captureでも
保持閉包を検証し、正常なsource応答で不正な保持データを無言で置き換えない。
再帰参照の検出はschemaVersion／mode／fit／source／snapshotを持つ完全なenvelopeで判定する。
`reference: { source, snapshot }`等の通常のGraph属性は保持し、実際の再帰参照は拒否する。

Slideは非active pageのthumbnail／presentationも購読し、Design prototypeにも描画用の解決結果を
渡す。HostがDocumentのresolverを差し替えたときは既存node viewの購読を切り替え、text engineと
Undoは維持する。3 canvasの静的描画のfitは`reference.fit`から取得し、参照解除時にnative画像へ引き継ぐ。
3 canvasの通常Image fit controlもdomain property commandで`reference.fit`とnative `imageFit`を同時更新する。
複数選択でも各source／modeを保つ。出力captureの待機中にresolverが切り替わった場合は結果を
採用せず再実行を案内する。Documentの印刷previewも同じ境界を守る。
SVG画像は埋め込み先のviewport内でもfit／fillが効くよう、描画用URIのroot aspect ratioを合わせる。
nativeに保持したSVG bytesは変更せず、Canvasと静的出力で同じ描画処理を使う。
Slideのobject IDはpage内のscopeで扱い、page間で同じIDがあっても描画とcaptureを混同しない。
source navigationからの復帰もpage IDとobject IDで指定する。明示したpageが見つからない場合に
別pageの同名objectへ復帰しない。
Slide／WhiteboardのCanvasはpaint orderが導出した親Groupのhidden等を保持し、
runtime projectionからはsrcだけを重ねる。非表示の子は描画・hit targetへ戻さない。
resolver差替え時は発見済みのsource名・選択を破棄し、以前のscopeの遅延list結果を採用しない。

| 形式                     | 対応                                                       |
| ------------------------ | ---------------------------------------------------------- |
| Native JSON              | 参照・mode・fit・exact native snapshot・依存を保持         |
| SVG／PNG                 | capture済みの静的描画＋`references.json`をZIPへ保持        |
| PDF                      | capture済み静的描画、exact source manifestを添付           |
| Document HTML            | capture済み画像、`artifact-references` metaに版情報        |
| Document Markdown        | capture済み画像。参照編集にはnative JSONを併用             |
| PPTX／DOCX／Design→React | 初期対応は拒否。参照を明示的に解除してから既存exportを使う |

既存native schemaへの加算的metadataであり、旧snapshotを移行しない。旧readerはimage srcを
固定画像として表示できるが、参照更新はできない。生成srcだけの互換readerをlive対応とは呼ばない。

## 対応範囲と上限

localの4 Surfaceとheadless/proposal経路に対応する。**共有参照編集は未対応**で、trusted codecが
参照付きcontentとoperationを拒否する。既存の非参照Artifactの共有編集は変わらない。
Template／linked reuseでの新規参照authoring、任意domainの再帰参照、双方向同期、
distributed transactionはこのsliceの宣言能力に含めない。
Template／linked reuse authoringは選択範囲を確定してから参照を検出して拒否する。
参照のない別範囲は保存できる。参照を解除した通常画像は既存のauthoring対象となる。
Design component内の参照（template／elements／instance overrideを含む）はnative検証でも拒否する。
この検出は埋め込みmetadataを対象とし、`webProps.reference`等の通常のJSONデータを禁止しない。

1 capture／Surfaceは64参照、native sourceは2 MiB、保持閉包は4 MiB、参照の深さは1。
tableは100 records×30列、Graphは100 nodes／300 edges。超過は切り捨てず、表示範囲を絞るよう
案内する。通常Data／Graph自体の編集上限を、この埋め込み上限へ縮めるものではない。
4 Surfaceは追加・複製・貼り付け・参照変更の結果全体を確定前に検証し、超過時はnative contentと
Undoを変更しない。DocumentはProseMirror stateの採用前にも検証する。Host独自のheadless
commandでもnative validatorまたは`assertReferenceItems`を確定前に呼ぶ。
Playgroundのlocal command／proposal適用は、変更前のdomainからnative validatorを選び、参照envelopeの
検出結果によらず出力を検証する。不正なschemaVersion／fit等を参照なしとして通さず、拒否時には
native content・revision・Undo／Redoを変更しない。IndexedDB再読込もdraftとすべての保存versionを
native検証してから参照履歴を走査する。不正recordは読込エラーとし、保持recordのexportと別Artifactの
操作を利用できる。読込時に不正なimmutable versionを修復・上書きしない。
`reference`はoptionalなown data propertyとし、prototypeから継承した参照とaccessorをaggregate検証で
拒否する。継承値を参照なしと見なして64件／合計容量の検査を省略しない。
Data参照元の保存view IDは一意で、synthetic view用の`default`と衝突しないことを要する。
不明確なsourceは診断付きで拒否し、既存Data本体や保存済みversionを変更しない。

`/reference-host.html`はPlayground state／CSSを使わず、public packagesだけで4 destinationと
source編集・保存・提案・接続失敗を検証する独立Host。production buildにも含まれる。
Claude等の拡張Hostはこのportへの接続が別途必要で、本体の追加によってMCP tool定義が
自動的に更新されるわけではない。自動CI停止とperformance測定保留は維持する。
独立Hostの非同期保存／JSON出力は開始時のkind・resolver・履歴配列を保持し、接続や
埋め込み先が切り替われば完了を拒否する。別domainの履歴を混ぜて保存・出力しない。
