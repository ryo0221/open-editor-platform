# 長編Document・DesignページのHost契約

既存Document/Designのlocal編集・確定版からの派生出力を組み合わせる契約です。[設計](novel-comic-design.md)と[検証記録](verification/novel-comic/README.md)を併用してください。Story、人物設定、承認、AI実行、章の進捗、ライセンス判断はHostが所有します。

## 長編Document

章ごとのArtifactを推奨します。Hostの章順はArtifact IDの配列にし、並べ替えで本文やversionを更新しません。シーンを別Artifactにするか、章内の複数paragraphをシーンとみなすかもHostが決めます。単一Documentも可能ですが、chapter/scene専用entityはありません。

既存 `@editor-platform/document/text` の `documentText` / `findDocumentText` / `locateDocumentText` は安定segment IDとUTF-16範囲を返します。`documentTextEditCommand` は期待する元テキストを検証してnative text engineの変更を作ります。`DocumentSurface.focusAddress` と `ArtifactEditor.select` に同じElementAddressを渡して移動・選択通知を接続します。annotationは既存 `resolveDocumentAddress` のCurrent/Outdated/Orphanを扱い、削除済みsceneのIDを別sceneへ付け替えません。

```ts
import { documentTextEditCommand, findDocumentText } from '@editor-platform/document/text';

host.flushInputs();
const content = host.content;
const edit = { ...findDocumentText(content, '夜の場面'), text: '夕暮れの場面' };
host.propose({
  id: proposalId,
  summary: '場面を改稿',
  baseLocalRevision: host.revision,
  commands: [documentTextEditCommand(content, [edit])],
});
// documentProposalDiffでpreviewを表示してから、人の操作で採用または拒否。
host.acceptProposal(proposalId);
```

`ArtifactEditor` のpropose/accept/rejectはlocal target revisionとpermissionを検査します。外部Artifactを読んだ提案は、既存 `previewHostProposal` / `applyHostProposal` と `checkProposalReads` にexact reference versionsを渡す経路を使ってください。local pending proposalだけでは外部参照の鮮度を保証しません。共有操作は既存Documentのauthority/text preparation subsetに限定します。

### 章横断の派生出力

`@editor-platform/document/sequence` の `composeDocumentSequence([{ artifact, versionId }, ...])` に確定版を順に渡します。全入力をawait前に所有し、kind/native content/version所属/hashを検証。失敗は `ok: false` とdiagnosticsを返し、部分的な `content` は返しません。成功時はreadonlyな `{ content, manifest }` を返します。正本として自動保存しません。

初期subsetはparagraph/heading、rich marks、既存text style、hidden、align/indentです。表/画像/HTML/未知field/reuseは拒否。最大128出典、合計2000ブロック/100万UTF-16単位。出力IDは `sequence:<出典index>:<元ID>`。manifestには各出典のArtifact/version/hash/順序とID対応、page設定差、annotation等の未収録を記録します。

DOCXはこのcontentを既存 `captureDocumentExportSnapshot` → `prepareDocumentDocx` → 人によるreport確認 → `encodeDocumentDocx` に渡します。章manifestとDOCXのloss reportを両方保持してください。初期版は章の内容を連続結合し、改ページを強制しません。EPUBは下記N2aの水平subset。日本語縦書き、ルビ、完成小説の出版組版は未実装です。PDFは既存Documentの経路を使い、別のPDF text engineを作りません。

### N2a: 水平EPUB 3

`@editor-platform/document-export/epub` は、同じ確定章の配列からopaqueなplanをprepareします。metadataはHost所有の必須title/language/identifier/creators/modifiedで、creatorsは空配列も可能。modifiedはUTC秒精度、languageは有効なBCP 47 tagを指定します。入力をawait前に所有し、章ごとの所属/version/hashを検証します。

```ts
import { prepareDocumentEpub, encodeDocumentEpub } from '@editor-platform/document-export/epub';

host.flushInputs();
const plan = await prepareDocumentEpub(
  savedChapters,
  {
    title: '三章の物語',
    language: 'ja',
    identifier: 'urn:uuid:09c104c5-1214-49ad-8110-b07b54247802',
    creators: [],
    modified: '2026-10-26T00:00:00Z',
  },
  signal,
);
// reportを表示し、人が同意したwarning IDだけを渡す。errorは同意で解除できない。
const result = await encodeDocumentEpub(
  plan,
  {
    planHash: plan.report.planHash,
    acceptedDiagnosticIds: acceptedWarningIds,
  },
  signal,
);
```

