# Mind Map 検証記録

## 対象と宣言範囲

| 項目                    | 内容                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| Editor / kind / package | Mind Map / `mindmap` / `@editor-platform/mindmap-core`・`@editor-platform/mindmap`                       |
| 基準                    | main `5fe38fb`                                                                                           |
| 設計                    | [design.md](design.md)                                                                                   |
| 宣言する能力            | Local 編集、Viewer、保存版の比較、図としての引用、SVG・PNG・Markdown・native JSON、提案の command（API） |
| 非対応                  | 共同編集、テンプレート・再利用、文字の引用、Playground の提案レビュー                                    |

## 実行記録

| Command / scenario                                               | 対象                                                                                                                                                                                                   | 結果    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| `npm run typecheck`                                              | 全体                                                                                                                                                                                                   | PASS    |
| `node scripts/gates/affected.mjs lint`                           | 変えたファイル                                                                                                                                                                                         | PASS    |
| `npx vitest run packages/mindmap-core`                           | 形式（0.1.5 の見本 2・拒否 5 ほか）、command、提案、比較、項目、配置の重なり（子より高い親を含む）、兄弟の並べ替えの比較、書き出しの 21 件                                                             | PASS    |
| `npx vitest run apps/playground/src/app/import-artifact.test.ts` | 素の Mind Map JSON（0.1.5 のファイル・自分の JSON 書き出し）の取り込みと不正な地図の拒否                                                                                                               | PASS    |
| `npm run test:tooling` / `check:areas` / `check:files`           | 全体                                                                                                                                                                                                   | PASS    |
| `tests/e2e/mindmap.spec.ts`（desktop）                           | 作成・子の追加・未適用入力の保持・印の上限・配置と Undo・Markdown・未適用の名前を版の保存が確定、未適用のまま Undo で枝が消えたときの拒否、2 版の比較、PNG、0.1.5 のファイルと JSON 書き出しの取り込み | PASS    |
| `tests/e2e/mindmap-mobile.spec.ts`（mobile）                     | 枝の追加、パネルが地図の下に並ぶ、横にはみ出さない                                                                                                                                                     | PASS    |
| 日本語 IME の実機入力                                            | Enter の確定で枝を足さない（`isComposing` を見る）                                                                                                                                                     | NOT RUN |
| 引用の画面操作（Document・Slide へ図を置く）                     | adapter と候補一覧は追加済み、ブラウザでの配置操作                                                                                                                                                     | NOT RUN |
| Performance                                                      | 追加の測定は停止中                                                                                                                                                                                     | NOT RUN |
