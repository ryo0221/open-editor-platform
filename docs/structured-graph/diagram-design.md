# Structured Graph：ノード形状とSemantic Sectionの設計

設計版0.3、2026-10-23（PR #398のレビューを反映）。状態は**設計として採用、Phase 1（ノードの形状とschema 2）・Phase 2（Section）・Phase 3（自動配置・パレット・テンプレート）は実装済み**。各Phaseの実装と検証は別のPRで行う。Phase 1〜3の範囲は[契約](../structured-graph-contract.md#ノードの形と塗り-396-phase-1-preview)（[Section](../structured-graph-contract.md#section-396-phase-2-preview)・[図の作成支援](../structured-graph-contract.md#図の作成支援-396-phase-3-preview)）・[変更の記録](changes.md)・検証記録にある。判断の理由と比較案はADR 015にある。採用後は、実装した範囲を[Structured Graph契約](../structured-graph-contract.md)・[埋め込み](../embedding.md)・[実装状況](../status.md)へ移し、この文書は計画と設計判断の記録として残す。要望はeditor-platform Issue #396。

## 1. 目的と範囲

Structured Graphを、型付きノード・関係の編集に加えて、ノードの形と意味を持つまとまり（Section）を扱える図の編集へ広げる。システム構成図で「本番環境 ＞ Backend ＞ API Server / Database」「Frontend → Backend」「外部サービスへの接続」を、図形ではなく構造化Graphとして表せることを目標にする。

| 範囲に入れる                                                                  | 入れない（理由）                                                          |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 7種の形状、Profileの型ごとの既定形状・style、nodeごとの上書き                 | 任意CSS/HTML/JS、URL・外部asset（Profileの信頼境界と描画の安全性）        |
| Sectionの型・属性・親子・明示的な所属、移動・リサイズ・解除・折りたたみ       | 多対多の所属（型付きedgeで表すか後続の拡張）                              |
| native・外部adapter・Data投影の能力宣言、proposal・readOnly・stale・Undo/Redo | 共同編集・template/reuse・Office/React出力（既存の非対応を維持。別Issue） |
| 構成図のテンプレートと形状パレット、Sectionを考慮した自動配置（Phase 3）      | 業務固有の語彙のハードコード（Profileとテンプレートにだけ置く）           |
| 旧schema 1の拒否と理由表示、更新前のエクスポート案内                          | schema 1の読み込み・自動移行・旧sidecarとの互換（Issueの互換性方針）      |

## 2. 三つの区分

| 区分                   | 置き場所                                           | command・履歴                                                                    |
| ---------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------- |
| semantic               | `nodes`・`edges`・`sections`・`attributes`         | 既存のguard・Undo/Redo・version・hash・proposal                                  |
| persisted presentation | `presentation`（native）、Hostのsidecar（adapter） | semanticと同じ履歴。intentは別で、一つのbatchで混ぜてよいのはnativeだけ          |
| private view state     | Surfaceのstate・props                              | 保存しない。camera・選択・filter・折りたたみ・経路・ラベル配置・自動計算した高さ |

既存の「Graph content・version・hash・履歴には表示設定を保存しない」という契約は、private view stateについての約束として残す。保存する見た目は`presentation`に限り、通常の編集と同じく版とhashに含める。

## 3. Native model（schema 2）

```ts
type GraphNodeShape =
  | 'rectangle'
  | 'rounded-rectangle'
  | 'ellipse'
  | 'diamond'
  | 'cylinder'
  | 'hexagon'
  | 'cloud';

interface GraphNodeStyle {
  fill?: string; // 3/6桁hex
  stroke?: string; // 3/6桁hex
  strokeWidth?: 1 | 2 | 3;
  dash?: number[]; // 最大8個、各0より大きく64以下。空配列は実線
}

interface GraphDocument {
  schemaVersion: 2;
  id: string;
  profile: { id: string; version: number };
  attributes: Attributes;
  nodes: GraphNode[]; // { id, type, attributes, sectionId? }
  edges: GraphEdge[]; // { id, type, from, to, attributes }（変更なし）
  sections: GraphSection[]; // { id, type, attributes, parentId? }
  presentation: {
    nodes: Record<string, { x: number; y: number; shape?: GraphNodeShape; style?: GraphNodeStyle }>;
    sections: Record<
      string,
      { x: number; y: number; width: number; height: number; style?: GraphNodeStyle }
    >;
  };
}
```

