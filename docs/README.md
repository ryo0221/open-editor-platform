# ドキュメント案内

起動方法は[root README](../README.md)、現在の対応範囲は[実装状況](status.md)を参照してください。
文書を追加・更新する際は[文書の記載方針](documentation-guide.md)で記載先を確認します。

## 利用・組み込み

| 目的                               | 文書                                                                                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 操作の意味とEditorごとの違いを知る | [Surface契約](surface-semantics.md)                                                                                                                                                |
| アプリケーションへ埋め込む         | [埋め込みAPI](embedding.md)・[Host組み込み](host-integration.md)                                                                                                                   |
| 共同編集を接続する                 | [接続手順](editor-collaboration-integration.md)・[対応範囲](editor-collaboration-coverage.md)・[Hostの責任](collaboration-host.md)                                                 |
| テンプレート・再利用を使う         | [テンプレート操作](template-authoring.md)・[カタログ](template-catalog.md)・[再利用の構成](reuse-composition.md)                                                                   |
| 成果物間の参照・ファイル出力を使う | [参照契約](artifact-references.md)・[出力契約](artifact-output-contract.md)                                                                                                        |
| Officeファイルを扱う               | [出力UIと対応形式](office-export-ui.md)・[取り込み](office-import.md)                                                                                                              |
| React UI・DesignのReact出力を使う  | [React UI組み込み](react-ui-integration.md)・[移植手順](react-ui-portability.md)・[Design連携](design-react-contract.md)                                                           |
| Graph・Designの機能を組み込む      | [Graph契約](structured-graph-contract.md)・[Graph表示設計](graph-reading-design.md)・[Design headless操作](design-headless-contract.md)・[prototype](design-prototype-contract.md) |
| Animation・Geoを使う               | [Animation 2D](animation/production-2d-design.md)・[Geoガイド](geo-guide.md)                                                                                                       |

## 開発・設計

| 目的                   | 文書                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 開発に参加する         | [開発者ガイド](developer-guide.md)・[作業ルール](../AGENTS.md)                                                                                         |
| 全体の構成を理解する   | [アーキテクチャ](architecture.md)                                                                                                                      |
| Editorを追加・拡張する | [Editor開発ガイド](editor-development.md)・[受け入れ条件](editor-acceptance.md)                                                                        |
| 設計・検証を記録する   | [設計テンプレート](editor-proposal-template.md)・[検証報告テンプレート](editor-verification-template.md)・[記載先と更新ルール](documentation-guide.md) |

## 検証・運用・履歴

- [実装状況と制限](status.md)：現在の対応範囲と各機能の根拠への案内。
- `docs/verification/<topic>/`：topicごとのsource・環境・実施結果。例：[React UIの受け入れ記録](verification/issue-24/README.md)。各記録は対応する機能文書から参照します。
- [環境・資産・CI](repository-assets.md)：フォント、ファイルサイズ、CI運用、生成資料の保持と取得。
- [実装報告の履歴](history/status-2026-10-19.md)：文書整理前の記録。現在の対応範囲はstatusで確認してください。

公開版では、公開用のREADME・statusなどが適用されます。公開範囲に応じて文書とリンクを確認します。
