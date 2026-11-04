# 漫画ワークスペース

漫画用のページ・コマ・台詞・作画・通読を、Designの同じ原稿と履歴で編集します。通常Designとの切り替えは表示設定です。別のArtifactや履歴は作りません。

## はじめる

Playgroundの「漫画を作成」で、1ページのDesign原稿を作成します。Libraryの入口では縦横と読み方向を選べます。保存先への原子的な新規作成に成功してからLibraryに表示し、失敗時は同じ作成要求で再試行します。

既存Designでは「漫画ワークスペース」で切り替えます。ページ未設定なら「Add page」で追加します。ページ外の要素は保持され、通常Designで編集できます。「Designで詳細編集」で戻っても選択・文字入力・UndoのSessionは共通です。ドラッグやIME入力中は切り替えを保留し、完了後に入力を確定します。表示設定はPlaygroundのArtifact別private preferenceで、原稿・version・共有データには保存しません。

## コマ割りと作画

1. 空のページで「連動コマ割りをプレビュー」を選び、余白と読み順番号を確認して採用します。これが新しいコマ形状への明示的な移行です。複数の既存コマは自動変換しません。
2. 「線を引いて分割」でコマ上をドラッグすると、横・縦・斜めの分割を試せます。プレビューを採用するまで原稿は変わりません。数値入力では線の向き・間隔・位置、絵を残す側、新しいコマを読み順の前後どちらに入れるかも指定できます。
3. 青い境界をドラッグして調整します。隣接するコマの形が同時に変わり、内部の絵・画像・台詞の位置は保ちます。境界にフォーカスして矢印キーで1単位、Shift併用で10単位動かせます。ドラッグは1回のUndo対象です。Escapeで取り消します。
4. ページ内の「Add dialogue」「Add balloon」「Add line/cubic」と既存の自由線・点編集を使って、同じ原稿へ描き足します。選択した枠の変更と、内部の絵を移動・拡縮する操作を区別してください。
5. 必要なら同じ分割から生じた2コマを、残すコマを明示して結合します。絵のID・位置は保持します。ページ全体の連動解除では形状と絵を残し、境界の連動だけを外します。

繰り返し分割すると、長方形・台形・三角形などの凸多角形とT字境界を作れます。斜め線を増やすだけで読みやすくなるとは限りません。導入・反応・動きの接点・結果を読み順と併せて確認してください。読み順は位置から推測せず、ページ・コマの順序として明示的に編集します。

Toolbarの「台詞を追加」は、選択した文字や絵の所属コマへ追加します。選択を外しても現在のページを保持し、そのページの先頭コマ（コマがなければページ）へ追加します。ページ未設定では利用できません。続けて追加した台詞も、通読・ページ出力に含まれます。

ツールバー・ページ一覧から追加する台詞は、三角形や台形の内側に文字枠全体が収まる位置へ置きます。必要なら枠と文字を同じ比率で縮めます。最小8単位の文字と余白を置けないコマでは追加できません。コマを広げてから追加してください。追加後の位置・大きさ・台詞は通常の文字として編集できます。

直線はページ左上を原点とする `nx*x + ny*y = offset` です。法線の長さは1、間隔はその法線方向のDesign単位。数値欄の90°は横境界、0°は縦境界です。ドラッグ中だけ有効範囲に止めます。数値入力・headless・提案に不正値があれば、黙って補正せず全変更を拒否します。

## 通読・提案・保存

「単ページ」で編集対象を合わせ、「見開き」「通読」で読み方向に従って並べます。右から左の作品では先のページを右側に表示します。これは編集中のdraftの表示です。原稿の座標や所属を変更しません。見開きに跨る1コマは未対応です。

Inspectorの「変更提案」でデータのみのJSONを読み込み、変更単位を選び直して再プレビューできます。手動で提案を用意する場合は、詳細欄の「現在の対象情報を表示」から対象版・revision・ページ/要素IDを取得できます。別資料を参照した提案には、その資料の参照版も追加してください。前後比較のページを切り替え、境界・切り取り範囲・台詞・読み順を確認して採用します。依存する変更はまとめて選択してください。依存不足・対象版の更新・別の編集・参照元の変更・権限失効では採用を拒否します。採用後の追筆も、提案全体のUndoも同じSessionです。Undoで元の見た目に戻しても古い提案のrevisionは復活しません。

提案の生成はHostが提供する `requestProposals` です。PlaygroundにはAIサービスや定型の自動コマ割り生成を内蔵していません。JSON読込とレビュー・採用は利用できます。ネームや線画の芸術的な品質、物語の矛盾は、このvalidationでは判定できません。

保存・確定版・native JSONの退避は既存Hostの操作を使います。ブラウザ保存先の削除を越える復旧は保証しません。出力は[Authoring契約](../authoring-contract.md)の `captureDesignPages` と `exportPages` を使い、固定versionとmanifestを検証します。独立Host `/authoring.html` の「Read saved vector pages」からPNG/PDFまで確認できます。通読draftを見ているだけでは確定版出力は更新されません。

## 埋め込みとnative契約

