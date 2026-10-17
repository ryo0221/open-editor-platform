# 開発者ガイド

この文書は、Editor Platformへの参加、既存Editorの拡張、新しいEditorの追加の入口です。新しいEditorの設計・実装手順は[Editor開発ガイド](editor-development.md)、レビュー時の判断基準は[受け入れ条件](editor-acceptance.md)を参照してください。

## 最初に理解すること

Editorは単独で埋め込める編集機能です。Playgroundは複数のEditorを組み合わせた参照Hostであり、特定製品のアプリケーションではありません。認証、組織・Roomの管理、ワークフロー、AIの実行、製品固有の参照、運用基盤は利用側のHostが担当します。

共通化するのはArtifactのライフサイクル、選択、command/transaction、履歴、イベント、Hostとの接続契約です。Documentの意味的な文章構造、Dataのレコード、Slideのページ、Whiteboardの無限平面などのcontentは、それぞれ独立したモデルとして保ちます。

| 状態・機能                  | 主な責任                           | 開発時の注意                                                          |
| --------------------------- | ---------------------------------- | --------------------------------------------------------------------- |
| Native content              | 各ドメインのmodel/commands         | 安定ID、整合性、入力検証、移行を定義する                              |
| Draft / immutable version   | `artifact-core`とHost              | Draft更新とversion確定を区別する。過去のversionを書き換えない         |
| Surface                     | 各ドメインのReact view             | public propsで接続し、Playgroundの状態やCSSを必要としない             |
| Local history               | `editor-core`の`EditorSession`     | 自分のlocal draft用。remote更新を流さない                             |
| Shared history / integrity  | collaboration packages             | authorityで検証したoperationとactor/session単位のselective Undoを使う |
| 保存・権限・外部処理        | Host / adapter                     | 保存失敗を表示し、権限を実行境界でも強制する                          |
| Camera・panel・一時的な選択 | Surface / Hostのprivate view state | content hash、version、共有Undoに混入させない                         |
| AI・ツール実行              | Host                               | Editorには提案された変更を渡し、preview/apply/rejectする              |

`readOnly`でボタンを消すだけでは権限制御になりません。ショートカット、貼り付け、headless API、提案の採用など、同じ変更に至る全入口をHostの実行境界でも検証します。共有時にはtrusted submission/authority側の検証が必要です。

## 推奨する読む順番

1. [README](../README.md)と[実装状況・制限](status.md): 起動方法と、現在どこまで検証されているか。
2. [アーキテクチャ](architecture.md)と[Surface固有の意味](surface-semantics.md): 共通契約と各ドメインの違い。
3. [埋め込み](embedding.md): Playgroundに依存しないpublic APIの使い方。
4. [Editor開発ガイド](editor-development.md)と[受け入れ条件](editor-acceptance.md): 設計からレビューまでの手順。
5. 対応する機能の契約: [通常Editorの共有編集](editor-collaboration-integration.md)、[対応範囲](editor-collaboration-coverage.md)、[テンプレート](template-contract.md)、[リンク再利用](reuse-contract.md)、[Office](office-export-contract.md)、[React UI](react-ui-contract.md)。

過去のIssue番号や検証Labの説明は実装の経緯を表します。Labでoperationが動くことだけで、通常Editorのツールバー・テキスト入力・保存・提案の経路まで対応したとは判断しません。

## ローカル環境

Node.js 20.20.2、npm、Python 3.10以上を推奨します。Nodeの最低要件は`package.json`も確認してください。

```sh
npm ci
npm run fonts:fetch
npm run dev
```

最初のfont取得にはネットワークが必要です。以降の通常起動には認証、API key、外部AI、製品のbackendは不要です。`fonts:check`が失敗した場合はフォントを準備し、検査を無効化して通さないでください。