- graph・node・edge・sectionのIDは文書内で一意。`sectionId`と`parentId`は存在するSectionを指す。親の連鎖に循環を許さず、深さは8まで。
- `presentation.nodes`のキーは存在するnodeだけ。位置がないnodeは今と同じ決定的な初期位置で描く。`presentation.sections`は全Sectionに必須。
- 未知のstructural field、未知の形状、style・位置の未知fieldは拒否する（今のLayoutと同じ厳格さ）。
- 上限は既存（1,000 nodes / 4,000 edges / 2 MiB など）に、Section 500件と深さ8を足す。Section範囲の各値は既存の座標上限±100,000と、幅・高さ40〜200,000に収める。
- schema 1は`Graph schema 1 is no longer supported in this preview; export it with the previous version or recreate it`の趣旨の理由で拒否する。旧データを黙って読み替えたり、上書きしたりしない。
- **Phase 1では`sections`を空配列、`sectionId`を未指定に限定する**。Phase 2でこの制限だけを外し、schemaのversionは変えない。

## 4. Profile（schema 2）

```ts
interface GraphNodeTypeUi extends AttributeUi {
  shape?: GraphNodeShape; // 型の既定形状
  style?: GraphNodeStyle; // 型の既定style
}
interface GraphSectionType extends GraphType {
  ui?: AttributeUi & { style?: GraphNodeStyle };
  contains?: { nodes?: string[]; sections?: string[] }; // 省略=制限なし、[]=入れられない、非空=許可する型の一覧
}
interface GraphProfile {
  schemaVersion: 2;
  id: string;
  version: number;
  graph: GraphType;
  nodes: Record<string, GraphType & { ui?: GraphNodeTypeUi }>;
  edges: Record<string, GraphEdgeType>;
  sections: Record<string, GraphSectionType>; // Phase 1では空
}
```

- `contains.nodes`・`contains.sections`はそれぞれ独立に、省略なら制限なし、空配列なら一件も入れられない、空でない配列ならそこに挙げた型だけを入れられる。たとえば子Sectionを持たない末端のSectionは`contains: { sections: [] }`と書く。配列は存在するnode型・Section型だけを指せ、重複を許さない。
- `readOnly`は既存と同じく、そのSectionの属性・範囲・style・親・所属の変更と削除を守る（§7の「readOnlyの保護」）。
- `edgeStyle`は今の定義のまま残す。node・Sectionのstyleは同じhex・dashの検証を使う。
- 業務の語彙（environment・network・system・layer・organization・phaseなど）はPlaygroundのProfileとテンプレートにだけ置き、packageのコードに入れない。

### 見た目の優先順位

| 順  | 形状・style の出どころ                                           |
| --- | ---------------------------------------------------------------- |
| 1   | nodeの個別指定（nativeは`presentation.nodes`、adapterはsidecar） |
| 2   | Profileのnode型の`ui.shape`・`ui.style`                          |
| 3   | 既定：`rectangle`とテーマの色                                    |

styleは項目ごとに上から決める（`fill`だけ個別指定して`stroke`は型の既定、など）。個別指定を消すと、そのnodeは型の既定に戻る。Profileの版を上げて既定を変えると、個別指定のないnodeの見た目が変わる。これはProfileの版管理（pin・stale判定）で扱い、既存nodeの`presentation`へ既定値を書き込まない。

## 5. Intent

既存の8種に加える。すべて`parseGraphIntents`の厳格なkey検査、`guardGraphCommand`、readOnly、proposalのpreview/apply、stale判定、Undo/Redoを通す。

| Phase | intent                                                         | 意味                                                                                      |
| ----- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1     | `set-node-shape { id, shape \| null }`                         | 個別の形状を設定する。nullで型の既定へ戻す                                                |
| 1     | `set-node-style { id, style \| null }`                         | 個別のstyleを丸ごと置き換える。nullで型の既定へ戻す                                       |
| 1     | `move-node`（既存）                                            | `presentation.nodes[id]`の位置だけを変える。形状・styleは保持する                         |
| 2     | `add-section { section, bounds }`                              | Sectionを作る。`section.parentId`は任意                                                   |
| 2     | `set-attribute` / `remove-attribute`（scopeに`section`を追加） | Sectionの名称・意味属性を変える                                                           |
| 2     | `set-node-section { id, sectionId \| null }`                   | nodeの所属を変える。座標は変えない                                                        |
| 2     | `set-section-parent { id, parentId \| null }`                  | Sectionの親を変える。循環・深さ・`contains`を検証する                                     |
| 2     | `move-section { id, position }`                                | Sectionと、子孫Sectionの範囲・所属nodeの位置を同じ差分だけ動かす                          |
| 2     | `resize-section { id, bounds }`                                | 範囲だけを変える。所属もnodeの位置も変えない                                              |
| 2     | `set-section-style { id, style \| null }`                      | Sectionのstyleを変える                                                                    |
| 2     | `delete-section { id }`                                        | Sectionを消し、直下のnodeと子Sectionを消したSectionの親へ繰り上げる。nodeとedgeは消さない |

