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

| Command / scenario                                     | 対象                                                                                                 | 結果    |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------- |
| `npm run typecheck`                                    | 全体                                                                                                 | PASS    |
| `node scripts/gates/affected.mjs lint`                 | 変えたファイル                                                                                       | PASS    |
| `npx vitest run packages/mindmap-core`                 | 形式（0.1.5 の見本 2・拒否 5 ほか）、command、提案、比較、項目、配置の重なり、書き出しの 20 件       | PASS    |
| `npm run test:tooling` / `check:areas` / `check:files` | 全体                                                                                                 | PASS    |
| `tests/e2e/mindmap.spec.ts`（desktop）                 | 作成・子の追加・未適用入力の保持・印の上限・配置と Undo・Markdown・2 版の比較、PNG、0.1.5 の取り込み | PASS    |
| `tests/e2e/mindmap-mobile.spec.ts`（mobile）           | 枝の追加、パネルが地図の下に並ぶ、横にはみ出さない                                                   | PASS    |
| 日本語 IME の実機入力                                  | Enter の確定で枝を足さない（`isComposing` を見る）                                                   | NOT RUN |
| 引用の画面操作（Document・Slide へ図を置く）           | adapter と候補一覧は追加済み、ブラウザでの配置操作                                                   | NOT RUN |
| Performance                                            | 追加の測定は停止中                                                                                   | NOT RUN |
