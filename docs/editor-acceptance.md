# 新しいEditorの受け入れ条件

新しいEditorを「対応済み」と説明する前に、この条件で設計・実装・検証を確認します。[開発ガイド](editor-development.md)と併用し、[設計書](editor-proposal-template.md)で対象機能を固定してから、[検証報告](editor-verification-template.md)に結果を記録してください。

これは新規Editorのレビュー基準です。既存Editorがこの文書の全項目を改めて通過したという証明ではありません。既存の契約、既知の制限、保留中のperformance条件は[status](status.md)のとおりです。

## 判定のルール

| 結果    | 意味                                 | 記載するもの                              |
| ------- | ------------------------------------ | ----------------------------------------- |
| PASS    | 対象範囲の条件を実際の検証で満たした | 対象、command/scenario、環境、結果、証拠  |
| FAIL    | 検証で条件を満たさなかった           | 再現、影響、関連する未解決の問題          |
| NOT RUN | 適用される条件だが検証していない     | 理由、未確認の範囲、実施に必要な環境      |
| N/A     | 宣言範囲の外であり適用しない         | 非対応の宣言と、入口が無効/拒否される根拠 |

「後で実装する」「環境がない」「試していない」はN/Aではありません。能力を宣言したら、その能力の条件は適用対象になります。PASSとFAILを平均して合格にしたり、後のretry成功だけを残して失敗を消したりしません。

Viewer-onlyの場合、変更・Undo・可変draftの編集に関する部分は理由付きでN/Aにできます。Read-only表示、native contentの保持、独立埋め込み、入力検証、権限境界、適用される保存/import契約は残ります。Local-onlyで始める場合はshared条件をN/Aにし、shared入口を有効にしません。

## 段階ごとの受け入れ

| 段階                  | 必要な状態                                                           | 説明してよい範囲                        |
| --------------------- | -------------------------------------------------------------------- | --------------------------------------- |
| 設計レビュー          | Native model、能力matrix、Host境界、移行、budget、検証計画が定義済み | 設計合意。実装/動作の受け入れではない   |
| Prototype             | 未充足の条件と利用制限を明記。通常導線の対応機能として扱わない       | 実験用・未受け入れ                      |
| Local機能受け入れ     | 必須条件N01–N14の適用部分がPASS。関連する条件付き項目もPASS          | 検証済みlocal/Viewer範囲                |
| 能力の追加受け入れ    | その能力の条件を満たし、必須条件と既存能力の回帰を確認               | 検証済みshared/template/format等の範囲  |
| Performance / release | 別途定義したbudget、環境、運用・製品の条件を満たす                   | 実際に承認されたperformance/release範囲 |

適用される必須項目や宣言能力にFAIL/NOT RUNが残る場合、その範囲を受け入れ済みにしません。Prototypeとしてのマージ可否は、露出範囲と影響を明示して別途判断します。契約を弱めたり、実装後に都合よく対象を縮めたりして条件を通さないでください。

## 全Editorの必須条件

