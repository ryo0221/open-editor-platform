# Template catalog (#4)

Definitions are immutable version-1 native data in [`builtins.json`](../packages/templates/src/builtins.json). Regenerate deliberate built-in revisions with `node scripts/build-templates.mjs`; changing a published definition requires a new template version. Fictional examples are included in the same definitions, and the gallery renders those native examples rather than unrelated thumbnail images.

## Whole artifacts: 25 completed examples

| Domain     | Template                                       | Purpose                                                    | Inputs                                                |
| ---------- | ---------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| slide      | `slide-proposal` — 企画提案                    | 課題・選択肢・次の一歩を3ページで提案                      | title, summary, left, right, conclusion               |
| slide      | `slide-progress` — 進捗報告                    | 期間別の指標と完了・次の対応を報告                         | title, summary, chart, findings                       |
| slide      | `slide-product` — 製品紹介                     | 製品の特長をページごとに紹介                               | title, summary, image, features                       |
| slide      | `slide-comparison` — 選択肢比較                | 左右の条件・利点を比較し結論を共有                         | title, summary, left, right, conclusion               |
| slide      | `slide-research` — 調査結果報告                | 集計グラフと観察結果を区別して報告                         | title, summary, chart, findings                       |
| whiteboard | `whiteboard-brainstorm` — ブレインストーミング | 発散したアイデアを分類して小さな実験へ                     | stage0, stage1, stage2                                |
| whiteboard | `whiteboard-kpt` — KPT振り返り                 | 継続・課題・次の試行をSectionで分離                        | stage0, stage1, stage2                                |
| whiteboard | `whiteboard-journey` — カスタマージャーニー    | 体験の段階を接続し、観察を付箋で記録                       | stage0, stage1, stage2, stage3, stage4                |
| whiteboard | `whiteboard-issues` — 課題整理                 | 事実と仮説を区別して課題を整理                             | stage0, stage1, stage2, stage3                        |
| whiteboard | `whiteboard-process` — プロセス図              | Sectionと接続で処理の順序を共有                            | stage0, stage1, stage2                                |
| design     | `design-landing` — ランディングページ          | 導入文・特長・CTAを縦に読む画面                            | title, summary, items, image                          |
| design     | `design-dashboard` — ダッシュボード            | 指標カードと更新情報を一覧                                 | title, summary, items                                 |
| design     | `design-cards` — カード一覧                    | 独立したカードをauto-layoutで反復                          | title, summary, items                                 |
| design     | `design-form` — 入力フォーム                   | 見出し・説明・入力欄・送信を配置                           | title, summary, items                                 |
| design     | `design-detail` — 製品詳細画面                 | 画像・仕様・購入前の判断材料を整理                         | title, summary, items, image                          |
| document   | `document-proposal` — 企画書                   | 背景・提案内容・期待する効果をsemanticな文書で整理         | title, summary, section0, section1, section2          |
| document   | `document-minutes` — 議事録                    | 議題・決定事項・次の対応をsemanticな文書で整理             | title, summary, section0, section1, section2, date    |
| document   | `document-research` — 調査報告書               | 調査目的・観察結果・考察と制約をsemanticな文書で整理       | title, summary, section0, section1, section2, results |
| document   | `document-procedure` — 手順書                  | 準備するもの・実施手順・確認することをsemanticな文書で整理 | title, summary, section0, section1, section2          |
| document   | `document-evaluation` — 比較評価書             | 評価基準・比較結果・推奨と根拠をsemanticな文書で整理       | title, summary, section0, section1, section2, results |
| data       | `data-issues` — 課題台帳                       | 影響と頻度から優先度を算出し、状態別に対応を整理           | rows                                                  |
| data       | `data-comparison` — 選択肢比較                 | 品質・導入容易性・月額費用を分けて比較し、評価点を計算     | rows                                                  |
| data       | `data-inventory` — 備品・在庫台帳              | 分類別の在庫数・発注点と在庫金額を把握                     | rows                                                  |
| data       | `data-research` — 調査結果台帳                 | 方法・母数・該当数を記録し、割合を同じ正本データから算出   | rows                                                  |
| data       | `data-roadmap` — ロードマップ                  | 開始・終了・状態と見積工数で実行計画を共有                 | rows                                                  |

## Fragments and presets

| Domain / kind         | Template                                                   | Effect                                             |
| --------------------- | ---------------------------------------------------------- | -------------------------------------------------- |
| slide / fragment      | `slide-comparison-page` — 左右比較ページ                   | 左右の条件・利点を比較し結論を共有                 |
| slide / fragment      | `slide-chart-page` — データグラフページ                    | 集計グラフと観察結果を区別して報告                 |
| whiteboard / fragment | `whiteboard-agenda-section` — 議題Section                  | 発散したアイデアを分類して小さな実験へ             |
| whiteboard / fragment | `whiteboard-process-fragment` — 接続付きプロセス図         | Sectionと接続で処理の順序を共有                    |
| design / fragment     | `design-card-group` — カード群                             | 独立したカードをauto-layoutで反復                  |
| design / fragment     | `design-field-group` — 入力field群                         | 見出し・説明・入力欄・送信を配置                   |
| document / fragment   | `document-summary-section` — 要約・結論section             | 背景・提案内容・期待する効果をsemanticな文書で整理 |
| document / fragment   | `document-comparison-table` — 比較table                    | 条件と評価を表で比較                               |
| data / fragment       | `data-common-fields` — 共通field set                       | 新しいfield IDで優先度と見積を追加                 |
| data / fragment       | `data-chart-view` — 互換fieldへのchart view                | 明示したfield mappingから集計viewを追加            |
| slide / preset        | `slide-readable-style` — 落ち着いた色・読みやすい設定      | 指定したstyle / 表示設定のみを変更                 |
| whiteboard / preset   | `whiteboard-readable-style` — 落ち着いた色・読みやすい設定 | 指定したstyle / 表示設定のみを変更                 |
| design / preset       | `design-readable-style` — 落ち着いた色・読みやすい設定     | 指定したstyle / 表示設定のみを変更                 |
| document / preset     | `document-readable-style` — 落ち着いた色・読みやすい設定   | 指定したstyle / 表示設定のみを変更                 |
| data / preset         | `data-readable-style` — 落ち着いた色・読みやすい設定       | 指定したstyle / 表示設定のみを変更                 |
| review / preset       | `review-readable-style` — 読みやすい差分表示               | 指定したstyle / 表示設定のみを変更                 |
| file / preset         | `file-readable-style` — ページに合わせて表示               | 指定したstyle / 表示設定のみを変更                 |

Slide uses ordered decks and pages. Whiteboard preserves Section membership and connectors. Design keeps Frames, layout and independent components. Document keeps semantic headings/lists/tables. Data templates have distinct typed schemas, formula dependencies and named projections. Review/Viewer entries contain settings only; they never create a replacement source file.

Images in the NEST product examples are portable fictional illustrations in an asset manifest. Image-free inputs remove the optional image record. Personal templates can capture their own portable image or define an image slot.

The independent `/template-host.html` entry demonstrates the standalone form and gallery together with a Host-owned deterministic agent client. It imports public packages and never imports Playground App or model.