reportはexact出典・順序・hash、元ID→派生ID→XHTML ID、metadata、exporterVersion、planHash、差異diagnosticsを保持します。basisは結合contentのlocal-draftであり、新規saved Artifact/versionを表しません。EPUB内の `sources.json` と `export-report.json` に同じ情報を収録します。章名とnavigation labelはArtifact.nameです。

対象はparagraph/heading、inline書式、既存block style、align/indent。hiddenは警告付きでreading contentから除外します。link/画像/表/HTML/reuse/未知field/ruby/縦書きは全体を拒否。fontを埋め込まず、page設定・readerによる改行/書体/固定ページの差は同意が必要な警告です。最大128出典・2000blocks・100万UTF-16単位、無圧縮entry合計16MiB、creator最大16名。metadataはXML-safeな有界文字列です。上限はperformance保証ではありません。

prepareのAbortSignalは例外、encodeの中止は `status: 'cancelled'`。encodeはok/blocked/cancelled/failedを返し、失敗時に部分bytesを返しません。planは同じprocessでprepareしたものだけ使用できます。同期ZIP中の即時割り込みは保証しません。Hostはencode前とdownload前にも現在のinput/IME guardを確認し、拒否時はcaptured planと同意を保持します。saved version/章順の変更ではpreviewをstaleにし、再prepareと同意を求めます。原稿・Undo・versionは変更しません。[段階設計](document-publishing-design.md)・[検証](verification/document-epub/README.md)を参照。

## Designページ

新しいComic kindはありません。`DesignContent.pagination` は次の任意metadataです。

```ts
{
  schemaVersion: 1,
  direction: 'rtl', // またはltr。自動空間ソートではない
  pages: [{ frameId: 'page-1', panelIds: ['panel-1-2', 'panel-1-1'] }],
  images: [{ elementId: 'image-1', source: 'Host-owned asset identity', license: 'Host-supplied license' }],
}
```

ページはroot frame、コマはその直属frameです。page/panel IDはnative element IDそのもの。pages/panelIdsの順序は通読順で、native elementsのz-orderと別です。画像出典は文字列データであり、URLの自動取得やライセンス判断は行いません。各ページ最大64コマ、最大128ページ、画像metadata最大8192件。

`@editor-platform/design/pagination` のpublic API:

| API                                            | 意味                                                        |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `insertDesignPage(bounds, id?)`                | frameと順序metadataを一つのcommandで追加。elementIdを返す   |
| `insertDesignPanel(pageId, bounds, id?)`       | ページ直属frameとpanelIdsをatomicに追加                     |
| `setDesignPagination(value)`                   | stable IDsを検証して読み順/方向/出典を更新                  |
| `designPageEditCommand(edits)`                 | JSON dataのM0 proposal adapter。bounds/text/image以外は拒否 |
| `captureDesignPages(artifact, exactVersionId)` | 確定版から通読順のSVGページと出典/差異manifestを取得        |

`designPageEditCommand` の各要素は `{ type, id, value }`。`bounds`はnative pxの `{ x, y, width, height }`（子要素もnative transformで移動/resize）、`text`はplain horizontal dialogue、`image`は `{ src, source, license }` です。Formatted text（共有styleから継承したrunsも含む）は既存native text preparationを使い、この狭いadapterでは拒否します。batchは最大100変更。途中で不正な対象があれば全部拒否。semantic表示には `@editor-platform/design/page-proposal-diff` の `designPageProposalDiff` を使い、fallbackがある提案をM0 Hostが採用しないでください。

通常DesignSurfaceにPages panelがあります。ページ/コマ作成、選択、読み順変更、方向、台詞追加を行います。移動/リサイズ/台詞編集/画像は既存canvas/Inspectorを使います。削除はnative `deleteElements` が同じtransactionでmetadataも除去。Undoは同じIDを復元し、新規作成は新IDにします。ページ移動後に別の古いIDを再利用しません。通常Duplicateはページ/コマを元の読み順の直後へ登録し、画像のsource/licenseも新しいelement IDへatomicに複製します。pagination付きDesignの要素copy/cut/pasteはmetadata付きclipboard未対応として変更前に拒否します（native text engine内の文字列clipboardとは別です）。

