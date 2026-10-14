# Graph閲覧表示の設計 (#224–#228)

設計版1、2026-10-13。既存 `structured-graph` の表示能力を追加する。
既存の [Graph契約](structured-graph-contract.md) を維持し、新しいkindや保存形式は作らない。
検証結果は [検証報告](verification/issues-224-228/README.md) に記録する。

## 目的と能力

多数の関係を持つGraphを読むHostで、初期全体表示、関係種別の絞り込み、
隣接の強調、全文ラベルの確認を行えるようにする。
利用側のDefinition、製品型、外部パネル、認証・保存はHostが所有する。

| 能力                                                    | 範囲と設計時点の状態                                                             | 条件             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------- |
| Viewer                                                  | 編集道具を隠し、属性を値として表示。Inspectorの非表示は公開propsで指定。検証済み | N06/N09/N11      |
| Camera                                                  | 初期origin/fit/指定camera、ノード絞り込み後の任意再Fit。検証済み                 | N03/N06/N11      |
| Node表示                                                | Host指定の固定寸法またはnode別寸法、全文title/accessible name。検証済み          | N06/N11          |
| Edge表示                                                | 種別絞り込み、選択nodeの隣接強調、衝突回避ラベル、Profile線色/破線。検証済み     | N02/N03/N08/N12  |
| Local編集・native JSON                                  | 既存command/session/保存/Undoを継続。関連回帰で確認                              | N04/N05/N07/N10  |
| Shared・annotation・template/reuse・Office/React export | 非対応。既存の入口非提供を維持                                                   | C02/C04–C09: N/A |
| Chromium desktop/mobile viewport                        | 独立public API Hostと既存Hostで機能確認済み                                      | N11/N13          |
| 他engine・実機・native IME・screen reader               | 今回の検証対象外、NOT RUN                                                        | C01/C10          |

## Native model・操作・履歴

Schema 1、既存ID、参照、位置、上限、draft/version/hashを維持する。
Camera、寸法、panel、filter、highlight、routing、ラベル配置はprivate view stateで、
contentやcommand/historyへ入れない。全Graphのvalidationと選択通知は変えない。
絞り込みで選択対象を削除扱いにしない。隣接は全Graphの直結辺から求める。

`readOnly` と `profile.graph.readOnly` の両方で編集道具を隠す。
既存のSurface `apply` とtrusted Host command境界で編集を拒否する。
編集中の属性bufferは表示変更でも消去せず、既存のstale/flush契約を保つ。
Inspectorと定義editorは非表示時も入力bufferを保持し、再表示で失われないようにする。
編集時のnode作成・属性・接続・移動・Undoは既存経路を使う。

## Surfaceと互換性

公開 `GraphSurfaceProps` に `showInspector` (true)、`initialView` (origin)、
`fitOnFilterChange` (false)、`nodeSize` (200×70)、`visibleEdgeTypes` (全種別)、
`highlightAdjacent` (false) を追加。`NativeGraphSurface` も同じpropsを受け取る。
Inspector非表示のHostは既存の `select` と `selectedId` で独自パネルを接続する。
初期cameraはcanvas寸法が確定した時点で各Graphにつき一度適用し、通常編集では再Fitしない。
初期Fitと指定されたfilter Fitは可視ラベルの実測を待つが、計測更新だけで手動cameraを戻さない。
経路拒否により描画しないラベルは待たず、空白・ゼロ幅文字のゼロ寸法も計測完了として扱う。
経路拒否の診断と全Graphの検証は維持する。
別Graphへの切替時はorigin/customもDOM scrollを0へ戻し、
同じGraphの再描画・編集では手動scrollを維持する。
`nodeSize` は40–4000 logical px/軸、異常値は200×70へ戻す。
未指定の場合は幅200px、最小高さ70pxで内容を折り返し、自然なDOM高さからnodeの高さを算出する。
改行を保持し、長い連続文字も折り返す。フォント読込、label編集、type／overlay、編集ボタンの
有無を表示計測へ反映する。初期／filter Fitはnodeとedge labelの計測を待つ。
明示寸法は固定で、全文が収まらない場合も自動拡張しない。headless fallbackは200×70のまま。
nodeの座標は変更しないため、成長で生じた重なりを自動配置で隠さず、従来の経路拒否を表示する。
描画・Fit・routing・端点hit判定に同じ寸法を使用する。
Fitで25%以下になった視点の縮小は倍率を半分にし、拡大へ逆転しないようにする。

Edge Profile `ui.edgeStyle` は `{color?: string, dash?: number[]}`。
colorは3/6桁hex、dashは最大8個のfinite正数（各64以下）、空配列は実線。
未知field、URL/任意CSS、node/graph/属性fieldのedgeStyleは拒否する。
既存Profileは変更なしで有効、新しいui指定もHostのProfile pin/版管理に従う。
Native Graph JSONへProfile本文を混入させない。

ラベルはroute上の候補を安定順序で調べ、node矩形と既配置ラベルを避ける。
空きがない場合は通常時に省略し、hover/focus/selectionで全文を表示する。
全文は線のtitleとaccessible descriptionにも残し、既存の選択名を維持する。ブラウザーは現在のSVG glyph boundsを測り、幅・高さを配置へ反映する。
非表示の候補も測定できるようvisibilityで隠し、font読込後や再描画で測り直す。
headless関数の文字数による幅はfallback推定であり、実glyphの非衝突保証ではない。
任意フォント・zoomで全ラベルの同時表示は保証しない。

## 検証計画・安全性

Pure geometryとProfile入力境界をunitで確認し、独立public API Hostで
初期Fit、filter変更、選択通知、content/hash/history不変、node寸法、
ラベル矩形の衝突、hover/focus、readOnly両入口、Inspector切替を確認する。
既存Graph/Data/embedding/mobile production回帰を実行する。
lint/typecheck/unit/build/file/toolingを実行し、README/status/embeddingを更新する。
生成画像、bundle、ログはGit外に保持する。

既存の最大1,000 nodes/4,000 edgesを変更しない。外部通信・asset取得・
untrusted code実行は追加しない。密な架空Graphの機能を検証するが、
追加performance測定・tuningは停止中、performance/release受け入れは保留のままとする。

readOnlyへの切替や属性フォームの破棄では、到着しないcompositionendに依存せず一時的な
composingフラグを解放する。変更済みの未確定文字列・元値・schemaはdraftに保持し、勝手にcommitしない。
元値と表示文字列が完全に同じdraftは除去し、無変更のcompositionだけで保存を拒否しない。
再編集で明示Apply/Cancelできる。合成event/Chromium IME protocolの検証は物理IME実機の認定ではない。
