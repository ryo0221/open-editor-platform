# @editor-platform/factory

FT2（計画）：生産ラインのモデル（`@editor-platform/factory-core`）の画面。

- `FactoryController`：Hostの`EditorSession`に1つの編集を1つのcommandで当てる。物を足す・つなぐ・動かす・消す・直す、作業時間のCSVの取り込み、流す・止める。結果は文書の鍵と組で持ち、編集の後は古い。
- `FactorySurface`：道具の列、上から見た配置図（SVG、mm）、インスペクタ、結果（タイル、状態の表、ボトルネックの順位、Gantt、リードタイムの度数、流れの量）。
- `factoryWorkerRunner`：1回の実行に1つのWorker。止めるとWorkerを終える。

Playgroundの種類`factory`（`apps/playground/src/factory/host.tsx`）がこれを使う。
