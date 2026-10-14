# 監査 #73：#53–#72 と #46 の追加対応

PR #52の #42–#51 修正に続け、監査の未修正20件と #46 D23、PRレビュー7件を同じPRで追跡する。参照デモは未マージPR #37とHost側修正を含むため、製品コードを取り込まず通常Platform UIとpublic APIで再現する。

## 所有境界・設計

Native内容、安定ID、既存command/transaction/Session/authority、immutable保存版を正本とする。入力・選択・camera・projectionは私的表示状態。Dataの明示的named viewのみ内容へ保存する。新しいkind、万能履歴、catalog、Code runtimeは追加しない。

Document PDFは既存ページ描画に位置の一致する不可視テキストを重ねる方式。日本語本文・表・リスト・コード・HTMLの抽出を提供し、画像・Mermaid図の文字は画像として保持する。PDFの読み順は本文順、表は行→列。Tagged PDF/図内OCRは非対応として出力前に表示する。ページプレビューとPDFは同じレイアウトを使用する。固定Notoフォントの既存配布・ライセンス・SHA-256契約を再利用し、生成フォント/出力をGitへ追加しない。フォント取得失敗や非対応文字は明示的拒否し、画像PDFへ黙って退行しない。

File PDFはpdf.jsの安全設定・既存32MB原本上限を維持し、文字レイヤーと抽出テキストの日本語検索を追加する。検索結果はページと位置へ移動する。領域注釈は既存PDFポイントを維持し、文字注釈の新regionやOCRを宣言しない。画像PDFは文字がない説明とHost OCRの責任を表示する。原本 bytes/hashは検索・コピー・表示で変えない。

Reviewの旧版参照はHost resolverへ渡し、解決できない場合は理由と明示的再紐付けを提供する。履歴全体をReviewContentへ保存しない。ファイル/原本revision変更で選択解除を通知し、Host投稿境界も現在の表示対象を照合する。

Dataは同じレコードを使用し、Timeline列追加・期間移動は既存command。CSVはpublic範囲指定APIをnative/Hostで共有し、追加先schemaに基づく全行診断後に原子的適用する。Dashboardの未保存構成のみ私的ビュー編集としてUndo/Redoし、保存境界で既存named-view commandへ確定する。Hostは表示状態を成果物別に保持し、選択は復元しない。

## 対応一覧

| Issue           | 対応                                                        |
| --------------- | ----------------------------------------------------------- |
| #53 / #54       | 表内Tab/ShiftTab、最終cellで行追加、Add row後に同列へ選択   |
| #55 / #56       | 旧source resolver/理由/再紐付け、選択解除通知とHost投稿照合 |
| #57 / #58 / #65 | PDF文字検索・コピー、明示的原本置換確認、BOM/encoding案内   |
| #59 / #60       | 検索可能Document PDF、見出しと後続の改ページ一致            |
| #61 / #62       | 日付列追加導線、pointer focus・移動0は無編集                |
| #63 / #64       | ビュー編集Undo/flush、成果物別の最終projection復元          |
| #66 / #67       | CSV行・列範囲と件数、追加schema/対応/行列診断               |
| #68             | Office形式別Host能力と入力/出力dialog境界                   |
| #69             | Whiteboard選択端点を前面overlayへ、候補表示                 |
| #70 / #46 D23   | 固定presetとHugの明示選択、native HTML意味/alt/診断誘導     |
| #71 / #72       | Document readonly ARIA、系列集計の説明と同じ計算結果の表    |

## デモ修正済み4件の扱い

D03: Documentの出力menuと本文入力のガードを区別して回帰確認。D04: native importのlocal注釈artifact IDだけを新成果物へ再結合し、外部参照を保持。D07: Host navigation CSSをscopeし、Review自身のnavigatorへ漏らさない。D21: Code実行はHost拡張で、PlatformにはCode kind/runtimeがないためN/A。デモの修正をPlatform検証済みと読み替えない。

## 受け入れ計画

N01–N14の変更箇所を通常production UI・独立Host・unitで確認。C01（入力/合成IME）、C02（固定source注釈）、C07（CSV/PDFの実reader抽出）、C08（厳格React変換）を対象とする。既存shared操作はauthority経路を保ち、新規非対応のview/publication編集は理由付き拒否する。Native往復、Cancel/失敗のcontent/history不変、Undo/Redo、保存/reload、keyboard、狭いcontainerの代表ケースを追加する。

Native OS IME、実機、実screen reader、全browser engine、実Office、性能はNOT RUNとして残す。#22の性能合格は保留、性能調整・追加測定は停止中。製品側試用の保証をしない。検証の実行結果は別途記録し、設計・実装の存在をPASSと扱わない。

Document print/PDF checklist markers use `[x]` / `[ ]` for checked/unchecked state, so generated markers do not require glyphs absent from the fixed CJK font. Native checklist content is unchanged.
