# Design 再利用の文字とベクター (#255–#257)

設計版 1 / 2026-10-14。既存 Design への公開 API 能力追加。
製品の状態、画面構成、アイコン選択、原本の取得と利用許諾は Host が所有する。

## 代表操作と契約

`saveAsTemplate` と `authorReusableComponent` は任意の `overflow` を受け、
既存の policy/maxItems/minFontSize の既定を個別に上書きする。既定は従来どおり
minFontSize 16。Design の明示設定だけ 10 以上を受け入れ、他ドメインの検証下限 12
を維持する。設定は immutable な新定義に保存し、旧定義・version/hash を変更しない。

新規 Design 部品の登録と、overflow を明示した Design template は
`overflow.textScope: 'instance'` を保存し、差し替え後の実際の instance の文字を
検査する。expand は instance 自身の bounds override を拡張し、共有する component
定義の局所座標を変えない。この欄のない旧定義は従来の検査・拡張処理を保つ。
既存 template を読み直して新しい検査を暗黙に有効にすることはない。
サイズ変更した instance は描画と同じ投影後の幅・高さで文字を測り、必要な高さを
累積縮尺で割って局所 bounds override へ戻す。フォントの大きさは縮尺で変えない。
canvas と部品内の auto-layout を反映し、hug/fill の文字を拡張する場合は表示中の幅を
保って instance 側の sizing を fixed にする。拡張不要なら寸法・sizing を保持する。
サイズ override の書込み後に部品の auto-layout を再投影し、後続の fill/hug の文字を
更新後の割当寸法で測る。文字の実効 typography / runs の行高と padding も高さに含める。
空の text は拡張しない。短い placeholder の bounds / hug / fill と auto-layout を保つ。
固定の clipContent frame は自動拡張しない。投影後の文字の行領域が祖先のクリップ枠に
隠れる場合は、expand 後も overflow を返して挿入を拒否する。SVG と同じ回転・反転、
padding、縦配置、行高さで確認し、横方向は文字枠の全幅を使う保守的な判定とする。
文字枠の下の空白だけが枠外へ出ても拒否しない。実フォントの字形計測ではない。
投影の `DesignDrawing.textSourcePath` は、その文字を提供する native 欄への参照を持つ。
template 展開はこの参照から overflow / clip 診断を入力キーへ対応付ける。
入れ子、同名の部品、singleton template、instance override、ID remap を含む。
これは描画用のメタデータであり、native content や SVG に保存しない。

`measureTemplateTextFit` は text/bounds/fontSize/minFontSize、任意の typography/runs を受け、columns、
lineCount、requiredHeight、fits を返す。幅から 16px を引き、ASCII を 0.55、
それ以外を 1 として行数を見積もり、高さを fontSize × 1.3 × 行数 + 8 とする。
typography/runs を渡す場合は layoutDrawingText の行高と両側 padding を求め、
従来の保守的な見積りとの大きい方を requiredHeight に使う。fontSize 指定を優先し、
未指定なら typography.fontSize、さらに未指定なら20px。拡張用の計算では fit による
フォント縮小を行わない。instance-aware Design の拡張と診断は実効書式を渡す。
これは挿入時の診断と共有する決定的な preflight であり、実フォントの計測ではない。
不正な寸法、下限未満の文字、固定枠を超える入力を拒否する。

```ts
import { authorReusableComponent, measureTemplateTextFit } from '@editor-platform/templates';
import { makeDesignVector } from '@editor-platform/design/model';

const fit = measureTemplateTextFit({
  text: '承認する',
  bounds: { width: 98, height: 26 },
  fontSize: 12,
  minFontSize: 10,
}); // fits: true / requiredHeight: 23.6
const component = await authorReusableComponent({
  domain: 'design',
  content,
  ids: [],
  name: 'Button',
  overflow: { minFontSize: 10, policy: 'error' },
});
const icon = makeDesignVector({
  viewBox: { x: 0, y: 0, width: 24, height: 24 },
  paths: ['M20 6 9 17l-5-5'],
  provenance: { source: 'lucide', name: 'Check', version: '1.51.0', license: 'ISC' },
});
// icon.fill / icon.stroke can bind to existing Design token styles.
```

Design の `shape` に任意の `vector` を追加する。`makeDesignVector` は
viewBox と SVG path 文字列群、source/name/version/license の provenance を受ける。
矩形・テキスト・画像のモデルや domain schema 1/2 を変更しない。path だけを解析し、
HTML/SVG markup、URL、script、任意の属性は受け付けない。viewBox と座標は有限で
絶対値 1,000,000 以下、path は最大 128、本あたり 16,384 文字、合計 65,536 文字。
完全な引数群と arc の半径/flag を検証する。未指定の既存 shape は従来どおり。
arc の flag は文脈に従って1文字ずつ読み、`A5 5 0 0110 10` のような隣接 flag / 座標も
受け入れる。原本の path 文字列は書き換えない。
path の区切りは SVG comma-wsp の space / tab / CR / LF に限る。
NBSP、form feed、その他 Unicode 空白を先頭・途中・末尾で拒否する。
paths は全 index に自身の文字列値を持つ密な配列とし、穴や継承した値を拒否する。
vector / viewBox / provenance は通常または null prototype の JSON record に限定する。
必須欄は自身の属性でなければならず、配列・Date・prototype 継承の値を拒否する。
小数の viewBox は維持し、生成した native element の初期寸法は各軸 1px 以上にする。
constructor の index は既存 shape と同じ配置位置に反映する。
provenance の4欄は XML 1.0 の Char に適合する文字に限る。禁止制御文字、孤立 surrogate、
U+FFFE / U+FFFF を拒否し、日本語・有効な補助面文字と markup delimiter の escaping を保つ。
vector override は参照する singleton template / component part の実効型が shape の
場合だけ受け入れる。入れ子、継承 vector の type 変更、参照切れもこの検査に含む。

