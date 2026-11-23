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

## 未実施

- `npm run build`とPlaywrightのE2E suite（desktop・mobileの回帰）は実行していない。
- Undo・import・共同編集、Fishbone・FTAの版保存と再読み込みは手動でも確認していない。
- FTAの計算結果を外部のツールと突き合わせていない。手計算（OR = 1 − (1 − 0.01)(1 − 0.02) = 0.0298）とだけ一致を確認した。
