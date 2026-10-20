# Issue #74: Animationレイヤー操作の検証

> この記録は元のrectangle実装sourceの結果です。後続schema 2の検証は[現在の記録](README.md)を参照してください。

## 範囲とsource

矩形・グループの子孫を含む複製・削除を、既存のlocal command/Host履歴へ接続します。
[操作とAPI](../../animation/layer-actions.md)が今回の契約です。
Issue全体の文字・画像・path・mask・nested compositionやshared対応の完了とは区別します。

ベースはmain `bca0cb147e7dd910ddbd74fcac32d587f66eec65`。
実装sourceは`854630b669bd312cf5433896d6f06b374399d424`。
以後のcommitはこの検証記録の更新だけで、runtime・テスト・設定は同一です。
Linux、Node 24.19.0、npm 11.9.0、Chromium 151.0.7922.173、Playwright 1.63.0。
production desktop 1440×900 / mobile viewport 390×844を使用します。

## 実行結果

| 検査                                                                  | 結果                                                                                       |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `npx vitest run packages/animation-core/src/layer-actions-v1.test.ts` | PASS: 18件                                                                                 |
| `npm test`                                                            | PASS: 272ファイル、2,859件成功、既存9件skip。main run 2,851件＋分離したSlide import 8件    |
| `npm run test:tooling`                                                | PASS: 107件                                                                                |
| `npm run lint` / `npm run typecheck`                                  | PASS                                                                                       |
| `npm run build`                                                       | PASS: 通常、React UI、Artifact Host、Animation Hostの4 production builds                   |
| `npm run check:files` / `git diff --check`                            | PASS                                                                                       |
| 新規production browser                                                | PASS: 6件＋最後のレイヤー削除の2件、計8件。リトライなし、console error/pageerrorを失敗扱い |
| 既存Animation/Slide production回帰                                    | PASS: 12件、リトライ・skipなし                                                             |
| ローカル公開snapshot export/check                                     | PASS: 1,925ファイル＋manifest。fresh依存監査、manifest、残留検査                           |

新規browserの実行コマンド:

```sh
npx playwright test --config playwright.animation-layer-actions.config.ts \
  --output /tmp/issue74-layer-browser-final
npx playwright test --config playwright.animation-layer-actions.config.ts \
  --grep 'initially selected' --output /tmp/issue74-layer-focus
npx playwright test --config playwright.animation-connection.config.ts \
  --grep 'ordinary Animation history|Slide retains and explicitly adopts|Animation synthetic IME|external Animation history|ordinary read-only changes|embedded Animation controls' \
  --output /tmp/issue74-layer-regression
```

最初のコマンドの実行時点は3シナリオ×2 viewportの6件でした。
同じruntimeのまま、初期選択の最後のレイヤー削除を1シナリオ追加し、2 viewportで実行しています。
通常Hostと独立Hostで、実際のnative import/download、削除対象の表示・取消、
複製内のparent/track/keyのID参照、元のレイヤー・別composition・保存済み版の保持、
Undo/Redo、保存・reload、同時刻の描画位置/opacity、独立Hostの保存版Playerを確認しました。
無効な入力、synthetic compositionstart/end、read-only、削除確認中の入力・revision変更を検証し、
古い確認の無効化と、再確認後の削除・Undoを通しています。
複製後は選択レイヤーへ、最後のレイヤー削除後はAdd rectangleへfocusが戻ります。

既存回帰12件は、通常Hostの履歴・未確定入力・native import・read-only切替、
Slideの保存版固定・新版採用・原本なしでの再読込、埋め込みPlayerのキー操作を確認しています。

最終の公開snapshotはsource `8451d9624144cacf36f5d8ad18786e5a44aeae67`から
`work/issue74-layer-actions/public-snapshot-final`へ出力・検査済みです。
manifest SHA-256は
`c28f9a41eca723bfb9379cd1481635789e0a645e212a601613241fde4984bd63`。
1,925ファイル＋manifestを検査し、export/checkはそれぞれnpmのdev/optionalを含む
fresh監査とOSV 3照会に成功しました。対応表のsource、policy、manifest hashを照合しました。
先行snapshotの`2cdfabdc…`は中間出力で、最終artifactの識別子ではありません。
現在のschema 2のsource・検証結果は[現在の記録](README.md)を参照してください。

単体では、子が先に保存された非連続の階層、外側の親と兄弟の保持、leaf複製、
全compositionを跨ぐID衝突、対応IDの不足/余分/重複/不正値、20,000 key・1,000 layerの既存上限、
準備後の引数変更、stale/read-only拒否、一操作のUndo/Redo、旧versionのbytes/hash保持を検証しました。

## 失敗と修正の記録

- 初回の新規unitはfixtureの相対import階層を一つ多く記述し、suite読み込みで失敗（0 test）。
  相対pathを修正し18件、続けて全unitが成功しました。
- 初回file policyは実行sandboxの`spawnSync git EPERM`で停止しました。
  同じ検査を実行可能なコマンド環境で再実行し成功しています。検査内容の変更や迂回はありません。
- 初回browserは4 PASS / 1 FAIL / 1 interrupted。IMEが入力値を変更せず終了した後、
  dirtyではなくなったため無効になったCancel inputsをテストがクリックしようとしてtimeoutしました。
  その時点で複製・削除が再び有効になることを確認するテストへ修正しました。
  mobileの同ケースを中断し、修正後の6件を全実行して成功しました。
- 削除確認は独立したnative内容のコピーとrevisionを保持します。内容更新後に古い確認を確定しません。
  操作後のfocus復帰も最終runtimeに含め、その後のbrowserで確認しています。

## 証拠と適用範囲

生ログは`/tmp/issue74-layer-*.log`、画像・traceは上記のoutput directoryに保持し、Gitへ追加しません。
desktopの独立Host、mobileの通常Host、mobileの古い削除確認の画像を目視しました。
削除対象・件数・確定/取消・無効な確定の説明は読め、対象一覧のIDは折り返されます。

実機mobile、native OS IME、Firefox/WebKit、全browser suite、plugin installed Host、
shared/codec/selective Undo、性能測定はNOT RUNです。synthetic IMEはOS変換の合格ではありません。
Actions、公開同期、deployment、plugin pin/配布版の更新は行っていません。
