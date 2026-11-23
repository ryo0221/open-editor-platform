# 分析間の要素参照の設計（Fishbone・FMEA・FTA）

状態：**設計案（レビュー待ち）**。実装・検証はしていない。追跡：[#85](https://github.com/ryo0221/open-editor-platform/issues/85)。

横断の決定は [tokiwa-ecosystem 0001](https://github.com/ryo0221/tokiwa-ecosystem/blob/main/docs/decisions/0001-analysis-element-references.md)（2026-11-24 採用）にあり、ここでは繰り返さない。この文書は、そのうち OEP が持つ部分（R1・R4・R6、保留事項 H4）の構成・代替案・決めてほしいことを置く。採用後の仕様は [Structured Graph 契約](structured-graph-contract.md)・[追加機能の契約](extension-addons.md)・[参照付き埋め込み](artifact-references.md)へ反映する。

## 1. いまあるもの

| もの                              | 状態                                                                                                                                                                                  | この設計での扱い                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Fishbone／FTA（#84）              | Structured Graph の Host 所有 Profile（`analysis-fishbone`・`analysis-fault-tree`）とテンプレート。原因の候補は node type `cause`（`name`・`status`・`evidence`）、基本事象は `basic` | node の属性に業務 ID と参照を足す                       |
| FMEA（#84）                       | Structured Data のテンプレート。固定列 `failure`・`effect`・`cause`・`s`・`o`・`d`・`rpn`・`ap` 等。Fishbone／FTA への言及は列 `evidence`（文字列）                                   | 行に業務 ID と参照の列を足す                            |
| `items@0-draft`                   | 外部パッケージの manifest で「どこに項目 ID があり、どの欄が別の項目を指すか」をデータで宣言。`readItems` が読む。点で区切った道筋、`refs` は文字列か文字列の配列                     | **組み込みの Graph／Data にも同じ宣言の形を使う**（U1） |
| 固定引用（`artifact-references`） | 版の名乗り（`versionId`・`revision`・`contentHash`）、`ReferenceHost` の `list`・`read`・`checkAccess`・`subscribe`・`open`、`ReferenceError.status`                                  | 状態の区別と移動・復帰の口を再利用する（U4）            |
| Data の `relation` 列             | 同じ表の行 ID だけを指す                                                                                                                                                              | 別の成果物は指さない。今回は使わない                    |

OWD 側は [open-workflow-definitions #22](https://github.com/ryo0221/open-workflow-definitions/pull/22) で決まった：引用は文章の外で ID の組として持ち、持ち場所は外の表か、**引用する側の項目の構造化された参照の欄**（正本は一か所）。`failure-analysis@1.0.0` は原因の候補 `CC-`、故障原因 `FC-`、基本事象 `BE-` などを持ち、`FC → CC` と `BE → FC` の引用を許す。

## 2. 決めること

### U1：組み込みの Graph／Data で、業務 ID と参照の欄をどう宣言するか（H4）

| 案            | 内容                                                                                                                                                                                                                                                                                   | 判断                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **A（推奨）** | 値は今ある型のまま持つ（Graph は string と string の配列の属性、Data は text 列）。どの欄が業務 ID でどの欄が参照かは、`items@0-draft` と同じ形（`ItemsCollection`）の宣言で表す。Graph は Profile の node type に、Data はテンプレート（列の役割）に置き、Editor が宣言を Host へ渡す | Host（PaoBub）は外部パッケージと同じ `readItems` で読める。Graph の保存形式は変えない。宣言はデータで、コードを動かさない       |
| B             | 新しい属性・列の型（例：`item-ref`）を足す                                                                                                                                                                                                                                             | 型ごとの検証と入力部品は作りやすいが、Graph schema・Profile schema・Data schema のすべてを上げる。Host の読み方が型ごとに増える |
| C             | Host だけが Profile ID や列 ID を知って読む                                                                                                                                                                                                                                            | OEP は変わらないが、読み方が Host に散り、OEP 単体のほかの Host で使えない                                                      |

A の宣言の例（Fishbone の原因の候補）：

```ts
// Profile の node type `cause` に足す（任意の欄）
items: { id: 'itemId', title: 'name' }
// Host へ渡すときは ItemsCollection に直す
{ at: 'nodes', id: 'attributes.itemId', title: 'attributes.name' }
```

FTA の基本事象は `items: { id: 'itemId', title: 'name', refs: ['failureCauseRefs'] }`、FMEA は列の役割で `{ at: 'rows', id: 'values.itemId', title: 'values.cause', refs: ['values.causeRef'] }` に相当する宣言を作る。

- 業務 ID の欄は文字列で、OEP は形を決めない（形と種類は Host が定義の `idForm` で決める）。OEP 単体では保存するだけ。
- Graph の node type ごとに宣言できるので、`cause` 以外の node（分類・問題）は項目にならない。
- Profile の `items` は任意の欄の追加で、Profile schema 2 のまま読み書きできるかは実装で確かめる（未知の欄を拒否する検証があるため、版を上げる必要が出たら U5 の互換に従う）。

### U2：Data の参照の列に、いくつの引用を持たせるか

Data のセルは単一の値（`string | number | boolean | null`）。

| 案            | 内容                                                                                                                              | 判断                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **A（推奨）** | 参照の列 1 つにつき引用 1 件（text のセルに業務 ID を 1 つ）。複数の候補から来る故障原因は、行を分けるか、参照の列を 2 本以上持つ | セルの型も Data schema も変えない。FMEA は「故障原因 1 行」が普通で、候補との対応も多くは 1 対 1 |
| B             | 参照の列だけ文字列の配列を許す                                                                                                    | 1 行で複数を引けるが、Cell の型・CSV・formula・Graph 投影・proposal の差分まで広く変わる         |

A で足りないことが実際の利用で分かったら、B を別の設計として起こす。Graph の属性は配列を持てるので、FTA の基本事象は複数の故障原因を 1 つの属性で引ける。

### U3：引用の値に固定版を入れるか

| 案                  | 内容                                                                                                                                       | 判断                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| **A（推奨・当面）** | 参照の欄の値は業務 ID だけ。固定版の持ち方は PaoBub の H2（[paobub #523](https://github.com/ryo0221/paobub/issues/523)）で決まってから足す | `readItems` の `refs` の形（文字列か文字列の配列）にそのまま合う                               |
| B                   | 値を `{ to, pin }` にする                                                                                                                  | 版を成果物と一緒に運べるが、`readItems` の形を変える。H2 が「工程の pin で足りる」となれば不要 |

H2 が引用ごとの固定版を要るとしたら、そのときに版の持ち場所（同じ要素の別の属性か、値の形の変更か）をこの文書の版を上げて決める。

### U4：候補・状態・移動の Host の口

Editor は OWD や PaoBub を import しない。参照の欄を編集するときだけ、Host から次を受け取る。

```ts
interface ItemReferenceHost {
  /** この項目のこの欄で引ける候補（種類の決まりは Host が定義から決める）。 */
  candidates(
    from: { artifactId: string; elementId: string; field: string },
    signal: AbortSignal,
  ): Promise<readonly ItemCandidate[]>;
  /** 欄にある業務 ID の今の状態。 */
  resolve(ids: readonly string[], signal: AbortSignal): Promise<ReadonlyMap<string, ItemRefState>>;
  /** 参照先へ移動。戻り先は今の要素。既存の ReferenceHost.open と同じ約束。 */
  open(
    id: string,
    returnTo: { artifactId: string; elementId: string; pageId?: string },
  ): Promise<boolean>;
  subscribe?(notify: () => void): () => void;
}
interface ItemCandidate {
  id: string;
  title: string;
  artifactTitle: string;
  note?: string;
}
type ItemRefState =
  | { status: 'ok'; title: string }
  | {
      status:
        | 'missing-source'
        | 'missing-target'
        | 'forbidden'
        | 'offline'
        | 'unresolved'
        | 'duplicate'
        | 'stale';
      reason: string;
    };
```

- 状態の名前は `ReferenceError.status` を使い、0001 の「未解決」「重複」だけを足す。`forbidden` では題も隠す。
- 候補の一覧に出す注意（例：除外された原因の候補）は Host が `note` で渡し、Editor は判断しない。止めるか知らせるかは PaoBub の H3。
- 既存の `ReferenceHost`（表示の埋め込み用）を広げる案もあるが、扱うのが「版を固定した値・図の写し」と「業務 ID の引用」で違うため、別の口にする（推奨）。移動と復帰の約束、権限の再確認の時点は同じにする。
- Host が無いときは参照の欄を文字列として編集・保存でき、候補・状態・移動は出さない。

### U5：互換と版

- Graph の保存形式（schema 3）と Data の保存形式（schema 2）は変えない（U1 案 A・U2 案 A）。
- Profile に `items` を足すことで Profile の版を上げる必要があれば、`analysis-fishbone`・`analysis-fault-tree` の Profile の版（`version`）を上げ、旧版の文書はそのまま読める（属性を足すだけ）ことを試験で確かめる。
- FMEA テンプレートに列 `itemId`・`causeRef` を足す。既存の FMEA の表は列が無いまま開け、項目にならないだけ。

## 3. 画面

1. 参照の欄（Graph の Inspector、Data のセル）に「候補から選ぶ」を出す。候補は Host から受け取り、題と出どころの成果物を並べる。
2. 選ぶと、その欄の値を変える**通常の 1 コマンド**として入る。Undo/Redo・保存・native JSON・インポート／エクスポートは今の経路に乗る。引用の解除も同じ。
3. 欄に並んだ業務 ID ごとに状態を出す（題、または「見つからない」「重複」「古い」「権限なし」）。状態は表示だけで、値を自動で書き換えない。
4. 「参照先を開く」で `open` を呼び、戻ると元の要素を選ぶ。
5. 関係の名前（「根拠」「対応」）は Host が渡す欄の名前で出し、別の関係を同じ線や同じ語で見せない。Graph の中に別成果物への線は描かない。

AI の提案は、既存の proposal（preview／apply／reject）で参照の欄を変える。採用までは引用ではない（Host が数えない）。

## 4. 段階

| 段  | 中身                                                                                                                                                                             | 依存 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| AR1 | Profile の node type の `items` 宣言と検証、Data の列の役割、宣言から `ItemsCollection` を作る純粋な関数、Fishbone／FTA の Profile と FMEA テンプレートに業務 ID・参照の欄を足す | なし |
| AR2 | `ItemReferenceHost` の型と、Inspector／セルの候補・状態・移動の画面。Playground に架空の Host（同じ Library の三つの成果物から候補を出す）                                       | AR1  |
| AR3 | 検証：引用・解除の Undo/Redo、保存と再読込、native JSON、権限なし・欠落・重複の表示、Host なしの編集、desktop／mobile                                                            | AR2  |

PaoBub 側の読み取り（`as: 'items'` の置き場）と統合試験は [paobub #523](https://github.com/ryo0221/paobub/issues/523)。

## 5. 扱わないこと

- 三つの分析を同じ要素にまとめること、名前の一致や文章からの自動の関連付け。
- FTA の確率から FMEA の O、RPN から AP を自動で決めること。
- 承認・失効の状態を Editor に持つこと（PaoBub が持つ）。
- 共同編集での参照の欄の扱い（今の共同編集の範囲に従い、別に決める）。

## 6. 決めてほしいこと

| #   | 問い                       | 推奨                                                                                                 |
| --- | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| U1  | 業務 ID と参照の欄の宣言   | A：今ある型の値と、`items@0-draft` と同じ形の宣言（Graph は Profile、Data はテンプレートの列の役割） |
| U2  | Data の参照の列の件数      | A：1 列 1 件                                                                                         |
| U3  | 引用の値に固定版を入れるか | A：当面は業務 ID だけ。H2 の決定後に見直す                                                           |
| U4  | Host の口                  | 表示の埋め込みとは別の `ItemReferenceHost`。状態の名前と移動の約束は既存に合わせる                   |
