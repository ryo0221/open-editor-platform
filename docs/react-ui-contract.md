# React UI: public contract

Issue #24 /
ADR010 /
受入台帳。

`@editor-platform/react-ui-core`は登録・構成・依存・プレビュー通信のpure契約とvalidatorを提供する。
W2以降の`exportReactUi` encoder、`@editor-platform/react-ui` Surface、
Host用`@editor-platform/react-ui-preview` renderer、既存`collaboration-adapters`のReact codecを接続する。
構成/encoderはpureのまま、React関数・DOM/network/build/file writingはHost/View側に置く。
公開entrypointだけからimportする。既存7 Surfaceのmodelを変更せず、Host製品のruntimeに依存しない。

## 正確な登録

```ts
import { sealReactComponent } from '@editor-platform/react-ui-core';

const button = sealReactComponent({
  schemaVersion: 1,
  ref: {
    registryId: 'your-ui',
    componentId: 'Button',
    version: '1.0.0',
    implementationHash: verifiedImplementationSha256, // Hostが固定した実装/buildのhash
  },
  name: 'Button',
  import: { source: '@your-app/ui', export: 'named', name: 'Button' },
  props: {
    label: { schema: { type: 'string', maxLength: 80 }, required: true },
    variant: {
      schema: { type: 'enum', values: ['primary', 'secondary'] },
      required: false,
      default: 'secondary',
    },
  },
  events: { onPress: { parameters: [], returns: 'void' } },
  slots: {},
  controlledInputs: [],
  layout: 'className',
  requires: ['ui-package', 'theme-css'],
  sampleProps: { label: 'Sample', variant: 'primary' },
});
```

これは登録例であり、元部品のpropsを自動解析・変換しない。実際の部品に合わせて登録する。
`sealReactComponent`は未公開metadataを所有・deep-freezeし、`contractHash`を計算する。
実装hashは計算しない。元部品の取得/build/版とhashの検証はtrusted Hostの仕事である。
既にhash付きの登録を再sealしない。読み取りは`validateReactComponent`で検査する。
同じID/versionを改変して公開せず、新版を作る。名前/array indexをidentityにしない。

`sealReactEnvironment`/`validateReactEnvironment`は環境metadataも固定する。
依存にはpackageの正確なSemVer、CSS/画像の安全な相対path、Provider importとJSON propsを宣言する。
Providerは`providerOrder`で外側からの適用順を指定する。Provider propsの実コードとの互換性は
Hostのbuild/typecheckで確認し、runtime adapterの診断として返す。
環境hashはtoken/style policy・mode・変数対応も含む。
import sourceはpackage/alias/`./`相対path、namedまたはdefault export。aliasの解決はHostが担う。
HTTP import、上位directoryへのtraversal、任意コードや文字列注入は対応しない。
同じsource/exportが異なる実装hashを指すと出力を止める。複数版を併用するHostは別のimport pathを用意する。

## 値・slot・接続のsubset

| 要素             | 検査する範囲                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| 値               | stringとmaxLength、finite numberと範囲、boolean、string enum、nullable、宣言fieldだけを持つobject、上限付きarray |
| 画像             | `asset`値は環境で宣言したPNG/JPEG/WebPのdependency ID。任意URL/inline HTML/SVGを初期subsetへ入れない             |
| props            | 必須/default、明示値。defaultは公開props/page inputに限り、object内部を再帰的に補完しない                        |
| sample           | 登録のpreview確認用。省略された必須propsを出力時に補うdefaultではない                                            |
| event            | voidと最大8個の型付き引数。function/closure/任意TS型文字列は保存しない                                           |
| slot             | stable slot ID→children/名前付きReactNode prop、許可registry/component ID、minimum/maximum、順序・所有者         |
| controlled input | valueProp/eventProp/正規化argumentIndexの同型。data接続時は対応callback接続も必要                                |
| data binding     | 公開入力と静的object path。中間optional/nullable、array index、任意式・変換は未対応                              |
| callback binding | 公開callback名だけ。部品が発する型がcallbackの受取型にassignableであること                                       |
| semantics        | テキスト/画像/コンテナ/button/linkの実装と意味は明示登録された元部品が持つ。内部DOMを編集nodeにしない            |

