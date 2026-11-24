# 分析間の要素参照の設計（Fishbone・FMEA・FTA）

状態：**設計案（レビュー待ち、2026-11-24 のレビューを受けて改訂）**。実装・検証はしていない。追跡：[#85](https://github.com/ryo0221/open-editor-platform/issues/85)。

横断の決定は [tokiwa-ecosystem 0001](https://github.com/ryo0221/tokiwa-ecosystem/blob/main/docs/decisions/0001-analysis-element-references.md)（2026-11-24 採用）にあり、ここでは繰り返さない。この文書は、そのうち OEP が持つ部分（R1・R4・R6、保留事項 H4）の構成・代替案・決めてほしいことを置く。採用後の仕様は [Structured Graph 契約](structured-graph-contract.md)・[追加機能の契約](extension-addons.md)・[参照付き埋め込み](artifact-references.md)へ反映する。

## 1. いまあるもの

| もの                              | 状態                                                                                                                                                                                                                                                            | この設計での扱い                                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Fishbone／FTA（#84）              | Structured Graph の Host 所有 Profile（`analysis-fishbone`・`analysis-fault-tree`、Profile schema 2）とテンプレート。原因の候補は node type `cause`（`name`・`status`・`evidence`）、基本事象は `basic`。`isGraphProfile` は Profile・type の未知の欄を拒否する | node の属性に業務 ID と参照を足す。Profile schema を 3 に上げる（U5）                                                 |
| FMEA（#84）                       | Structured Data のテンプレート（Data schema 2）。1 行に故障モード `failure` と故障原因 `cause` が同居し、`s`・`o`・`d`・`rpn`・`ap` 等を持つ。Fishbone／FTA への言及は列 `evidence`（文字列）。`Column` には役割を持つ欄が無い                                  | 1 行 = 故障原因 1 件。故障モードは行から多対一で投影する（U6）。宣言と参照は Data の新しい欄（U1・U2、Data schema 3） |
| `items@0-draft`                   | 外部パッケージの manifest で「どこに項目 ID があり、どの欄が別の項目を指すか」をデータで宣言。`readItems` が読む。点で区切った道筋、`refs` は文字列か文字列の配列                                                                                               | **組み込みの Graph／Data にも同じ宣言の形を使う**（U1）                                                               |
| 固定引用（`artifact-references`） | 版の名乗り（`versionId`・`revision`・`contentHash`）、`ReferenceHost` の `list`・`read`・`checkAccess`・`subscribe`・`open`、`ReferenceError.status`                                                                                                            | 状態の区別と移動・復帰の口を再利用する（U4）                                                                          |
| Data の `relation` 列             | 同じ表の行 ID だけを指す                                                                                                                                                                                                                                        | 別の成果物は指さない。今回は使わない                                                                                  |

OWD 側は [open-workflow-definitions #22](https://github.com/ryo0221/open-workflow-definitions/pull/22) で決まった：引用は文章の外で ID の組として持ち、持ち場所は外の表か、**引用する側の項目の構造化された参照の欄**（正本は一か所）。`failure-analysis@1.0.0` は原因の候補 `CC-`、故障原因 `FC-`、基本事象 `BE-` などを持ち、`FC → CC` と `BE → FC` の引用を許す。

## 2. 決めること

### U1：組み込みの Graph／Data で、業務 ID と参照の欄をどう宣言するか（H4）

| 案            | 内容                                                                                                                                                                                                                                                                                             | 判断                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| **A（推奨）** | 値は今ある型のまま持つ（Graph は string と string の配列の属性、Data は text 列と行の参照の欄）。どこが業務 ID でどこが参照かは、`items@0-draft` と同じ形（`ItemsCollection`）の宣言で表す。Graph は Profile の node type に、Data は表の宣言（列 ID で書く）に置き、Editor が宣言を Host へ渡す | Host（PaoBub）は外部パッケージと同じ `readItems` で読める。宣言はデータで、コードを動かさない |
| B             | 新しい属性・列の型（例：`item-ref`）を足す                                                                                                                                                                                                                                                       | 型ごとの検証と入力部品は作りやすいが、型ごとに Host の読み方が増える                          |
| C             | Host だけが Profile ID や列 ID を知って読む                                                                                                                                                                                                                                                      | OEP は変わらないが、読み方が Host に散り、OEP 単体のほかの Host で使えない                    |

宣言の置き場と形：

- **Graph**：Profile の node type に任意の欄 `items` を足す（例：`cause` に `{ id: 'itemId', title: 'name', refs: [], rootRefs: ['problemRef'] }`）。Host へは `{ at: 'nodes', where: { type: 'cause' }, id: 'attributes.itemId', title: 'attributes.name', rootRefs: ['attributes.problemRef'] }` に直して渡す。Profile の形が変わるので Profile schema を 3 に上げる（U5）。
- **Data**：表の最上位に任意の欄 `items` を足し、列 ID で書く（列名ではない）。例：`items: [{ kind: 'failure-cause', id: 'fcId', title: 'cause', refs: ['fmId', 'refs.causeCandidates'] }, { kind: 'failure-mode', id: 'fmId', title: 'failure', refs: ['functionRef'], merge: { equal: ['failure', 'effect', 's', 'function'] } }]`。`Column` 自体には役割を書かない（一つの行から二つの項目を読むため、役割は列ではなく宣言に置く）。Data schema を 3 に上げる（U5）。
- 宣言の `kind` は表示用の名前で、どの OWD の項目種類にあたるかは Host が業務 ID の形（`idForm`）で決める。OEP は ID の形を決めない。
- `items@0-draft` は未知の欄を拒否する（`itemsDeclarationProblems`）ので、次の三つの欄は**新しい版 `items@1-draft`** として足す：`where`（配列の要素を属性で絞る）、`rootRefs`（内容の根からの道筋。そのコレクションの全項目が引く）、`merge`（U6）。`items@0-draft` の宣言はそのまま有効で、意味は変えない。
- **版の交渉**：Host は読める版の一覧を `ItemReferenceHost` と一緒に渡す（`itemsVersions`）。組み込みの Graph／Data は、Host が `items@1-draft` を読めるときだけその宣言を渡す。読めない Host には宣言を渡さず、Editor は「この Host は分析の項目を読めない」と出す（`0-draft` に落として一部だけ読ませることはしない）。旧い Host が `1-draft` を受け取ったときは、今の検査が「unsupported items add-on version」で断る（黙って読まない）。
- PaoBub は OEP の依存版を固定し、`items@1-draft` を読めるようにしてから（[paobub #523](https://github.com/ryo0221/paobub/issues/523) の AR-P3）その版の OEP に上げる。

#### OWD の 9 種類と OEP の構造の対応

| OWD の項目    | OWD の成果物      | OEP の構造                                                                       | 業務 ID の欄        | 参照の欄（引用の向き）                                                           |
| ------------- | ----------------- | -------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------- |
| 機能 FN       | problem-statement | OEP の Graph／Data の外（文書）。FMEA の行は参照だけ持つ                         | —                   | —                                                                                |
| 問題 PB       | problem-statement | OEP の外。Fishbone・FTA は図の属性で参照だけ持つ                                 | —                   | —                                                                                |
| 原因の候補 CC | cause-diagram     | Fishbone の node type `cause`（1 node = 1 件）                                   | `attributes.itemId` | 図の属性 `problemRef`（`rootRefs`、CC → PB）                                     |
| 故障モード FM | fmea              | FMEA の行から**多対一の投影**（同じ FM ID の行を 1 件にまとめる。U6）            | 列 `fmId`           | 列 `functionRef`（FM → FN）                                                      |
| 故障原因 FC   | fmea              | FMEA の行（1 行 = 1 件）                                                         | 列 `fcId`           | 列 `fmId`（FC → FM）、行の参照の欄 `refs.causeCandidates`（FC → CC、複数可。U2） |
| 頂上事象 TE   | fault-tree        | FTA の node type `top`（1 node = 1 件）                                          | `attributes.itemId` | `attributes.problemRef`（TE → PB）                                               |
| 基本事象 BE   | fault-tree        | FTA の node type `basic`（1 node = 1 件）                                        | `attributes.itemId` | `attributes.failureCauseRefs`（配列、BE → FC）                                   |
| 対策 AC       | action-plan       | OEP の外（PaoBub の既定の表）。FMEA の `action` 列は今どおりメモで、項目にしない | —                   | —                                                                                |
| 確認 VR       | action-plan       | OEP の外                                                                         | —                   | —                                                                                |

- Fishbone の `problem`・`category`、FTA の `and`・`or`・`input` は項目にしない（宣言を持たない）。FTA の中間事象を項目にするかは定義に種類が無いので扱わない。
- FMEA の S・O・D・RPN・AP は FC の行の値で、FC の指紋に入る。FM の指紋には入れない（FM の重大度 S は `merge.equal` で行ごとに一致を求める）。

### U6：FMEA の 1 行から故障モードと故障原因を読む（多対一の投影）

OWD は故障モード（FM）と故障原因（FC）を別の項目種類にし、`FC → FM` の引用を必須にする。今の FMEA は 1 行に両方が同居するので、行に業務 ID を 1 つ足すだけでは FM を独立した ID・指紋・引用先として読めない。

| 案            | 内容                                                                                                                                                                                                                                                                                                                                                                              | 判断                                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A（推奨）** | 1 行 = FC 1 件（列 `fcId`）。FM は列 `fmId` を持ち、同じ `fmId` の行を 1 件の FM に投影する。投影の約束は宣言の `merge: { equal: [...] }`：挙げた列（故障モード・故障影響・S・要求機能）と、そのコレクションの `refs` の欄（FM → FN の `functionRef`）が全行で同じなら 1 件、違えば**その ID は重複**として扱い、Host はどちらにも解決しない。FC は自分の行の `fmId` で FM を引く | 表の見た目と行の意味（故障原因ごとの S/O/D・対策）を変えない。FM の題・指紋は一致を求めた列と `refs` の欄だけから作るので、FC の行の O・D の変更は FM を変えない |
| B             | FM を別の表（別の Data）に分け、FMEA の行は FM を参照だけする                                                                                                                                                                                                                                                                                                                     | FM が独立して明快だが、FMEA を 2 つの表に割り、今の作業表の形から離れる                                                                                          |
| C             | 行ごとに FM を別 ID で持つ（同じ故障モードでも行ごとに別項目）                                                                                                                                                                                                                                                                                                                    | 同じ故障モードが複数の項目になり、FN からの網羅と影響が数を誤る                                                                                                  |

- `merge` するコレクションでは、`refs` に挙げた欄は `merge.equal` に書かなくても必ず一致を求め、指紋にも入れる（行ごとに違う引用を 1 件にまとめると、どの引用か決まらないため）。
- Editor は `merge.equal` の列か `refs` の欄が食い違う行に診断（「FM-03 の故障影響が行ごとに違う」）を出す。直すのは利用者（自動で揃えない）。
- `merge` は `readItems` の約束として決め、OEP 単体でも同じ関数で試験する（宣言から投影した項目の一覧を作る純粋な関数を AR1 に置く）。

#### 投影した項目の同一性（業務 ID）と native 要素（行 ID の集まり）

- 投影した FM の**同一性は業務 ID**（`fmId`）で、固定版の基準・引用先・影響はすべてこの ID と項目の指紋で扱う。どの行から作ったかは同一性に入れない。
- 投影の結果は、項目ごとに**その版で ID を持つ native 要素の集まり**（FM-01 なら `{row-1, row-2}`）を併せて返す。これは移動（`open` で選ぶ）と表示のための対応で、固定版の基準の同一性ではない。Host が基準と一緒に記録しても、比べるのは業務 ID と指紋だけ（paobub #524 の H2 と同じ）。
- `missing-target` は、その業務 ID を持つ要素が一つも無くなったときだけ。row-1 を消しても row-2 に FM-01 が残れば FM-01 はあり、指紋が変わらなければ古くもならない。
- 行の削除・並べ替え・追加（同じ `fmId` の行を足す）で同じ FM が保たれることを AR1 の試験に置く。`open` は今の版でその ID を持つ行をすべて選び、最初の行へ移る。
- 1 node = 1 件の項目（CC・TE・BE）と 1 行 = 1 件の FC も同じ扱いで、native 要素の集まりが 1 つになるだけ。

### U2：一つの故障原因が複数の原因の候補を根拠にするとき

Data のセルは単一の値（`string | number | boolean | null`）。同じ故障原因の行を分けると、FC の ID・S/O/D・対策・承認の状態が二重になるので、**行を分けることは代替策にしない**。

| 案            | 内容                                                                                                                                                                                                                                                 | 判断                                                                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A（推奨）** | 行に任意の**参照の欄** `refs`（欄名 → 業務 ID の配列）を足す。セルではないので、セルの型・formula・並べ替えは変えない。宣言は `refs.causeCandidates` のように道筋で指す。編集は行の Inspector（候補から選ぶ・外す）で、1 回の選択・解除が 1 コマンド | 1 行のまま複数を引ける。`readItems` の `refs`（文字列か文字列の配列）にそのまま合う。CSV には `;` で区切った読み取り専用の列として書き出し、CSV の取り込みでは参照の欄を作らない |
| B             | 参照の列を 2 本以上持つ（`causeRef1`・`causeRef2`）                                                                                                                                                                                                  | 型は変えないが、件数の上限が列の数で決まり、空の列が並ぶ                                                                                                                         |
| C             | 参照の列だけ文字列の配列を許す                                                                                                                                                                                                                       | Cell の型・CSV・formula・Graph 投影・proposal の差分まで広く変わる                                                                                                               |

Graph の属性は配列を持てるので、FTA の基本事象は 1 つの属性で複数の故障原因を引ける（今の型のまま）。

### U3：引用の値に固定版を入れるか

| 案            | 内容                                                                                                                                                                                                                                                                          | 判断                                                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A（推奨）** | 参照の欄の値は業務 ID だけ。引用ごとの固定の基準（引用先の成果物の保存版・native 要素 ID・指紋、古いまま残す理由）は **Host が引用ごとに記録する**（[paobub #524](https://github.com/ryo0221/paobub/pull/524) の H2 改訂案）。Editor は基準を持たず、状態を Host から受け取る | 引用の正本（欄の業務 ID）は一か所のまま。基準は「確かめた記録」で引用の正本ではないので、0001 の「正本一か所」と両立する。`readItems` の形も変えない |
| B             | 値を `{ to, pin }` にする                                                                                                                                                                                                                                                     | 版を成果物と一緒に運べるが、`readItems` の形を変え、Editor が Host の指紋を保存することになる                                                        |

### U4：候補・状態・移動の Host の口

Editor は OWD や PaoBub を import しない。参照の欄を編集・表示するときだけ、Host から次を受け取る。すべての呼び出しに**引用元の文脈**（どの成果物の、どの要素の、どの欄か）を渡す。古い（`stale`）は引用元ごとの基準で決まり、業務 ID だけからは決まらないため。

```ts
/** 引用元：どの成果物の、どの要素（node・行）の、どの参照の欄か。 */
interface ItemRefSource {
  artifactId: string;
  elementId: string;
  field: string; // 宣言の refs の道筋
}
interface ItemReferenceHost {
  /** この引用元で引ける候補（種類の決まりは Host が定義から決める）。表示の手がかりで、権限の約束ではない。 */
  candidates(from: ItemRefSource, signal: AbortSignal): Promise<readonly ItemCandidate[]>;
  /** この引用元から見た、業務 ID ごとの今の状態。Host は引用元ごとの基準と今の引用先を比べる。 */
  resolve(
    from: ItemRefSource,
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, ItemRefState>>;
  /** 参照先へ移動。開く時点で権限を確かめ直し、開けなければ false と理由。戻り先は引用元。 */
  open(
    id: string,
    from: ItemRefSource,
  ): Promise<{ opened: true } | { opened: false; state: ItemRefState }>;
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
    }
  /** 引用先は基準の版から変わったが、古い版のまま残すと決めてある（理由つき）。 */
  | { status: 'kept'; title: string; reason?: string };
```

- `ok` は「基準の指紋と今の引用先が同じ」、`kept` は「違うが、今の引用先の版について古いまま残すと決めてある」、`stale` は「違い、まだ決めていない（または残すと決めた後にさらに変わった）」。三つの意味は paobub #524 の 4 と同じ。
- `kept` の `reason` は、引用先を読める人にだけ Host が入れる。読めないときは `forbidden` を返し、題も理由も出さない。

責務の分け方：

- **候補を選んだ後**：Editor は選んだ ID を `resolve(from, [id])` で確かめ直し、`ok` か `stale` のときだけ欄を変えるコマンドを入れる。`forbidden`・`missing-target`・`duplicate`・`unresolved` なら入れずに理由を出す（候補の一覧を取った後に権限や重複が変わる場合のため）。`offline` なら値の入力は許し、状態を「確かめられない」と出す。
- **競合**：欄の値は Editor の通常のコマンドで、保存の競合は今の保存の約束（版の比較）で扱う。Host は保存後に索引で全引用を読み直し、そこでの判定が正（Editor の表示は手がかり）。
- **`stale`**：Host が引用元ごとの基準と今の引用先の指紋を比べて返す。基準の作り方・更新・見送りは Host（PaoBub #524 の H2）。比較・更新・見送りの操作は Host の画面で行い、Editor は「古い」と出して Host の画面へ移るだけ。
- **`open`**：Host が開く時点で権限を確かめ直す。既存の `ReferenceHost.open` と同じ約束で、`forbidden` では題も出さない。
- 状態の名前は `ReferenceError.status` を使い、0001 の「未解決」「重複」と、古い版を残す決定の `kept` だけを足す。候補の注意（例：除外された原因の候補）は Host が `note` で渡し、Editor は判断しない。
- 既存の `ReferenceHost`（表示の埋め込み用）は「版を固定した値・図の写し」を扱い、これは「業務 ID の引用」なので別の口にする。移動と復帰の約束、権限の再確認の時点は同じにする。
- Host が無いときは参照の欄を文字列として編集・保存でき、候補・状態・移動は出さない。

### U5：互換と版

- **Graph Profile**：`items` を node type に足すので、`graphProfileSchemaVersion` を 3 に上げる。`upgradeGraphProfile` は schema 1・2 を `items` 無しの 3 として読む。schema 3 の Profile を今の版の OEP で開くと、今の「新しい schema」の誤りになる（黙って欄を落とさない）。`isGraphProfile` の検証に `items` の形（道筋が node type の schema にある属性を指すこと、`refs` の属性が string か string の配列であること）を足す。これを AR1 の必須作業にする。
- **Graph の文書**（schema 3）：属性を足すだけなので形は変えない。
- **旧い Profile の登録を残す**：`graphProfileFor` は Profile の ID と `version` の完全一致で引くので、`analysis-fishbone`・`analysis-fault-tree` の新しい `version`（`items` つき）を足しても、旧い `version` の Profile は登録から外さない。旧い成果物は旧い Profile で開き、表示・保存し、Profile の参照を勝手に書き換えない（項目にはならない）。新しい Profile へは「分析の項目を使う」の明示のコマンドで上げる（Profile の参照を変え、業務 ID の欄を空で足す。Undo で戻る）。
- AR1 の回帰試験：旧い Profile の Fishbone／FTA を開く・表示する・保存して再読込すると、Profile の参照と中身が変わらない。上げるコマンドの後は新しい Profile で開き、Undo で旧い参照に戻る。
- **Data**：表の `items` と行の `refs` を足すので schema を 3 に上げる。今の `isStructuredData` は未知の欄を拒否しないので、版を上げないと古い版が欄を黙って落として保存しうる。schema 3 を古い版では開けないようにする（今の版の判定は 1・2 だけを読む）。
- **列の改名・削除**：宣言は列 ID で書くので、列名の変更は意味を変えない。宣言が指す列の削除は確認を出し、削除すると宣言からその列を外す（同じコマンドの中で。Undo で両方戻る）。業務 ID の列を消すとその項目は無くなり、Host では「消えた」として下流に要確認が出る。
- **取り込み**：native JSON は宣言・参照の欄ごと運ぶ。CSV の取り込みは宣言・参照の欄を作らない（新しい表は項目にならない）。既存の表への CSV の取り込みは列 ID が残る列だけ値を変え、宣言はそのまま。
- **宣言が無い表・図**：項目にならない。Host は推測で項目を作らない（列名や属性名から読まない）。
- FMEA テンプレートに列 `fcId`・`fmId`・`functionRef` と宣言を足す。既存の FMEA の表は宣言が無いまま開け、項目にならないだけ。

## 3. 画面

1. 参照の欄（Graph の Inspector、Data の行の Inspector）に「候補から選ぶ」を出す。候補は Host から受け取り、題と出どころの成果物を並べる。
2. 選ぶと、Host に確かめ直してから、その欄の値を変える**通常の 1 コマンド**として入る。Undo/Redo・保存・native JSON・インポート／エクスポートは今の経路に乗る。引用の解除も同じ。
3. 欄に並んだ業務 ID ごとに状態を出す（題、または「見つからない」「重複」「古い」「権限なし」「確かめられない」）。状態は表示だけで、値を自動で書き換えない。
4. 「参照先を開く」で `open` を呼び、戻ると元の要素を選ぶ。
5. 関係の名前（「根拠」「対応」）は Host が渡す欄の名前で出し、別の関係を同じ線や同じ語で見せない。Graph の中に別成果物への線は描かない。
6. FMEA で同じ `fmId` の行の一致を求めた列が食い違うと、その行に診断を出す。

AI の提案は、既存の proposal（preview／apply／reject）で参照の欄を変える。採用までは引用ではない（Host が数えない）。

## 4. 段階

| 段  | 中身                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 依存 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| AR1 | Graph Profile schema 3（node type の `items`、検証、1・2 からの読み替え、互換の試験）、旧い `analysis-*` Profile の登録を残すことと上げるコマンド・その回帰試験、Data schema 3（表の `items`、行の `refs`、列の削除と宣言、CSV の扱い）、`items@1-draft`（`where`・`rootRefs`・`merge`）と版の交渉、宣言から項目の一覧（FM の多対一の投影と、項目ごとの native 要素の集まり）を作る純粋な関数と、行の削除・並べ替え・追加で同じ FM が保たれる試験、Fishbone／FTA の Profile と FMEA テンプレートの更新 | なし |
| AR2 | `ItemReferenceHost` の型と、Inspector の候補・状態・移動の画面、選択後の確かめ直し。Playground に架空の Host（同じ Library の三つの成果物から候補を出し、基準を覚えて `stale` を返す）                                                                                                                                                                                                                                                                                                                 | AR1  |
| AR3 | 検証：引用・解除の Undo/Redo、保存と再読込、native JSON・CSV、FM の食い違いの診断、権限なし・欠落・重複・古い・残した（`kept`）・確かめられないの表示、Host なしの編集、`items@1-draft` を読めない Host、古い版での schema 3 の拒否、旧い Profile の成果物、desktop／mobile                                                                                                                                                                                                                            | AR2  |

PaoBub 側の読み取り（`as: 'items'` と `items@1-draft`）、引用ごとの基準、統合試験は [paobub #523](https://github.com/ryo0221/paobub/issues/523)・[#524](https://github.com/ryo0221/paobub/pull/524)。`ok`・`kept`・`stale` の基準と、投影した項目の同一性（業務 ID）と native 要素の集まりの分け方は #524 の H2 と同じ定義を使う。

## 5. 扱わないこと

- 三つの分析を同じ要素にまとめること、名前の一致や文章からの自動の関連付け。
- FTA の確率から FMEA の O、RPN から AP を自動で決めること。
- 承認・失効の状態や引用ごとの基準を Editor に持つこと（PaoBub が持つ）。
- 共同編集での参照の欄の扱い（今の共同編集の範囲に従い、別に決める）。

## 6. 決めてほしいこと

| #   | 問い                                 | 推奨                                                                                                                                |
| --- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| U1  | 業務 ID と参照の欄の宣言             | A：今ある型の値と、`items@0-draft` と同じ形の宣言（Graph は Profile の node type、Data は表の宣言を列 ID で）。9 種類の対応は上の表 |
| U2  | 一つの故障原因が複数の候補を引くとき | A：行の参照の欄 `refs`（配列）。行は分けない                                                                                        |
| U3  | 引用の値に固定版を入れるか           | A：値は業務 ID だけ。引用ごとの基準は Host が記録する                                                                               |
| U4  | Host の口                            | 引用元の文脈を渡す `ItemReferenceHost`。状態に `kept` を足す。選択後の確かめ直しは Editor、最終の判定は Host の索引                 |
| U5  | 互換                                 | Graph Profile schema 3・Data schema 3・`items@1-draft`。古い版は開かずに誤りを出し、旧い Profile の登録は残す                       |
| U6  | FMEA の FM と FC                     | A：1 行 = FC、FM は同じ `fmId` の行を一致を条件に 1 件へ投影                                                                        |