local/native validatorは既存 `isDesignWithPaths`。legacy `isDesign` はpaginationを拒否するため、未対応shared/template/reuse/React adapterへ渡すと失敗します。public `designIntentCommand` もpaginationには非対応です。新規M0 adapterはlocalのArtifactEditor経路のみ。Hostは未対応経路を有効化しません。

### M1a: localベクター線画・吹き出し

`@editor-platform/design/page-artwork` の `insertDesignPagePath(panelId, 'line' | 'cubic', bounds)` と `insertDesignSpeechBalloon(panelId, bounds, text)` をPages panelから利用できます。登録済みコマへ、既存schema3のnative path、またはgroup/path/textを一つのtransactionで追加します。返る `elementId`（吹き出しではpathId/textIdも）は生成後固定。既存の点編集・native text engine・Undo/Redoで編集し、旧確定版を変更せず保存します。

吹き出しの尻尾は既存line/cubic segmentであり専用contentを増やしません。文字数は最大2万UTF-16単位、pathの上限は既存schema3のもの。入力boundsは所有してからnative commandへ渡し、missing/deleted/locked/hidden panel、readOnly、不正値では部分変更を残しません。path proposal/shared/template/reuse/React変換、Raster brush、縦書き/ルビは非対応です。[設計](design-page-artwork.md)・[検証](verification/design-page-artwork/README.md)を参照。

### 通読・PNG/PDF

captureはhash/所属/全native contentを検証。frameの固定viewBoxへnative drawingを投影します。elements outside declared pagesとhiddenは警告、画像の不足や外部参照/rotation/componentはerrorで全出力を止めます。defaultのM0 captureでは構造path/legacy vectorも拒否します。`captureDesignPages(artifact, versionId, { mode: 'vector' })` を明示すると、native pathと既存provenance付きvectorを描画し、manifestのcapability/artworkとnative paint boundsによるcrop診断を返します。共有styleを適用した実効appearanceのtypography/runs/rotationも同じ対応範囲で検査します。通常Inspectorやnative commandで画像sourceを変えると、旧source/licenseを同じ変更で除去し、Hostが再登録するまでcaptureを拒否します。`designPageEditCommand` のimage変更では新しいsource/licenseを同じtransactionで登録できます。画像は埋め込みPNG/JPEG/WebPとsource/license metadataが必要です。最大4096px/辺・合計6400万pixelのcapture境界を設けます。これは速度・メモリ保証ではありません。

Hostは返されたpagesをpublic `canvas-ui` の `exportPages(pages, 'png' | 'pdf', 1, name, JSON.stringify(manifest))` に渡せます。PNG ZIPにはreferences.json、PDFには同manifest attachmentが入ります。PDFはrasterであり文字選択・再編集は保証しません。native正本と選択・annotation/historyを置き換えません。吹き出しは既存ellipse等とhorizontal textを組み合わせます。M0のcaptureでは尻尾付きpathを拒否し、M1aのvector opt-inでのみ出力します。ルビ、縦書き、Raster brush/筆圧/トーン、PSD互換は未対応です。

## 参照Host・入力・保存

`npm run build` の後、`npx vite preview --config vite.artifact-host.config.ts` で `/authoring.html` を開けます。3章×2シーン、4ページ×2コマをpublic packageだけで構成します。初期版を確定し、native edits、proposal、章順、save/reload、通読、DOCX/水平EPUB/PNG/PDFを操作できます。localStorageは参照実装で、productionのdurability/authenticationを保証しません。

選択/annotation/historyは既存SessionとSurfaceを使います。保存・切替・proposal採用・capture前にinputsをflushまたはIME中は拒否。保存失敗は未保存状態と原稿を保持しretryできます。参照Hostの「Hold composition」は障害注入であり、OSのnative IME実機検証ではありません。確定版出力のpreviewはdirty draftを含まず、更新にはsave→recaptureが必要です。
