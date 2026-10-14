# Public Issue #3 — Structured Graph verification

対象は `ryo0221/open-editor-platform#3` の汎用Graph・Data連携。
2026-10-09の本文と全コメント（0件）を読み、最新mainを起点に実装した。
同日最終確認でも本文・コメントに変更なし。
[設計・能力matrix](../../structured-graph-contract.md)と
[embedding](../../embedding.md#structured-graph-local-mode)に対応する報告である。
旧内部Issue #3（collaboration）とは別のIssueである。

PR #40の初回レビュー修正は [review-40.md](review-40.md)、
追加レビュー修正は [review-40-followup.md](review-40-followup.md)、前回の再レビュー修正は [review-40-followup-2.md](review-40-followup-2.md)、最新6件の修正と検証結果は [review-40-followup-3.md](review-40-followup-3.md)を参照。
以下は初回headの記録を保持したもの。

## 対象と環境

- Native `structured-graph` schema 1、Profile schema 1、local history、typed属性、
  接続/削除/layout、native Artifact draft/version/import/restore。
- 同じDataのGrid/Form/Graph、scalar同一Data relation、共通Data command/history。
- 公開可能な架空Definition Adapter、未表示情報保持、immutable原本、sidecar、
  derived関係、注入domain validator、revision/pin付きproposal。
- Linux、Node 20.20.2 / npm 10.8.2、production Vite build、Chromium。
  Desktop 1440×900、mobile 390×844、1 worker。通常Host `/` と独立 `/graph-host.html`。
  独立Hostはpublic packagesと専用CSSだけをimportする。

宣言しない能力：Graph shared、annotation、template、linked reuse、Office/React出力、
任意コード実行、自動配置、port/subgraph/hyperedge。通常Hostの関連入口を隠す/無効化。
DataのGraph slot未登録HostはGraph表示を拒否し、Data自体は保持する。

## コマンドと結果

| 実施対象                                                             | 結果    | 範囲・証拠                                                                                          |
| -------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `npm run lint`                                                       | PASS    | 全source lint                                                                                       |
| `npm run build`                                                      | PASS    | strict TypeScript、通常/独立Host、既存React preview build                                           |
| `npm test`                                                           | PASS    | **1,020 tests / 110 files**。新規Graph 47、Data Adapter 27、Definition 10、Data input境界2、既存934 |
| `npm run test:tooling`                                               | PASS    | **25 tests**、public-export/size guardの既存回帰                                                    |
| `npm run check:files`                                                | PASS    | 生成物/大きいfileをGit対象にしないguard                                                             |
| `npx playwright test --config playwright.graph.production.config.ts` | PASS    | **12 production Chromium cases**：新規Graph desktop6/mobile2、既存Data/embedding/mobile4            |
| 代表screenshotの目視                                                 | PASS    | 通常native desktop/mobile、独立Graph/Data mobile、Definition desktop。横page overflowなし           |
| performance workload                                                 | NOT RUN | budget/fixtureのみ設計。追加測定・調整は停止中                                                      |
| 実Workflow integration                                               | NOT RUN | 実Framework Adapter/Definition/schema validatorは利用側の責務                                       |

Production configは既存Data全表示、独立embedding、relation/shared/preset/CSVの回帰、
既存mobile、Graph specsだけを列挙する。全repository E2E合格という意味ではない。
browser fixtureはconsole error/page errorで失敗する。原証跡はGit外の
`work/graph/` のlogと `/tmp/editor-platform-graph-results/` の画像/traceに保持する。
公開環境では上記コマンドで再生成でき、秘密fixtureやサービスを要しない。

## 条件別の判定

| ID                        | 結果    | 証拠・未確認の範囲                                                                                                       |
| ------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| N01 目的/native domain    | PASS    | Profileを替えた関係Graph/架空Definition/Data。業務依存なし、Dataは別Artifactなし                                         |
| N02 Model/validation      | PASS    | `graph.test.ts`：ID/型/refs/接続制約/readonly/schema/上限/JSONの正常・拒否                                               |
| N03 Draft/version/view    | PASS    | Native全version/hash roundtrip、restore、新しいdraft、private camera/selection、layout別扱い                             |
| N04 Pure/atomic command   | PASS    | intent batchとtrusted command guard、失敗でcontent/history不変、元JSON/未表示値保持                                      |
| N05 Local Undo/Redo       | PASS    | drag一編集、cascade一編集、Grid名→Graph接続→Form Undo、layoutとproposalのUnit/E2E                                        |
| N06 独立Host              | PASS    | public entrypoint/CSSのproduction entry、native/Data/Definition、Save/reload、readOnly、mobile                           |
| N07 通常Host/登録         | PASS    | Library新規Graph、Inspector/Canvas、Data slot、save/import/restore、未対応入口off                                        |
| N08 Selection/event       | PASS    | node/edge安定ID、Data node→row/edge→cell、keyboard選択/Host通知、診断scope/id/path                                       |
| N09 Read-only/権限        | PASS    | Surface/Host executor/GraphSession/DataSession/Bindingの拒否。prepared後の権限変更もUnitで拒否                           |
| N10 Native保存/import     | PASS    | draftと全retained version/hash、不正/未知Profile拒否、storage failure→draft保持→retry/export。旧Graphschemaなし（1のみ） |
| N11 Keyboard/mobile/focus | PASS    | Delete/cascade dialog/Cancel、矢印移動、入力shortcut抑制、responsive/scroll、mobile viewport。実機/支援技術はNOT RUN     |
| N12 Untrusted input       | PASS    | strict宣言Profile、accessorを実行せず拒否、prototype/code/remote `$ref`拒否、bounded JSON、HTML/codeをtextとして保持     |
| N13 回帰/再現性           | PASS    | 全Unit、tooling、build、対象12 Chromium。全browser suite/新Office renderingはNOT RUN                                     |
| N14 文書/対応宣言         | PASS    | design/README/status/embedding/本報告/public export policyに範囲・限界を記録                                             |
| C01 Text/IME              | NOT RUN | typed input/textarea、buffer Cancel/文書Undo境界は実装/Chromium確認。native OS IMEの実入力は未実施                       |
| C02 Annotation            | N/A     | Graph annotation/anchorの登録なし、通常Comments入口disabled                                                              |
| C03 Proposal/headless     | PASS    | pure model entrypoint、preview/reject無変更、apply一Undo、stale/source削除/Profile/adapter/layout/access変更で拒否       |
| C04 Shared                | N/A     | Graph shared未登録、shared起動入口なし。Data Graph slotもshared Hostへ登録しない。S01–S06は宣言外                        |
| C05 Template              | N/A     | Graph template creation/insertion/publication未登録、入口なし                                                            |
| C06 Reuse/token           | N/A     | Graph reusable management/token/update未登録、入口なし                                                                   |
| C07 外部format            | PASS    | 架空Definition Adapterのlossless投影/限定逆変換/未知値/順序/readonly導出辺/validator injection。実形式の統合はNOT RUN    |
| C08 React/bridge          | N/A     | React Surfaceの実装とは別のReact UI/Design bridge能力。Graphへの生成/出力登録なし                                        |
| C09 Large asset/recovery  | N/A     | Graph asset importを宣言しない。Storage failure/retryはN10で確認。offline/reconnect/大容量assetは宣言外                  |
| C10 特定環境              | NOT RUN | Chromium viewportのみ。Firefox/WebKit、実機touch、native IME、screen readerは未実施                                      |

PASSはここに宣言した限定範囲のlocal機能確認であり、未実施環境を認定しない。

## 重要scenario

1. Native：新規作成→属性編集→drag→Undo→Commit→reload→native import。
   通常Hostでは版1/版2保存後のrestoreと全JSON importを確認。旧versionのcontent/hash/IDは不変。
   無効なretained version、未知Profile、hash改ざんは書込み前に拒否する。
2. Data：Gridの名前編集→Graphの接続→FormのUndo二回で正本と表示が戻る。
   Graph配置だけではrows/values/ref/orderを変えない。版保存/reloadでviewと未表示値を保持する。
   削除cascade、relation列変更、readonly/計算値、foreign/multivalue、stale buffer/proposalは共通Data境界で検証する。
3. Data identity：`node:` と `edge:` namespaceでrow IDとGraph root/edge IDの衝突を回避。
   列名/順序/target変更・filter外参照でもidentityを維持。新rowはDataのdefault値を使う。
4. Definition：原本をdeep freezeし下書きだけを編集。ノード移動はsidecarだけを変更し、
   source値/版/phase順序/semantic historyを維持。導出next辺の切断は拒否、明示phase reorderはUndo可能。
   proposal preview/reject、apply、stale拒否、保存失敗/再試行を確認する。
5. 入力：Graph/Formのclean bufferは正本Undo後に更新、dirty bufferは元row/schema/stampをpin。
   Cancelで最新値を読み直す。Gridの未確定bufferは表示切替で破棄し、確定済み編集を二重適用しない。

## 初回失敗・制限・受け入れ判断

- 開発中lint/typecheckのunused/import不足を修正して最終lint/buildを通した。
  `.npm-cache/` の生成cacheがfile guardに含まれた初回失敗はignore追加で解消。
- 初回browser configの緩いmobile正規表現が全mobile specを選択したため中断した。
  15 PASS、1 interrupted、46 NOT RUN。明示filenameへ修正し対象12件を検証した。
- 最終Data Form追加assertはGraph接続元のPlanningを選択したままResearchを期待し、1 FAIL/11 PASS。
  Form切替前にResearchを選択するscenarioへ修正し、対象12件を再実行した。
  初回の失敗/中断logをGit外に残し、成功だけに置き換えていない。
- Array/object属性はbounded JSON textarea。完全なrecursive form、独自widget registry、
  他Graphschemaへのmigration、ports/自動layoutは初期範囲外。
- Data relationsはscalar同一dataset row IDのみ。既存Dataのoptional `graphView` を旧readerで再保存すると
  view設定を落とす可能性がある。Graphを未登録でも元レコードは保持する。
- 独立Hostは明示Save方式。source切替/reload前にSaveする。Storage失敗時のdraftは画面内に保持し、
  retry/exportできる。production auth/durability/publicationはこの参照例の認定対象ではない。
- 実Workflow Frameworkや非公開Definitionはimportせず、既存validatorへの注入境界だけを提供する。
  実形式との互換性・公開/採用・利用側trialは別検証。
- 自動Actionsはmanual-onlyのまま、実行していない。性能追加測定/調整は停止を維持し、
  #22の性能合格保留は変えない。functional test時間を性能合格の根拠にしない。

判定は**local functional review checkpoint（レビュー待ち）**。
この限定Graph/Data/架空Adapter機能の検証結果を提供する。正式受け入れ、native IME/他環境、
実Framework統合、performance、production release、利用側trialは独立した判断である。
