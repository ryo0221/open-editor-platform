# DesignページのM1a: ベクター線画・吹き出し

2026-10-26、#537後続、#546依存。既存のDesign schema3/pathと通常Surfaceの点編集を再利用する。初期M1aの範囲はページ内へのline/cubic線画、尻尾付きpathとhorizontal native textの吹き出し、明示opt-inの確定版vector page capture。新kind、Raster brush、共有/proposalのpath codec、Story専用参照、CAD solver、縦書き/ルビは追加しない。

[検証記録](verification/design-page-artwork/README.md)を受入の根拠とする。M1全体ではなく、受入済みpath基盤を使うM1aのlocal subset。

## 代表操作・失敗

4ページ×2コマで線画追加→anchor移動→吹き出し作成→台詞編集→move/resize→Undo/Redo→保存/reload→exact capture→PNG/PDF。削除されたpanel、locked/hidden/readOnly、未知preset、不正bounds、IME/gesture中断はatomicに拒否する。履歴・選択・保存はnative Session/Surface。吹き出しはgroupにpath/textを持ち、安定IDの別モデルを作らない。

## API・モデル

`@editor-platform/design/page-artwork`:

- `insertDesignPagePath(panelId, preset, bounds)` はinsertDesignPath/presetDesignPathを包み、登録panelの所属をapply時に検証する。
- `insertDesignSpeechBalloon(panelId, bounds, text)` は一つのnative transactionでgroup/path/textを作る。返る各element IDは一度だけ生成する。尻尾はlineとcubicの既存構造化pathとして編集可能。
- `captureDesignPages` はdefault M0を維持し、明示的なvector opt-inでschema3の直接所有pathとprovenance付きlegacy vectorだけ許可。rotation/component/reuse/referencesは引き続き拒否。native paint boundsでページcropを診断する。

Pages panelにline/curve/balloon追加を接続し、既存の点編集・text engine・gesture/input guardを使う。PNG/PDFは既存renderer/encoder、PDF rasterでnative textとしての編集可能性は宣言しない。

## 境界・検証

Native schemaは既存3で、M0paginationは既存metadata。旧versionは不変。schema1/2→3はnative path挿入の既存atomic移行。shared/template/reuse/React経路は拒否を維持。path proposalは宣言しない。線画geometryのprovenanceを捏造せず、外部vectorは既存DesignVectorのsource/name/version/licenseを保持。

上限は既存path上限・page上限・capture pixel境界。新規性能測定/tuningは行わない。headlessの不変/失敗/ID、通常/独立Hostのdesktop/mobile、出力、既存path回帰を検証する。OS native IME、実機、実Office、Raster/出版組版は未検証。

N2は別途、native ruby等の表現能力とDOCX/EPUB/PDFの対応/損失matrix、reader検証計画を先に定める。既存PDF text出力を二重実装しない。