色は既存の fill/stroke/strokeWidth と `styleCapabilities.design` を使う。
Library の exact style/token dependencies、mode 切替、instance overrides、native
command/transaction と Undo を使い、別のカタログや描画状態を作らない。
viewBox は bounds に縦横比を維持して中央に配置し、線幅は viewBox 単位で拡縮する。
path の描画は宣言した viewBox で clip し、範囲外の座標や stroke を他の要素へ描かない。
clip 矩形は x/y/width/height だけを投影し、viewBox の未定義属性を SVG へ渡さない。
geometry は要素・component template・正規の override からのみ解決する。
import した style の未定義 vector 欄は保持できるが、図形の提供・置換には使わない。
Surface/SVG/PNG は同じ primitive を使い、SVG にも provenance の data 属性を残す。
`drawingPrimitives(drawing, resourceId?)` の clip ID は描画の occurrence に属し、
native ID や部品 ID の連結から作らない。未指定時は新しい ID を割り当てる。
決定的な primitive 文字列が必要な Host は SVG 文書内で一意な resourceId を渡す。
既存 SVG exporter は固定の連番、Surface は React の useId を渡す。
Design の投影内部も native と衝突しない hierarchy ID を使い、祖先 frame の clip / hidden
を保持する。保存済み ID と既存の選択・文字用 drawing address は変えない。
ライセンス文書の取得・配布は Host の責務。内蔵アイコン一覧や SVG markup import UI
はこの API 追加の範囲外。Host は例えば lucide 1.51.0 / ISC の path を渡せる。
Slide/Whiteboard の未定義 vector 欄はそれぞれの描画投影から除外する。Design は
shape に属する検証済み vector だけを shared drawing へ渡す。版比較は出どころと
geometry の短い表示用 fingerprint を示し、path 本文を大量に表示しない。
この fingerprint は保存の完全性・セキュリティを保証する hash ではない。

SVG の既定書体は `Noto Sans CJK JP, sans-serif`。明示の要素/文字範囲の fontFamily
を優先する。SVG へのフォント埋込みは行わず、外部 reader はその書体を必要とする。
Drawing 以外で組み立てる Whiteboard Section / connector label と Structured Data chart
も同じ `defaultDrawingFontFamily` を使う。

## 能力と検証計画

| 能力                           | 宣言範囲                                    | 条件・検証                                         |
| ------------------------------ | ------------------------------------------- | -------------------------------------------------- |
| Pure/native model              | path/provenance、既存 schema の任意欄       | N01/N02/N12、異常 geometry/上限/不変性             |
| Local commands/history         | shape の既存挿入・色変更・Undo/Redo         | N03–N05、既存 version と入力の保持                 |
| Surface/Host                   | 既存 DesignSurface/Inspector の表示・色変更 | N06–N09/N11、独立 Host と通常 Host、desktop/mobile |
| Native JSON                    | provenance/geometry、retained definitions   | N10、roundtrip と旧定義 hash                       |
| Template/linked reuse          | 小さい文字、既存 style/token mode           | C05/C06、公開 API の登録→挿入→dark                 |
| Shared                         | 既存 Design transactions の vector field    | C04/S01/S02/S04、authority 拒否と selective Undo   |
| SVG/PNG                        | resolved 色と書体                           | C07、primitive/XML と実ブラウザ PNG pixel          |
| React/Office vector conversion | 今回の宣言範囲外                            | C08 N/A。React の非対応診断を確認                  |
| Performance/実機/全browser     | 追加測定・受け入れを宣言しない              | C09/C10 NOT RUN。既存の停止・保留を維持            |

旧 reader は追加 geometry を描画しないため、vector の編集・書出しには新 reader が
必要。旧定義を一括書換え・再sealせず、新版の定義を利用側で明示採用する。
機能判定と実施環境は別の検証報告に記録し、生成物・ログ・画像は Git 外に置く。

## Post-merge correction semantics

Linked Design adoption compares the complete `vector` value (paths, view box and provenance) as
one native field. Unmodified values adopt the selected exact definition; explicit overrides,
including default-equal ones, and local edits retain their entire vector. Existing read stamps
reject stale previews; geometry and retained reference remain in the same native transaction.
Slide/Whiteboard do not interpret this field during linked adoption. Existing imported
vector metadata is preserved even when the incoming definition changes or removes it;
supported native fields and the selected exact reference can still update. Their existing
transaction field allowlists and rendering projection remain unchanged.

`measureTemplateTextFit` checks the base and effective normalized nonempty rich runs against
`minFontSize`. It follows drawing normalization (mismatched runs fall back to plain text and
empty runs are ignored) and the existing 8px drawing run floor. Preflight still measures with
clip behavior, so `overflow: 'fit'` does not hide a minimum violation by shrinking text.
Empty text, Design height expansion, legacy template behavior and Document/Slide defaults
remain unchanged. This does not introduce font-metric or performance measurement.
