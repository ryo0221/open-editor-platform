# Editor検証報告テンプレート

新しいEditorや能力追加の受け入れに使う報告書です。コピーして`[記入]`を埋め、[受け入れ条件](editor-acceptance.md)のIDと実際の検証を結び付けます。実行していない確認を過去の結果からPASSにしないでください。

## 対象と宣言範囲

| 項目                        | 内容                                             |
| --------------------------- | ------------------------------------------------ |
| Editor / kind / package     | [記入]                                           |
| 検証したrepository / commit | [記入: 公開報告には公開側で参照できる情報を使う] |
| 設計書の版 / 対象PR         | [記入]                                           |
| 実施日時                    | [記入]                                           |
| 宣言する能力と上限          | [記入: 設計matrixと一致させる]                   |
| 非対応 / 未実装             | [記入]                                           |
| 今回の変更と回帰対象        | [記入]                                           |

## 環境

| 項目                                        | 値                                 |
| ------------------------------------------- | ---------------------------------- |
| OS / Node / npm                             | [記入]                             |
| Browser / version / project                 | [記入]                             |
| Desktop / mobile viewport / embed container | [記入]                             |
| 独立Host / 通常Host / dev・production build | [記入]                             |
| Server / adapter / fault条件                | [記入 / N/A理由]                   |
| Fixture / schema / asset / font             | [記入]                             |
| Native IME / 実機 / assistive technology    | [実施した環境 / NOT RUN / N/A理由] |
| Office等の外部reader                        | [実施した環境 / NOT RUN / N/A理由] |

## 実行記録

| Command / config / scenario     | 対象・件数                  | 結果    | 証拠・失敗への参照 |
| ------------------------------- | --------------------------- | ------- | ------------------ |
| `npm run check:files` / tooling | [記入]                      | NOT RUN | [記入]             |
| Lint / typecheck                | [記入]                      | NOT RUN | [記入]             |
| Unit                            | [対象と件数]                | NOT RUN | [記入]             |
| Build / 独立Host entry          | [記入]                      | NOT RUN | [記入]             |
| Desktop / mobile browser        | [config/project/specと件数] | NOT RUN | [記入]             |
| 宣言能力 / 関連回帰             | [記入]                      | NOT RUN | [記入]             |

結果の初期値は`NOT RUN`です。実施したものだけ更新します。一部のspecだけなら「全browser回帰PASS」と書かず、対象を明記します。異なるsnapshot/commitの結果を混ぜません。

## 条件ごとの判定

各行をPASS/FAIL/NOT RUN/N/Aのいずれかにし、PASSには証拠、N/Aには宣言範囲外である理由と入口の扱いを書きます。部分的な確認だけなら、未確認部分を残してください。

| ID                        | 結果    | Test / 手動scenario / 証拠 | 未確認の範囲・N/A理由 |
| ------------------------- | ------- | -------------------------- | --------------------- |
| N01 目的・native domain   | NOT RUN | [記入]                     | [記入]                |
| N02 Model・validation     | NOT RUN | [記入]                     | [記入]                |
| N03 Draft/version/view    | NOT RUN | [記入]                     | [記入]                |
| N04 Pure/atomic command   | NOT RUN | [記入]                     | [記入]                |
| N05 Local Undo/Redo       | NOT RUN | [記入]                     | [記入]                |
| N06 独立Host              | NOT RUN | [記入]                     | [記入]                |
| N07 通常Host・能力登録    | NOT RUN | [記入]                     | [記入]                |
| N08 Selection/event       | NOT RUN | [記入]                     | [記入]                |
| N09 Read-only/権限        | NOT RUN | [記入]                     | [記入]                |
| N10 Native保存/import     | NOT RUN | [記入]                     | [記入]                |
| N11 Keyboard/mobile/focus | NOT RUN | [記入]                     | [記入]                |
| N12 Untrusted input/asset | NOT RUN | [記入]                     | [記入]                |
| N13 回帰・検証の再現性    | NOT RUN | [記入]                     | [記入]                |
| N14 文書・対応宣言        | NOT RUN | [記入]                     | [記入]                |
| C01 Text/IME              | NOT RUN | [記入]                     | [記入]                |
| C02 Annotation/anchor     | NOT RUN | [記入]                     | [記入]                |
| C03 Proposal/headless     | NOT RUN | [記入]                     | [記入]                |
| C04 Shared                | NOT RUN | [S01–S06へ対応付け]        | [記入]                |
| C05 Template              | NOT RUN | [記入]                     | [記入]                |
| C06 Reuse/token           | NOT RUN | [記入]                     | [記入]                |
| C07 外部format            | NOT RUN | [記入]                     | [記入]                |
| C08 React/bridge          | NOT RUN | [記入]                     | [記入]                |
| C09 Large asset/recovery  | NOT RUN | [記入]                     | [記入]                |
| C10 特定環境              | NOT RUN | [記入]                     | [記入]                |

Shared対応の場合は以下も記録します。非対応ならC04にN/Aの根拠を記載してください。

| ID                    | 結果    | Test / scenario / 証拠 | 未確認の範囲 |
| --------------------- | ------- | ---------------------- | ------------ |
| S01 通常操作とwire    | NOT RUN | [記入]                 | [記入]       |
| S02 Authority/原子性  | NOT RUN | [記入]                 | [記入]       |
| S03 Concurrent/text   | NOT RUN | [記入]                 | [記入]       |
| S04 Selective Undo    | NOT RUN | [記入]                 | [記入]       |
| S05 Pending/reconnect | NOT RUN | [記入]                 | [記入]       |
| S06 通常/独立Host E2E | NOT RUN | [記入]                 | [記入]       |

## 重要scenarioの具体的な結果

- 作成/代表編集/Undo/Redo/保存/reload/native roundtrip: [操作、期待結果、実結果]
- Viewer/read-onlyとUI以外の拒否経路: [content/hash/history不変の確認]
- Import異常、atomic failure、Cancel、storage retry: [部分的な結果が残らない確認]
- 旧schema、draft移行/restore、retained version: [旧bytes/hashを保持した確認]
- 独立Host、狭いcontainer、keyboard/focus、mobile: [表示・操作・screenshotの確認]
- 能力別のpeer conflict、template/reuse、外部format等: [正常/拒否の実結果]

## 未解決事項と証拠の限界

| 条件ID / 問題 | 影響・再現方法 | 対応方針・受け入れへの影響 |
| ------------- | -------------- | -------------------------- |
| [記入]        | [記入]         | [記入]                     |

- 初回失敗、retry、flaky結果とその原因: [記入。成功だけに置き換えない]
- 未実施browser/実機/native IME/外部reader: [記入]
- 証拠へのアクセス制限と、公開環境での再現方法: [記入]
- 現在のperformance保留と測定停止: [記入。未測定を合格にしない]

Raw log、trace、画像、build、生成exportはGit外に保持します。報告書にcredentials、個人情報、private URL、秘密のfixtureを貼り付けません。

## 受け入れ判断

- 今回の判定: [未受け入れ / prototype / local機能受け入れ / 特定能力の受け入れ]
- 受け入れるkind・能力・上限: [記入]
- FAIL/NOT RUNが残り受け入れられない範囲: [記入]
- 設計matrix・機能契約・利用ガイド・statusに反映した非対応/制限: [記入。READMEは概要・起動・導線が変わる場合に更新し、記載先は文書の記載方針で確認する]
- 別判断のperformance/release/production運用・製品trial: [記入]
- レビューの判断と根拠: [記入]
