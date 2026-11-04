# ドキュメント案内

起動方法は[root README](../README.md)、現在の対応範囲は[実装状況](status.md)を参照してください。
文書を追加・更新する際は[文書の記載方針](documentation-guide.md)で記載先を確認します。

## 利用・組み込み

| 目的                                    | 文書                                                                                                                                                                               |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 操作の意味とEditorごとの違いを知る      | [Surface契約](surface-semantics.md)                                                                                                                                                |
| アプリケーションへ埋め込む              | [埋め込みAPI](embedding.md)・[Host組み込み](host-integration.md)                                                                                                                   |
| 共同編集を接続する                      | [接続手順](editor-collaboration-integration.md)・[対応範囲](editor-collaboration-coverage.md)・[Hostの責任](collaboration-host.md)                                                 |
| テンプレート・再利用を使う              | [テンプレート操作](template-authoring.md)・[カタログ](template-catalog.md)・[再利用の構成](reuse-composition.md)                                                                   |
| 成果物間の参照・ファイル出力を使う      | [参照契約](artifact-references.md)・[出力契約](artifact-output-contract.md)                                                                                                        |
| Officeファイルを扱う                    | [出力UIと対応形式](office-export-ui.md)・[取り込み](office-import.md)                                                                                                              |
| React UI・DesignのReact出力を使う       | [React UI組み込み](react-ui-integration.md)・[移植手順](react-ui-portability.md)・[Design連携](design-react-contract.md)                                                           |
| 外部の参照元を読む（Geo・Data・GitHub） | 読取契約・ADR 016                                                              |
| 外部の提案をdomainの差分で確かめる      | [提案のdomain別の差分](proposal-review.md)                                                                                                                                         |
| Graph・Designの機能を組み込む           | [Graph契約](structured-graph-contract.md)・[Graph表示設計](graph-reading-design.md)・[Design headless操作](design-headless-contract.md)・[prototype](design-prototype-contract.md) |
| Animation・Geoを使う                    | [Animation 2D](animation/production-2d-design.md)・[Geoガイド](geo-guide.md)                                                                                                       |

## 開発・設計

計算領域の設計：[共通計算](calculation/design.md)・[分析ノート](analysis-notebook/design.md)・[見積・積算・工程](design-estimation/design.md)。初期設計の検証記録と現在の実装記録は区別します。

| 目的                            | 文書                                                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 開発に参加する                  | [開発者ガイド](developer-guide.md)・[作業ルール](../AGENTS.md)                                                                                                   |
| 全体の構成を理解する            | [アーキテクチャ](architecture.md)                                                                                                                                |
| Editorを追加・拡張する          | [Editor開発ガイド](editor-development.md)・[受け入れ条件](editor-acceptance.md)                                                                                  |
| Fiction Mapの操作・pure native  | [操作ガイド](fiction-map/user-guide.md) / [headless model API](../packages/fiction-map/README.md) / 設定から作る制作デモ計画 |
| Designのパス編集・曲線APIを使う | [操作ガイド](vector-authoring/guide.md)・[設計と受け入れ条件](vector-authoring/design.md)・[実装計画](vector-authoring/implementation-plan.md)                   |
| 設計・検証を記録する            | [設計テンプレート](editor-proposal-template.md)・[検証報告テンプレート](editor-verification-template.md)・[記載先と更新ルール](documentation-guide.md)           |

## 検証・運用・履歴

- [実装状況と制限](status.md)：現在の対応範囲と各機能の根拠への案内。
- `docs/verification/<topic>/`：topicごとのsource・環境・実施結果。例：[React UIの受け入れ記録](verification/issue-24/README.md)。各記録は対応する機能文書から参照します。
- [環境・資産・CI](repository-assets.md)：フォント、ファイルサイズ、CI運用、生成資料の保持と取得。
- [実装報告の履歴](history/status-2026-10-19.md)：文書整理前の記録。現在の状態はstatusで確認してください。

公開版では、公開用のREADME・statusなどが適用されます。公開範囲に応じて文書とリンクを確認します。

- 見積・積算・工程の利用とHost接続（実装中）
- [計算・分析ノートの利用とHost接続](analysis-notebook/guide.md)
- [計算・分析ノートの検証記録](verification/analysis-notebook/README.md)

長編Document・Designの複数ページ: [Host契約](authoring-contract.md) / [設計](novel-comic-design.md) / [検証](verification/novel-comic/README.md)。

後続の制作能力: [Designページ線画・吹き出し](design-page-artwork.md) / [Document出版出力の段階設計](document-publishing-design.md) / [水平EPUBの検証](verification/document-epub/README.md)。

漫画制作UXの後続提案: [共同ネーム・作画・参照・出力の設計](manga-creation/design.md)。現行能力、追加仕様、未決事項と段階別の受入条件を分けています。

漫画専用画面と通常Designを同じ原稿で往復する: [操作・APIガイド](manga-creation/guide.md) / [ワークスペースとコマ境界の設計](manga-creation/workspace-design.md)。直線分割・連動境界・通読・提案採用のlocal/native実装と制限を説明します。

小説専用画面と通常Documentを同じ原稿で往復する: [小説ワークスペースの設計案](novel-creation/workspace-design.md)。漫画と共通にする部分、日本語組版の段階、文字数・表記照合を整理しています。

通常PlaygroundのDesignで線・画像を編集する: [ペン入力・提案の比較と採用](playground-inking.md) / [限定PNG編集](design-raster-editing.md)。人物・動物別の生成presetや作品制作Hostはこの汎用契約に含めません。

キャラクター・3Dアニメーション（モデリング・リグ・キーフレーム）: [Characterの設計](character/README.md)・ADR 019。

キャラクター・舞台設計モード: D0設計提案。CH/LO正本、Host参照、部位レイヤー、proposal差分とprovenanceの依存関係を整理しています。

Character Mode（D1）: CH人物表を正本とするカード・設定画・候補・部位編集の参照Host。既存Data/Designとproposalを再利用します。

Setting Mode（D2a）: 世界の覚え書きのLO見出しを正本とする舞台設計。D1 HostとDocument/Designを再利用します。

小説・漫画の横断制作（D3a）: 既存Workspace右ペインの人物・場所参照、設定編集からSceneへの復帰、exact versionと明示更新。地図に依存しません。

ラフからレイヤー別清書: nativeラフ修正、基準保存版、画像レイヤーの生成依頼と比較/採否。AI実行とWorkflowは消費Host側。

作品世界と制作前提の接続: CW1の採用版と資料往復、CW2の明示した生成接続、CW3のlocal地図・場所・設定画・Scene参照。既定Hostの実AI、実生成品質、利用製品での受入は別段階です。

物語タイムライン（設計）: 裏側の出来事、提示順、人物の認識、世界線を既存の正本とつなぐ編集モード。受入シナリオで二世界・回想・変更影響・保存を具体化しています。T0契約で正本・保存・依存粒度とfixtureを確定しています。参照Hostの診断・試算と受入記録で実装範囲を確認できます。

物語タイムラインの診断根拠・例外・変更影響: 既存reader/resolverの責務、保存後の例外照合、facet伝播を整理した採用済み設計です。#693の実装・検証記録と最終受入・main反映を参照してください。

物語ボードの使い方: 一枚のWhiteboardで人物別Timeline・固定地図・カード・自由メモを確認します。共通時点、人物/場所/筋の表示条件、owner別保存と元資料往復に対応。Hostへの組み込みは契約、受入範囲は最終検証。
