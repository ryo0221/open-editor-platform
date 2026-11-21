# 種類の登録と領域境界の整理（e2e短縮 段階2）

状態：提案（2026-11-21）。採用後は契約文書（`docs/kind-registry-contract.md`）へ反映します。

## 目的

段階1（#45）で、e2eは変更の影響範囲だけを走らせられるようになりました。ただし、次の2点で選択が広がっています。

1. **Playground と Artifact Host が全種類を1か所で分岐している。** `apps/playground/src` には `kind === '…'` が288か所（33ファイル）あり、`model.ts` の作成・検証・表示名と `app/editor-surfaces.tsx` の描画が全26種類を並べています。`App.tsx` などの共有ファイルを触ると、全種類のspecが選ばれます。Artifact Host の `HostApp.tsx` も同じ形です。
2. **領域をまたぐ依存が3つある**（このほか、見本の拡張機能 `extension-sample`（core）が Animation の表示に `animation-core` と `animation-player` を使っています。見本なので境界の確認では例外として残します）。 core / office / engineering の3領域（段階1の `scripts/e2e/areas.mjs`）のうち、次の依存が境界を越えています。
   - `character` と `character-core`（engineering）が `animation-core`（office）を使う。使うのは `Easing`、`Rational`、`easingProgress` だけ。
   - `estimate`（office）が `cad-core` と `bim-core`（engineering）に依存する。使うのは `cad-source.ts`、`bim-source.ts`、`bim-panel.tsx` の3ファイル（631行）。
   - Playground と Artifact Host が、両方の領域の全packageを直接importする。

段階2では、種類ごとの定義を登録制にして、Hostは登録された定義を順に使うだけにします。あわせて上の3つの境界越えを解消し、境界を守っているかを `npm run test:tooling` で確認できるようにします。これで次のことが成り立ちます。

- 共有ファイルの変更が全種類へ広がらず、その種類の定義ファイルの変更はその種類のspecだけを選ぶ。
- officeの変更でengineeringのspecが選ばれない。逆も同じ。
- 段階3（engineeringを別リポジトリに分ける）を選んだとき、engineering側の定義一式をそのまま移せる。

## 対象外

- 各Editorの内部実装、保存形式、Host API（`EditorHostAdapter`）の変更。
- 種類の追加・削除。表示名、アイコン、作成時の初期内容は今と同じにする。
- リポジトリの分割（段階3）。GitHub Actionsの再開。

## 構成

### 種類の定義（core、Reactなし）

core領域に `@editor-platform/artifact-kinds` を追加します。中身は種類を識別・作成・検証するための型と登録の仕組みだけで、React にもどの Editor にも依存しません（U1=A）。描画は Host 側で登録します（下の「Hostごとの描画」）。

```ts
/** content 以外に記録へ載る付随データ（今の StoredArtifact の追加欄と同じ名前） */
export interface KindRecordExtras {
  cadResources?: unknown[];
  cadParts?: unknown[];
  simulationSources?: unknown[];
  constructionSources?: unknown[];
  geoResources?: unknown[];
}

/** 新規作成の結果。今の makeArtifact が返す内容を、content・名前・付随データに分けたもの */
export interface KindInitial<C> {
  name: string;
  content: C;
  extras?: KindRecordExtras;
}

export interface KindDefinition<C> {
  kind: string; // 'cad'、'document' など。保存済みの値と同じ
  area: 'office' | 'engineering';
  label: string;
  icon: string;
  description: string;
  creatable: boolean;
  /** 新規作成。count は「CAD 3」の番号、options は作成元の選択（施工の建物、解析のCADなど） */
  create(count: number, options?: unknown): KindInitial<C>;
  /** 今の validContent の分岐 */
  validate(content: unknown): content is C;
}

/** 型付きの定義を作る。content の型 C は validate の型ガードと create の戻り値で固定される */
export function defineKind<C>(definition: KindDefinition<C>): RegisteredKind;

/** 登録用に型を消した形。content は validate を通したものだけを扱う */
export interface RegisteredKind {
  readonly kind: string;
  readonly area: 'office' | 'engineering';
  readonly label: string;
  /* icon、description、creatable も同じ */
  create(count: number, options?: unknown): KindInitial<unknown>;
  validate(content: unknown): boolean;
}

export function createKindRegistry(kinds: RegisteredKind[]): KindRegistry;
```

