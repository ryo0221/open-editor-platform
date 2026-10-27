# CADとDesignの2D曲線・編集基盤の共通化

## 1. 今回決める境界

1. **正本・拘束・command・履歴は各domainに残す。** P1/P2では統一曲線unionや `evaluateCurve2` dispatchを作らず、必要な種類別の計算を公開する。
2. **Designが使うBézier計算から始める。** CADのB-splineはまずCAD内の重複を整理し、Designが区間分解・曲率表示・転送に使う段階で既存処理を共通層へ移す。
3. **CADのUI移行をDesignの完了条件にしない。** CanvasStageの入力調停と軽い点編集部品を分け、CADが後で採用できる独立subpathを用意する。
4. **Design schema3の構造化pathを正本にする。** 旧vectorは読込時に変更せず、直接所有するshapeだけを初期編集対象にする。
5. **P2はlocal編集・保存までを受け入れる。** 未対応の共有・component/reuse・外部変換経路ではpathを黙って欠落させず、理由付きで拒否する。
6. **schema3は入口ごとの明示opt-inとする。** 既存`isDesign`をschema1/2専用として維持し、対応・未対応の全callerを棚卸ししてfail-closedにする。

| 項目               | 内容                                                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状態 / 版 / 更新日 | **設計提案・未実装** / 0.3 / 2026-10-26                                                                                                                    |
| 対象               | 既存の `cad` と `design`。新しいArtifact kindは作らない                                                                                                    |
| 主なpackage        | `geometry-core`、`cad-core`、`canvas-ui`、`design`。CAD UIの採用は任意の後続変更                                                                           |
| 対象範囲           | P1/P2の境界・保存モデル・受け入れ。後続能力は追加時に設計する                                                                                              |
| 関連文書           | [設計テンプレート](../editor-proposal-template.md)・[受け入れ条件](../editor-acceptance.md)・検証記録 |

CADで開発した処理を活用し、Designへベクター制作を追加する。初期の直接共有量は限定し、具体的な利用箇所に合わせて共有範囲を広げる。
以下の新API、schema、UIは提案であり、現在の対応能力を示すものではない。段階実装・検証は[実装計画](implementation-plan.md)、操作は[ガイド](guide.md)を参照する。実装追跡はIssue #502を参照する。

## 2. 利用者・範囲と現行実装

ロゴや図版を制作する利用者のため、既存Designのshape・レイヤー・スタイル・Artifactライフサイクルを利用する。
P2の代表操作は、用意したline/cubic pathの追加、anchor/handleの移動・座標入力・mode切替、Undo/Redo、保存→reload→native JSON往復とする。
CADの既存スケッチ操作は維持する。拘束不成立、staleな編集、非対応の保存箇所へのpath混入は、理由付きで拒否し部分変更を残さない。

| 現行実装                                                                                                             | 初期段階での扱い                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [CAD sketch](../../packages/cad-core/src/sketch.ts) / [curvature](../../packages/cad-core/src/curvature.ts)          | 非有理B-splineの評価・微分・knot生成の重複をCAD内で整理。次数2/3/5、uniform clamped/periodic、sampling、mm由来の方針を保つ |
| [SketchCanvas](../../packages/cad/src/sketch-mode.tsx) / [draft](../../packages/cad/src/sketch-draft.ts)             | 独自SVG、solver、点IDへのsnap、Finishの既存経路を維持。P2のためのUI移行は行わない                                          |
| [CanvasStage](../../packages/canvas-ui/src/index.tsx)                                                                | 点編集とobject編集の入力所有権を調停する。点編集部品はrootとは独立させる                                                   |
| [DesignVector](../../packages/design/src/vector.ts) / [model](../../packages/design/src/model.ts)                    | viewBox・SVG path文字列・provenanceを持つ既存vectorを保存したまま、構造化pathを追加する                                    |
| [geometry-core](../../packages/geometry-core/src/index.ts) / ADR 017 | 既存P21 APIとkernel境界を維持。pureなBézier関数を追加し、OCCT依存を持ち込まない                                            |

