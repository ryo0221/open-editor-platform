# 分析手法の試作（Fishbone・FTA・FMEA）検証記録（2026-11-23）

対象は[Fishbone・FTA](../../prototypes/fishbone-fta.md)と[FMEA](../../prototypes/fmea.md)の試作。
いずれも既存のStructured Graph・Structured Dataを使うHost側のProfile・テンプレートで、新しいEditor種類ではない。
試作であり、受け入れ判断の対象ではない。

## source・環境

- source: PR #84 のレビュー修正後のbranch `prototype/fishbone-fta-20261123`（本記録を含むcommit）。
- Cloud内のLinux、Node 22、Chromium（Playwright同梱版）。`NODE_OPTIONS=--max-old-space-size=8192`。
- 本repositoryにはGitHub Actionsのworkflowが無いため、CIの結果は無い。以下はすべてlocalの実行結果。

## 実行結果

| 確認                                   | 結果                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| `npm run lint`                         | PASS                                                                                   |
| `npm run typecheck`                    | PASS                                                                                   |
| `npm run check:files`・`check:areas`   | PASS                                                                                   |
| `npx prettier --check`（変更ファイル） | PASS                                                                                   |
| 全unit（`npm test`）                   | 898 files・8,127 PASS、401 skip（既存のoptional）、FAIL 0。別processの8件もPASS        |
| 対象unit（3 files）                    | 23 PASS。FTA計算・拒否条件、FMEAの評点検査・列名/式の変更後の判定、Data kind経由の作成 |

## Playgroundでの操作確認

`npx vite --host 127.0.0.1 --port 5173`を起動し、Playwrightで次を確認した。

- 1440×900と390×844で、FTA・Fishbone・PFMEAを作成できる。FTAは「トップ事象の確率 2.9800%」、PFMEAは評点の案内を表示する。ページの縦スクロールは増えず、page errorは0件。
- Fishboneの見本は、原因・分類・問題を左から右へ並べ、線がノードを横切らない。問題ノードは1440幅の初期表示に収まる。
- PFMEAを有効な値のまま版として保存するとHistoryが1件になる。Sを11にすると表示が「入力要確認 1件」に変わり、版の保存は拒否されてdraftが残る。再読み込み後もdraftの値と表示、History 1件が保たれる。

## 追加検証（2026-11-24、GitHub Actions上の隔離環境）

本リポジトリの通常のGitHub Actions設定は存在しなかったため、PRのブランチに**一時的な検証用workflow**を追加して実行した。検証後、workflowはPRから除去する。したがって通常の恒久CIが整備されたという意味ではない。

| 対象commit | 検証と結果 | 証拠 |
| --- | --- | --- |
| `bc7f6a0fb83f11fcd9b022467efeab29e65a1824` | `npm run build` PASS、既存のGraph/Data関連Playwright 64件PASS（desktop/mobile含む） | [run 45204314114](https://github.com/ryo0221/open-editor-platform/actions/runs/45204314114) |
| `ffda74c9b8c3cb4ae8732b91b2b06cc021b21f79` | `npm run build` PASS。新設の分析専用E2E 5件中4件PASS、PFMEAの仮想化列を直接探すテストがFAIL。テスト側を修正 | [run 45206032244](https://github.com/ryo0221/open-editor-platform/actions/runs/45206032244) |
| `be2f5cab3bf5a722e810168779eb2c282b45a67b` | `npm run typecheck` PASS、分析専用E2E 5件PASS、変更したbrowser specのESLint・Prettier PASS | [run 45208285502](https://github.com/ryo0221/open-editor-platform/actions/runs/45208285502) |

中間の失敗は記録を省略しない：`5d8f67f`で新規E2Eのテンプレート文字列構文ミス、`90203d6`でE2E fixtureのimport漏れ、`ffda74c`で仮想化列のLocator不一致、`a12d68f`でE2EからUI/CSS込みのエントリをimportしたことによる解析エラーがあった。いずれも**新規テストの問題**で、対象コードの変更を要さずテスト修正で解消した。失敗ジョブの実行履歴はGitHub Actionsに残す。

分析専用E2Eでは、Fishbone/FTAの新規作成・要素移動・Undo/Redo・確定版保存・リロード・native JSON出力、FTAの入力不足エラーとUndo回復、PFMEAのForm編集・RPN再計算・S=11での確定版保存拒否・draft維持、DFMEA新規作成を検証した。既存のGraph/Data E2Eは通常のnative export/importなどを検証している。

## 未実施・制限

- Playwrightの**全E2Eスイート**は実行していない。検証したのは関連する既存64件と追加5件。試作に不要なEditorの全回帰は含まない。
- Fishbone/FTA/FMEAという**新規Profileを含むArtifactをImportしたときの固有のroundtrip**、共有編集、外部Host統合、専門規格への適合、性能測定は確認していない。既存の通常Graph/Dataに対するImport検証とは区別する。
- FTA確率は独立事象の手計算とは一致するが、外部の認証済み解析ツールとの突き合わせや独立性の実証は未実施。
- この試作は`docs/editor-acceptance.md`に基づく正式Editorの受入や、安全解析の正当性を宣言しない。
