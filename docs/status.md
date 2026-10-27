# 実装状況と制限

この文書は現在の対応範囲と、仕様・検証記録への入口をまとめます。
実行source、環境、件数、再現手順はリンク先の記録で確認してください。
個別Issueの経緯は[整理前の実装報告](history/status-2026-10-19.md)に保存しています。
記載先の使い分けは[文書の記載方針](documentation-guide.md)を参照してください。

## EditorとHost

| 対象                        | 現在の対応                                                                                                                        | 主な制限・参照先                                                                                                                                                                                                                                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Document                    | 意味的な文章構造、リッチテキスト、表、文書出力、Host履歴を使うショートカット                                                      | 形式ごとの対応は[Surface契約](surface-semantics.md)・[Office入出力](office-export-ui.md)。キーの接続は[埋め込み](embedding.md)                                                                                                                                                                                     |
| Structured Data             | Grid・Form・Graph・Chart・Kanban・Dashboard・Timelineなどが同じレコードを利用                                                     | [埋め込み・CSVの契約](embedding.md)。DataのGraph projectionと独立したGraphは対応範囲が異なる                                                                                                                                                                                                                       |
| Structured Graph            | 型付きProfile、ノード・関係・属性、レイアウト、ノードの形と塗り・Section・自動配置とパレット（Preview）、native JSON、外部adapter | schema 2（Preview・pre-1.0）。schema 1は読まずに断るので、旧版で書き出して作り直す。図のテンプレートはPlaygroundのProfileの例だけ（設計）。共同編集・注釈・テンプレート・形式別出力は非対応。[契約](structured-graph-contract.md)・変更の記録 |
| Review / File Viewer        | テキスト比較、画像・PDF・テキスト閲覧、注釈、元bytesの保持                                                                        | OCR・tagged PDF・Code実行は提供しない。[埋め込み](embedding.md)                                                                                                                                                                                                                                                    |
| Slide / Whiteboard / Design | native canvas編集、履歴、バージョン、対応するテンプレート・出力                                                                   | 各ドメインの操作と座標を維持。[Surface契約](surface-semantics.md)                                                                                                                                                                                                                                                  |
| Designの拡張                | React連携、prototype、再利用テキスト・vector、headless command                                                                    | [React契約](design-react-contract.md)・[prototype](design-prototype-contract.md)・[graphics](design-reuse-graphics.md)・[headless](design-headless-contract.md)の宣言範囲に限定                                                                                                                                    |
| React UI                    | Host登録コンポーネント、分離preview、props・binding編集、TSX出力                                                                  | 元実装とpreview/build環境はHostが提供。[組み込み](react-ui-integration.md)                                                                                                                                                                                                                                         |
| Animation                   | 2Dレイヤー・timeline・graph・mask・motion・nested、通常共有編集、Design変換、Slide/Web/React再生、SVG/PNG                         | schema 2の宣言subset。旧版は読み込みと明示移行。generic template/reuse・animated Slide/Office・video等は非対応。[能力・制限](animation/production-2d-design.md)・[検証](verification/issue-74/README.md)                                                                                                           |
| Geo                         | ローカルCSV/GeoJSON、地図・表編集、オフライン境界背景、Data結合とSlide参照                                                        | CRS84の限定renderer・容量上限。共同編集・template/reuse・背景タイル・geocodingは非対応。[操作と制限](geo-guide.md)・[背景データの範囲・権利条件](geo-background-contract.md)                                                                                                                                       |
| 成果物間参照                | Data/GraphをDocument・Slide・Design・Whiteboardへ、GeoをSlideへ参照                                                               | 保存済み版を固定または明示的に追従。共有参照とOffice/React参照出力は非対応。[契約](artifact-references.md)                                                                                                                                                                                                         |
| Artifact Host               | IDごとのSession、attach/detach、保存・入出力・権限の接続                                                                          | local参照Host。製品の認証・永続性はHostが担当。[組み込み契約](host-integration.md)                                                                                                                                                                                                                                 |

## 共通機能の境界

- 共同編集は[対応表](editor-collaboration-coverage.md)に記載した操作を対象とします。独立Graph・Geoなどへ自動的に拡張されません。Animationはschema 2の宣言subsetに限定します。組織・Room・認証・永続サーバーはHostが担当します。
- テンプレート・リンク再利用は[テンプレート契約](template-contract.md)と[再利用契約](reuse-contract.md)のドメイン別対応に従います。形式別の出力で保持できない情報は[Office契約](office-export-contract.md)などで確認してください。
- ローカル保存はブラウザのIndexedDBを利用します。Undo stackや参照Hostのメモリ内状態を永続保存と同一視せず、必要な成果物はnative JSONで退避してください。
- 既知の入力・出力・frame操作の制約と除外した条件は[監査・レビュー記録](verification/issues-53-73/pr52-review-triage.md)に保持しています。無関係な修正で解消済みと扱いません。

## 検証と運用

- 検証結果は記載されたsource・環境・対象に適用されます。ローカル機能の成功から、別ブラウザ・native IME・実機・外部製品の対応を推定しません。
- React UIの固定条件の受け入れは[記録](verification/issue-24/README.md)を参照してください。追加の性能測定・tuningは停止中です。
- CI/Actionsの実行は停止中です。[CI運用](repository-assets.md)に従い必要な検証をローカルで行います。
- 公開snapshot・配布への反映は個別に確認します。コードの実装やoverlayの更新だけで、利用中のplugin pin・配布版が更新されたとは扱いません。
- snapshotの収録と貢献の扱いは[CONTRIBUTING](../CONTRIBUTING.md)、公開の条件は[OSS Preview gate](release/OSS-PREVIEW-GATE.md)を参照してください。

## 試験的な実装と未受入の範囲

- CAD の model・Surface・参照Host source を収録していますが、D0 kernel配布条件と
  D1の製品受け入れは未達です。OCCT/OpenCascade.js の binary は同梱せず、通常の
  buildではkernelは利用できません。`CAD_OCCT_DIST` は開発用の明示的な外部入力です。
  再現build・512 MiB上限・第三者noticeと対応sourceの提供条件が揃うまで、kernel配布や
  CADの動作保証を行いません。
- Video の WebM/Opus 実験は機能gateが FAIL/BLOCKED（16/16）のままです。codec採用・
  通常Hostへの配布・別環境での受け入れを意味しません。private build入力を指定しない
  通常buildでは追加Video runtimeは無効で、実験用の外部依存・生成runtimeは同梱しません。
- Extension の Counter loader はHostが組み立てた信頼済みの固定graphだけを扱います。
  pin検証は未信頼コードの隔離を保証せず、任意pluginの実行を許可する仕組みではありません。
  独立Editorへの追加ライセンス許諾はdraftのままで、有効な例外ではありません。
- Schedule の source も収録されていますが、公開側での製品受け入れ・外部サービス接続を
  保証しません。参照Hostとドメインごとの明示的な対応範囲を区別してください。