- `add-node`は今のままで、作成UIで形状を選んだときは`add-node`と`set-node-shape`を一つのbatch（一つのUndo）にする。
- Sectionの名称は意味属性で、Profileの`ui.labelField`で示す（nodeと同じ）。Issueは「タイトル」をpresentationの例に挙げているが、名称で環境やシステムを区別する以上、意味として扱う（§11の1）。
- `delete-node`は今のまま。Section内のnodeを消しても、そのSectionは残る。

## 6. 形状の幾何（Phase 1）

形状ごとの計算はpure moduleにまとめ、Surface・Fit・経路・hit判定・Graph参照のSVG描画で同じものを使う。

```ts
interface GraphShapeGeometry {
  path(box: Bounds): string; // SVG path
  polygon(box: Bounds): Point[]; // 曲線は固定数の線分に近似
  contentBox(box: Bounds): Bounds; // ラベルを置ける内側の矩形
  portRange(side: Side): [number, number]; // 辺の上でportを置ける範囲（0〜1）
}
```

- **端点**：今の`routeGraphEdge`は外接矩形の辺にportを置き、`separateGraphRoutes`がその後で平行経路のportを辺に沿ってずらす。形状の外周は外接矩形の内側にあるので、**portの位置が確定した後（`separateGraphRoutes`の後）に、portから外接矩形の内側へ向かう直線**（portの辺に垂直）と`polygon`の交点を求め、経路の端の線分をその点まで延ばす。交点は、port側から見て最初に当たる点（凹みのある雲では外側の弧）とする。最後の線分は辺に垂直のままなので、経路は直交を保つ。
- **同じ端点を使う所**：矢印、edgeの描画とhit用のpath、ラベル配置の候補、選択時の端のhandle、Graph参照のSVG描画はすべてこの最終端点を使う。self edge（今は上辺の二つのport）と平行経路も、ずらした後のportから同じ計算をする。
- **portの範囲**：菱形・楕円・六角形・雲では、辺の端に近いportだと交点が浅い角度になったり、内側へ深く入ったりする。そのため`portRange`で平行経路をずらせる幅を狭める（例：菱形は中央の±25%）。この範囲の中では、内向きの直線が必ず外周と交わることをunitで確かめる。
- **円柱**：上面の外周は上側の楕円弧で、下から入る経路は底の弧で終わる。上面の楕円の高さは`min(高さの15%, 12px)`。
- **障害物**：経路の探索は今と同じく外接矩形に余白を足して避ける。形状の内側の空きを経路に使わない（保守的で、結果が安定する）。
- **hit判定**：pointerの判定は形状のpath（SVGの`pointer-events`）で行い、外接矩形の角では反応しない。keyboardのfocusは今のノードのbuttonのままで、focus表示は外接矩形に出す。
- **自動の高さ**：幅は今と同じ（既定200px、Hostの`nodeSize`）。高さは、実測したラベルが`contentBox`に収まる最小の値を形状ごとの比から求め、最小70pxとする。菱形は比が小さいため、長いラベルでは縦に長くなる。明示の`nodeSize`では今と同じく拡張しない。
- **Fit・ラベル配置**：外接矩形で計算する（今と同じ）。
- **アクセシビリティ**：形状の名前をaccessible descriptionに入れ、色だけで型を区別させない。文字色は`fill`の輝度から黒か白を選び、コントラスト比4.5以上を満たさないstyleは文字色の側で補正する。

## 7. Section（Phase 2）

### 検証