| ID  | 条件                                                                           | 最低限の確認・証拠                                                                                                                               |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| N01 | 目的とドメインの意味が定義され、既存のprojectionやHost機能との違いを説明できる | 設計書に代表操作、対応/非対応matrix、kind、所有境界、既存Editorとの差分                                                                          |
| N02 | Native contentが独立・JSON serializableで、不変条件を検証できる                | Domain validatorに正常/異常/境界値。安定ID、参照、finite値、サイズ・深度上限。React/DOMや製品型を必須にしない                                    |
| N03 | Draft、確定version、view stateを区別し、versionはimmutable                     | Commit/restore/旧schema/reloadの確認。過去のcontent/hashが同じであること。選択・camera・panelでcontent hashが変わらない                          |
| N04 | 編集はpure commandとatomic transactionを通る                                   | 代表commandで入力の非破壊、対象以外の値/IDの保持、bulk/pasteの原子性、失敗/Cancelの無変更                                                        |
| N05 | Local Undo/Redoの範囲・入力bufferとの役割が正しい                              | 代表編集とUndo/Redo、gestureが1編集、typingの区切り、Cancel、readonly。Remote更新をsnapshot historyに流さない                                    |
| N06 | Public APIだけで独立Hostへ埋め込める                                           | Playground App/store/CSSをimportしないHostで起動・代表操作。Package CSS、定義済みcontainer、production build entry                               |
| N07 | 通常Hostの能力宣言、factory、validator、Surface、lifecycleが一致する           | 新規作成→代表操作→保存→reload→version表示/importの対象scenario。Unsupported kind/schemaの拒否。未対応の能力を有効にしない                        |
| N08 | 安定IDに基づくselectionと適切なHost通知がある                                  | 選択変更、並べ替え、削除、reload後の対象追跡。Regionを返す場合は型・単位・意味が一致。Viewerの固定sourceは内容を変更しない                       |
| N09 | 権限とread-onlyを全変更入口で強制する                                          | Button、shortcut、paste、headless、proposal等の適用入口を確認。拒否後content/hash/historyが不変。Trusted境界でも検証する                         |
| N10 | Native保存/importが完全性を保ち、失敗を隠さない                                | Native roundtrip、旧schema、draftと全retained versionのdomain/hash検証、不正入力の拒否、失敗時の部分保存なし、retryと遅延保存の確認              |
| N11 | Keyboard、focus、狭いcontainer、mobile viewportで宣言した操作が可能            | Accessible name/label、menu Escape・focus復帰、input中のshortcut、panel/scroll/overflow、desktop/mobileの代表操作とscreenshot確認                |
| N12 | Untrusted contentを実行せず、依存・assetの扱いが明確                           | JSONはdata。HTML/SVG/URL等のsanitization/sandbox/上限、危険な入力の拒否。Asset/第三者依存にはlicenseとprovenance。認証情報や個人データを含めない |
| N13 | 変更範囲に応じた検証が再現でき、回帰を確認した                                 | Lint/typecheck/unit/build、file/tooling policy、該当desktop/mobile・独立Host・関連Editorの回帰。使用configと実行対象、失敗、未実施対象を記録     |
| N14 | 利用者と開発者向けの説明が実装と一致する                                       | README/status/契約、public API、対応matrix、known limits、Host責任、設計書、条件IDごとの検証結果。Performance/deploymentの保証を混同しない       |

「画面に表示できる」だけでN06/N07はPASSになりません。編集を宣言する場合は実際の編集経路、Viewerの場合はread-only・原本保持の経路を確認します。保存や移行などHost責任の条件は、参照Hostとの統合結果で確認してください。

## 宣言した能力に適用する条件

| ID  | 適用される宣言                                | 条件と確認内容                                                                                                                                                                                     |
| --- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C01 | Contentのtext editing / IME                   | Native composition、Enter/Delete/選択、編集bufferとplatform Undoの役割、composition中のpeer更新がある場合の整合性を確認。合成eventの確認とOSのnative IME確認を区別                                 |
| C02 | Annotation / region anchor                    | Domain単位・source version・sideが一致。Move/edit/delete/restore後のmappingとorphan/outdatedが正しい。固定sourceを誤更新しない                                                                     |
| C03 | 外部proposal / deterministic headless操作     | UIと同じvalidation/command境界。Preview不変、apply時のrevision/permission再検証、reject/Cancel無変更、採用は一つのUndo対象。AI runtimeはHost所有                                                   |
| C04 | Shared editing                                | 下記S01–S06すべてと[通常Editorのcoverage](editor-collaboration-coverage.md)に対応範囲を記載                                                                                                        |
| C05 | Template creation / fragment / preset         | 宣言するkindのauthor/validate/preview/apply経路。Exact version、ID/参照remap、atomic transaction、Cancel無変更。Whole creationはatomicかつ同じrequestにidempotent、異なる内容の同IDはconflict      |
| C06 | Linked reuse / component / token              | Exact version/hashとretained dependency closure、所有権/local override/slot、更新preview・conflict・Undo、missing/cycle/unknown mode拒否。Importでdraftと全versionを検証                           |
| C07 | 外部format import/export                      | Supported/loss/reject matrix、asset/ID/style/textの扱い、対応範囲のroundtripと実際のreader/output確認。Nativeの完全性と外部形式のlossを区別。OfficeはXML/ZIP生成と実際のopen/render/editを別に報告 |
| C08 | React preview / TSX / Design bridge           | Hostが登録した原本とtyped contractに基づく実際のpreview、独立build/export。Semantics/routes/diagnosticsを宣言。Regenerationは独立編集を保持しconflictを拒否                                        |
| C09 | 大容量asset / recovery / offline              | 宣言する上限、欠落・破損・中断・retry/recovery、import原子性。No data lossを保証する保存範囲と限界を記載。未提供のdurabilityを保証しない                                                           |
| C10 | 特定browser / 実機 / assistive technology対応 | 宣言対象の実環境で代表操作を確認。Viewport、browser engine、実機、screen reader検証は別々に結果を記載                                                                                              |

