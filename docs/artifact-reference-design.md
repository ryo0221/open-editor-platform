# Artifact参照埋め込み（#264）

設計版1、2026-10-16。既存Editorへの能力追加。新しいcontent domainは作らない。

## 対象と責務

Dataの保存されたnative viewの表／chart、GraphのProfile付きnode／edge／layoutを、
Documentのimage block、Slide／Designのimage object、Whiteboardのimage nodeへ配置する。
作成時に「固定版」または「更新連動」を選ぶ。既存image／ChartSnapshotは変更しない。
画像のsrcは再生成可能な描画cacheであり、編集正本は参照元のnative contentである。
sourceへの編集導線、exact version／SHA-256、必要なProfileを保持する。

Hostが発見・権限・保存済みversion取得・通知・navigationを注入する。Platformは
認証・AI・組織policyを所有しない。sourceのdraftやproposal previewは取得対象にしない。
各domainのnative schemaは独立し、coreは参照envelope、上限、検証、解決だけを所有する。

## Native modelと互換性

既存imageにoptional `reference`を追加する加算的schema拡張。旧readerは保持srcを
固定画像として表示できるが、参照編集には新readerが必要。既存schema/versionのbytes／hashは変更しない。
参照はartifact ID、domain、kind、view IDと選択したcolumn／row／node IDs、mode、fit、
exact snapshotを持つ。snapshotはversion ID、単調増加revision、content SHA-256と
必要依存（Graph Profile等）のSHA-256を持つ。native import時には閉包全体を検証する。

最初のsource adapterはData／Graphだけ。参照の再帰解決は行わず、自己参照・未知domain・
依存内の埋め込みを拒否する（最大参照深さ1）。1 source 2 MB、closure 4 MB、1 capture
64参照、table 100行×30列、Graph 100 nodes／300 edges。上限超過は黙って切り捨てない。

## 操作と更新

挿入／参照先変更／mode変更／固定版採用／参照解除は各domainの通常commandまたは
Document text transactionを通す。readOnlyと未確定入力guardを守る。Undoは埋め込み先だけ。
Documentは幅と元の縦横比で表示し、固定viewportによるcropは未対応。contain／cover切替は3 canvasに限る。
既存Documentのfit metadataは保持し、保存済みnative版を変更しない。
元の保存済み外部更新は描画用のprivate stateへ入り、destinationのdraft／Undoを書き換えない。
遅い古い応答、同revisionの異なるhash、revision逆行を拒否。購読はSurfaceの寿命に合わせて解除。

欠落source／target、権限失効、offline、stale、失敗を区別する。offlineだけは保持snapshotを
警告付きで表示できる。権限失効時は保持描画も隠す。再取得、sourceを開く、固定化、解除を提供。
navigation復帰点はdestination Artifactとelement ID、Slideではpage IDも保持する。
公開Hostのopenは既存二引数を保ち、optionalな第三引数でpage IDを受け取る。
遷移時に入力をflushし、拒否時は留まる。
作成待機中はsource／mode／発見の操作を固定し、先行する発見の遅延結果を採用しない。
Documentへ戻る場合はembedded nodeの選択とscrollを復元し、native contentは変更しない。
独立Hostはsource編集中のdestination kind変更を無効にし、移動時とsource編集・保存境界で
現在権限を強制する。編集中の失効は元editorを隠し、hash待機後の永続化・公開も拒否する。

保存／native export／graphic exportはsource毎に一度captureし、同一sourceの複数viewへ
同じsnapshotを適用する。capture中にdestinationや入力が変わったら結果を採用しない。
historical versionは保持snapshotを使い、live解決しない。配布JSONはnative閉包とhashを保持。

## 能力matrixと検証計画

| 能力                    | 範囲                                     | 検証                                                   |
| ----------------------- | ---------------------------------------- | ------------------------------------------------------ |
| Local native／UI        | Document、Slide、Design、Whiteboard      | 挿入、移動、fit、固定／連動、Undo、reload              |
| Sources                 | Data table／bar等、Graph native＋Profile | 95→80、formula/filter/sort/aggregate、node/edge/layout |
| Proposal                | 既存command／Document transaction        | preview/reject非伝搬、apply後saveで伝搬                |
| Host                    | Playground＋独立public API Host          | 元編集、復帰、保存、reload、通知解除                   |
| Native JSON             | 閉包保持／hash検証                       | 改竄、依存欠落、過去版不変                             |
| Graphic／HTML/Markdown  | captureした静的描画                      | 出力中版混在なし、link喪失を明記                       |
| Office／React export    | live linkの保持は非対応                  | 明示diagnostic／拒否、無言で成功にしない               |
| Shared references       | 初期対応は非対応                         | trusted codecが参照入りcontent／operationを拒否        |
| Templates／linked reuse | 参照の新規authoringは非対応              | 既存snapshot/reuseの意味を変更しない                   |

unitで改竄・権限・offline・遅延・上限・capture整合性を検証。desktopと狭いviewportの
通常UI／独立Hostで主要経路を検証。実機mobile／全browser／実Officeは別途NOT RUNを記録。
自動CI停止・performance測定保留は維持する。検証結果は別文書へ記録し、設計をPASS証拠にしない。
