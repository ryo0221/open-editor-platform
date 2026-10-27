# Document出版出力の段階設計（N2）

2026-10-26。#536の後続。N2aの水平reflowable EPUB subsetを実装し、N2b以降の日本語出版組版と分離する。[長編Host契約](authoring-contract.md)のN0/N1を入力とし、[検証記録](verification/document-epub/README.md)の範囲で判断する。

## 現行能力と追加先

| 能力                     | 現在                                          | 追加先・失敗時の扱い                                                                       |
| ------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 複数章とexact version    | composeDocumentSequence、出典/ID manifest     | EPUBでも同じsource manifestを使う。二重の編集原稿を作らない                                |
| 見出し/段落/inline marks | DocumentContent schema1/2、native text engine | 初期EPUBのXHTML projectionの候補。未知block/markはaddress付きで拒否                        |
| DOCX                     | 既存preflight/encode、loss report             | 既存adapterの能力表を維持。EPUB用設定をDOCXへ黙って流さない                                |
| PDF                      | 既存DocumentPrintRenderer、rasterとtext layer | #59の経路を維持。別PDF engineを作らない                                                    |
| 縦書き/縦中横/ルビ       | native schema/engine/UIは未対応               | まずnative属性とtext mapping・annotation・IMEの契約が必要。CSS出力だけをnative対応としない |
| 禁則・改ページ・書体     | 画面/Office/readerで再flowが異なる            | font pin/coverageとreaderごとの結果をreport。完全同一の改行やpage数を約束しない            |
| EPUB                     | N2aの水平EPUB 3 adapterと独立reader検証       | 専用のpure export adapter。native内容を正本として保持。縦書き/ルビ/画像等は拒否            |

## N2a: reflowable EPUBの互換subset

対象はN1のparagraph/headingとinline formatting、水平text。public `@editor-platform/document-export/epub` のprepare/encodeを使う。Hostがtitle/language/creators/identifier/modifiedを指定し、確定版の順序をEPUB spineとnavigationへ明示する。章の表示名はArtifact.name。EPUB 3のmimetypeを先頭・無圧縮で置き、container.xml/package.opf/nav.xhtml/章XHTML/CSS/出典manifest/reportを生成する。EPUBCheckと独立epub.js readerでの表示検証を別に記録する。

日本語縦書きをhorizontal subsetへ混在させず、未知のwritingMode/rubyを全出力のblocking diagnosticとする。外部URLの自動取得やscript/HTML実行をしない。linkはtarget mapping未対応として拒否。画像・font埋め込みはlicense/provenance/size/hashをHost adapterで検証できる段階まで非対応。画像blockは拒否し、font・固定改行/ページ再現の差は同意が必要なreportにする。hidden blockは警告付きでreading contentから除外。出典manifestはnativeとの差と未収録annotation/historyを記録する。

既存export-coreのcapture→prepare→report/consent→encode契約を再利用する。入力とmetadataをawait前に所有し、exact version/hashを検証する。派生contentのbasisはlocal-draftとして明示し、架空のsaved Artifact/versionを作らない。Cancel/stale/permission/input boundaryはHostの既存経路を維持し、失敗時にはpartial ZIPを返さない。原稿・選択・Undo/versionを更新しない。上限はN1の128出典/2000blocks/100万UTF-16単位と、全entry合計16MiB（無圧縮）。上限はperformance保証ではない。

独立Host `/authoring.html` にmetadata入力、report確認・同意、stale時の再prepare、EPUB/report downloadを追加する。通常Documentのtoolbar/schema/commandを変更しない。CancelはAbortSignalとHostのgeneration guardを使う。同期ZIP処理の途中に実行を割り込ませる保証はない。

## N2b: 日本語native表現（実装前）

ruby base/reading、縦中横、writing directionをnative text engineとcontentのstable rangeへどう保持するかを先に定める。UTF-16選択、delete/split/join、IME、proposal、annotation mapping、Undo、shared schema/codecの可否、native importの旧version readerを含める。未知markを黙ってflat textにしない。

画面、DOCX、EPUB、PDFごとにsupported/approximation/rejectを宣言し、rubyや縦中横が崩れるreaderは理由付きreportにする。縦書きをCSSに指定しただけで、禁則・行送り・フォント・画像混在の受入を通したとしない。

## N2c: reader/出版preflight（実装前）

N2aではEPUBCheck 5.4.0と独立epub.js 0.3.93のdesktop/mobile表示・章navigationを検証済み。N2cでは縦書き/ルビ/縦中横/画像/欠落fontのfixtureとreaderの範囲を広げる。実機reader、OS native IME、実Office、PDF text抽出はそれぞれ別条件。失敗readerと未検証readerを隠さない。新しい大規模performance/tuning、製品公開、配信/DRMは対象外。