- 種類ごとに content の型が違うので、配列に入れるときは `defineKind` で `RegisteredKind` に変換します。`KindDefinition<C>` をそのまま `KindDefinition<unknown>[]` に入れると、`validate` の型ガードと `create` の戻り値の型が消えるか、関数引数の変性で型エラーになるためです。`RegisteredKind` から content を取り出すのは、`validate` を通した後だけにします。
- 型の扱いは、`artifact-kinds` のテストに `@ts-expect-error` を使ったコンパイルテストを置いて確かめます。誤った型の `create`、`validate` で絞り込む前の content の利用、同じ種類名の2回登録が、それぞれ型エラーか実行時エラーになることを確認します。
- `KindRegistry` は、種類名から定義を引く、作成できる種類を並べる、内容を検証する、の3つを提供します。同じ種類名を2回登録したら、起動時にエラーにします。

### 定義を一か所に置く（共有の定義とHostごとの差分）

種類の名前・アイコン・説明・作成・検証（上の `KindDefinition`）は、その種類の Editor package に一つだけ置き、`<package>/kind` として公開します。たとえば `@editor-platform/cad/kind`、`@editor-platform/document/kind` です。Playground と Artifact Host は同じ定義を import し、写しは作りません（U2=A：共有の定義と Host ごとの接続を分ける）。

- `<package>/kind` は React を import しません。作成と検証だけなので、Host の初期表示で読み込むコードは増えません。
- 領域ごとの一覧は `@editor-platform/artifact-kinds` には置かず、各 Host が `kinds/{office,engineering}.ts` で並べます。engineering の一覧は engineering の package だけを import します。段階3で engineering を別リポジトリへ移すときは、各 package の `./kind` がそのまま移り、Playground 固有の型は持ち込みません。

### Hostごとの描画と接続

描画と Host 固有の処理は、Host ごとに `apps/<host>/src/kinds/` に置きます。

| 置き場所                                            | 内容                                                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `apps/playground/src/kinds/office/<kind>.tsx`       | Playground の Surface（`lazy()`）と、取り込み・書き出し・記録の分割保存など Playground 固有の hook |
| `apps/playground/src/kinds/engineering/<kind>.tsx`  | 同上（engineering の種類。今の `apps/playground/src/cad/host.tsx` などをそのまま参照）             |
| `apps/playground/src/kinds/{office,engineering}.ts` | 共有の定義と Host の部品を組にして並べる                                                           |
| `apps/artifact-host/src/kinds/`                     | Artifact Host の Surface と hook。共有の定義は Playground と同じものを使う                         |

Host 側の組は `hostKind(definition, { Surface, hooks })` で作ります。`Surface` の props の content 型は `definition` の `C` から決まるので、別の種類の Surface を組むと型エラーになります。

`App.tsx`、`model.ts`、`app/editor-surfaces.tsx` からは種類ごとの分岐をなくし、登録された組を使います。種類に固有の処理で hook に収まらないものは、移行中に見つけた時点で一覧にして、この文書に追記します。

### 境界越えの解消

1. **Easing と Rational を core へ。** `Easing`、`Rational`、`easingProgress` を新しい core package `@editor-platform/easing` へ移します（既存の `time-axis` は工程表の日付軸で、用途が違うため使いません）。`animation-core` は同じ名前で re-export するので、animation 側の呼び出しは変わりません。`character` と `character-core` は `easing` を使うようにし、`animation-core` への依存を外します。
2. **estimate の CAD/BIM 連携を、画面のないengineering packageへ。** 新しい engineering package `@editor-platform/estimate-engineering` には、CAD/BIM の数量の取り出しと検証の処理（今の `cad-source.ts` と `bim-source.ts`）だけを置き、Estimate の画面・編集操作・`EstimatePort` は置きません。
   - 両者が受け渡す型は core の `calculation-core` に置きます。`SourcePin` はすでに core にあり、ここに `RetainedSource`、取り出した数量 `MeasuredQuantity`（単位・値・品質・取り出し元）、`QuantityVerification` を加えます。`estimate-core` は同じ名前で re-export するので、Estimate 側の呼び出しは変わりません。
   - `estimate-engineering` の依存は core（`artifact-core`、`calculation-core`）と engineering（`cad-core`、`bim-core`）だけです。office の package は import しません。
   - 数量パネル（`cad-panel.tsx`、`bim-panel.tsx`、`cad-updates.tsx`）は Estimate（office）に残します。CAD/BIM の処理は、Host から `geometrySources`（`estimate-engineering` の関数をまとめたもの）として受け取ります。Host が渡さなければパネルは出ません。`MeasuredQuantity` から Estimate の `Quantity`（名前・根拠・採否など）を作る処理は Estimate 側に置きます。
   - Host の検証器（`quantityVerification`）がないときは、今の `verifyEstimate` と同じく `quantity-verifier-required` で拒否します。
3. **Host の直接import。** 上の登録制で、Host本体（`App.tsx` など）が直接参照するのは `kinds/{office,engineering}.ts` の2つだけになります。

