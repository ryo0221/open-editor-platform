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

### 種類の定義（新しいcore package）

core領域に `@editor-platform/artifact-kinds` を追加します。中身は型と登録の仕組みだけで、どのEditorにも依存しません。

```ts
export interface ArtifactKindDefinition<C, H> {
  kind: string; // 'cad'、'document' など。保存済みの値と同じ
  area: 'office' | 'engineering';
  label: string;
  icon: string;
  description: string;
  creatable: boolean;
  /** 新規作成時の内容。今の makeArtifact の分岐をここへ移す */
  create(options: KindCreateOptions): C;
  /** 今の validContent の分岐 */
  validate(content: unknown): content is C;
  /** Hostごとの描画。H は Host が渡す状態（Playground の SurfaceHost など） */
  Surface: LazyExoticComponent<ComponentType<{ host: H; content: C }>>;
  /** 任意：取り込み、書き出し、記録の分割保存など、今Hostが種類ごとに分岐している処理 */
  hooks?: Partial<KindHooks<C, H>>;
}

export function createKindRegistry<H>(
  definitions: ArtifactKindDefinition<unknown, H>[],
): KindRegistry<H>;
```

- `KindRegistry` は種類名から定義を引く、作成できる種類を並べる、内容を検証する、の3つを提供します。同じ種類名を2回登録したら、起動時にエラーにします。
- `Surface` は今と同じく `lazy()` で読み込みます。初期表示で読み込むコードの量は変わりません。

### 定義の置き場所

| 種類                                               | 定義の置き場所                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------------- |
| office（document、slide、design、data など15種類） | `apps/playground/src/kinds/office/<kind>.tsx`                           |
| engineering（cad、bim、pcb、factory など11種類）   | `apps/playground/src/kinds/engineering/<kind>.tsx`                      |
| 領域ごとの一覧                                     | `apps/playground/src/kinds/{office,engineering}.ts`（定義を並べるだけ） |
| Artifact Host                                      | `apps/artifact-host/src/kinds/` に同じ形で置く                          |

今 `apps/playground/src/cad/host.tsx` などにある engineering の Host 部品は、そのまま `kinds/engineering/cad.tsx` から参照します。中身は移しません。

`App.tsx`、`model.ts`、`app/editor-surfaces.tsx` からは種類ごとの分岐をなくし、`registry.get(kind)` の結果を使います。種類に固有の処理で `hooks` に収まらないものは、移行中に見つけた時点で一覧にして、この文書に追記します。

### 境界越えの解消

1. **Easing と Rational を core へ。** `Easing`、`Rational`、`easingProgress` を core の `time-axis` へ移します。`animation-core` は同じ名前で re-export するので、animation 側の呼び出しは変わりません。`character` と `character-core` は `time-axis` を使うようにし、`animation-core` への依存を外します。
2. **estimate の CAD/BIM 連携を engineering 側へ。** `cad-source.ts`、`bim-source.ts`、`bim-panel.tsx` を新しい engineering package `@editor-platform/estimate-engineering` へ移します。`estimate` の Surface は、数量の取り込み元を `quantitySources` として Host から受け取ります（今は `./bim-panel` を直接 lazy import している）。Playground と Artifact Host は、engineering の一覧からこの取り込み元を渡します。`estimate` の `cad-core`、`bim-core` への依存はなくなります。
3. **Host の直接import。** 上の登録制で、Host本体（`App.tsx` など）が直接参照するのは `kinds/{office,engineering}.ts` の2つだけになります。

### 境界の確認

`scripts/check-area-boundaries.mjs` を追加して、`npm run test:tooling` から呼びます。`package.json` の `dependencies` と `peerDependencies` を見て、次の依存があれば失敗します。

- core → office / engineering
- office → engineering
- engineering → office（engineering → core は可）

あわせて `apps/playground/src/kinds/office/**` が engineering の package を import していないことも確認します。移行中は、上の3つの境界越えを許可一覧に書いておき、解消したPRで一覧から消します。

### e2eの選択への反映

`scripts/e2e/affected.mjs` は `apps/playground/src/kinds/<area>/<kind>.tsx` の変更を、その種類のpackageの変更として扱います。`kinds/office.ts` の変更は office の light spec 全部、`kinds/engineering.ts` は engineering の spec 全部を選びます（どちらも、今の「Playground共有ファイル → 全light spec」より狭い）。

## 段階的な実装計画

統合ブランチ `feat/kind-registry` に段階ごとのPRを入れ、最後に main への受け入れPRを1つ出します。各PRは Codex の指摘がなくなってから統合ブランチへマージします。

| 段階 | 内容                                                                                                  | 確認                                                                              |
| ---- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| KR1  | 境界の確認スクリプト（今の3つは許可一覧に入れる）                                                     | tooling テスト                                                                    |
| KR2  | Easing/Rational を `time-axis` へ。character の `animation-core` 依存を外す                           | unit、character と animation の e2e（影響範囲）                                   |
| KR3  | `estimate-engineering` を作り、estimate の CAD/BIM 依存を外す                                         | unit、estimate-editor と bim-hosts の e2e                                         |
| KR4  | `artifact-kinds` package と、Playground の作成・検証・表示名の登録制（`model.ts`）                    | unit、作成と検証の全種類テスト、影響範囲の e2e                                    |
| KR5  | Playground の描画を登録制に（`editor-surfaces.tsx`、`App.tsx`）。office と engineering の一覧を分ける | 影響範囲の e2e（共有ファイルを触るので office と engineering の light spec 全部） |
| KR6  | Artifact Host を同じ形に                                                                              | host、bim.hosts、cad.hosts の各スイート                                           |
| KR7  | `affected.mjs` を `kinds/` に対応させる。受け入れPR                                                   | tooling、mainとの比較（段階1の手順）                                              |

KR5 と KR6 は共有ファイルを大きく触るので、e2e は段階1の `--from-json` と `compare.mjs` で main と比べ、ブランチだけで落ちるテストがないことを確認します。重い CAD/解析の spec は、そのPRで engineering の定義を変えたときだけ走らせます。

## 未決事項

- **U1 定義の型をどこに置くか。** 案A：新しい core package `artifact-kinds`（推奨。どのEditorにも依存せず、段階3で両リポジトリから使える）。案B：既存の `editor-host` に入れる（package は増えないが、Host API と登録の仕組みが混ざる）。
- **U2 engineering の定義を package 側に持たせるか。** 案A：今回は `apps/playground/src/kinds/engineering/` に置く（推奨。Host部品はすでに apps 側にあり、移す量が少ない）。案B：各 engineering package に `./kind` を作って定義を持たせる（段階3では移しやすいが、今回の変更が大きくなる）。
- **U3 Playground で engineering を外せる起動を作るか。** 例えば `VITE_KINDS=office` で engineering の一覧を読み込まない Playground を作れば、office の e2e が CAD の Worker やカーネルを一切読み込まずに走ります。今回は作らず、必要になったら追加する案を推奨します。