構造の検証（`isGraphDocument`）で、ID重複・存在しない`sectionId`/`parentId`・循環・深さ超過・上限・`presentation.sections`の欠けや余りを拒否する。Profileの検証（`validateGraph`）で、未知のSection型と`contains`に反する所属を、既存の接続ルールと同じく`blocking`の診断にする。所属nodeがSectionの範囲の外にあるのは`warning`（`blocking: false`）にとどめ、自動で直さない。

### 操作

| 操作             | 結果                                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 作成             | 選択中のnodeがあれば、それを入れる案を出す。確定すると`add-section`と`set-node-section`を一つのbatchにする                                    |
| 所属の変更       | Inspectorの「所属」欄、またはノードのドロップ。中心が入った最も内側の枠へ、移動と同じUndoで入れる（#448で確定操作から変更）                   |
| 移動             | Sectionの枠をドラッグする。所属nodeと子Sectionが一緒に動く（`move-section`一つ）                                                              |
| リサイズ         | 範囲だけが変わる。範囲から外れたnodeも所属は変わらない                                                                                        |
| 解除・削除       | `delete-section`。中身は親へ繰り上がる。消す前に影響する所属を一覧で見せる                                                                    |
| 折りたたみ・展開 | private view state。折りたたんだSectionは一つの箱として描き、内外を跨ぐedgeを「相手・向き・型」ごとに一本へ集約して件数を出す。edgeは変えない |

### readOnlyの保護

親のSectionへの権限だけで、readOnlyの子孫の保護を迂回させない。`guardGraphCommand`はintentの種類ではなく変更前後のcontentの差分で判定するので、任意のheadless commandにも同じ規則がかかる。

| 守る対象                     | 変更前後で一致しなければ拒否するもの                                             |
| ---------------------------- | -------------------------------------------------------------------------------- |
| readOnlyのnode型のnode       | node全体（`sectionId`を含む）と`presentation.nodes[id]`（位置・形状・style）     |
| readOnlyのSection型のSection | Section全体（属性・`parentId`）、`presentation.sections[id]`、存在（削除を含む） |
| readOnlyのSectionの中身      | そのSectionを`sectionId`/`parentId`に持つ要素の出入り（追加・取り出し）          |

このため、子孫にreadOnlyのnodeやSectionがあると`move-section`は位置を動かせず、直下にreadOnlyのnodeやSectionがあると`delete-section`は繰り上げができない。どちらもbatch全体を拒否し、正本と履歴を変えない。Surfaceは操作の前に影響する要素を数え、拒否の理由（どの要素がreadOnlyか）を示す。試験では、readOnlyの孫を持つSectionの移動、readOnlyの子を持つSectionの削除、readOnlyのSectionへのnodeの出し入れ、任意commandでの同じ変更が、すべて一batchごと拒否されることを確かめる。

Sectionの描画順は親が先、子が後で、nodeとedgeはその上に描く。Sectionの枠はクリップせず、外にはみ出したnodeもそのまま見せる。

## 8. 外部adapterとData投影

```ts
interface GraphAdapter<S> {
  // ...既存
  presentationMode?: 'sidecar' | 'source' | 'none'; // 今の layoutMode を置き換える
  sections?: boolean; // 既定 false
}
interface PresentationSidecar {
  schemaVersion: 2;
  sourceId: string;
  sourceRevision: string;
  adapter: { id: string; version: number };
  profile: { id: string; version: number };
  presentation: GraphDocument['presentation'];
}
```

- **sidecar**：nodeの位置・形状・styleをsidecarに保存する。見た目だけのbatchはsidecarへ、意味の編集はadapterの`prepare`へ送る。両方を混ぜたbatchは、今と同じく原子性を保証できないので拒否する。sidecarは`stamp`に入り、古いpreviewのapplyを拒否する。sourceから消えたnodeのsidecarの値は今と同じく無視し、次にsidecarを書くときに落とす。
- **Sectionはsourceのadapterだけ**：`sections: true`は`presentationMode: 'source'`と組み合わせたときだけ認め、`sidecar`・`none`との組み合わせは`GraphBinding`の作成時に拒否する。Sectionの作成・削除は意味（Section）と見た目（範囲）を同時に変えるので、sidecarでは二つの保存先にまたがる。分散transactionを作らず、Sectionの範囲もsourceが一つのcommandで保存する。sidecarでSectionを扱う必要が出たら、範囲の既定値と孤立した値の扱いを決めてから別に設計する。
- **source**：adapterの`prepare`が見た目のintentも受けるか、理由付きで拒否する。
- **none**：見た目のintentを拒否する。表示はProfileの既定だけを使う。
- `sections: false`のadapterでは、Sectionのintentを`This source cannot represent Graph sections`の趣旨の理由で拒否し、正本と履歴を変えない。
- **Data投影**：位置は今と同じくDataの`graphView.positions`（`source`）。形状の個別指定とSectionはDataの正本に表す場所がないので拒否する。表示はData投影のProfile（`record`型）の既定形状を使う。表示だけの形状設定が必要になったら、Dataに書き戻さないHostのprops（private）として別に設計する。
- **参照Definition Adapter**：sidecarをschema 2にし、形状の個別指定を受ける。Sectionは架空Definitionに表す場所がないので`sections: false`にする。
- **Graph参照の描画**：保存版のSVG描画に同じ形状の幾何を使う。Sectionは範囲と名称を描き、折りたたみは扱わない。