Playgroundのdraft/versionはブラウザのIndexedDBに保存されます。ブラウザのデータ削除で失われるため、必要な内容はnative JSONで退避してください。private view state、選択、Undo stackはcontentのバックアップと同じものではありません。

追加の参照Host:

- 埋め込み: `/embed.html`。
- 共有編集: 別terminalで`npm run collaboration:server`。サーバーはin-memoryの参照実装です。
- React UIのpreview/build: 別terminalで`npm run react-ui:dev`。元のReact実装とruntimeはHostが管理します。

workspacesは`private: true`でTypeScript sourceを公開entrypointから渡します。このリポジトリを追加することと、npm向けのJS packageを配布することは別の作業です。

## コードの見取り図

| 場所                                                                                                                          | 読む目的                                                            |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [`packages/artifact-core/src/index.ts`](../packages/artifact-core/src/index.ts)                                               | Draft/version、canonical hash、storage adapter                      |
| [`packages/editor-core/src/index.ts`](../packages/editor-core/src/index.ts)                                                   | Command、transaction、local Undo、selection、proposal、typed events |
| [`packages/editor-ui/src/index.tsx`](../packages/editor-ui/src/index.tsx)                                                     | `EditorLayoutProps`、panel/focus、toolbarなどの共通UI               |
| [`packages/slide/src/model.ts`](../packages/slide/src/model.ts) / [`view.tsx`](../packages/slide/src/view.tsx)                | 独立したmodel/commandsとSurfaceの実例                               |
| [`apps/playground/src/model.ts`](../apps/playground/src/model.ts) / [`App.tsx`](../apps/playground/src/App.tsx)               | Hostのkind一覧、factory、入力検証、保存・import/exportの接続        |
| [`apps/playground/src/embed.tsx`](../apps/playground/src/embed.tsx)                                                           | public packageだけを使う独立Host                                    |
| [`packages/collaboration-core/src/contracts.ts`](../packages/collaboration-core/src/contracts.ts)                             | Serializable operation、codec、authorityの契約                      |
| [`packages/collaboration-adapters/src/editor-transactions.ts`](../packages/collaboration-adapters/src/editor-transactions.ts) | 通常Editor commandとshared operationの接続                          |
| [`packages/templates/src/types.ts`](../packages/templates/src/types.ts)                                                       | Templateのdomain、native content、入力契約                          |
| [`packages/reuse-core/src/contracts.ts`](../packages/reuse-core/src/contracts.ts)                                             | 再利用定義、exact version、依存関係、上限                           |
| [`tests/e2e/fixtures.ts`](../tests/e2e/fixtures.ts)                                                                           | browser errorを失敗にする共通fixture                                |

実装例を読む際は、モデルの構造や対応範囲までそのままコピーしないでください。既存Editorにはそのドメイン固有の制約があります。

## 変更の進め方

小さな修正では、変更理由、影響する契約、再現・検証結果をPRに書きます。新しいEditorや大きな能力の追加では、[設計テンプレート](editor-proposal-template.md)を先に埋め、対象範囲を確認してから実装します。

1. 既存contentの別の見せ方か、新しい独立ドメインかを判断する。
2. 対応機能、非対応、モデルの不変条件、Hostとの境界、保存/移行方針を定義する。
3. Pure modelとcommandを実装し、操作の失敗時に変更が残らないことを確認する。
4. Surfaceと独立Host、通常Hostを接続する。
5. 宣言した機能のadapterを接続し、[検証報告テンプレート](editor-verification-template.md)に証拠を記録する。
6. [受け入れ条件](editor-acceptance.md)に照らしてレビューする。未実施の検査があるときは、その能力を受け入れ済みにしない。

UI操作、command、共有operation、content schemaは別の契約です。一つの層に機能を追加しただけで残りの層が自動的に対応するわけではありません。

## 検証の基本

動作・モデル・APIを変更する場合の基本確認:

