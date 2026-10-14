# React UIの導入・独立Host・出力組込

[公開契約](react-ui-contract.md) / ADR010 /
W1–W5受入台帳。性能調整・追加測定は停止中。

React UIはDesign Editorとは別の画面・データモデルである。Designは図形/テキスト/フレームを
編集してSVG/PNGを出力し、React UIは元React部品のprops/slot/binding/layoutを編集してTSXを出力する。
Artifact保存・版管理・Undo・共同編集・token契約は共通基盤を使う。

## 起動して通常UIで使う

Node 20.20.2、npm、Python 3.10+を使う。初回は`npm ci`と`npm run fonts:fetch`。
別ターミナルで`npm run dev`（Editor:5173）と`npm run react-ui:dev`（Host preview:5174）を起動する。
productionは`npm run build`の後、`npm run preview -- --port 4173 --strictPort`と
`npm run react-ui:preview`（preview:4174）。共有を使う場合は`npm run collaboration:server`（4180）。

Editorの「New React UI」で開始し、Libraryの部品とTarget slotで挿入する。
treeで選択し、Inspectorでprops/variant/画像、binding、layoutを編集する。
treeのdrag/drop、Move up/down/target slot、Duplicate subtree、Delete subtreeは通常commandを使う。
「Export screen proposal JSON」はHostが付けた画面/状態IDと構成を、画像撮影やTSX生成を待たずに書き出す。
Page inputsで入力/コールバックschemaとfixtureを宣言する。controlled inputのdata/eventは組で接続する。
「Product page」「Contact form」「Host tokens」はHostが供給する構成例である。
Edit compositionは選択、Interactは元部品の入力/クリックとHostの一時状態を使う。
preview幅は390/1024/1400px。Save version、History、native JSONは既存Artifact lifecycleを使う。

## 元部品を登録するHost

pureは`@editor-platform/react-ui-core`、通常Viewは`@editor-platform/react-ui`、
別originでのHost rendererは`@editor-platform/react-ui-preview`の公開entrypointを使う。
ReactUiSurfaceへcontent/readOnly/execute/select/runtimeを渡し、既存EditorSessionのcommand経路へ接続する。
元部品関数をEditorのmain frameへ渡さない。

実行できる例は`apps/react-ui-reference`にある。`components.tsx`のCard/Button/Text/Image/Inputと
ThemeProviderを、`catalog.ts`で公開props/events/children・名前付きslot/依存/版/hashに明示登録する。
DOM eventからvalueへの正規化は元HostのInput/Buttonが行う。既存製品の部品を自動改造しない。
`components-v2.tsx`はTextの公開propをtextからcontentへ変更した別版で、元版も保持する。

この例の`@reference/ui`と`@reference/ui-revision`はHostの固定source aliasであり、
公開npm packageではない。実装hashは`reuseHash(sourceText)`（canonical JSON文字列のSHA-256）、
asset hashは`reuseHash(dataURL)`、CSS hashは`reuseHash(cssText)`という明示した表現を使う。
部品契約/環境hashは既存canonical JSONで計算する。利用側は自分の表現と実bytes検証を固定し、
source/build/package/CSS/assets/Providerのexact版をruntime resolutionとして返す。
hashはHost認証やコード安全性の証明ではない。

```ts
import {
  readReactRegistrationCandidates,
  type ReactRegistrationSourceAdapter,
} from '@editor-platform/react-ui-core';

const source: ReactRegistrationSourceAdapter = {
  id: 'host-catalog',
  async readCandidates(signal) {
    const response = await fetch('/approved-registration-candidates.json', { signal });
    if (!response.ok) throw new Error('Candidate catalog unavailable');
    return readReactRegistrationCandidates(await response.json());
  },
};
// JSON: { sourceRevision: 'exact-host-commit', candidates: [registeredMetadata] }
// Host/人が公開props/slot/副作用/依存を確認した後、承認した登録を構成へ保持する。
// 読取り結果はReactRegistrationCandidate（review: unreviewed, proposed: 登録案）。
// Hostが確認してproposedを採用するまで、確定済み登録とは別の型である。
// 読取りだけではcatalog/構成へ採用しない。任意ソースやnpmを実行しない。
```

ReactRuntimeAdapter.resolveは要求されたexact部品・環境・全依存を解決する。
previewEndpointは異なるHTTPS originを返す。loopbackだけ異なるHTTP portを許す。
Hostは専用origin/CSP/配布、Provider順序/props、tokensの固定mode/変数、依存取得を管理する。
起動は型付きhost-ready handshakeを使い、初期about:blankへ構成を送らない。
各render responseはsource/origin/session/request/revisionを検証する。readyはDOM描画後、
例外はdiagnostic、restartはiframeを再作成する。Hostの一時入力状態はdraftへ書き戻さない。
fixtureのasset IDはHostの固定asset mapで解決する。任意URLはasset型へ入れない。

## TSXをフロントエンドへ組み込む

