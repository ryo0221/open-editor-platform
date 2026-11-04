# 漫画ワークスペースとDesignの共存設計

設計案 v3、2026-10-29。`@editor-platform/design` の能力追加を提案する。[漫画制作全体の設計](design.md)のうち、作業画面の入口、コマ割り、通常Designとの往復を具体化する。新しい `comic` kindは設けず、漫画専用の画面から同じDesign原稿を編集する。これは未実装の提案であり、既存機能の受け入れ記録ではない。

## 1. 採用を提案する判断

利用者には「漫画」を独立した作成・編集の入口として見せる。内部では一つのDesign Artifact、一つのdraft、一つの編集sessionを共有する。漫画画面はページ、読み順、コマ境界、台詞を中心に構成し、「Designで詳細編集」から通常のレイヤー・図形編集へ往復する。

| 選択肢                                 | 利点                                     | 判断                                                                               |
| -------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------- |
| 通常Designに漫画用ボタンだけ追加       | 実装を小さく始められる                   | 制作中に必要なページ・読み順・境界操作が一般の設定に埋もれるため、完成形にはしない |
| 別kind・別Editorとして漫画を作る       | 画面を自由に構成できる                   | 原稿変換、ID対応、履歴、保存、線・文字操作が重複するため採らない                   |
| 専用の漫画画面と入口、共通のDesign原稿 | 制作に合う画面と既存編集能力を両立できる | 本案。画面切替とデータ変更を分離する                                               |

コマ割りには、ページを直線で分割し、隣接コマが共有する境界と間隔を編集する方式を追加する。個々のコマに台形等の外形を指定する能力は残るが、形状の種類を増やすだけで読みやすい漫画になるとは扱わない。境界編集は枠とclipを変え、内部の絵の位置・比率を保持する。構図の調整は別の明示操作にする。

本案は画面とコマ境界についての後続案として優先する。全体設計の脚本・人物・舞台・参照・保存復旧・ワークフローの責務は引き継ぎ、ここへ別の制作管理機構を追加しない。

## 2. 現状と追加範囲

調査時のmainと、取り込み前の共同ネーム実装を区別する。後者がmainへ入るまで、そのAPIを既存Hostの利用可能な契約として案内しない。実装変更時にはこの表と[Host契約](../authoring-contract.md)を更新する。

| 項目           | 調査時main                                                                                       | 取り込み前の共同ネーム実装                                                                                | 本案で追加するもの                                                          |
| -------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 原稿・ページ   | Design schema 1〜3、pagination schema 1。pageはroot frame、panelは直属frame。読み順とz-orderは別 | 同じkind・native modelを利用                                                                              | 同じArtifactを開く専用画面。境界機能には後述のschema拡張                    |
| コマの形       | ページUIの矩形コマ操作                                                                           | 8種の閉じた形状、反転・clip、6種の配置案。台形等の頂点比率は固定                                          | ページ分割、共有境界の移動・傾き、間隔、隣接コマの同時更新                  |
| 提案           | `designPageEditCommand` のbounds/text/image subset                                               | `DesignPageReviewHost`、対象版・依存関係付きの部分採用。bounds/panelShape/text/image/pageOrder/panelOrder | 分割・境界・結合等の明示operationと、共有境界を一体とする採用単位           |
| 描画・文字     | native line/cubic、点編集、一定幅のペン、限定PNG編集、水平native text                            | 既存能力を再利用                                                                                          | 入力とsessionを保持する画面切替。筆圧・縦書きの対応宣言は増やさない         |
| 表示・出力     | 通常Design、exact versionのページcapture、PNG/PDF、opt-in vector capture                         | ページ比較・読み順の編集UI                                                                                | 漫画向けの単ページ・見開き・通読表示、新しいpolygonの描画・選択・出力の一致 |
| 保存・共同編集 | native保存/import。pagination/pathのshared経路等は非対応                                         | 同じ保存・非対応境界                                                                                      | 新schemaの完全性検査。遠隔同時編集や環境外の復旧保証は追加しない            |

実装済みコードが存在することと、この設計のUI・新geometryが検証済みであることは別である。取り込み前の実装を含む接続試験は実装段階で行う。

## 3. CLIP STUDIOから参照する操作と本案の判断