```sh
npm run check:files
npm run test:tooling
npm run lint
npm run typecheck
npm test
npm run build
npx playwright install --with-deps chromium
npm run test:e2e -- tests/e2e/issue2-embedding.spec.ts tests/e2e/issue2-mobile.spec.ts
```

最後の行は既存の埋め込み・mobile検証の例です。新Editorのspecと必要な関連回帰を加え、desktop/mobile双方の対象を実行してください。production buildの確認とdev serverの確認は区別して記録します。全回帰を実施したと記載するには、実際の全対象・project・設定を報告します。

文書だけの変更では、記載したAPI・コマンド・リンク、format、公開snapshotへの収録と残留チェックを確認します。実施していないunit/browser検証を文書変更の結果として再掲しません。PRを作成したことや自動CIが存在することも検証の実施を意味しません。

現状、追加のperformance測定・tuningは停止しており、既存の正式performance受け入れは保留です。[状況](status.md)と[測定契約](reuse-performance-budgets.md)を確認してください。新しいEditorのworkloadとbudgetは測定前に設計しますが、停止中に追加測定を実施したり、未測定を合格と書いたりしません。

## PRに必要な説明

React UIの汎用登録抽出・改訂／構成差分は[portability手引き](react-ui-portability.md)、
保存済み版からのファイル受け渡しは[成果物出力契約](artifact-output-contract.md)を参照する。
TypeScript toolingはHost/build時の任意packageで、通常Editor runtimeの依存にはしない。
元実装／依存hash・wrapper等の方針・承認／配置はHostが提供する。

- 利用者のどの操作がどう変わるか、どのkind/capabilityに影響するか。
- 変更したschema/public APIと、既存Artifact・旧version・既存Hostへの影響。
- 必須条件と条件付き条件の結果、適用外の理由、未実施・未対応・既知の制限。
- 実際に実施したcommand、commit、環境、対象、結果、関連する失敗・回帰の記録。
- 該当する契約・README・statusの更新。生成画像、ログ、build、font、exportはGit外に置く。

公開用文書もcanonicalな開発元で保守し、レビュー済みsnapshotへ含めます。公開側だけを変更すると次の同期で衝突するため、maintainerが開発元へ反映してから同期します。[README](../README.md)の更新・貢献方針も参照してください。

## 開発時によくある誤り

| 誤り                                                          | 必要な対応                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------ |
| 全Editorのcontentを共通node schemaにまとめる                  | 共有する契約とドメイン固有の意味を分ける                           |
| `Artifact.kind`に文字列を足せば全Hostで動くと思う             | closed union、factory、validator、Surface分岐と各adapterを確認する |
| 表示順のindexをelement IDにする                               | 並べ替え・reload・import後も追跡できるIDを使う                     |
| React component内から直接contentを変更する                    | 通常command/transactionの境界へ渡す                                |
| 保存失敗でも「Saved」にする                                   | 未保存状態、原因、retryを利用者へ知らせる                          |
| Shared modeで非対応操作をlocal commandへ落とす                | 非対応を理由付きで拒否し、内容を変更しない                         |
| 過去のversionを新schemaへ一括更新する                         | 旧readerを保ち、draftの移行やrestoreを新たな変更として扱う         |
| 実際に表示されたpreviewを検証せずmetadataだけで対応済みにする | 宣言した成果物を独立Host/実際の対象で検証する                      |
| 狭いviewportの成功を実機・全browserの成功と書く               | 検証環境と未実施対象を明記する                                     |
| importしたJSONをcommandやJSとして実行する                     | データとして検証し、trusted codeのcommandへ変換する                |

## Artifact Host integration example

The [public Host contract](host-integration.md) and `apps/artifact-host` show per-ID
local Session ownership, attach/detach, save results, domain-specific formats and
readonly/failure handling without Playground dependencies. Actual Site Host sources
live separately in `apps/studio-demo`. Use the condition matrix
for verified scope and unrun environments; this example does not certify shared or
production authorization/durability.