### 境界の確認

`scripts/check-area-boundaries.mjs`（KR1）を `npm run test:tooling` から呼びます。`package.json` の `dependencies` と `peerDependencies` を見て、次の依存があれば失敗します。例外の許可一覧はありますが、橋渡し用の例外は作りません。

- core → office / engineering
- office → engineering
- engineering → office（engineering → core は可）

あわせて次を確認します。

- `<package>/kind` が React と他の Editor package を import していない（KR4）。
- `apps/*/src/kinds/office/**` と `kinds/office.ts` が engineering の package を import していない（KR5）。

移行中の境界越えは許可一覧に書いておき、解消したPRで一覧から消します。見本の拡張機能 `extension-sample` の Animation への依存は、見本の目的上そのまま残します。

### e2eの選択への反映

種類名と package 名は一致しないことがあります（`data` の package は `structured-data`）。また、依存を切った後は、package の依存関係だけでは連携の spec に変更が届かなくなります（`estimate-engineering` の変更が Estimate の連携 spec に届かないなど）。そこで `scripts/e2e/areas.mjs` に次の対応を明示します。

- **種類 → package：** 各種類の定義を持つ package と、Surface を持つ package（`kindPackages`）。`apps/*/src/kinds/<area>/<kind>.tsx` の変更は、その種類の package の変更として扱います。
- **連携 → spec：** 依存を切った連携を、spec の owner に明示します。たとえば `estimate-*` の spec の owner に `estimate-engineering`、`cad-core`、`bim-core` を加えます。

`kinds/office.ts` の変更は office の light spec 全部、`kinds/engineering.ts` は engineering の spec 全部を選びます（どちらも、今の「Playground共有ファイル → 全light spec」より狭い）。

**過少選択の確認（KR7の受け入れ条件）：** 段階1（main）の選択規則で、各 package の変更が選ぶ spec の一覧を固定値として保存します。新しい規則で同じ変更が選ぶ spec がその一覧を含むこと（減ってよいのは、Playground 共有ファイルの広い規則でだけ選ばれていたものに限り、その理由を一覧で示す）を tooling テストで確認します。

## 段階的な実装計画

統合ブランチ `feat/kind-registry` に段階ごとのPRを入れ、最後に main への受け入れPRを1つ出します。各PRは Codex の指摘がなくなってから統合ブランチへマージします。

| 段階 | 内容                                                                                                           | 確認                                                                                                                             |
| ---- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| KR1  | 境界の確認スクリプト（今の3つは許可一覧に入れる）                                                              | tooling テスト                                                                                                                   |
| KR2  | Easing/Rational を `easing` へ。character の `animation-core` 依存を外す                                       | unit、character と animation の e2e（影響範囲）                                                                                  |
| KR3  | 受け渡しの型を `calculation-core` へ。画面のない `estimate-engineering` を作り、estimate の CAD/BIM 依存を外す | unit、境界の確認（橋渡しの例外なし）、estimate-editor と bim-hosts の e2e                                                        |
| KR4  | `artifact-kinds`（Reactなし）と各 package の `./kind`。Playground の作成・検証・表示名を登録制に（`model.ts`） | 全26種類の作成結果（content・名前・付随データ）が今と同じこと、保存→再読込で同じになること、型のコンパイルテスト、影響範囲の e2e |
| KR5  | Playground の描画を登録制に（`editor-surfaces.tsx`、`App.tsx`）。office と engineering の一覧を分ける          | 影響範囲の e2e（共有ファイルを触るので office と engineering の light spec 全部）                                                |
| KR6  | Artifact Host を同じ形に                                                                                       | host、bim.hosts、cad.hosts の各スイート                                                                                          |
| KR7  | `affected.mjs` を `kinds/` と `kindPackages` に対応させる。受け入れPR                                          | 過少選択の確認テスト、tooling、mainとの比較（段階1の手順）                                                                       |

KR5 と KR6 は共有ファイルを大きく触るので、e2e は段階1の `--from-json` と `compare.mjs` で main と比べ、ブランチだけで落ちるテストがないことを確認します。重い CAD/解析の spec は、そのPRで engineering の定義を変えたときだけ走らせます。

## 決定事項（設計レビュー、2026-11-21）

- **U1=A：** 種類の定義の型は React に依存しない core package `artifact-kinds` に置く。
- **U2=A：** 共有の定義（`<package>/kind`）と Host ごとの接続（`apps/<host>/src/kinds/`）を分ける。
- **U3：** engineering を外した Playground は今回作らない。
- 受け入れ条件に「既存の種類ごとの e2e 対象を過少選択しないこと」を加える（上の「過少選択の確認」）。
