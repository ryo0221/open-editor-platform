# #246 Design 画面試作の検証

保持されたコメント再試行の追補は [retained-retry.md](retained-retry.md) を参照。

PR #250 の修正・既定条件での比較記録は [review-250.md](review-250.md) を参照。以下の当初記録は失敗履歴を含めて保持する。

2026-10-13。対象は main `5a32d35` を基点にした `feat/issue-246-design-prototype`。
[設計・公開契約](../../design-prototype-contract.md)版 1 に対応する。後続の記録用 commit 以外の検証対象は、この PR の実装差分。全 unit は実装 commit `52f5c9f`。後続の native 参照 remap は関連 279 tests、overlay 履歴/状態は関連 12 tests で検証した。最終の実装 commit は `8f5669b`。

最後に main が `ac0252c`（PR #238 merge）へ進んだため rebase した。
実装 commit の対応は `52f5c9f` → `69d5da7`、native remap → `9f80a92`、overlay → `442a63a`。
`git diff 8f5669b HEAD -- packages/design packages/templates/src/native.ts packages/collaboration-adapters/src/editor-transactions.ts apps/playground/src/App.tsx`
が空で、検証済み Design code は同じ。Graph の既存変更と文書を両方保持している。
latest main 上の `e1de3e7` で再 build と試作 browser 7/7 PASS。rebase 後の全 unit は再実行していない。

## 対象と環境

Design の任意の native interactions / prototyping metadata、通常 Inspector、独立した
試作 Surface、headless 診断・実行、flow 完了 callback、既存 anchored comments との接続を対象とする。
Native schema 1/2、flow 100 本・各 256 frame、overlay 8・private history 256・instance 深度 16、
flow 診断の候補履歴 64 が上限。新しい Artifact kind、製品の試作記録、公開基盤、React/Office の試作 runtime は含まない。

Linux cloud、Node 20.20.2 / npm 10.8.2、system Chromium 147。
Desktop 1440×900、mobile は Chromium の iPhone 13 viewport 390×844。
通常 Playground は production build。独立 Host は public packages と UI CSS のみを esbuild で bundle し、
production preview へテスト用 route として配信する。Playground state/CSS は import しない。
共有は既存 in-memory reference authority と別 browser context を使う。
固定 Office font 4 種の SHA-256 検査を通した。実機、他 browser、native IME、支援技術、production 認証・永続サーバーは未検証。

## 実行記録

