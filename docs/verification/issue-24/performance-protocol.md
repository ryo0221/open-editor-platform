# #24 性能受入の固定条件（2026-10-18）

測定前の契約。ADR010の21登録・500 node・深さ4・390/1024/1400px、編集/preview
p95≤100ms、幅切替p95≤500msを維持する。努力目標は50/250ms。
500 nodeを縮小せず、元の7 Surfaceの予算も変更しない。

## fixtureと実行場所

このrepoの合成Host fixtureを使う。21種類の実React exportを明示登録し、Provider、
独自CSS、固定PNG、props/slot/data/callbackを持つ。root1→section6→card18→leaf475で
正確に500 node、最大深さ4。製品のCP21部品を認証するfixtureではない。
previewと独立TSXは同じ元実装・CSS・Provider・画像を使い、登録/環境hashを固定する。

browserはproductionの公開ReactUiSurface、EditorSessionと別originの公開
ReactCompositionを使う独立Host。normal Playgroundは既存production機能試験で別途確認する。
測定Hostに最適化用の代替renderer/command/validatorを作らない。
保存は実IndexedDBを使い、native内容/ID/hashとreload後の復元を検査する。

Node20.20.2、React19.1.1、Playwright1.63.0、実行時のChromium版・CPU/cgroup・OSを記録。
今回の受入はCloud環境内のローカル実行と原証跡で行う。Actionsはdispatchしない。
旧CI結果と今回の実行は区別する。browser機能は代表Firefox/WebKitも確認する。

## 操作・時間・予算

定常操作は各条件5 warm-up+20測定sample、fresh process/browserで3反復。nearest-rank p95と最大値、
warm-upを含む全sampleを保存し、外れ値を捨てない。正式実行中はbuild/unit等を並行しない。

| 対象                   | 計測する処理                                                                   |    Hard | 努力目標 |
| ---------------------- | ------------------------------------------------------------------------------ | ------: | -------: |
| native編集             | 公開commandのprop変更・挿入・移動・session Undo                                |   100ms |     50ms |
| browser編集            | 通常Inspector/Library/tree/Undoの入力eventからexact preview ready後の2 RAFまで |   100ms |     50ms |
| browser幅切替          | select changeからexact preview ready後の2 RAFまで                              |   500ms |    250ms |
| pure TSX出力           | 公開exportReactUiの全preflightと5ファイル生成                                  |   500ms |    250ms |
| Host依存解決           | 承認済みローカル実装・CSS・画像の実bytes照合とexact resolution                 |   100ms |     50ms |
| native保存往復         | serialize+parseとID/構成を含む復元                                             |   500ms |    250ms |
| browser保存            | Save clickから実IndexedDB transaction完了                                      |  1000ms |    500ms |
| browser初期表示/reload | navigation開始から500 nodeのexact preview ready+2 RAF                          |  5000ms |   2500ms |
| 独立出力先typecheck    | pinned依存導入済みのfresh strict tsc process全体                               | 10000ms |   5000ms |
| 独立出力先build        | pinned依存導入済みのfresh production Vite build process全体                    | 15000ms |   7500ms |

browser編集4種類は全3幅で実行し、各sampleの前後で500 nodeへ戻す。
挿入は501 nodeへの通常挿入、計測外Undoで500へ復元。移動は同slot内で隣接順序を交換し、
計測外で戻す。Undoは計測外で1回propを編集した後、その変更をUndoする。
propsは1文字ずつ追記し、全25回の最終値とpreviewを照合する。幅は別の固定幅から対象幅へ切替。
保存/reloadは各幅で同じ固定500 node。初期表示とreloadは同じ指標に混ぜず個別に報告する。
初期表示は各幅につき各反復の新しいcontextで1回、計3回のcold navigationを測定する。
CLI typecheck/buildも各3 fresh processを測定し、少数sampleなのでp95を装わず全値と最大でHardを判定。

各実行のsource/build/fixture manifestを照合する。比較可能な前版がない初回は20%回帰を未判定と
記録し、同条件の前版がある場合は各条件のp95の20%超悪化で受入を止める。
努力目標だけの調整は最大2回。Hard/正確性の未達は保留し、値を結果に合わせて変えない。
判定・失敗・制約は最終記録へ追記する。生成JSON/画像/出力/build/log/traceはGit外へ保存する。