Reactのkey/ref、className/style、dangerouslySetInnerHTMLを一般propsへ入れない。
childrenはslot、onClick等はevent契約で宣言する。予約語・prototype名を公開identifierに使わない。
省略/明示defaultとbindingは区別する。同じpropの明示値とbindingは同時に所有できない。
bindingの型検査はfixtureの偶然の値ではなくschemaの全範囲で行う。

## responsive layoutとトークン

登録の`layout`は`none`/`className`/`style`/`wrapper`。
wrapper対応はHostが宣言した場合だけ利用する。W2のencoder/rendererが同じ規則を適用し、W5でpreview/export一致を確認する。
`node.layout.base`と`node.layout.breakpoints`は値の上書きを保持し、
documentの昇順`minWidth`を満たす順にbaseへ適用する。未知breakpointは診断する。

| property                                                                         | subset                                                                               |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| display/flexDirection/alignItems/justifyContent/flexWrap/position                | 公開type/validatorの固定enum。absoluteは明示指定                                     |
| gridTemplateColumns                                                              | 最大12等分の`1fr`列、または`repeat(N, minmax(0, 1fr))`                               |
| gap/padding/margin/width/height/minWidth/maxWidth/fontSize/borderRadius/top/left | dimension token。literal許可時はfinite px数値、px/rem/em/%、property別autoと負値制約 |
| color/backgroundColor                                                            | color token、literal許可時は6/8桁hex                                                 |
| fontFamily/fontWeight                                                            | 対応型のtoken、literal許可時は限定family文字列と1–1000の整数weight                   |

tokenは既存`ReusableDefinition<TokenSet>`のkind=tokens/domain=sharedをexact pinして保持し、
`resolveTokens`で全mode/alias/型を検査する。初期版は自己完結token定義を扱い、外部alias closureは未対応。
CSS変数はHost提供のtoken ID→`--name`対応。modeは必須の明示固定。
`tokens-only`は構造enumと等分gridを除くvisual valueをtokenに制限する。
未知/型違いtoken、未宣言変数、負のsize/gap等を拒否する。任意CSS、calc/url等は初期対象外。
styleと元CSS/Providerの実描画一致はW5の同環境・幅別比較で検証する。

## native保存と決定的出力

