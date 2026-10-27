# Designのパス編集（local）

Designの通常ツールバーで **Add line path** / **Add cubic path** を選びます。
最初の追加でdraftだけがschema3になり、追加とschema移行は1回のUndoで戻ります。
旧vectorは変換しません。cubic presetは2区間で、中央anchorの両handleを編集できます。
frameを選択して追加すると、その内側へ置きます。小さいframeでは初期サイズを収めますが、
pathのlocal frameと親のclipは保持します。frameを選択していない場合は画面の中央へ追加します。

要素を選択してInspectorの **Edit path points** を押します。点とcontrol線を画面へ
収め、固定local frameを使って編集します。点はcanvas上でdragするか、**Path point**
から選び、**Path point X/Y**で座標を入力します。Tabで点にfocusし、矢印で1単位、
Shift+矢印で10単位移動できます。cornerは独立、smoothは反対側の長さを保って方向を
連動、symmetricは反対側の長さも合わせます。modeは編集方針で、読込時の形状保証では
ありません。anchor移動は接続handleを平行移動し、未編集anchorを動かしません。
非表示のpathや非表示の親がある場合は、先に表示へ戻してください。編集中に非表示へ
切り替えると点は描かれず、Fitは理由付きで拒否します。表示へ戻すか点編集を終了できます。

編集で点が画面外へ出たときは **Fit path points** で全anchorとhandleを収め直します。
カメラだけを変更し、pathの座標やUndo履歴は変えません。通常の **Fit design** は
描画範囲を収める操作で、曲線から離れたhandleは含みません。
schema3では受理可能な大きい座標・変換にも合わせて縮小し、点は画面上で一定の大きさを保ちます。

座標の未確定入力は別の点を選ぶ前に確定します。無効な値は元の点の入力欄へ保持され、
選択変更と保存を拒否します。値を修正するかEscapeで入力を取り消してから再試行してください。

pointer moveはpreview、pointerupは1 native commandです。Escape、pointercancel、
capture喪失、権限/内容変更、detachで取消します。点編集中のDeleteは拒否します。
**Finish point editing**またはEscapeで通常の移動・resize・rotate・削除へ戻ります。
保存/export中に未確定gestureがあれば先に確定/取消してください。

複製と同じSurface内のCopy/Cut/Pasteでは、subpath/anchor/segment IDと参照を一括で
振り直します。貼付先のschema3化と追加は1 Undoです。通常Hostの保存、native JSON、
restoreを使い、SVG/PNGは **Export design** から出力します。frame外の曲線とstrokeも
派生boundsへ含めます。明示的な親frame clipは保持します。

path単体の入力上限8 MiBは保存保証ではありません。Hostはdraftと全保持versionを含む
Artifact総JSONを16 MiBに制限します。保存失敗時は未保存draftとUndoを保持します。
Savedになっていないことを確認し、draftの容量を減らして再試行してください。過去版は
自動削除しません。ブラウザのタブを閉じる前に未保存状態を解消してください。

schema3は明示対応local/native入口のみで受理します。shared、template、reuse、component、
外部proposal、React変換、Design→Animationは拒否します。自由作図、点追加/削除、split、
SVG import、CAD/BIM取り込み、Boolean/offset、ラスターペイントは対象外です。

[設計v0.3](design.md)・[段階と検証](implementation-plan.md)を参照してください。
