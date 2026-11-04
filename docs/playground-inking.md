# Playgroundで線画を描き、人とAIで同じ原稿を編集する

通常のPlaygroundのローカルDesignで、一定幅ペン、native pathの点編集、作画提案の確認・採用を使う。別の漫画専用Editorや保存領域は作らない。原稿・履歴・保存版はPlaygroundの既存のものを使う。

## 起動と原稿の準備

```sh
npm run dev
```

`http://localhost:5173/`を開く。新しく描く場合はLibraryのArtifact typeをDesignにしてNew artifactを選ぶ。既存の原稿はLibraryのImport artifactからnative JSONを読み込む。モバイルではToggle libraryからLibraryを開く。

native JSONはImport artifactで読み込める。全保存版のdomainとcontent hashを既存のimport境界で検証し、新しいartifact IDのコピーとして追加する。元の原稿を上書きしない。描線IDと各版のcontentは保持し、versionのartifact IDだけを新しいscopeへ移す。Playgroundの既存上限は1ファイル16MB。

生成した原稿・画像・動画はGit外に保持する。コードに完成原稿を埋め込むことや、開くたびに原稿を再生成することはしない。

## 描く・直す・保存する

1. 白紙から始める場合は「白紙の作画ページを用意」でページとコマを作る。Designの上の「描くレイヤー」で、表示中のframe/groupを選ぶ。非表示のネームやロックした資料を含む層は候補から外す。
2. `Draw ink stroke`を選び、キャンバスに線を引く。狭い画面では`More editor tools`の中にある。1ストロークが1つのnative pathとUndoになる。
3. `Finish drawing strokes`で入力を終える。Escapeは描きかけを取り消す。
4. Navigatorで線を選び、Inspectorの`Edit path points`で同じ線の点・曲線ハンドルを修正する。色と線幅も通常のInspectorで変更できる。線全体の削除は点編集を終えてcanvasでDelete。
5. Playground上部のUndo/RedoとSave versionを使う。Export artifact → Export JSONで持ち出せる。再読込後も同じ描線IDを編集できる。

入力は一定幅2.5のpolylineで最大2048 samples。描画後の線幅変更は可能。筆圧・傾き・可変幅ブラシ・高品質な手ぶれ補正・消しゴム・点/segment挿入削除は未対応。完成した商用漫画ツールの受け入れを意味しない。

## AIから受け取った線の変更を採用する

「線を描く・AIと編集する」を開き、「AIに渡す作画データを保存」で現在の原稿・revision・選択をJSONへ出す。AI側はこのデータに対し、既存pathの置換または新しいpathの追加をdata-only JSONとして返す。「作画提案を開く」でそのJSONを選ぶと、現在と提案後の線画が画像で並ぶ。

確認して「作画案を採用」すると同じPlayground sessionの1 transactionになる。「作画案を却下」は原稿を変更しない。人は採用後の同じ線を通常UIで編集できる。古いrevision・別の原稿・閲覧専用・描きかけの入力では拒否し、採用時にも再検査する。

Playgroundから外部AIサービスへ自動送信する機能や、チャットに対する自動作画応答を追加したものではない。AIの実行、認証、transportはHost側の接続対象。

### 接続用のローカルtool

ローカルDesignをEditor表示している間だけ`window.playgroundInk`を登録する。History、別kind、sharedへ移ると解除する。既に取得した古いtool handleも解除後は操作を拒否する。このtoolはlocalhostの参照用で、production認証APIではない。

```ts
const current = window.playgroundInk!.read();
const line = current.content.elements.find(
  (element) => element.path && current.selectedIds.includes(element.id),
);
if (!line) throw new Error('編集する線を選択してください');
const path = structuredClone(line.path!);
path.subpaths[0].anchors[0].y += 4;
window.playgroundInk!.propose({
  id: 'refine-line-1',
  artifactId: current.artifactId,
  summary: '選択した線の始点を修正',
  baseRevision: current.revision,
  operations: [{ type: 'replace', id: line.id, path }],
});
```

`read()`は`artifactId/revision/content/selectedIds`を返す。`propose()`は`id/artifactId/summary/baseRevision/operations`を受け、追加は`{type:'add',name,path,bounds,parentId?,fill?,stroke?,strokeWidth?}`、置換は`{type:'replace',id,path}`を指定する。1〜32操作、JSON読込は8MiBまで。native commandがgeometry・style・hidden/locked・書込可否を検証する。文字列をコードとして実行しない。

共有sessionではこのローカル作画toolとペン入力を有効にしない。remote編集をsnapshot Undoへ流す接続はしない。特定の人物・背景の分類や画像生成schemaはこの機能の契約に含めない。

検証結果・未実施範囲は[作画機能の検証記録](verification/design-local-editing/README.md)を参照。

## AI画像レイヤーを手で直す

ローカルDesignでは、所有する埋込PNGをNavigatorで選び、Inspectorの
「画像を直接描き直す」を開く。ブラシは同じ画像のピクセルを描き換え、消しゴムは
alphaを消す。画像下の別レイヤーが透ける。白で塗る場合はブラシの色を白にする。
一筆ごとに既存Undoへ確定し、既存Save versionで保存する。

AIへ一部の修正を依頼する場合は「範囲選択」→矩形をドラッグ→「選択範囲を使う」。
その後に「AIに渡す作画データを保存」を使い、現在のimage.srcを元にAIで候補PNGを作る。
同じ画素サイズのPNGを次の提案として返す。

```ts
const current = window.playgroundInk!.read();
const selection = current.rasterSelection;
if (!selection) throw new Error('画像の範囲を選択してください');
await window.playgroundInk!.proposeRaster({
  id: 'hair-refinement',
  summary: '髪の範囲を描き直す',
  artifactId: current.artifactId,
  baseRevision: current.revision,
  operations: [
    {
      type: 'raster-region',
      id: selection.elementId,
      region: selection.region,
      src: candidatePngDataUrl,
    },
  ],
});
```

`candidatePngDataUrl`はAIから受け取った同サイズPNGのdata URL。現在の原稿と比較して
採用すると、選んだ矩形内だけを同じ画像に反映する。矩形外の手直しは残る。
AIの自動呼出しはHost接続の対象で、この画面では提案JSONの入出力も使える。
4MiB/2048pxなどの上限と未対応範囲は[限定PNG編集](design-raster-editing.md)を参照。
画像を含む全保存版JSONは大きくなるため、16 MBの読込上限にも注意する。