## 9. 履歴・保存・公開表記

- 見た目の変更も既存のtransaction・Undo/Redo・versionの差分・hashで追う。History Compareは形状・style・Section範囲の変更を、位置の変更と同じく見た目の変更として示す。
- native JSONはschema 2だけを書き、読む。schema 1は理由付きで拒否する。PlaygroundのIndexedDBでは、そのrecordの読み込み失敗を隔離し（今の仕組み）、理由とrecordのエクスポートを示す。移行scriptは作らない（必要になったら一回限りのものを別に用意する）。
- READMEと変更の記録に「Structured GraphはPreview / Experimental（pre-1.0）で、予告なくschema/APIを変更することがある。更新前にエクスポートすること」を書く（Phase 1のPR）。

## 10. 実装と検証の段階

各PhaseはPRを分け、独立してレビューできるようにする。`docs/workflow`の工程（ストーリーと受入条件、画面、状態、試験の対応）への追記は、そのPhaseのPRで行う。CIは停止中のため、検証はローカルで行い、[検証報告テンプレート](../editor-verification-template.md)に沿って記録する。追加の性能測定は停止中（保守・運用状況）のため、性能は既存の試験の範囲で退行がないことだけを確かめる。

| Phase | 実装                                                                                                                                                                                                           | 検証                                                                                                                                                                                                                  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | schema 2（sectionsは空）とProfile 2、形状の幾何module、`set-node-shape`/`set-node-style`、Surfaceの描画とhit、Inspectorと作成UIの形状選択、Data投影・参照adapter・Graph参照描画・Playgroundの更新、Preview表記 | 7形状の外周点・port範囲・contentBox・hitのunit、schema 1の拒否、優先順位、readOnly・proposal・stale・Undo/Redo・hashのunit。desktop/mobileのE2Eで形状の変更と保存・再読込、edgeの終端の画像確認                       |
| 2     | Section型・検証・intent、描画・Inspector・移動・リサイズ・解除・折りたたみ、adapter・Data投影の拒否                                                                                                            | 循環・深さ・`contains`（省略・空・型の一覧）・所属の明示性（移動とリサイズで所属が変わらない）・readOnlyの子孫の保護、sidecarと`sections`の組み合わせの拒否、折りたたみでedgeが変わらないこと、Sectionを跨ぐedgeのE2E |
| 3     | 構成図テンプレート、形状パレット、Sectionを考慮した自動配置、Section単位のFit                                                                                                                                  | 構成図（Production / Frontend / Backend / API / Database / 外部Cloud）の実操作の記録                                                                                                                                  |

## 11. レビューで決めたこと

PR #398のレビュー（2026-10-23）で、次のとおり決めた。

| #   | 論点                                      | 決定                                             | 補足                                                                                 |
| --- | ----------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 1   | Sectionの名称                             | 意味属性（`ui.labelField`）                      | presentationのタイトルにはしない                                                     |
| 2   | schema 2にSectionの構造を最初から入れるか | 入れて、Phase 1では空に限定                      | Phase 2でschemaのversionを変えない                                                   |
| 3   | nodeごとの寸法を保存するか                | 今回は保存しない（Hostの`nodeSize`と自動の高さ） | nodeを個別にリサイズするUIを出す段階で、`presentation.nodes`への保存を改めて検討する |
| 4   | Section削除時の中身                       | 親へ繰り上げる                                   |                                                                                      |
| 5   | 個別styleの色                             | 保存はhex、UIは固定のパレットだけを出す          |                                                                                      |