C01のnative IME等が未検証なら、その宣言能力にはNOT RUNが残ります。実装があることだけで検証済みとしません。対応範囲を変更する必要がある場合は、設計matrixと利用者への説明を更新してレビューしてください。

### Shared editingの追加条件

| ID  | 条件                                                        | 代表scenario                                                                                                                                 |
| --- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| S01 | 通常Editorの対応操作をserializable operationへ変換できる    | Toolbar/Inspector/keyboard/clipboard/headlessから同じauthorityへ到達。未対応操作は理由付き拒否、local fallbackによる変更なし                 |
| S02 | Authorityが権限・precondition・asset・最終contentを検証する | Revoked/expired/readonly、stale計算、deleted target、schema mismatch、invalid payload。Multi-action failureは全体を拒否                      |
| S03 | Concurrent editingとtext engineがドメインの意味を保つ       | 独立peerの同/異対象編集、text rebase、delete/move競合、computed read dependency。結果だけでなく不変条件と無関係な値の保持も確認              |
| S04 | Selective Undo/Redoがactor/sessionに従う                    | A編集→B編集→A UndoでBの編集が残る。競合時の理由、再接続・入力bufferとのhistory境界                                                           |
| S05 | Pending/confirmed、再接続、重複、Cancel、保存を正しく扱う   | Delayed/reordered/duplicate transport、disconnect/reconnect、permission更新。Pending中save/export/restoreをguardし、private viewは共有しない |
| S06 | 通常Surfaceと独立Hostのend-to-end統合が検証されている       | 複数browser contextとheadless、reference/fault adapter、asset/anchor/proposalの宣言経路。Labだけの結果を通常Editorの結果にしない             |

Production authentication、永続server、組織・Room policy、実運用のscaleはHost側の別受け入れです。Reference HostでS01–S06を通しても、それらの保証にはなりません。

## 必要な代表scenario

少なくとも下記から適用されるscenarioを、独立Hostと通常Hostの検証へ割り当てます。Test名だけでなく、期待するcontent/hash/ID/historyの結果も書きます。

1. **基本経路**: 作成→2種類以上の代表操作→Undo/Redo→保存→reload→native export/import。Viewerなら選択・表示移動と原本不変を確認。
2. **失敗経路**: 不正入力、上限、missing target、storage failure、Cancel。Content、version、libraryに部分的な結果が残らない。
3. **互換性**: 旧schemaのfixtureを読む。Draftの移行/restore後も旧version bytes/hashが変わらない。
4. **権限**: Read-only中のbutton/shortcut/paste/headless/proposalを拒否。UIを迂回しても変更されない。
5. **埋め込み**: Playground state/CSSなし、外部panel制御、狭いcontainer、production build、focusとkeyboard。
6. **能力別**: Sharedのpeer/fault、templateの重複creation、reuseのconflict、formatのlossなど、宣言した各条件の正常系と拒否系。

既存の汎用unitが通るだけでは、新しいEditorのdomain validator、通常UI、import分岐、capability adapterが動いた証拠になりません。条件と実際のscenarioを対応付けてください。

## 検証報告に残すもの

- 検証対象commit、kind、宣言能力と上限、設計/契約の版。
- Node/browser/OS、viewport、Host、dev/production、reference server/adapter等の環境。
- 実行commandとconfig、test/scenario、結果、条件ID、ログ・screenshot等の参照。
- FAIL/NOT RUN/N/Aと理由。再実行した場合は最初の失敗も追跡できるようにする。
- 検査の限界: 合成IME、viewportだけのmobile、未実施browser、未実施の実Office等。
- 判定: Local受け入れ/能力別受け入れ、未解決blocker、別途保留されているperformance/release条件。

Raw log、trace、screenshot、生成exportはGit外へ置き、Gitには小さな検証報告と必要な参照だけを残します。Private環境のURL、個人情報、秘密のデータを公開報告へ含めません。公開readerが参照できない証拠がある場合は、その事実と再現方法を説明します。

## Performance・公開判断に関する注意

Functional PASSから速度やproduction readinessを推定しません。Workloadのサイズ、sample数、warmup、repetition、p95/最大値、失敗sample、network delayの扱いを測定前に決めます。既存の[budget](reuse-performance-budgets.md)を使う場合は、その対象fixtureと条件を維持してください。

現在の正式performance受け入れは保留で、追加測定・tuningは停止中です。新しいEditorの機能受け入れが完了しても、この保留は解除されません。測定をしていない項目や、snapshotの公開・同期を、performance/releaseの合格として扱わないでください。
