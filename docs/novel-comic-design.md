# Document長編・Designページ構成の設計（#536 / #537）

設計版1、2026-10-26。既存 `document` / `design` の能力追加。新しいkind、Story Graph、Undo、catalog、AI runtimeは追加しない。検証結果は[検証記録](verification/novel-comic/README.md)へ分離する。

## 所有境界と代替案

| 項目         | 章ごとのDocument（採用）                       | 単一Documentの見出し分割                 |
| ------------ | ---------------------------------------------- | ---------------------------------------- |
| 安定ID・選択 | Artifact + paragraph ID + UTF-16範囲           | 同じ。見出しはシーンを自動定義しない     |
| 章順         | HostのID配列。原稿/versionを変更しない         | native block移動。本文revisionが変わる   |
| 保存版       | 章ごとのexact version                          | 全文単位のversion                        |
| 部分改稿     | documentTextEditCommand / documentProposalDiff | 同じnative engine経路                    |
| annotation   | 既存ElementAddressとresolveDocumentAddress     | 同じ。削除はorphan、曖昧な範囲はoutdated |
| 共同編集     | 既存Documentの宣言subsetのみ                   | 同じ。章間transactionはない              |
| 長文性能     | 章単位で分離できるが新規性能保証なし           | 全文の再投影。既存検証以上の性能保証なし |

Story/シーン一覧、進捗、役割、承認、権限、画像のライセンス判断はHost所有。Documentは既存text/selection/proposal APIを利用。Document内のparagraphがシーンとして扱えるかはHostが決める。汎用のlive Story referenceは追加しない。

Designは既存frameをページID、ページ直属frameをコマIDとして利用。任意要素のz-orderは既存elements/hierarchy、ページ/コマの読み順は任意の `pagination`（schemaVersion 1）へ保存し、位置から推測しない。方向はrtl/ltrを明示。画像にはelement IDごとのsource/license文字列を保持する。別の描画正本を作らない。Whiteboardへの重複実装はせず、M0参照実装はDesignを採用。

## 不変条件・上限

- Paginationは最大128ページ、各64コマ、画像8192件。参照先は同じDesignの既存frame/画像。ページはroot frame、コマはページ直属frame。重複ID、dangling参照、未知field/schemaは拒否。
- ページ/コマ順を変えてもnative IDとz-orderは不変。削除は対象subtreeとpagination参照を一つのcommandで削除。Undoは同じIDを復元。再作成は新ID。
- Document結合は最大128確定版、合計2000ブロック/100万UTF-16単位。初期subsetはparagraph/headingと既存rich/style。その他、reuse、未知fieldはdiagnosticで拒否し、部分出力しない。
- 結合したIDは出力内でnamespacingし、元Artifact/version/hash/順序/元element IDの対応をmanifestへ記録。先頭章のpage設定を採用し、章ごとの差は報告。annotation/history/private selectionは含まず、その欠落も報告。
- 新規性能測定・tuningは行わない。上限は入力境界でありperformance受入ではない。

## 操作・権限・入力

通常EditorSession / ArtifactEditorが唯一の履歴。Drag/resize/textは既存Surfaceを使う。新規構成commandは全体read依存でatomic。Proposalは既存preview/apply/reject、baseLocalRevision、権限再検証とinput boundaryを利用。Documentはnative engine step、DesignはM0の移動/サイズ/台詞/画像変更のみを意味的に提示する。未対応proposalをfallbackで採用しない。

共有・template・linked reuse・React変換はpagination非対応としてlegacy `isDesign`入口で拒否する。local/nativeは `isDesignWithPaths` で検証する。Hostはnative inputs/IMEをflushまたは拒否してから保存・切替・proposal採用・出力を行う。Cancel/拒否/保存失敗で本文や確定版を置換しない。

## Public APIと出力

React/DOM不要のDocument sequence APIとDesign pagination APIをpublic subpathで提供。既存DocumentSurfaceのfocusAddress、DesignSurfaceのfocusRequest、ArtifactEditor.selectを再利用し、選択をcontentへ保存しない。

Designの通読captureはexact version/hashを検証し、ページframeの固定viewBoxへ既存native drawingを投影。PNG/PDFは既存canvas-ui/exportPagesで生成する派生画像。PDFはraster、text編集/検索は保証しない。隠し要素、ページ外要素、参考画像の不足、対応外描画は診断。外部画像は埋め込み済みrasterのみ出力対象にして、暗黙fetchをしない。吹き出しはellipse等のshape + horizontal textの互換subset。尻尾、縦書き、ルビ、禁則、Raster筆圧/トーン、EPUBはM1/M2/N2の未実装能力。

DOCXは結合結果を既存document-exportのpreflight/encodeに渡す。Office実readerとnative IME実機は自動browser検証と区別する。N2は既存PDFテキスト出力を置き換えない。

## 実装・受入計画

Pure API/validator/command → 通常Design Surfaceのページ操作 → public packagesのみの独立Host → 3章×複数シーン/4ページ×複数コマの保存/reload/提案/出力 → 関連回帰。N01–N14、C01/C02/C03/C07の適用結果を記録する。C04–C06は新規pagination subsetでは非対応、実機/大容量/production運用は未検証。追加能力の公開同期・deploymentは本作業に含めない。