penによる自由作図、split/delete、SVGからの明示変換、CADとの転送は後続。ラスターペイント、PSD/AI互換、組版、Boolean/offsetは今回扱わない。
認証・永続化・AI実行・外部処理はHostが担当する。新しい履歴stack、asset store、runtimeは追加しない。

## 3. 計算の境界と共有を広げる条件

Designで使う三次Bézierには、`evaluateBezier3`、微分、`splitBezier3`等の種類別APIを
`@editor-platform/geometry-core/bezier` 相当の公開subpathへ置く案とする。純粋な座標値を受け取り、domainのID・文書・履歴を持たない。
最初の実利用者として既存Animationの三次曲線評価・微分を共通計算へ接続する。`animation-core`→`geometry-core`の新しい依存はworkspace manifest/lockの変更を伴うため、他の統合作業と競合を調整する。
既存Animation fixtureで、同じ入力の座標・微分・向きが`Object.is`で一致することを優先して検証し、演算順序の変更による差を検出する。追加する分割・bboxの数値試験とは分け、どうしてもbitwise一致しない場合は差と根拠を記録してレビューする。
必要なparameter区間、finite値、退化入力、数値許容誤差を関数ごとに定める。統一dispatchを必要とする利用箇所がないため、P1/P2では追加しない。

paint boundsに必要な範囲のBézier bboxは対象にできる。snap候補の計算も必要なpure関数に限定する。
精密な最近点探索・汎用曲線エンジンを一括で実装せず、hit testは画面精度・上限を明示する。点列を保存形状やBooleanの正解にしない。

CAD内では `splinePoints`、`splineComb` 等から重複したde Boor・微分・knot生成を抽出し、既存公開関数はwrapperとして保つ。
CADのnative schema、constraint/solver、unit/tolerance、計算順序・samplingを変更しない。`packages/cad-core/src/fixtures.ts`の独立したCox–de Boor参照実装は抽出対象に含めず、変更前後を照合する別系統の検証として保持する。`splinePoints`の端点補正と`splineComb`の評価方式の相違も維持する。この整理はDesignの着手・完了の前提ではない。

**DesignがB-splineの区間分解、曲率表示、CADからの曲線転送を必要とした時点で、整理済みのCAD計算をgeometry-coreへ抽出する。**
Design側に同等のB-spline処理を重複実装しない。抽出時は第二consumerの入力・診断・精度を確認し、公開APIと回帰条件を定める。
数学的な表現変換、target domainの受入可否、pole/constraintとanchor/handleの編集意味の往復を別に扱う。
次数2/3のB-spline→Bézier区間分解と、次数5や円弧→三次の近似を同一視せず、未対応変換を黙ってflattenしない。

`geometry-core`へReact/DOM、CAD/Design、OCCTへの依存を加えない。DesignからCAD内部をimportしない。
既存の [geometry-kernel-occt](../../packages/geometry-kernel-occt/README.md) とCADの評価adapterは別の責務として維持する。

## 4. 点編集UIと座標