#38では任意empty slotのpropをpreview／TSX双方で省略し、map走査順に依存しない
multiline出力を生成器 `react-ui-tsx@2.0.1` として固定する。Native v1と意味のある
順序を維持する。[登録抽出・意味的差分](react-ui-portability.md)と
[#35のimmutable版出力](artifact-output-contract.md)は既存保存／明示採用を再利用する。

```ts
import {
  loadReactUiDocument,
  inspectReactUiDocument,
  serializeReactUiDocument,
  parseReactUiDocument,
  prepareReactUiExport,
  exportReactUi,
} from '@editor-platform/react-ui-core';

const owned = loadReactUiDocument(hostComposition);
const saved = serializeReactUiDocument(owned);
const reloaded = parseReactUiDocument(saved);
const inspection = inspectReactUiDocument(reloaded);
// inspection.documentはsemanticエラーがあってもデータを保持する。
// Hostが実際にexact build/全依存を解決した結果で、計画を準備する。
const plan = prepareReactUiExport(reloaded, trustedHostResolution);
const bundle = exportReactUi(reloaded, trustedHostResolution);
// bundle.files: Screen.tsx/Screen.css/manifest.json/composition.json/README.md の文字列
```

`load`/`parse`はschema・登録/環境のhashを検査し、deep-frozenな所有copyを返す。
unknownなfield/版、functions/accessors/toJSON/hidden properties、cycle、prototype汚染キー、
非finite値、sparse array、上限超過を採用前に拒否する。
getterやserialization hookを読んでから検査することはない。

`inspect`は欠損登録・実装参照の不一致、必須props、slotのcycle/重複所有/個数/許可部品、
binding/fixture/画像、layout、未宣言依存について対象path/code/recovery付きdiagnosticsを返す。
semantic不完全な構成をnative保存することはできる。無言の補完/削除/置換は行わない。
不正schemaでは`document`を返さず、原本と既存draftは呼出元が保持する。

`prepareReactUiExport`は全semantic検査に加えて、trusted Hostの`ReactRuntimeResolution`を確認する。
全retained登録と環境のpackage/CSS/asset/Providerの正確なhashが必要。
自己申告のresolutionをEditorが認証するAPIではない。Hostは実際に取得・buildし、
成功したときだけresolutionを提供する。未解決import/typecheck/Provider例外はadapterから診断する。
エラーでは`ReactUiError.diagnostics`を返し、部分計画を作らない。

成功planには所有composition、決定的fingerprint、imports/依存、出力予定名と
`generated-directory-only`の所有範囲を含む。`exportReactUi`は同じpreflightの後で決定的な
元部品import/公開ScreenProps/Provider/CSS/assets参照を生成する。File writingはHostが担当する。
入力のnode/slot順序、明示値/override、exact参照をnative JSONで保持する。
Artifactのdraft/immutable versions/hash/保存adapterはそのまま再利用する。

上限: JSON 4MiB/100,000値/深さ64、schema深さ16、登録128、依存256、
node 2,000、tree深さ32、各props/slot/callback map 128、breakpoint 8。
これはschemaの拒否条件であり、この規模のbrowser性能合格ではない。

## Host adapterとプレビュー通信

`ReactRegistrationSourceAdapter`はcatalog/manifestから登録候補とsourceRevisionを返す拡張点。
候補は`ReactRegistrationCandidate`（kind/未確認review/proposed/sourceRevision）であり、
確定済み`RegisteredReactComponent`とは別の型。Host/人が確認してproposedを採用する。
`ReactRuntimeAdapter`がexact参照の解決と別origin endpointを提供する。
Hostが担うのは元コード・build・配布・CSP/依存・Provider/theme・保存・実データ/処理。
Editorが担うのは構成、公開command、検証、選択/overlay、履歴/競合、出力。

`validateReactPreviewEndpoint(editorOrigin, endpoint, environmentRef)`は別originと固定buildを検査し、
URLを返すだけでnetwork取得やiframe作成を行わない。
`validateReactPreviewResponse(event, context)`には実際のiframe.contentWindow、
正確なorigin、session/request/revision、modeと構成を渡す。毎messageで送信元・版を検証する。
readyはexact解決、selectionはeditのstable node、callbackはinteractの登録event/引数、
errorは対象付きdiagnostic。受信したcallbackが構成を直接変更することはない。
Surfaceはこれを別origin iframe/error UI/restartへ接続する。ready前はiframe操作を待つ。
起動の`ReactPreviewBootstrap`はsource/originとstrict shapeを確認し、Host Reactが準備できてから
renderを送る。bootstrapはtransportの準備だけで、composition/runtimeのexact attestationは
session/request/revision付きreadyで引き続き必要となる。

`applyReactUiEdits`/`reactUiCommand`は人とHostの同一編集API。
`prepareReactUiRevision`は旧版/新版、明示mapping、現在basisを比較するatomic commandを返す。
既存`prepareEditorTransaction`と`reactUiEditorCodec`でauthority/permission/precondition/
receipt/proposal/selective Undoへ接続する。資源表と競合規則。

`ReactScreenProposal`と`ReactScreenshotAdapter`は外部screen/state ID付き画面案と
viewport/fixture/environment hash付き比較画像の拡張契約。Hostの製品固有IDを解釈しない。
`createReactScreenProposal`は画像/TSXより先にID付き構成JSONを用意する。
serialize/parse/validate関数は構成/opaque ID/版とコード定数`reactScreenProposalWidths`を検査する。
未撮影はscreenshots=[]、画像を付ける場合は全3幅。
`prepareReactScreenProposal`はHost captureを呼び、3幅とfixture/environment hashを確認し、
composition/opaque ID/PNG参照を返す。候補読み取りは`readReactRegistrationCandidates`で行い、
Host/人が承認するまで採用しない。例・画像比較は[導入手順](react-ui-integration.md)とW5記録。

## 例と検証範囲

`tests/fixtures/react-ui/contracts.ts`はpure検証用の合成metadataである。
実物は`apps/react-ui-reference/src/components.tsx` / `components-v2.tsx`と
`catalog.ts`の明示登録・実装hash・環境依存。実コード登録、original import、独立typecheck/build、
入力/callback、幅別比較をW2から
W5まで順番に記録した。
[導入・独立Host・出力組込例](react-ui-integration.md)を参照する。
性能の追加測定・調整は停止中であり、schema上限や少数fixtureの機能成功を性能合格とは扱わない。