「Export React TSX」は検査後にScreen.tsx/Screen.css/manifest.json/composition.json/README.mdと
Hostが供給する固定CSS/assetsをZIPにする。純粋な`exportReactUi(document, resolution)`は同じ
5ファイルの文字列bundleを返す。package実装は元importのままで、Editor runtimeを含めない。
Hostは生成専用directoryに展開し、manifestのReact/package版、alias、Provider、CSS、asset pathを解決する。
ScreenPropsのdata/callbackをアプリの状態・処理へ渡す。

```tsx
import { useState } from 'react';
import { Screen } from './generated/Screen';

export function ContactPage() {
  const [name, setName] = useState('');
  const [title, setTitle] = useState('Contact us');
  return (
    <Screen
      title={title}
      name={name}
      onNameChange={setName}
      onBuy={() => setTitle(`Thanks ${name || 'visitor'}`)}
    />
  );
}
```

このScreenPropsはContact form例の出力に対応する。型は登録/page inputから生成する。
assetを公開入力にした場合、出力先はその入力へ解決済みURLを渡す。
再exportは生成directoryだけを置換し、上記の手書きアプリ側状態/処理は別ファイルに置く。
手編集TSXの逆取込みは対象外。

再現できる独立出力先は`npm run react-ui:export-host -- form`（product/unbound/revisedも可）。
`scripts/react-ui-export-host.mjs`は固定reference登録から生成し、元UI sourceとCSS/既存画像を
`work/issue-24/export-host/<screen>/`へコピー、React-only Appを作り、strict typecheckとproduction buildを行う。
Editor/preview/history/collaboration packageは出力アプリのdependencyではない。
`node scripts/react-ui-export-server.mjs`で4アプリをbuild後、4175の`/product/`、`/form/`、`/revised/`で操作できる。
これは検証用の固定source driverで、任意uploaded codeをbuildするサービスではない。

## 共有と明示改訂

通常メニューのOpen collaborativelyから既存reference Hostを使う。
`reactUiEditorCodec`と既存`prepareEditorTransaction`/SharedEditorSessionが同じserializable operation、
trusted scope/permission、preconditions、receipt/retry、proposal、selective Undoを扱う。
W4資源表を参照する。独立prop/既存breakpointのpropertyは保持し合う。
同じprop/slot、delete/edit、move/delete、後続依存のUndoは明示競合となる。
Hostは本番の認証/組織/Room/永続authorityを供給する。例のA/Bとin-memory serverは本番保証ではない。

Review component/environment revisionでmetadataと現在値を比較し、prop/slot mappingをPreviewしてAdoptする。
Keep current version、旧版の保持、stable ID/slot順序/binding保持、stale review拒否は公開
`prepareReactUiRevision`のatomic commandで行う。latestへ自動追従しない。

## 画面案と対応条件

`createReactScreenProposal(document, externalReferences)`は画像なしの画面案を返す。
`serializeReactScreenProposal`/`parseReactScreenProposal`/`validateReactScreenProposal`で
外部ID・構成・schemaVersion・固定幅を検査する。`screenshots: []`は未撮影を明示する。
`reactScreenProposalWidths`はreadonly tuple `[390, 1024, 1400]`、撮影幅の型も同じ3値である。
通常UIのJSON exportとHost APIは同じ検査を使い、W3相当の編集/接続段階から利用できる。

Hostの`ReactScreenshotAdapter.capture`を`prepareReactScreenProposal`へ渡すと、同じ構成/fixture/環境の
390/1024/1400pxのPNG参照とhash、opaque namespace/screen/state IDを含むJSONを得る。
Hostが実画像をcaptureし、bytesのSHA-256とfixtureの`reuseHash`、environment.ref.hashを返す。
EditorはIDの業務上の意味を解釈しない。W5のPlaywright adapterは実capture・独立出力比較を行い、
PNG/画面案JSONをtest outputへ保存する。TSXと画面案は別成果である。

機能fixtureはReact/ReactDOM 19.1.1、元5部品とText新版、5 node、深さ2、2 breakpoint、
Provider/独自CSS/既存PNG、product/form/revisedである。Host tokens例も通常UIで検証する。
browserの正確な版と結果はW5記録を参照する。500node/21部品の性能は未測定・保留。

対応は公開契約のJSON値、静的object path、void callback、ReactNode slot、layout subset。
任意アプリ逆変換、部品内部DOM編集、JS式/非voidイベント/非直列化props、SSR/RSC全面対応、
任意npm実行、API/業務処理builderは対象外。必須slotは個数制約を満たすatomic構成で挿入する。
Libraryの単品挿入で満たせない部品は診断され、Hostの完成sample/公開batch commandを使う。
無効native/欠損実装を無言で補完・置換せず保持し、実用exportは止める。

製品固有の部品登録・catalog adapter・実材料試用は利用側で行う。本repoの検証済みcommitと
自分の部品/環境版を固定して取り込む。製品固有の変更は共通実装へ持ち込まない。
生成TSX/CSS/JSON、build、PNG、ログ/trace/raw evidenceはGitへ追加せずwork/、/tmp、CI artifactに置く。