参照先は[漫画制作の紹介](https://www.clipstudio.net/ja/comics-manga/)と公式マニュアルの[コマ割り](https://help.clip-studio.com/ja-jp/manual_jp/540_comic/%E3%82%B3%E3%83%9E%E5%89%B2%E3%82%8A%E3%80%90PRO__47_EX%E3%80%91.htm)。公式マニュアルには、基本枠の分割、上下・左右の間隔指定、隣接コマの連動、枠の変更と内部レイヤーの分離が説明されている。これを本案の操作の参考にする。

専用画面と共通Design modelの組み合わせ、以下の分割木、初期上限は、このリポジトリ向けの設計判断である。CLIP STUDIOの内部形式やすべての操作を再現する提案ではない。

改善の順序は、脚本の因果と見せ場を決める、大小と間で読み順を作る、必要な境界だけ斜めにする、構図を合わせる、通読する、とする。例えば動きのある場面でも、すべての枠を斜めにせず、接触点の小コマと大きなアクションの対比を作る。これは検証する編集方針であり、自動的に品質を保証する規則ではない。

## 4. 利用体験と画面

### 作成・再開・切替

1. Hostの「新規作成 → 漫画」で用紙・読み方向を選び、Design Artifactと初期ページを一つの作成処理で用意する。Hostは途中の空Artifactを完成品として公開しない。重複送信は同じ作成requestへまとめ、失敗時は入力を保持して再試行する。この作成導線は追加実装である。
2. ページ上で分割線を引き、コマの順序と台詞を置く。ラフ、線、画像も同じ原稿へ追加する。Hostから渡された人物・舞台・脚本の版付き参照を横に開ける。
3. 「Designで詳細編集」で通常のレイヤー、図形、点編集へ移る。同じコマと子要素が選択され、編集の続きから操作できる。「漫画へ戻る」でページ作業へ戻る。
4. 比較中の提案も対象版が変わらなければ保持する。人が原稿を直した後の古い提案は再比較が必要になる。採用後も同じ原稿へ追筆できる。
5. Hostの保存状態を確認して再開する。画面ごとの別ファイルや別の保存ボタンは作らない。確定版から出力し、ページ順・文字・clip・欠落素材を確認する。

既存Designを開いたときの既定は通常Design。paginationの存在だけで漫画画面へ自動切替しない。Hostが明示した画面、または利用者が前回選んだ画面を優先できるが、この選択はHostのprivate view stateでありnative contentに入れない。native JSONに画面指定がなくても原稿を完全に復元できる。

ページのない原稿で漫画画面を選んだ場合は、ページ設定への入口とページ外要素の存在を表示する。切替だけでpage/panel登録や配置変更をしない。「ページを設定」の明示操作が一つのUndo対象になる。既存frameの登録は候補と配置をプレビューし、選ばれていない要素は保持する。既存ページの分割木への参加も別の明示操作とする。

### 漫画画面の構成案

```text
Host: 作品 / 原稿名 / 保存状態 / 漫画・Design切替 / 版・出力
┌─────────────┬───────────────────────┬─────────────────────┐
│ ページ一覧  │ 選択・分割・境界・    │ 選択対象の設定      │
│ 読み順      │ 台詞・ペン・素材      │ 間隔 / 枠 / 台詞    │
│ コマ一覧    ├───────────────────────┤ 脚本・人物等の参照  │
│             │ 単ページ / 見開き     │                     │
│ ページ外要素│ 原稿キャンバス        │ 提案の比較と採否    │
└─────────────┴───────────────────────┴─────────────────────┘
```

これは画面構成案であり、実装画面の画像ではない。漫画用ツールバーは作業に必要な操作を前へ出す。通常Designのツールバーや拡張slotは保持する。台詞、線、画像の編集実装を漫画専用に複製しない。ネーム→ラフ→作画を必須のモード遷移にはせず、同じ原稿で行き来する。

狭いcontainerではページ一覧・設定・参照を一度に開かず、切り替える一つのdrawerにする。選択、戻る、Undo、画面切替を常時到達可能にし、keyboard操作にはラベルとfocus復帰を用意する。境界はドラッグに加え数値・方向キーでも調整可能にする。読み順番号と分割ハンドルはview overlayで、出力には入れない。

### 切替の不変条件

| 対象                    | 切替時の動作                                                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Artifact・draft・確定版 | ID、content、hash、local revisionを変更しない。view切替をUndo履歴に積まない                                                                                           |
| session・選択           | Artifact単位の既存sessionを上位に保ち、workspaceをkeyにしてsessionを作り直さない。安定IDで選択を引き継ぐ                                                              |
| camera・panel           | 画面ごとのprivate stateとして保持できる。選択中のコマを表示範囲へ案内する                                                                                             |
| 文字入力                | native IME composition中は切替を保留。確定後のbufferは既存の入力flush境界で確定し、失敗時は切り替えない。文字の確定は通常の編集であり、切替操作による編集とは数えない |
| ペン・ドラッグ          | pointer gesture中は切替を保留。完了かEscapeによるCancel後に切替できる。中間形状や未確定strokeを保存しない                                                             |
| read-only               | 表示切替と閲覧は可能。作成・setup・分割・paste・proposal適用はUIと適用境界の両方で拒否                                                                                |
| 対応外のschema・shared  | 理由を示す。編集可能なlocalコピーへ黙って切り替えない                                                                                                                 |

reload後に同じUndo履歴まで復元する保証は追加しない。既存のnative JSONが保持する原稿・確定版と、実行中sessionの履歴、Hostのview設定を区別する。

## 5. Editor・Host・ワークフローの責務

| 所有者                  | 責務                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Design model / commands | ページ・コマ・線・画像・文字、分割木とpolygon、validator、選択の対象、atomic変更、native履歴、出力projection         |
| Design Surface          | 漫画/通常の画面構成、共通canvasと入力、境界ハンドル、preview、読み順overlay、read-only表示                           |
| 消費Host                | 作成入口、画面選択の保存、同じsessionの保持、保存adapter、確定版・復旧、AI実行、人物・舞台・脚本への接続、提案の取得 |
| ワークフロー定義        | 工程候補、成果物、依存、確認観点。漫画画面の切替やコマgeometryの形式を所有しない                                     |
| 実行・制作管理Host      | 作品/Scene/Page等の制作単位、実行instance、進捗・再承認、反復、物語時刻と提示順。Editor内へ複製しない                |

画面選択の最小API案は、既存 `DesignSurfaceProps` にoptionalな `workspace?: 'design' | 'manga'` を足す形とする。省略時は従来のDesign。これは未実装の型案である。共通canvas・入力controllerを保持したままツールバー等を切り替え、別のSurfaceで原稿を複製しない。汎用workspace登録frameworkは作らない。

切替要求はHostの既存input guardを通す。独立Hostにも同じ保留/flush結果を返す接続を公開し、Playgroundの内部storeやCSSをpackageからimportしない。`workspace` propは希望する画面として受け取り、Surfaceも切替可能性を検査する。保留中は現在の入力UIを維持し、`onWorkspaceTransition`（型名案）で要求画面・表示画面・適用/保留・理由を通知する。composition/gesture終了後に最新の要求だけを再判定し、明示Cancelなら要求を取り下げる。propの直接変更でも未確定入力を破棄しない。具体的な型は既存input contextへ合わせ、別の入力sessionを作らない。

`inkInput`、`rasterInput`、参照、extension等の既存opt-inは引き継ぐ。漫画画面を選んだだけで未許可の能力を有効化しない。既存の共同ネームreview接続も利用し、AI runtime、catalog、history stackを追加しない。

作品設定→Scene→Page/Panelの参照はHostが保持する版付き対応を利用する。Panel IDは所属ページ・読み順から独立させる。物語時刻と読者への提示順、Scheduleの制作予定、Animationの再生時刻は別とする。人物の知識や時間の矛盾は参照の存在検査だけでは検証できず、人の通読判断を残す。

作品設定の接続、制作単位別の承認、物語の時間軸UIはHost側でも追加設計・実装が必要であり、現行Playgroundに揃っているとはしない。漫画画面の完成をそれらの完成と同一視しない。

## 6. コマ境界のnative model案

### 直線分割の木を正本にする

初期範囲は「ページの内枠を直線で二分し、その領域を再分割する」方式。一本の境界を動かすと、その両側にあるすべてのコマの輪郭を再計算する。上下段の境界に斜線を使い、上段だけ左右に割るT字接続も表せる。矩形、台形、三角形等が分割の結果としてできる。

任意の隣接graph、曲線、穴、重なりコマまで一度に扱わない。全leafを持つページ単位で連動を有効にし、初期版では連動コマと自由な差し込みコマを同一ページに混在させない。自由配置が必要なページは既存の独立frame方式を使える。

```text
DesignContent schema 4（提案。画面切替だけでは移行しない）
  pagination schema 2
    direction / images: 既存の意味を保持
    pages[]: frameId / panelIds（読み順）/ division?
      division: region / root
        region: ページ原点からの内枠 rectangle、Design座標単位
        root: Leaf(panelId) | Split(dividerId, line, gap, a, b)
        line: 単位法線 nx, ny（無次元）と offset（Design座標単位）
              原点はページlocal原点。ページサイズによる0〜1正規化はしない
        gap: 分割後のpolygon間隔、Design座標単位
  elements[]: 既存のpage/panel/線/画像/文字
    panel frame: bounds + panelGeometry? { polygon: 正規化頂点列 }
```

schema番号とfield名は提案である。変更はDesign content内に閉じ、Artifact envelopeとkindを変えない。page/panelの安定IDと直属の親子関係を保持する。`panelIds` の読み順を木の走査順から暗黙生成せず、z-orderとも分離する。

分割線 `n·p = offset` の `p` はページ左上を原点とするDesign座標、`n = (nx, ny)` は長さ1の無次元ベクトルとする。`offset` は同じ原点から法線方向へ測った符号付き距離、`gap` は斜線への垂直距離で、両方ともDesign座標単位。regionの左上を原点にせず、ページ幅・高さで0〜1に正規化しない。側aは `n·p <= offset - gap/2`、側bは `n·p >= offset + gap/2` とする。例えばpageのworld位置が `(100, 200)`、regionのlocal位置が `(30, 40)`、`n=(1,0)`、`offset=300` なら、境界中心のworld xは400である。

水平・垂直で異なる既定間隔を選べるが、保存する値は各境界のgap。傾きを変えても画面のx/y幅へ意味を変えない。0〜1の正規化を使うのは後述のpanel内polygon頂点であり、分割線の座標とは別である。

連動中の正本はdivision。panelのboundsとpolygonは同じcommandでmaterializeする。validatorは再計算した輪郭と保存されたbounds/polygonの一致を検査し、両者を独立に編集可能な正本にしない。浮動小数の比較・丸め規則は共通geometry helperへ固定し、rendererごとに補正しない。importが不一致の値を黙って修復することも禁止する。

materialize時には重複頂点と連続する同一直線上の頂点を共通helperで除き、SVG座標で時計回り、xが最小（同値ならyが最小）の頂点を始点とする列へ揃える。この正規化も再計算・一致検査に含める。下記の頂点数上限はこの凸polygonの頂点を数え、strokeを描くための派生形状とは分ける。

既存Designの座標保存はworld座標である。divisionはpage local、panelのboundsはworld座標のAABB、polygonはbounds内の0〜1座標とする。境界編集時には子のworld座標を維持する。既存の `transformElements` によるframe resizeは子のconstraintに従うため、そのまま境界編集へ流用しない。

### 親境界を動かすとき

初期版はすべての分割線をページlocalの絶対指定にする。親の境界を動かしても、子の分割線の `n`・`offset`・`gap` は書き換えない。子が割る領域とそこから得るpolygonを再計算するため、T字接続の端点は新しい親境界まで延びるか縮む。子を親regionに対して相対移動・伸縮させる規則は追加しない。

pointer gestureでは、直前の有効previewから要求位置・角度・間隔までの操作区間のうち、全leafが連続して成立する範囲に制限する（clamp）。有効範囲の端で止め、制約になったコマと実際の境界位置を表示する。geometry helperのvalidatorと許容誤差を共有し、十分に有効と確認できなければ直前の有効previewを保つ。離れた有効位置へ飛び越えたり、子境界を勝手にずらしたりしない。確定commandにはプレビューした実際の値を渡し、1 gestureを1 Undoにする。

数値の確定入力、headless、proposal、importは指定値をそのまま検査し、領域消失や下限違反なら全体を拒否する。clampして別の値を黙って採用しない。gestureでもbase・権限が変わった場合はCancelまたは拒否し、geometryのclampでstaleを回避しない。親境界をさらに動かしたい場合は、利用者が制約になる子境界を別操作で調整する。

### 描画・clip・余白

`panelGeometry` は登録panel frameに限る閉じた凸polygonで、frameの輪郭とclipの両方を表し、`clipContent: true` を必須にする。旧shape・flip・radius等の別輪郭指定を併用しない。style参照を解決したappearanceについてもこの条件を検査し、style更新やclip解除で迂回できないようにする。初期版では連動中・解除後ともにpolygon panelとそれを含むpageの回転は0のみ、layoutは未指定またはabsoluteのみとする。作画要素の回転や通常Designのpolygon以外の既存能力は変更しない。

polygon間の白地をgapと一致させるため、新しいpanelGeometryの枠線はpolygon内側に描画する。通常shapeのstroke仕様は変えない。描画、point hit、marquee、nested clip、サムネイル、SVG/PNG/PDFのcaptureで同じgeometryを用いる。CSSだけでclipして選択や出力に反映されない状態では受け入れない。

枠線の角は `stroke-linejoin: bevel`、端は `stroke-linecap: butt` に固定する。初期版はmiterを使わず、miter limitによる切替にも依存しない。内側幅をwとすると、閉じたpolygon境界上の幅2wのstrokeを同じpolygonでclipする描画と定義し、w=0は枠線なしとする。これを共通geometry helperからprojection/captureへ渡し、rendererの既定joinや継承styleへ委ねない。joinとcapの意味は[SVGのstroke仕様](https://www.w3.org/TR/SVG2/painting.html#LineJoinProperties)に従う。通常shapeのstyleを変更する仕様ではない。

境界移動で絵が欠ける場合は切り取り範囲をプレビューする。画像のbounds、crop、path、textを勝手に変更しない。画像の位置や切り取り範囲を調整する操作は別のUndo対象にする。既存の `imageFit: 'fill'` は縦横比を保って切り取る描画であり、これを非等方な引き伸ばしの不具合と説明しない。

### 上限と拒否

連動1ページは最大32leaf、31divider、深度8、1polygonは最大12頂点を初期の提案上限とする。これは入力の防御上限であり性能の合格値ではない。既存の独立コマの上限64/page、128pages、8192画像出典は変えず、これを超える原稿を縮小して読むこともしない。既存のpath・Host JSON byte上限も引き上げない。

深度はrootからleafまでに通るSplitの個数と定義し、rootがLeafなら0とする。凸polygonを一つの半平面で切ったときの頂点数の増加は最大1なので、矩形regionの4頂点から深度dで `4 + d` 頂点、深度8なら最大12となる。各leafは一つのSplitにつき片側の半平面だけを通る。深度と頂点上限はこの関係を保って変更する。解除後も初期版は12頂点を保持するが、後続の自由頂点編集では分割木の深度による根拠がなくなるため、上限を別途決め直す。

finite値、法線の正規化、IDの一意性、木の深度、内枠の包含、正の面積、線が対象領域を二分できること、非負gapを検証する。細すぎるコマやgapで消える領域を拒否する下限はDesign座標でAABB各辺1、面積1とし、実装で同じ値をUI/headless/importへ適用する。読みやすい最小サイズの保証ではない。

全leafはそのページの `panelIds` と一対一対応し、同じpanelを複数leafへ置けない。未知field/schema、自己交差、凹polygon、循環木、欠落panel、他ページのpanel、範囲外頂点、形状の不一致は拒否する。サイズ/深度検査は再帰的なgeometry計算より先に行う。

### 通常Designからも壊れないこと

共通validatorとcommandの適用境界で連動を守る。通常Designへ切り替えても、連動panelだけを汎用resize・shape変更・親変更して不整合を作ることはできない。対応操作は同じ境界commandへ接続し、それ以外は「ページのコマを連動中」と理由を示し、境界編集または連動解除へ案内する。

ページ全体の平行移動は子要素を一緒に移動し、page localなdivisionを保つ。ページのresizeは内枠・境界・作画の扱いを示す専用previewができるまで拒否し、通常のresizeを透過させない。読み順変更はgeometryを変えない。頁外要素の編集は従来どおり可能にする。

「このページの連動を解除」は一つのUndo対象で、divisionだけを除き、各panelのpolygon、ID、作画位置を保持する。schemaを元へ戻す操作ではない。解除後はpolygonの通常移動・resizeを可能にし、形状presetへの変更はpolygonを置換する明示編集になる。分割木の自動推測・再構築はしない。

解除時点の見た目は保持するが、その後の独立移動・非等方resizeでは斜辺の角度や隣との間隔が変わる。連動を解いた後の意図した挙動であり、gapの一致や隣接コマへの追従は保証しない。通常frameの移動・resizeでは作画も既存constraintに従う。polygon panel自体の回転・auto-layoutは解除後も初期範囲外としてUI/command/importで拒否する。作画要素の回転と区別して理由を示す。

## 7. 操作・履歴・提案

以下のoperation名は未実装の案。既存M0 adapterのclosed unionは黙って広げず、新schemaに対応するpage proposal adapterとして宣言する。最初はpage content全体をread依存として保守的にstale判定する。

| 操作 / operation案          | Atomic単位とID・作画の扱い                                                                                    | 拒否・Cancel                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 連動開始 / `startDivision`  | 選んだページの全panel対応・内枠・分割木・polygonをpreviewし1編集。既存IDを保持。空ページなら初期1panelを作る  | 未対応形状を無断近似しない。対応不足・上限・取消で無変更            |
| コマ分割 / `splitPanel`     | 明示した側が元panel IDと作画を保持し、他方に新IDの空コマを作る。tree・frame・読み順を1編集で更新              | 新ID衝突、領域消失を拒否。既存作画を両コマへ複製しない              |
| 境界・間隔 / `setDivider`   | 影響する全leafを同時更新。有効範囲に制限したgesture previewの確定が1Undo。子のworld座標と子境界の指定値は不変 | 確定commandの範囲外・失われるleaf・古いbaseは全体拒否               |
| コマ結合 / `mergePanels`    | 初期は同じ親splitの2leafのみ。残すpanel IDを明示し、子ID・world位置を保って集約。除去IDへの参照はorphan       | 非兄弟や子splitを含む結合は非対応。参照を残す側へ勝手に付け替えない |
| 連動解除 / `detachDivision` | ページ全体を解除。polygonと作画を保持、1Undoで連動へ戻る                                                      | read-only等では無変更                                               |
| 読み順・台詞・画像位置      | 既存の対応commandを再利用。geometryとの依存がある場合は同じproposal内に明示                                   | 入力guard、権限、baseの検査を省略しない                             |

コマ削除は連動領域に穴を作らないよう、結合・作画だけの消去・連動解除を明示的に選ぶ。Deleteを隣接コマの拡大へ暗黙変換しない。ページ全体の削除は既存の子削除とpagination cleanupにdivisionの削除を含める。

`splitPanel` は元IDを残す側a/bと、新panelの挿入位置 `insert: 'after' | 'before'` を明示する。UIの既定は元panelの直後（after）で、rtl/ltrや縦・横・斜めの分割から順序を暗黙に推定しない。previewに番号と読み方向を表示し、新旧2コマの順序を入れ替えた場合はbeforeとして同じsplit commandへ含める。例えば `[P0, P1, P2]` のP1を分割すると、既定は `[P0, P1, new, P2]`、入替時は `[P0, new, P1, P2]`。他のコマ同士の順序は保つ。さらに離れた位置への並べ替えは既存の読み順commandを使う。

ページ複製はelement IDに加えdivider IDとleaf参照を一括remapする。コマ単独の複製・他ページへの移動・clipboard貼り付けは、連動中は初期範囲外として拒否する。先に解除すれば既存の対応範囲で操作できる。native importは原稿内IDを保持し、別Artifactとしての取り込みはHostの既存衝突規約に従う。

外部提案では、対象Artifact/version・draft revision、参照版、影響コマ、変更理由を表示する。「一つの境界と両側のコマ」は分離不能な採用単位にする。片側だけ採用して隙間や重なりを作らない。構図や台詞がその境界に依存するときは依存unitを明示し、選択した閉包から新規proposalを作り直して再previewする。

previewは無変更、採用は1transaction/1Undo、rejectは無変更。採用直前にも権限・base・参照版を検査する。新しいIDはproposal準備時に確保し、再描画やRedoのたびに発行しない。失敗した途中のframeやtreeを残さない。画面切替だけではproposalをstaleにしないが、文字の確定等でrevisionが変われば再比較する。

## 8. 保存・移行・互換性

漫画画面だけを先行実装する段階ではschema変更を不要とする。分割木/polygonを初めて採用する明示編集でdraftをDesign schema 4、pagination schema 2へ移す。旧schema 1〜3とpagination 1は読み取り、従来の編集を続けられる。過去の確定版のbytes/hashは書き換えない。restoreはその版のschemaを保ち、新機能の再使用時に再び明示移行する。

schema移行と最初のgeometry編集は同じatomic command・同じUndo対象にする。UndoはschemaVersionとpaginationを含む移行前のcontentへ戻し、canonical JSONとcontent hashの一致を確認する。移行だけを残す別履歴を作らない。Redoは同じpanel/divider IDで移行後のcontentを復元する。既存の確定版を書き換えたり、Undoのために削除したりしない。

schema 3等のdraft revisionで準備した別proposalは、移行後のdraftではstaleとして拒否する。Undoでcontent hashが元へ戻ってもlocal revisionは巻き戻さないため、その古いproposalを自動で有効に戻さない。現在のschema・revisionから再準備し、再previewする。移行自体を含むproposalは移行前のbaseで一度検証・採用するもので、この古い別proposalの再適用とは区別する。

新schemaを旧readerへ矩形に近似して渡すfallbackは作らない。対応しないHostは理由付きで拒否する。Hostのfactory/validator、domain reader、page adapter、captureとnative importを同じ段階で対応させる。native importはdraftだけでなく全retained version、hash、参照closure、polygon/treeの整合を確認し、失敗時は全体を取り込まない。

画像の出典・利用条件、既存の参照snapshot・元版の扱いを保持する。境界編集が新しい画像を生成したり既存assetを削除したりしない。欠落素材は警告し、欠落を隠した最終出力を成功扱いしない。外部AI生成、素材取得・license確認はHostの責務である。

保存は既存のdraft更新・確定版commit・adapterを通す。切替で追加保存を要求せず、dirtyな編集は両画面で同じ保存状態を示す。保存失敗はdraftを保持し、retry、遅延完了、別版への切替で取り違えない。端末内保存を環境外checkpointと同一視しない。大容量・offline・別環境復旧のC09は全体設計の別受入に残す。

## 9. 宣言能力と非対応

以下は新しい漫画画面・分割境界subsetの目標。すべて実装予定で、今回検証済みの機能はない。通常Designの既存能力を全面的に無効にする表ではない。

| 能力                   | UI / headless / sharedの範囲                                                                     | 受入条件               |
| ---------------------- | ------------------------------------------------------------------------------------------------ | ---------------------- |
| Viewer・local編集      | 両画面で同じ原稿。公開packageだけで独立Hostへ接続                                                | N01〜N09、N11、N14     |
| Native text・ペン      | 既存の水平text・入力を再利用。切替中のIME/gestureを保護。筆圧・縦書きは追加しない                | C01、N05、N11          |
| 選択・参照             | page/panel/子要素は安定ID。削除でorphan、版違いでoutdated。汎用region annotationの拡張は対象外   | N08、C02               |
| Proposal・headless     | pure validator/commands、base・権限・依存、preview/apply/rejectをUIと共有                        | N02、N04、N09、C03     |
| Native JSON            | 新旧draft/retained versionとhashを検査。未知schema拒否                                           | N03、N10、N12          |
| ページSVG/PNG/PDF      | 同じexact version・読み順・polygon/clip。現行PDFのrasterという制限を継続                         | C07                    |
| Shared                 | 新subsetは非対応。wire/authority/selective Undoを追加受入するまでshared入口を拒否                | C04、S01〜S06は範囲外  |
| Template・linked reuse | 新schemaのwhole/fragment/preset登録・reuseは非対応。既存の拒否を拡張し、分割木を落として渡さない | C05、C06は範囲外       |
| React bridge           | 新subsetのReact原本・変換・再生成は非対応、入口で拒否                                            | C08は範囲外            |
| 保存復旧・実機         | 今回は追加のdurability、実機ペン、screen reader対応を宣言しない                                  | C09、C10の拡張は別受入 |

将来、作者がコマ割り道具を改良できるよう、分割操作をdeterministicなdata commandとして設計する。ただし初期版にユーザーscript実行、別preset catalog、macro runtimeを導入しない。再利用可能なレイアウトは既存template/preset契約に沿って、ID remap・版・原子性のC05を後続で満たす。

## 10. 実装順と受入計画

| 段階                | 主な変更箇所                                                                                                                        | 完了条件                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| A: 共存する画面     | `packages/design/src/view.tsx`、`view-panels.tsx`と漫画用UI部品、Playgroundの`app/editor-surfaces.tsx`・作成導線・Host view state   | 同じsession・原稿・選択・履歴で往復。既存通常Designの回帰と独立Host試験。schema変更なし |
| B: 境界のmodel      | Designの`model.ts`、`pagination-contract.ts`、`pagination.ts`、新geometry helper、editor-coreの描画・clip・hit判定、Hostのvalidator | 分割/間隔/結合/解除、ID・byte上限、移行・native import。全変更入口で整合性を守る        |
| C: 編集と提案の接続 | 境界UI、共同ネームreview/adapter、captureと出力、通常Host/独立Host                                                                  | 画面操作・headless・出力が同じ形状。部分採用・Undo・stale・拒否を検証                   |
| D: 通読と引継ぎ     | 固定の2ページ作品、操作デモ、契約・ガイド・対応表・検証記録                                                                         | 原稿と実出力の比較、読みやすさの人によるレビュー、保存/importで編集を再開               |

Aだけを公開してコマ割り改善が完了したとはしない。Bの新schemaを一般の編集入口へ公開するのはCの描画・選択・出力・保存が揃ってからとする。先行する共同ネーム実装の全体マージは前提にせず、必要な基盤を現行mainへ抽出してA〜Cを組み立てる。未取り込みのAPIを存在する前提でimportせず、接続する型・validator・commandを同じ変更で揃える。

### 先行実装から引き継ぐ範囲

全体をそのまま取り込むと、置き換える予定の配置操作とUIも通常Designの契約になる。一方、全実装を捨てると、提案の安全な採用境界やclip/選択の修正と回帰試験まで作り直す必要がある。必要な基盤と試験を引き継ぎ、コマ割りのmodelと入口を本案に合わせて組み直す方針を提案する。

| 先行実装の領域                                                | 再利用の方針                                                                                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 対象版・参照版・権限の再検査、依存関係付き部分採用、1 Undo    | 基盤と拒否試験を再利用。新しい分割・結合を扱うoperationと意味的diffは追加設計する。現行diffは要素の追加/削除を対応外とするため、そのままでは使えない |
| 描画・祖先clip・範囲選択・回転要素の整合                      | 共通処理と回帰試験を再利用し、任意の凸polygonへ拡張。固定形状のenumだけに新境界を押し込めない                                                        |
| 2ページの比較部品、Hostの入力flush・適用境界                  | 再利用候補。漫画画面の比較UIへ接続し、通常/独立Hostの両方で再検証する                                                                                |
| Pages内の形状選択と別dialog中心の共同ネームUI                 | 漫画ワークスペースの選択対象に応じた操作へ置き換える。通常Designの汎用図形編集は保持する                                                             |
| 固定形状を並べる配置候補、先頭2コマを一律に交換する読み順候補 | 初期漫画機能には採用しない。分割木・共有境界・演出意図を扱う提案へ置き換える                                                                         |
| 既存デモscriptとfixture                                       | 調査・回帰の材料として保全。新操作のデモはW01〜W10と2ページ8コマの通読fixtureに合わせて作り直す                                                      |

先行のbounds変更は汎用frame transformを使い、子のconstraintに応じて作画も移動・resizeする。境界だけを動かす `setDivider` の代用にはしない。初期の提案operationも固定メンバーの位置・形状・読み順を扱うもので、分割・結合・ページ移動まで実装済みとは扱わない。

未マージの試作APIや配置候補を、互換性のためだけに恒久的に残さない。mainで提供しているkind・旧schema・native原稿・M0 APIは引き続き保持する。抽出後は新しいsourceで回帰を取り直し、先行実装のレビューやテスト結果をそのまま合格根拠にしない。

### 固定する操作シナリオ

| ID  | 操作と合格条件                                                                                                                                                                                                                                              | 条件ID                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| W01 | 漫画を新規作成→台詞・線→Designで追筆→漫画へ戻る。ID/選択を保持し、切替自体はhash/revision/history不変。編集を跨いでUndo/Redo可能                                                                                                                            | N01、N03〜N08、N14           |
| W02 | ページなし・既存paginationあり・ページ外要素ありを開く。切替だけでは登録/移動/削除しない。setupは1Undo                                                                                                                                                      | N03、N04、N07                |
| W03 | 直線/斜線分割、間隔変更、T字接続の親境界の移動。子境界の指定値・絵のworld座標/cropを保持し、端点と全leafを再計算。限界のgestureはclampし表示値を採用、同じ範囲外の数値/headless/proposalは無変更で拒否。原点をずらしたpage/region、深度8/12頂点と超過も確認 | N02、N04、N05、N08           |
| W04 | 通常Design、shortcut、paste、headlessから連動panelの単独resize/親変更/削除を拒否。解除・複製は原子的。解除後の独立移動/非等方resizeで角度・gapは変化できるが、polygon panel/pageの回転・auto-layoutは引き続き拒否。通常shapeの既存回転は保持                | N02、N04、N09、N12           |
| W05 | 提案の境界unitを選択→依存を含め再preview→部分採用→追筆。片側採用・古いbase・権限変更は拒否。採用は1Undo                                                                                                                                                     | C03、N04、N05、N09           |
| W06 | 台詞composition・未確定buffer・ペンgesture・保存失敗中に切替。Hostからpropを直接変更した場合も入力を失わず、失敗は表示。Escape/keyboard・focus復帰を確認                                                                                                    | C01、N05、N09、N11           |
| W07 | rtl/ltr、縦/横/斜め、元IDを残す側a/bでsplit。既定afterとpreviewで選ぶbeforeの順序を確認し、他コマの相対順序を保持。split/mergeのID、削除参照のorphan、元版固定、restore/複製後の対象も確認                                                                  | N04、N08、C02                |
| W08 | 新旧schemaの保存/reload/native roundtrip、retained versionのhash、破損/byte上限/遅延保存の原子性とretry。初回移行のUndoで旧schemaとcanonical JSON/hash、Redoで新schemaとIDを再現。移行後とUndo後の両方で古いproposalをstale拒否                             | N03、N05、N10、N12、C03      |
| W09 | 固定版を見開き・SVG・PNG・PDFで比較。鋭角三角形を含め、bevel join・内側の枠線・gap・文字・画像比率・clip・missing assetを確認。同じ倍率/画素数で比較し、枠線がpolygon外へ突き出ない                                                                         | C07、N13                     |
| W10 | 通常/独立Host、1440×900と390×844 containerで代表操作。read-only・非対応adapterを理由付きで拒否し、console errorを残さない                                                                                                                                   | N06、N07、N09、N11、N13、N14 |

最初の通読fixtureは同じ脚本を使う2ページ8コマの冒険場面とする。1ページ目は港の危機→主人公の反応→ロープが留め具に掛かる接触点→大きな跳躍。中段と下段の間だけ斜めの共有境界を使い、外枠はページの内枠に揃える。2ページ目は鎖の落下→仲間の反応→羅針盤の手元→横長の出航。円形の羅針盤は絵の中に残し、枠は矩形にする。接触点の追加に合わせて8コマへ構成し直す。

粗いネームで読み順、行動の因果、台詞の面積、見せ場を確認してから作画する。絵があるfixtureだけでなく、nativeな線・文字を直接直すfixtureを含める。生成画像の配置・層分離と、直接描画の編集品質は別に判定する。読みやすさ・線画の品質は人が通読して判断し、geometry検証だけで合格にしない。

実装時はlint、file policy、tooling、typecheck、unit、build、通常/独立Hostのbrowser確認を行い、screenshotと出力を目視する。合成composition eventとOSのnative IME確認を分け、未実施実機・browser・readerをNOT RUNと記録する。ここに示したサイズは機能fixtureであり性能測定ではない。追加の性能測定、製品試用、公開同期、deploymentの条件をこの計画から拡張しない。

## 11. 残る判断と後続範囲

レビューでは、専用入口と共通原稿、ページ単位の直線分割、連動解除、既存作画を動かさない境界編集、shared等の非対応境界を確認する。上限と小さすぎるコマの判定値は実装・ネーム試作で妥当性を確かめ、変更する場合はschema/validator/受入fixtureを一緒に更新する。

自由な頂点編集、曲線境界、差し込み/重なりコマ、ページを跨ぐ1コマ、裁ち落としを含む印刷製版、縦書き・ルビ、筆圧ブラシ、Raster独立domainは後続の設計に残す。分割木の制約で必要な表現が作れないと判明した場合は、自由polygonを参照する境界graphへの拡張を別途比較する。初期版へ未検証の汎用graphを先回りして追加しない。

初期範囲の受入後は、差し込み/重なりコマと連動コマの同一ページ内での共存を優先候補にする。読み順・z-order・clip・選択・参照を定義してから対応を広げる。解除後のpolygon panelの回転・auto-layoutも別の後続能力とし、初期版の非対応を解除操作で回避できるとはしない。