`DesignSurface` は従来どおり `@editor-platform/design` から利用します。`workspace?: 'design' | 'manga'` の既定値は `design`。`onWorkspaceRequest` はHostへ切り替え希望を通知し、`onWorkspaceTransition` は要求値・表示値・`applied | pending`・理由を通知します。制御propの変更でも入力中は保留します。`pageReview?: DesignPageReviewHost` でcurrent context・入力確定・採用・任意の生成providerを渡します。権限と参照の読取は採用時も最新値を返してください。

| 公開subpath                                   | 主なAPI                                                                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `@editor-platform/design/division`            | `designDivisionCommand`, `materializeDivision`, `parseDivisionOperation`, `clampDividerOffset`, native型と上限                               |
| `@editor-platform/design/page-proposals`      | `readDesignPageProposal`, `prepareDesignPageProposal`, `checkDesignPageProposal`, `designPageProposalCommand`, `isPreparedDesignPageCommand` |
| `@editor-platform/design/manga-proposal-diff` | `designMangaProposalDiff`。形状・分割木・所属・読み順を含む比較                                                                              |

```ts
session.execute(
  designDivisionCommand(
    {
      type: 'startDivision',
      pageId: 'page',
      region: { x: 30, y: 30, width: 540, height: 740 },
      root: { panelId: 'opening' },
    },
    () => host.canEdit(),
  ),
);
session.execute(
  designDivisionCommand(
    {
      type: 'splitPanel',
      pageId: 'page',
      panelId: 'opening',
      newPanelId: 'action',
      dividerId: 'boundary',
      line: { nx: 0.2, ny: Math.sqrt(0.96), offset: 350 },
      gap: 16,
      retain: 'a',
      insert: 'after',
    },
    () => host.canEdit(),
  ),
);
```

`startDivision` / `splitPanel` / `setDivider` / `mergePanels` / `detachDivision` は閉じたデータ型です。IDは呼出時に確定し、Undo/Redoで変えません。1 commandが分割木・コマ形状・所属・順序を原子的に変更します。proposalは最大32単位・100操作。形状・bounds・台詞・画像の操作は原稿全体の読取として保守的に扱うため、複数単位には明示的な依存が必要です。独立した読み順操作はページ別に扱えます。prepareで固定した内容と、採用時のversion・local revision・参照・権限を照合します。

初めての連動コマ採用でdraftをDesign schema4 / pagination2へ移行します。ページは二分木、コマは世界座標のboundsと正規化した凸polygonを保持し、両者を再計算で検証します。readerは不一致を修復しません。旧schema1/2/3の原稿と確定版は読めます。Undoで移行前のbytes相当の内容を復元します。新形式を旧readerへ渡すことはできません。

1ページ32コマ・深さ8・polygon12頂点、bounds幅/高さと面積はそれぞれ1以上です。通常paginationの上限とは別に適用します。コマ枠は内側線、bevel角で描画し、canvas・hit test・SVG captureで同じpolygonを使用します。枠線はコマ内の絵の後に描画し、画像に隠れません。枠の描画用要素をnative IDや選択対象に追加せず、後続ページの重なり順も保ちます。ページ複製はコマ・境界IDを再発行し、絵の参照元情報を保持します。連動コマ単体の複製/移動/resize/所属変更、ページの一般resize、枠のrotation/flip/角丸は拒否します。ページの平行移動、枠内の通常の絵の編集は可能です。

## 通読fixtureの再現

`node scripts/dev/prepare-manga-workspace-demo.mjs` で、港の危機から出航までの2ページ8コマを `work/manga-workspace-demo/` に生成します。`native.json` を通常Hostへimportすると、台詞・ロープの線・コマ境界を編集できます。固定版のSVG2ページとmanifestも生成します。初期状態はネーム確認用であり、作画品質の受け入れを意味しません。

任意の `--assets DIRECTORY` では、利用権を確認したオリジナルデモ用の6枚のJPEG（harbor/resolve/hero/impact/compass/departure）を配置できます。画像はリポジトリへ収録していません。`--out DIRECTORY` で生成先を変更できます。画像の配置とnativeな線の直接編集を分けて確認してください。

## 対応範囲

local/nativeのワークスペースです。shared authority、template/reuse、React/Animation変換は新形式に未対応で、既存の未対応境界で拒否します。新規Raster筆圧ブラシ・トーン・部分消去・縦書き/ルビ・PSD互換、自由な凹polygon、飛び出し/重なる独立コマ、跨り見開き、境界木の自動推定は追加していません。

人物/舞台の正本、作品内時間と提示順、WorkUnitの工程・承認・保存復旧管理はHostの後続実装です。画像生成の出力を配置することと、人/AIがnative線を直接変更することを区別します。全体像は[共同制作設計](design.md)、今回の判断根拠は[ワークスペース設計](workspace-design.md)を参照してください。実機筆圧・OSのnative IME・全browser・商用印刷品質・性能は、この実装だけで検証済みとはしません。

既存Playgroundのコメントは要素IDへの参照を使います。結合で消えたコマへのコメントはOrphanとなり、Undoで復元するとCurrentへ戻ります。固定version付きコメントと版差分のOutdated表示は今回追加していません。提案の対象版・参照版の検査とは別の後続機能です。