| 検査                                               | 対象・結果                                                                                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check:files`                              | PASS、1098 files                                                                                                                    |
| `npm run test:tooling`                             | PASS、25 tests                                                                                                                      |
| `npm run lint`                                     | PASS                                                                                                                                |
| `npm run build`                                    | PASS、最終 `8f5669b` と rebase 後 `e1de3e7` の tsc・Playground・React reference build                                               |
| Design / adapter / template unit                   | 対象の最終 62/62 PASS（全 unit に含む）                                                                                             |
| `playwright.design-prototype.production.config.ts` | PASS、最終 `8f5669b` / rebase 後 `e1de3e7` で desktop 5 / mobile 2 = 7 tests                                                        |
| Legacy reader                                      | main 5a32d35 の model を bundle して新しい native fixture を読む確認 PASS。追加欄は JSON に残るが旧 reader は試作を表示・検証しない |
| Public snapshot export/check                       | PASS、rebase 後 commit `e1de3e7` で 828 files。最終記録 HEAD も export/check してから pushする                                      |

初回 unit の 3 失敗は、継承リセットの undefined の扱い、shared fixture の既存 ID 制約、
template fixture の text fit を修正して再実行した。Desktop 初回は status locator が Host の output と重複した。
Playwright の project ごとの testMatch を限定し、途中の runner を停止・cleanup して再実行した。
Mobile 初回は独立 Host の検証用 JSON pre の横幅が viewport を広げた。pre の overflow を制御した後、
`innerWidth === 390` を確認し、5 frame のタップ・重ね開き・閉じる・完了通知を通した。
通常 mobile の初回は既存の More editor tools を開かずに折りたたまれた Open prototype を探して timeout した。menu 経由に修正して再実行し PASS。最終 `8f5669b` では同じ 7 tests を全て再実行し PASS。
これらの初回失敗を最終 PASS で上書きしない。

全 unit は `npm test -- --maxWorkers=1 --testTimeout=30000` で 1174 件を実行し、
1173 PASS / 1 FAIL（132 files 中 131 PASS）。失敗は
`packages/slide-import/src/import.test.ts` の I07 self-export corpus import が固定 60 秒で timeout するもの。
前の作業でも同じ timeout が残っており、今回 Office import code/fixture に差分はない。
今回の exact page/object cap と XML/entry/expanded-byte cap は全 unit 内で PASS した。
I07 の timeout を増やして合格に見せたり、検査から除外したりしていない。

Native template の参照変換を Design の interactions / prototyping に限定した後、
`npm test -- packages/design/src packages/templates/src --maxWorkers=1 --testTimeout=30000`
を再実行し、35 files / 279 tests が全て PASS。Host の webProps に含まれる frameId、frameIds、
interactions と同名の文字列は変換しないケースを追加した。全 unit の記録をこの後続修正の全件検査として再掲しない。

Overlay の close は開いた visit も取り消し、閉じた後の Back が同じ画面に一度留まらない。
Overlay の switch は base を保持し、最上位の表示だけを変更する。これらを含む最後の関連 12 tests は全て PASS。
最終 production 検査は `playwright.design-prototype.production.config.ts` で 7/7 PASS、console error / pageerror なし。

関連 browser は `playwright.production.config.ts --workers=1` で H2 Design（部品上書き・定義・auto-layout・実 PNG）と QA-18 独立 Host を PASS。
QA-17 全 Surface mobile（390/768）は初回どちらも全体 45 秒 timeout。途中の Document/panel 操作で期限に達し、
その時点では focused の snapshot も採れている。初回の失敗は保持し、他の CPU 検査なしで同じ設定を再試行したが、2 tests とも固定 45 秒で timeout。
再試行は PDF replacement の後の Next PDF page 操作まで進んだ。今回 File/PDF code と QA-17 spec は変更していない。
この aggregate suite を PASS としない。追加した試作 mobile の 2 tests は別に PASS している。

## 条件と証拠

| 条件                            | 判定                        | 証拠と範囲                                                                                                                                                                                                                                             |
| ------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| N01 目的/domain/所有境界        | PASS                        | 公開契約。既存 Design の capability。Host が記録・公開を所有                                                                                                                                                                                           |
| N02 model/validation            | PASS（対象 unit）           | enum、参照 ID、duplicate trigger、空/疎配列、flow 上限、invalid overrides、missing target、instance cycle                                                                                                                                              |
| N03 draft/version/private state | PASS（対象 unit/desktop）   | 旧 version bytes/hash を保持。試作・完了・戻る後の native bytes/hash 不変                                                                                                                                                                              |
| N04 pure/atomic command         | PASS（対象 unit）           | frozen source、invalid command 無変更、既存 command/transaction、削除参照を残して Undo 回復                                                                                                                                                            |
| N05 Undo/Redo                   | PASS（desktop）             | interaction 上書き Undo/Redo、shared selective Undo、試作の移動は編集履歴へ入らない                                                                                                                                                                    |
| N06 独立 Host                   | PASS（desktop/mobile）      | public packages/CSS だけの Host。source/anchor/completion を Host で観察                                                                                                                                                                               |
| N07 通常 Host                   | PASS（desktop）             | import→設定→試作→version→reload。同じ native factory/validator/Session を使用                                                                                                                                                                          |
| N08 selection/event             | PASS（desktop）             | native instance ID + world canvas Region、任意位置、名前つき flow の完了 callback は実行ごとに一回                                                                                                                                                     |
| N09 readonly/permission         | PASS（対象 unit/desktop）   | Inspector disabled、Host command 拒否、authority writable=false 拒否、注釈拒否時 buffer 保持                                                                                                                                                           |
| N10 保存/互換                   | PASS（対象 unit/desktop）   | optional metadata roundtrip、schema 1/2 欄なしを変更しない、旧 version 保存、通常 Host import/reload                                                                                                                                                   |
| N11 keyboard/mobile/focus       | PASS（追加した試作操作）    | Enter、Escape overlay、次の要素 focus、390 viewport のタップ。通常 mobile dialog の幅と 5 frame flow                                                                                                                                                   |
| N12 untrusted input             | PASS（対象 unit）           | JSON shape validator。URL/JS/DOM/実行可能 action を追加しない。既存 image/asset 規則を維持                                                                                                                                                             |
| N13 regression/reproducibility  | FAIL（I07 / QA-17 timeout） | 全 unit 1174 件中 1173 PASS / 1 FAIL。132 files 中 131 PASS。試作 7 tests と既存 Design PNG / 独立 embedding は PASS。全 Surface mobile の初回 2 tests は 45 秒 timeout。同じ設定での再試行も両方 45 秒 timeout（PDF の Next PDF page 操作まで進んだ） |
| N14 docs/declaration            | PASS（source snapshot）     | canonical README/status/embedding/coverage と public overlay/policy を更新                                                                                                                                                                             |
| C01 text/native IME             | N/A                         | 試作の text editing engine を追加しない。flow 名は既存 CommitInput                                                                                                                                                                                     |
| C02 annotation                  | PASS（desktop）             | 非リンク要素・instance 部品・任意位置。Host の既存 addAnnotation/native storage                                                                                                                                                                        |
| C03 headless/proposal           | PASS（対象 unit）           | public pure APIs、UI と同じ diagnose 関数。外部 agent runtime は追加しない                                                                                                                                                                             |
| C04 shared metadata             | 対象 PASS                   | trusted codec で interaction/root settings、2 contexts の伝搬、peer rename を残す Undo/Redo                                                                                                                                                            |
| C05 template copy               | PASS（対象 unit）           | whole template の flow/frame/override target を remap。外部 frame 参照は残して診断                                                                                                                                                                     |
| C06 linked reuse/tokens         | N/A                         | 新しい linked flow definition を宣言しない。既存 component/style/reuse を変更しない                                                                                                                                                                    |
| C07 graphic formats             | PASS（対象 unit）           | metadata の有無で SVG が byte-identical。PNG は同じ SVG rendering 経路。関連 export 回帰は別記                                                                                                                                                         |
| C08 React/bridge                | N/A                         | Design prototype action を React runtime に変換しない                                                                                                                                                                                                  |
| C09 large asset/recovery        | N/A                         | 新しい binary/asset/persistence adapter を追加しない                                                                                                                                                                                                   |
| C10 特定環境                    | N/A                         | desktop/mobile viewport 以外の実機/browser 保証を宣言しない                                                                                                                                                                                            |

Shared の新しい metadata 経路について、S01 wire/通常 UI、S02 authority/atomic permission、S04 selective Undo、
S06 通常 Host の 2 contexts は対象検査 PASS。S03 の同じ root settings の CAS は既存 transaction 規則を使う。
S05 reconnect/fault と独立した shared browser Host の全組み合わせは新規検証していないため NOT RUN。
既存の shared transport を変更せず、試作 runtime は operation を送らない。これを全 shared 受け入れの証拠にしない。

## 証拠と判断の限界

Raw log、trace、画像、生成 bundle/build/snapshot は `/tmp/design-246-*` または
`/tmp/design-prototype-*` に保持し、Git へ入れない。公開 reader はこれらの実行環境上の証拠へアクセスできない。
fixture/spec/config は公開 snapshot に収録し、上記 command で再現できる。
最終 screenshot は `/tmp/design-prototype-overlay-verified` と `/tmp/design-prototype-rebased-browser` の Home、overlay、mobile overlay、mobile Done、通常 mobile prototype。
Desktop overlay と通常 mobile の Completed 表示を目視確認し、ダイアログが viewport 内に収まることも browser で確認した。
原寸画像はこの環境上の証拠であり、public release assets に upload していない。

全 unit の既存 I07 FAIL が残るため N13 全体は受け入れ済みとしない。試作の対象検証は PASS だが、I07 と QA-17 の timeout が残るため PR は Draft とする。最新 main の build / 試作 7 tests / source snapshot は PASS。全 unit を最終 HEAD の全件検査として再掲していない。
Performance の追加測定・tuning は停止を維持し、functional PASS を performance/release/運用受け入れにしない。