| 対象                                     | 責務・依存                                                                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canvas-ui/path-handles` 相当の新subpath | 点・handle・制御線、画面距離のhit test、gestureの開始/preview/commit要求/cancel。root barrel、CanvasStage、text engine、export moduleをimportしない |
| CanvasStage                              | point/objectの入力所有権、既存camera・toolbar・textとの調停。点編集部品から逆にCanvasStageへ依存しない                                              |
| Design adapter                           | native値の投影、座標変換、操作可否、snap候補、native commandの生成・送出                                                                            |
| CAD                                      | 現行SketchCanvasを維持。軽い部品が実際に役立つ段階で採用を別途判断する                                                                              |

`@editor-platform/geo-inspector/point-edit`はGeoのPoint属性のフォーム編集であり、このpath anchor/handle編集とは責務が異なる。新しい公開subpath名は`canvas-ui/path-handles`相当として区別する。
subpath名だけでなくimport graphを分離する。CADからrootをimportすることを前提にせず、将来採用時もtext/exportの推移的依存を導入しない。
共通部品はdomain controllerやEditorSessionを所有せず、snap候補の確定・点ID共有・拘束作成も行わない。

Design adapterは **local → element → world → screen** と逆変換を定める。rotation、flip、親変換、zoomを含め、非可逆な変換では編集を開始しない。
hit toleranceはCSS pxで扱う。後でCADへ採用する場合も、mm/pxやy軸方向を部品へ固定しない。
点編集中はobject resize/rotateを止め、Delete・矢印・Escapeのownerを明示する。text input/IME、toolbar、pan/zoomを横取りしない。
P2の点編集中のDeleteは未対応として理由付きで拒否し、通常shapeの削除へ流さない。要素を削除するときは点編集を終了して通常操作を使う。
keyboardで点を選択・移動する入口、座標入力、操作名とfocus復帰を備える。`canvasOwner`を点編集フックへ転用しない。

現行 [Drawing.vector](../../packages/editor-core/src/drawing.ts) のaspect-fit/clipを新pathに流用せず、描画専用の `Drawing.path` 相当を追加する。D2で描画DTOを増やしてもschema3を受理せず、path fixtureはDesign内の閉じたテスト経路でのみ使う。既存Drawing consumerへ未検証pathを流さず、D3の入口対応・拒否を整えてから外部へ公開する。
local frameは点編集の間固定し、frame外の点も描く。派生paint boundsを描画・hit test・選択・export範囲へ反映する。
点編集によるbounds再計算で全曲線を再fitせず、未編集点のworld座標を保つ。明示的なobject移動/resize/rotateは別操作として全曲線に適用する。
camera、点選択、preview、点列・paint boundsのcacheはcontent/hashへ保存しない。

## 5. Native pathと入力検証

`DesignContent.schemaVersion: 3` を編集可能パスの導入境界とする。既存の通常shapeに `path?: DesignEditablePath` を追加し、`vector` と排他的にする。
SVG文字列は派生値とし、構造化pathとの二重の正本にしない。

| 保存項目               | 意味                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------- |
| local frame            | 点編集時に自動fitしない座標枠                                                         |
| subpaths               | 安定ID、anchor/segmentの順序、open/closed。closedは最後→最初の明示segmentを含む循環列 |
| anchors                | 安定ID、local座標、corner/smooth/symmetricの編集方針                                  |
| segments               | 安定ID、始終anchor ID、line/cubic。cubicは2 control点をlocal座標で持つ                |
| fill rule / appearance | nonzero/evenodd、要素単位のfill/stroke。subpath別paintは後続                          |
| provenance             | 変換元に由来情報がある場合に保持。手描きpathへ架空のsource/licenseを付けない          |

control点のidentityはsegment IDと側で表す。移動・保存でIDを再生成せず、Undoは元IDを復元する。
IDと参照はunique・整合を検証し、duplicate等を追加する場合はatomicにremapする。配列indexをIDにしない。
Designでは自己交差、controlとanchorの座標一致、明示的なzero-length segmentを許容する。CADのregion制約を適用しない。
確定pathは1 segment以上とし、1点だけの作図状態はprivate previewに留める。空になったpathは同じcommandでshapeを削除する。

### 5.1 許可する保存箇所と上限

**schema3はfail-closedで導入する。** 現行の`isDesign(value)`は既存のschema1/2専用predicateとして維持し、schema3を扱うと明示したDomain/Host入口だけが独立したv3対応predicate（実装時に名称を決める）を使用する。単に`isDesign`の受理versionを3へ広げてはならない。公開入口ごとにread/create/edit/export/restoreの対応可否を固定し、未対応呼び出し元では旧schemaに自動変換せず拒否する。D3ではテスト以外の**全`isDesign`呼び出し元の一覧と、path有無・schema3の扱い表**を作成・検証する。

確認済みの棚卸し対象は、`apps/playground/src/app/import-artifact.ts`、`apps/playground/src/artifact-references.ts`、`apps/playground/src/reference-host.tsx`、`apps/playground/src/app/version-views.tsx`、`packages/template-ui/src/preview.tsx`、`packages/design/src/component-publication.ts`、shared codec/authority、Host native import/restore、template/reuse、React、Animation adapter。列挙は網羅リストではないため、実装時にコード検索とimport graphで増減を確認する。

P2では直接所有する `elements[]` の通常shapeだけにpathを許可する。domain validatorは次のnative格納箇所を区別する。

- `elements[*].overrides` とその入れ子にあるpathは拒否する。
- `components[*].elements`、`components[*].template` とその内部のoverrideにあるpathは拒否する。
- instance、linked/reuse定義、React由来要素へpathを持ち込む非対応操作は拒否する。
- schema1/2内のpath、path/vector併存、未知schema・未知segment、壊れたID参照を拒否する。

通常elementの型追加だけで上記を許可しない。**`path`と`vector`の排他は、直接shapeだけでなく全格納文脈・旧schema・patch・import/restoreの各入口で拒否する。** native格納箇所を理解するvalidatorをcommand、import、restore、draft/全retained version、
headless、proposal、shared authorityに適用する。UIの禁止や汎用 `Partial<DesignElement>` の型だけに依存しない。

提案上限は1 shapeあたり128 subpaths・4,096 anchors/segments、Design全体で16,384 anchors/segments・path JSON合計8 MiB、座標絶対値1,000,000以下。
finite値、既存のID長・bounds等、Host/参照先のより小さな上限も検証する。これらは入力境界であり性能保証ではない。
**Hostのnative JSON上限はdraftと全retained versionを合わせたArtifact全体で16 MiB**（`packages/editor-host/src/index.ts`の`MAX_NATIVE_BYTES`）。Designのpath JSON 8 MiBは局所的な受理上限であり、Hostで保存できる保証値ではない。serialize後のArtifact総byteを事前検査し、超過時は保存失敗として未保存draftとUndoを保持し、Saved表示をしない。容量を減らせる操作後に再試行できるようにする。Host上限の緩和や過去versionの黙った削除は行わない。

### 5.2 旧データと後続拡張

schema1/2と既存DesignVectorは読込時に変更しない。最初のpath作成でschema3化と作成を1 transactionにし、Undoで移行前のdraftへ戻す。
既存vectorからの変換は後続の明示操作とする。旧versionのbytes/hashを変更せず、restoreは現在draftへの新しい編集にする。
旧readerはschema3を明示拒否する。新readerはdraft/全versionを検証し、変換失敗で元のgeometry/provenanceを消さない。

schema3はeditable path対応を表す。後続のpath拡張は局所的に管理する方針とし、独立path versionを今すぐ追加しない。
optionalな追加を互換とするのは、既存readerで意味と保存内容を損なわないと確認できる場合だけとする。
clip/mask、塗り分け等の意味を変える拡張は、未知version・未対応機能を明示拒否できる形式で追加し、黙って無視・欠落させない。

### 5.3 Anchor mode

modeは編集時の連動方針であり、保存されたcontrol座標の対称性・滑らかさを保証する不変条件ではない。
native読込時に形状を補正しない。後続のSVG変換ではmode情報がないためcornerを既定とし、対称性から勝手にmodeを推定しない。
smooth/symmetricの連動は明示mode切替またはhandle操作で適用し、単なるanchorの移動で勝手に対称化しない。
modeとcontrol座標を変える操作は1 native command/Undoにする。UIもmodeを現在形状の対称性保証として表示しない。

## 6. Command・履歴・保存と能力の拒否

Designのpointer moveはprivate preview、pointerupは1 native commandとし、**1 gesture = 1 Undo**にする。no-op/cancel/拒否では履歴を作らない。
既存EditorSessionを利用し、dragをtyping用mergeKeyでまとめない。CADのsolver/draft/Finish単位は維持する。
pointercancel、capture喪失、Escape、detach、対象削除、readOnly/権限変更でpreviewを取り消す。
確定時も対象・locked/readOnly・元path・座標変換の依存を再検証する。UIとheadlessは同じpure command境界を通す。

gesture中のsave/export/restoreはguardし、確定済みdraftを既存StorageAdapterで保存する。保存失敗をSavedと表示せず、retryと遅延完了を扱う。
native importはenvelope、draft/全versionのdomain validationとhashを確認し、失敗時は作成全体を取り消す。

| 能力                                                | P2の宣言・拒否                                                                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local / native保存                                  | 通常shapeのpath作成・点編集・履歴・JSON往復を受け入れる。外部の選択通知はelement単位、点選択はprivate                                                                           |
| Shared                                              | schema3の接続を拒否。既存schema1/2 sessionへのcommand/proposal/headless/restore/component更新によるschema3/path導入もpreparationとtrusted authorityで拒否。local fallbackしない |
| Proposal / template / reuse / component / React連携 | path操作・pathを含む非対応payloadを理由付きで拒否。対応済みと宣言する段階で各adapterを受け入れる                                                                                |
| SVG変換・外部形式                                   | pathの安全な表示projectionを用意する。外部形式の機能はpath-awareに検証できる範囲だけを有効化し、非対応export/importは拒否。nativeの完全性と外部形式のlossを分ける               |
| 狭いcontainer・mobile                               | 閲覧・選択・既存操作を維持し、未受け入れの点作図は理由を示して無効化。viewport・touch・実機を別々に判定                                                                         |

既存schema1/2の対応能力は維持する。非対応判定でgeometryを黙って落としたり、旧schemaやvectorへ自動flattenしたりしない。

既存の`vector`を名指しで拒否・説明・消去する経路は、path追加後に**拒否漏れやデータ消失を起こし得る**。D2/D3で`.vector`の使用箇所（例：`rg '\.vector\b'`）とshape変換入口を網羅的に棚卸しし、少なくとも次を確認する。

| 経路                                               | 新pathへの対応方針                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `packages/animation-adapters/src/index.ts`         | Design→Animationで未対応pathを診断付きで拒否。rectangle等の既定shapeへ黙って置換しない |
| `packages/design-react-core/src/convert-native.ts` | React変換前に未対応pathを診断付きで拒否し、形状の欠落を成功扱いしない                  |
| `packages/design-react-core/src/commands.ts`       | React化でpathが残って不正な型になることを拒否・検証。安易な削除による内容の消失も禁止  |
| `packages/editor-core/src/describe.ts`             | 診断・説明でpathが落ちないよう、path-awareな概要または明示的な未対応診断を返す         |

この表も全経路を列挙したものではない。legacy predicateの全callerとvector特殊処理の双方を、D3の完了条件にする。

## 7. 実装順とP1/P2の受け入れ

| 段階         | 変更                                                                                              | 依存・完了条件                                               |
| ------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| P1・CAD側    | CAD内のB-spline計算の重複整理                                                                     | V02・V04。Designの着手・完了とは独立                         |
| P1・Design側 | 必要な種類別Bézier関数                                                                            | V01・V03。統一曲線型やB-spline移動を前提にしない             |
| P2           | Design path/model/commands/projection、独立した点編集部品、CanvasStageの入力調停、保存・能力guard | Design側P1に依存。V05–V09・V12。CAD UI採用は必須条件にしない |

既存の条件IDを保持し、0.2で対象を絞った方針に対して0.3でschema3の段階導入を補強する。V02/V04はCAD側を変更する段階の回帰、V11はSVG変換を導入する後続段階の条件とする。

| ID  | 期待結果                                                                                                                                                          | 既存条件           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| V01 | pureな種類別APIを公開subpathから利用でき、geometry-coreにdomain/React/OCCT依存がない                                                                              | N02・N06・N13      |
| V02 | CADの評価・微分・knots・samplingを既存fixtureで維持。保存/hash、影響するkernel評価・STEP出力を同じ条件で比較する                                                  | N02・N10・N13      |
| V03 | Bézierの評価/微分/分割を解析解・独立した検証で確認し、不正値・退化・上限を明示的に扱う                                                                            | N02・N12           |
| V04 | CADの点移動、solver refusal、Finish/Cancel、履歴単位に変更がない。DesignだけのP2へCAD UI移行のgateを課さない                                                      | N04・N05・N13      |
| V05 | 点操作とobject操作が二重発火せず、keyboard/IME/focus/cancelが正しい。path-handlesのimport graphがCanvasStage/text/exportに依存しない                              | N05・N09・N11      |
| V06 | zoom/rotation/flip/親変換でも位置が一致し、frame外の点をclipしない。点編集で未編集点のworld座標が不変                                                             | N02・N08・N11      |
| V07 | UI/headlessの1 gesture=1 Undo、拒否時無変更、readOnly/locked/stale検証が一致。読込時にmodeから形状を補正せず、mode/handle編集だけで連動を適用する                 | N04・N05・N09      |
| V08 | 旧schema不変、v3明示opt-in、path/vector排他、移行/Undo、save/reload/native往復、全version、16 MiB Host超過時のdraft保持/retry。override/component等への混入を拒否 | N03・N10・N12      |
| V09 | Playground/独立embedで代表操作を確認。全isDesign callerの対応表・vector特殊処理棚卸しによりshared/変換等の未対応入口を拒否し、geometryを欠落させない              | N06・N07・N09・N14 |
| V12 | 旧vector・通常図形・text、Slide/Whiteboard等のCanvasStage利用者と既存出力に回帰なし。宣言していない形式を成功扱いしない                                           | N13・N14           |

変更範囲に応じてfile/tooling/lint/typecheck/unit/buildとdesktop・独立Host・狭いviewportを検証する。
CAD変更時はV02/V04を実行し、Designのみの変更へ無関係な全kernel試験を追加しない。
browser specは [共通suites](../../tests/playwright/suites.ts) に登録し、[検証テンプレート](../editor-verification-template.md)で実行sourceとPASS/FAIL/NOT RUN/N/Aを記録する。

## 8. 後続能力と閉路の変換条件

pen、split/delete、CAD転送、shared、template/reuseは用途とadapterを具体化して別に設計する。
旧V10（制作操作）・V13（shared）は後続の条件とし、P1/P2の受け入れには含めない。共有履歴は既存authority/selective Undoの契約に従う。
外部libraryの採用は不足機能が具体化した段階で判断し、libraryのsceneをnative正本にしない。追加性能測定は今回行わず、数値budgetも別途固定する。

### V11: SVG閉路の往復（SVG変換の導入時に必須）

SVGの `Z` は始点へ閉じるsegmentを作り、始終点が同じ場合はゼロ長になり得る。閉路のjoinとopen pathのcapは区別する。
[SVG2 Pathsのclosepath・zero-lengthの規則](https://www.w3.org/TR/SVG2/paths.html)を前提に、native正規形ではclosedの末尾segmentを明示し、closure状態を保存する。
exportは末尾segmentを出してから `Z` を付ける。importでは閉路を二重追加せず、端点一致だけで既存cubicを消さない。

| 入力・状態              | 正規化と往復で確認すること                                             |
| ----------------------- | ---------------------------------------------------------------------- |
| 始終点が異なる `... Z`  | closing lineを1本だけ作る                                              |
| `... L x0 y0 Z`         | 明示closing lineを再利用し、余分なline/anchorを作らない                |
| `... C ... x0 y0 Z`     | closing cubicとcontrol点を保持する。端点一致は曲線長ゼロの判定にしない |
| openで始終座標が一致    | closedへ自動変更せず、cap/joinの意味を保つ                             |
| 明示的なzero-length L/C | closure由来の冗長なsegmentと混同して削除しない                         |

**正規化後のnative → SVG → nativeを繰り返しても、形状・segment数・開閉・cap/joinの意味が変わらないこと**を受け入れ条件にする。
元SVGの文字列やcommand数、SVGに出していないnative IDの一致は要求しない。対応parser、数値上限、許容誤差、loss/rejectを変換実装時に固定する。
SVGは任意markupとして挿入せず、許可したgeometryを検証する。未対応command・外部参照等は全体を理由付き拒否し、元vector/provenanceを保持する。
