# Issues #42–#51 — local usability verification

2026-10-10、最新main `09a7875` から新規10件を一つのPRへ実装した。
本文・全コメント（各0件）、AGENTS.md、status、開発・受入契約を確認し、最終チェックでも
新規対象と本文・コメント数に変更はなかった。[設計・能力範囲](../../issues-42-51-usability.md)、
[Host入力契約](../../embedding.md#pending-inputs-and-keyboard-history-44--47)、
[Graph契約](../../structured-graph-contract.md)と併せて読む。

## 環境と再現

Linux、Node 20.20.2、npm workspace、固定Office fontsのSHA-256検証、production Vite build。
Playwright Chromium、desktop 1440×900 / mobile viewport 390×844、worker 1。
通常Playground、public packageだけをimportする独立 `/graph-host.html`、隔離React preview、
既存export build server / shared reference serverを使用した。実機touchとは区別する。
全browser fixtureでconsole error/pageerrorを失敗にする。

```sh
npm run lint
npm test
npm run build
npm run test:tooling
npm run check:files
npx playwright test --config playwright.usability-regression.production.config.ts
# 新規ケースのみ
npx playwright test --config playwright.usability.production.config.ts
# Make component の既存3回帰
npx playwright test tests/e2e/template-review.spec.ts tests/e2e/v2.spec.ts tests/e2e/editor-collaboration.spec.ts --config playwright.production.config.ts --grep 'R4-3/4|design frames, text|EI-Q06' --project desktop --workers 1
npm run public:export -- --ref HEAD --out work/issues-42-51/public-final
npm run public:check -- work/issues-42-51/public-final
```

Strict TypeScriptはbuildに含む。Unit **1102 / 121 files PASS**、tooling **25 PASS**。
Production browser **73 PASS**（新規21：desktop 18/mobile 3、関連回帰52：desktop 49/mobile 3）。
共通component作成の追加3回帰もPASS（合計76 distinct browser cases）。Lint、strict TS/build、
変更ファイルformat check、file guardもPASS。Public export **771 files**とmanifest/residual check
**772 files PASS**。raw log・画像・ZIP・dist/fonts・public exportは
Git外の `work/issues-42-51/` またはconfigの `/tmp/editor-platform-*-results/` へ保存する。
本PRに入れる証跡は本書、再現用config、test sourceのみ。
Graph経路/端点、Design・Whiteboard入力、Slide fit編集前/編集中、mobile直接編集、
公開部品の実React previewの画像を目視し、元bounds・行高・toolbarと周囲の表示を確認した。

## Issueと代表scenario

| Issue | 検証した操作と不変条件                                                                                                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #42   | Native/Dataのnode本体drag、from/to端点drag、候補preview、Cancel、readonly切替中のgesture取消。Dataの旧参照解除＋新参照設定は一Undo、占有元は拒否・正本不変、保存/reload。既存connection formも保持                                                      |
| #43   | Data Graphからrecords FormとFieldsへ移動。固定Profile/派生Definitionの所有元・非編集理由。独立Host-owned Profileのlabel/schema/connection制約変更、invalid migration preview拒否、同一source/historyでUndo/Redo・版保存・reload                         |
| #44   | Graphの二ノードbufferを一回のHost Saveで確定・保存。Data Formの表示を変えてもbuffer保持、無効なhidden recordを表示して保存停止、別のvalid draftは保持、Cancel後保存/reload。合成composition中Save拒否・確定後保存。共通Inspector bufferは一度だけcommit |
| #45   | Slide/Whiteboard/Designの元bounds内のProseMirror、Japanese入力/selection/paste/input Undo/Redo/Host Save、元rotation/zoom、fit font・padding・vertical align・行box。soft wrapはnative改行にしない。mobile toolbarと任意拡大は同じbuffer                |
| #46   | UI Make component → 未公開診断から設定へ戻る → HTML意味・public props/slots設定 → 保存/reload → strict React ZIP → 実React preview → React UI再利用。既存strict export/regeneration/buildの回帰。公開版・参照検証は維持                                 |
| #47   | 入力中Mod-Z/Redoはinput history、canvas焦点ではHost文書history。Inspector commit→canvas Undo後のblurで古い値を再適用しない。既存shared selective Undoも回帰確認                                                                                         |
| #48   | 中間ノードを避ける両方向routing、上下/左右port・self loop、selected pathと両端の強調。移動・retarget・zoomで再計算、描画経路をnativeへ保存しない                                                                                                        |
| #49   | Data relation候補は現在の名前、renameに追従、valueは安定ID。自己参照・接続上限の日本語対象名/理由/修正案、code/args保持、英語formatter unit、詳細ID。未知domain diagnosticはHost文言を保持                                                              |
| #50   | 元slide直後への複製・copy選択、native IDs remap、本文/画像/geometry保持、一Undo/Redo、版保存/reload、mobile操作                                                                                                                                         |
| #51   | sticky/shape/textの本文抜粋と全文検索、明示名優先、本文更新/Undoに追従。検索結果から選択・camera fit・強調、private viewはnative/historyを変えない。group/frame/image/freehandのplaceholder本文は検索しない                                             |

## 必須条件・宣言能力

対象は既存Editorへの今回の追加機能であり、全Editorの再認定ではない。
以下のPASSは上記scenarioと関連回帰に限定する。native OS IME等は未検証で、NOT RUNを残す。

| ID                       | 結果    | 根拠・範囲                                                                                                                  |
| ------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| N01 目的・所有境界       | PASS    | 各domain正本とHost Profile/実装を区別。未マージPR #37、製品/業務型を取り込まない                                            |
| N02 Native不変条件       | PASS    | 既存native validators、stable IDs、Graph typed schema、declared merges、保護値/未知属性保持                                 |
| N03 draft/version/view   | PASS    | 保存/reload、旧version不変、buffer/camera/searchを正本から分離                                                              |
| N04 command/transaction  | PASS    | pure preparation、元source/schema pins、atomic Data endpoint・buffer batch、Cancel/invalid無変更                            |
| N05 Undo/Redo            | PASS    | gesture一編集、入力とHost履歴、Inspector再適用拒否、shared既存選択Undo                                                      |
| N06 Public埋込み         | PASS    | public `EditorInputs` / history / source actions、独立production Graph Hostでedit/save/definition migration                 |
| N07 通常Host lifecycle   | PASS    | native通常作成/編集/保存/再読込、strict Design React導線、未対応shared公開は理由付き非編集                                  |
| N08 selection/通知       | PASS    | node/edge/copy/body searchのstable ID選択、pending/composing通知、invalid hidden bufferを表示                               |
| N09 readonly/権限        | PASS    | UIとcommand/Host境界、captured gesture取消、stale source/access/profile拒否。新規Graph sharedは宣言しない                   |
| N10 保存/import          | PASS    | 保存前preflight/flushとlatest canonical読取、invalid/composing保存停止、版不変、既存完全native roundtrip/import guard回帰   |
| N11 keyboard/狭いUI      | PASS    | desktop/mobile viewport、focus/caret、portal toolbar、expanded同buffer、input/document Undo。実機はC10                      |
| N12 untrusted/dependency | PASS    | declarative bounded JSONと既存strict converter/sandbox/asset境界。新規runtime/eval/製品依存なし                             |
| N13 検証・回帰           | PASS    | lint/strict TS/full unit/build/tooling/file policy、target production browser、format/public scan。全browser suiteはNOT RUN |
| N14 文書                 | PASS    | README/status/design/embedding/本報告に追加範囲・Host契約・限界を記録                                                       |
| C01 Text/IME             | NOT RUN | 合成composition、Japanese text/paste/selection/input historyはChromium確認。native OS IMEの実入力は未検証                   |
| C02 Annotation           | N/A     | 今回annotation追加なし。既存契約の変更なし                                                                                  |
| C03 Proposal/headless    | PASS    | public pure preparation、stale/reject、既存Definition preview/reject/Undo回帰                                               |
| C04 Shared               | PASS    | 既存Design React/Data selective Undo・authority回帰の範囲。Graph shared/new native公開commandは未登録でN/A                  |
| C05/C06 Template/reuse   | NOT RUN | 今回新規登録なし。native component/compound templateの選択回帰はPASS。既存全template/reuse browser suiteは未再実行          |
| C07 外部format           | NOT RUN | React bundleはC08。Office XML/ZIP unit回帰のみ、新規Office reader/open/editは未実行                                         |
| C08 React/bridge         | PASS    | strict ZIP/実React preview/React UI再利用、既存独立build/export/原本/再生成conflict回帰                                     |
| C09 asset/recovery       | NOT RUN | 既存unitとGraph保存/import失敗回帰の範囲。新規offline・大容量asset trialは未実施                                            |
| C10 実環境               | NOT RUN | Chromium viewportのみ。Firefox/WebKit、実機、screen reader、native IMEは未実施                                              |

## 初期FAILと修正

最初の関連回帰runは72件中48 PASS / 6 FAIL / 18 NOT RUN（max-failuresで停止）。
修正箇所8件の再検証PASS後、新規hidden-record caseを加えた最終73件は一回のrunですべてPASS。
最後に上記component作成の既存3件もPASS。初回の追加3件commandはCLIのvariadic `--project`
がfilenameを消費して起動しなかった。filenameを先に指定して再実行し、起動失敗logも保持する。
公開exportの最終文言が、UTF-8をUTF-16としても調べる検査に誤一致した。
検査は維持し、説明文の表現を修正して再チェックした。

- 新規browserの初回はテスト側のmenu Escapeが公開設定dialogまで閉じ、SVG pathのbbox中央を
  クリックして実線に当たらなかった。menuを明示close、実path上の座標またはkeyboard選択へ修正。
- invalid Form保存失敗のfocus復帰がprojection flushを再実行していた。失敗回復は直接Formを表示し、
  hidden invalid rowを特定する。Cancel後に古いbufferをeffectで再登録しない。
- 複数線が重なった端点のhit strokeが選択handleを覆った。選択edgeを最後に描画する。
  占有元へのdropは接続数diagnosticで拒否され、旧/new参照とも不変。
- 既存Graphのrequired omissionは非blockingの未完成draftだった。新preflightが拒否していたため、
  blockingだけを拒否し、未完成diagnosticは維持。bounded Profile/Definition proposal回帰とunitを追加。
- 既存hidden属性拒否後のExport検証は、今はinvalid bufferもpreflightで止まる。
  明示Cancelしてから正本を確認するscenarioに更新。Export検証を無効化しない。
- Whiteboardのgroup placeholderを本文として扱ったため既存layer名が変わった。可視本文を持つ
  sticky/shape/textのみ抜粋/検索し、group等のfallback名を保持する。
- 目視でfit文字の行boxが大きいことを検出。文字だけのinline decorationでは祖先font-size markが
  行高を拡げた。表示mark wrapperも同じfit倍率へ縮小し、native marks・clipboard serializerは保持。
  元位置の編集paragraph高と共有layout高が一致するbrowser assertを追加した。
- 開発中のstrict TS/ref/importとtest HTMLElement型不足を修正。mobileの隠れたtoolbar/Board名称、
  localized診断の期待値も実導線へ合わせた。初期失敗logをGit外に保持する。

## 制限と判断

`EditorInputs` は同期commandの全buffer preflight後にHostへcommitする。複数boundaryの
二番目のHost拒否までrollbackする分散transactionではない。Hostはboolean拒否/throwと
最新canonical読取、非同期authority flush/ack、durabilityを既存sessionで提供する。
追加Form/Graph/Canvas/publicationと登録CommitInputが対象で、全JSON/settings widgetの
buffer登録を認定しない。独立Hostは明示Save方式で、source切替/reload前にSaveする。

Graph固定/派生Profileの所有元を無断変更しない。所有Hostが公開callbackを実装した場合だけ
definition migrationをcommitする。新規Graph共有編集・routing自動layoutは宣言外。
共有Design Hostが未登録のnative React公開設定をlocalへfallbackしない。

実Workflow Framework/非公開データの互換性、全browser/実機/native OS IME、production
認証・耐久性、利用側trialは別確認。性能測定/調整は停止、#22合格は保留のまま。
Actionsはmanual-onlyで起動しない。製品固有変更・他PRの統合は含めない。

判定は**local functional review checkpoint（レビュー待ち）**。未検証能力・環境、性能、
production releaseを受け入れ済みとはしない。
