# React UIの出力・登録候補・意味的差分

[#38の設計](react-ui-portability-design.md)、[React UI契約](react-ui-contract.md)、
[#35の成果物受け渡し](artifact-output-contract.md)を併用する。
React UIとDesignのnative model、元実装をHostが保持する境界は変更しない。

## 出力と保存往復

空の任意slotは対応propを省略する。元部品の `prop ?? default`、真偽判定、
parameter defaultはpreviewと生成TSXで同じように働く。必須slotのminimumは
従来のpreflightが検査する。空のFragmentを渡して既定表示を抑制しない。

保存JSONは従来からcanonicalだった。保存前後でTSXが変わった原因はinputs、
callbacks、bindings、slotsのmap走査順だった。これらを固定し、roots、slot内の
children、Provider、breakpointの意味のある順序は保つ。元の入力を並べ替えない。
生成器 `react-ui-tsx@2.0.1` は行分けしたTSXと既存5ファイルを返す。
JSON値は引き続き安全なexpressionとしてencodeし、任意JSXを補間しない。
旧native v1／公開登録hash／保存済み版は書き換えない。

## 型から登録候補を抽出する

`@editor-platform/react-ui-tooling`はHost/build時だけの任意packageで、通常の
Editor bundleへTypeScript compilerを持ち込まない。Hostが作ったstrictNullChecks
有効のProgramを `extractReactRegistrationCandidates(program, request)` へ渡す。
sourceRevision、各entryのfile/exportName/import/ref（exact versionとHost提供
implementationHash）、必要な依存ID、Host方針を明示する。原本をimport／実行しない。

requestのpoliciesは `reactExtractionPolicyKey(ref)` をkeyにする。Hostが指定できる
のはexclude、sampleProps、layout（none/className/style/wrapper）、slotsの個数・許可部品、
controlledInputs。classNameを受けない部品へwrapperを暗黙追加しない。
style配置はReact.CSSPropertiesを受け取れる宣言に限り、文字列・限定したstyle object・
追加必須field等の不整合を診断する。必須slotのminimumをHost policyで下げることはできない。
必須JSON propには汎用preview placeholderを作り、HostがsamplePropsで上書きする。
placeholderは公開defaultではなく、実用出力で必須値を補完しない。

対応する型はstring/finite number/boolean、string literal enum、nullable、宣言fieldの
object、上限付きarray、top-level ReactNode slot、正規化されたvoid callbackである。
numeric literalはnumberへ広げず診断する。React slotはProgram内の実際のReact symbolで
識別し、同名の独自JSON型をslotに置き換えない。
混合union、any/unknown/index signature、optional/rest callback引数、非void callback、
object内ReactNode、generic/overload等は部品名・prop/path・理由・回避方法を診断する。
必須JSON fieldのundefined unionと必須callbackも診断する。任意fieldだけundefinedを
省略可能として扱い、event契約に必須flagがないcallbackはHost wrapperで明示変換する。
戻り値はProgram内のReactNode型へのassignabilityを検査する。非renderableな普通の
関数を部品として登録しない。型の一部を無言で落とした登録を返さない。ReactNodeの入れ子はHost wrapperで公開slotへ
移す等の明示対応を行う。欠損sampleや型違いpolicyでも診断し、既存登録を残す。

CLIも同じAPIとruntime request validatorを使う。top-level／entry／ref／import／policyと
slot・controlledInputsの未知field、欠損field、型違いは拒否する。request JSONは上の内容に任意のtsconfig相対pathを加える。
fileもrequest JSONのdirectoryから解決する。元実装／依存hashを自動算出しない。

```sh
node scripts/react-ui-register.mjs request.json > candidates.json
node scripts/react-ui-register.mjs next-request.json candidates.json > next-candidates.json
```

診断がある場合はexit 1。stdoutのdiagnosticsとexcludedを確認し、成功した候補も
`unreviewed`としてHost／人が検査する。確認前に本番catalogへ採用しない。
immutable版の上書き、latest自動追従、破壊的変更の自動採用は行わない。
上限は登録128、field128、schema深さ16、callback引数8、抽出arrayは最大1000。

## 改訂と構成の差分

`diffReactRegistrationCandidates(before, after)`にはsourceRevision/candidatesの
snapshotを渡す。各snapshotはidentityごとにexact版を1つ選ぶ。複数版からlatestを
推測しない。追加・削除・改訂、旧新版、破壊的変更候補のreasonを返す。
prop削除／必須化／型の狭まり、event/slot/layout/default/依存・controlled input変更、
同じ版の書き換え、実装hash変更を保守的に検出する。実装hashだけから互換性を証明
しない。Hostが判断した後の採用は既存 `prepareReactUiRevision` を使う。

`diffReactUiComposition(before, after)`はstable node IDを対応付け、追加・削除、
prop、binding、slot／rootsの順序、layout property、採用component、環境、inputs、
callbacks、fixture、breakpoints、保持登録の差分と両fingerprintを返す。
node配列・object keyの挿入順だけの変更は意味的差分にしない。省略とnullは区別する。
結果はdeep-frozenな観察値であり、command／権限証明として実行しない。
画像比較・承認画面での表現と外部業務IDの意味はHostに残す。

## 独立HostとVite

既存のunbound/product/form/revisedに加え、`react-ui:export-host -- portable`は
別のHost型Panelをtoolingで抽出する。classNameなし→Host明示wrapper、空のbody/actionの
既定表示、enum callbackをReact-only出力で検証する。実物の製品コードは使わない。

Vite 6.4.1／React・ReactDOM 19.1.1の固定環境では、今回tree shaking既定値でも
参照unboundアプリのbuildが完了し、報告されたreact-dom停止は未再現だった。
既存独立driverの `rollupOptions.treeshake:false` は固定fixtureの既存互換設定として
保持する。すべてのHostへ必須とはしない。利用側で失敗する場合はexact lockfile、
import alias、React/ReactDOMの重複・版、JSX設定、実際のerrorを保存して切り分ける。
出力TSXへ場当たり的なreact-dom依存を追加しない。

基本設定はESM、automatic JSX、React/ReactDOMのexact版、元部品aliasとProvider/CSS/
asset解決。strict tsc、production build、実描画とcallbackは別々に検証する。
この試験はperformance受け入れではない。計測／調整停止、生成物のGit除外、
利用側の実資料試用、外部製品との非統合を維持する。結果は[検証記録](verification/issue-38/README.md)。

CLIはtsconfigのparse診断も拒否する。明示entryを別に追加するため、glob探索に入力が
見つからない診断18003だけは対象外とし、未知option・不正値・extends読込失敗等は
候補を出力せず終了する。
