import { createContext, useContext } from 'react';
import { type GraphLocale } from './diagnostics';
import { type GraphNodeShape } from './model';

/**
 * Visible wording of the Surface's toolbar, Inspector and dialogs. `locale` picks a dictionary and
 * a Host may replace any entry with `labels`. Accessible names given by `aria-label` stay English
 * and stable; only visible text follows the locale.
 */
export interface GraphSurfaceLabels {
  sourceOwner: string;
  openSource: string;
  openDefinition: string;
  palette: string;
  paletteInto: (section: string) => string;
  paletteOther: string;
  nodeType: string;
  shape: string;
  addNode: string;
  sectionType: string;
  addSection: string;
  addSectionAroundNode: string;
  arrange: string;
  graphProperties: string;
  deleteSelection: string;
  resetView: string;
  fitGraph: string;
  typeDefault: string;
  typeDefaultShape: (shape: string) => string;
  shapes: Record<GraphNodeShape, string>;
  /** Fill palette names, keyed by colour value. */
  fills: Record<string, string>;
  kind: string;
  appearance: string;
  fill: string;
  outline: string;
  solid: string;
  dashed: string;
  shapeSummary: (shape: string) => string;
  shapeKeptByType: string;
  section: string;
  noSection: string;
  sectionMembers: (nodes: number, sections: number) => string;
  fitSection: string;
  parent: string;
  noParent: string;
  deleteSection: string;
  deleteSectionConfirm: (
    name: string,
    nodes: number,
    sections: number,
    destination: string | undefined,
  ) => string;
  deleteSectionApply: string;
  /** Shown when connections end at the Section itself (#594): they are deleted with it. */
  deleteSectionConnections: (connections: number) => string;
  cancelSectionDeletion: string;
  connectNodes: string;
  retargetConnection: string;
  relationType: string;
  chooseRelation: string;
  from: string;
  to: string;
  chooseNode: string;
  /** Option groups of the connection ends when the relation type may end at a Section (#594). */
  endNodes: string;
  endSections: string;
  connectionLabel: string;
  useSelectedConnection: string;
  cancelConnection: string;
  connectionStale: string;
  reloadConnection: string;
  addConnection: string;
  applyAttributes: string;
  cancelAttributes: string;
  undeclaredRetained: string;
  diagnostics: (count: number) => string;
  nodesAndConnections: string;
  graphSummary: string;
  retainedDeleted: string;
  discardRetained: string;
  noVisibleNodes: string;
  deleteNodeTitle: string;
  deleteNodeBody: (connections: number) => string;
  confirmDeletion: string;
  cancelDeletion: string;
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

const en: GraphSurfaceLabels = {
  sourceOwner: 'Owner',
  openSource: 'Open source data',
  openDefinition: 'Data definition',
  palette: 'Palette',
  paletteInto: (section) => `Adds inside “${section}”`,
  paletteOther: 'Other',
  nodeType: 'Node type',
  shape: 'Shape',
  addNode: 'Add node',
  sectionType: 'Section type',
  addSection: 'Add section',
  addSectionAroundNode: 'Add section around node',
  arrange: 'Arrange diagram',
  graphProperties: 'Graph properties',
  deleteSelection: 'Delete selection',
  resetView: 'Reset view',
  fitGraph: 'Fit graph',
  typeDefault: 'Type default',
  typeDefaultShape: (shape) => `Type default (${shape})`,
  shapes: {
    rectangle: 'Rectangle',
    'rounded-rectangle': 'Rounded rectangle',
    ellipse: 'Ellipse',
    diamond: 'Diamond',
    cylinder: 'Cylinder',
    hexagon: 'Hexagon',
    cloud: 'Cloud',
  },
  fills: {
    '#ffffff': 'White',
    '#e2e8f0': 'Grey',
    '#dbeafe': 'Blue',
    '#dcfce7': 'Green',
    '#fef3c7': 'Amber',
    '#fee2e2': 'Red',
    '#ede9fe': 'Violet',
    '#334155': 'Dark',
  },
  kind: 'Type',
  appearance: 'Appearance',
  fill: 'Fill',
  outline: 'Outline',
  solid: 'Solid',
  dashed: 'Dashed',
  shapeSummary: (shape) => `Shape: ${shape}`,
  shapeKeptByType: ' (this source keeps the type default)',
  section: 'Section',
  noSection: 'No section',
  sectionMembers: (nodes, sections) =>
    `${plural(nodes, 'node')} and ${plural(sections, 'section')} inside`,
  fitSection: 'Fit section',
  parent: 'Parent',
  noParent: 'No parent',
  deleteSection: 'Delete section',
  deleteSectionConfirm: (name, nodes, sections, destination) =>
    `Deleting “${name}” moves ${plural(nodes, 'node')} and ${plural(sections, 'section')} to ${destination ?? 'the top level'}. Nodes and connections stay.`,
  deleteSectionApply: 'Delete and move contents up',
  deleteSectionConnections: (connections) =>
    `${plural(connections, 'connection')} to this section will be deleted with it.`,
  cancelSectionDeletion: 'Cancel section deletion',
  connectNodes: 'Connect nodes',
  retargetConnection: 'Retarget connection',
  relationType: 'Relation type',
  chooseRelation: 'Choose relation',
  from: 'From',
  to: 'To',
  chooseNode: 'Choose node',
  endNodes: 'Nodes',
  endSections: 'Sections',
  connectionLabel: 'Connection label',
  useSelectedConnection: 'Use selected connection',
  cancelConnection: 'Cancel connection input',
  connectionStale: 'Connection input is stale. Reload current values.',
  reloadConnection: 'Reload connection',
  addConnection: 'Add connection',
  applyAttributes: 'Apply attributes',
  cancelAttributes: 'Cancel attributes',
  undeclaredRetained: 'Undeclared attributes are retained.',
  diagnostics: (count) => `Diagnostics (${count})`,
  nodesAndConnections: 'Nodes and connections',
  graphSummary: 'Graph summary',
  retainedDeleted: 'A deleted item has unapplied input',
  discardRetained: 'Discard deleted Graph input',
  noVisibleNodes: 'No visible nodes. Add a node or clear the view filter.',
  deleteNodeTitle: 'Delete node and related connections?',
  deleteNodeBody: (connections) =>
    `This atomically removes ${connections} connections. External sources may refuse protected references.`,
  confirmDeletion: 'Confirm deletion',
  cancelDeletion: 'Cancel deletion',
};

const ja: GraphSurfaceLabels = {
  sourceOwner: '所有元',
  openSource: '元データを開く',
  openDefinition: 'データ定義',
  palette: 'パレット',
  paletteInto: (section) => `「${section}」の中に追加します`,
  paletteOther: 'その他',
  nodeType: 'ノードの種類',
  shape: '形',
  addNode: 'ノードを追加',
  sectionType: 'まとまりの種類',
  addSection: 'まとまりを追加',
  addSectionAroundNode: 'ノードを囲むまとまりを追加',
  arrange: '図を並べ直す',
  graphProperties: 'グラフの設定',
  deleteSelection: '選択を削除',
  resetView: '表示を戻す',
  fitGraph: '全体を表示',
  typeDefault: '種類の既定',
  typeDefaultShape: (shape) => `種類の既定（${shape}）`,
  shapes: {
    rectangle: '四角形',
    'rounded-rectangle': '角丸四角形',
    ellipse: '楕円',
    diamond: 'ひし形',
    cylinder: '円柱',
    hexagon: '六角形',
    cloud: '雲',
  },
  fills: {
    '#ffffff': '白',
    '#e2e8f0': '灰',
    '#dbeafe': '青',
    '#dcfce7': '緑',
    '#fef3c7': '黄',
    '#fee2e2': '赤',
    '#ede9fe': '紫',
    '#334155': '濃色',
  },
  kind: '種類',
  appearance: '見た目',
  fill: '塗り',
  outline: '線',
  solid: '実線',
  dashed: '破線',
  shapeSummary: (shape) => `形: ${shape}`,
  shapeKeptByType: '（この元データでは種類の既定のままです）',
  section: 'まとまり',
  noSection: 'まとまりなし',
  sectionMembers: (nodes, sections) => `ノード ${nodes} 個・まとまり ${sections} 個を含みます`,
  fitSection: 'まとまりを表示',
  parent: '親',
  noParent: '親なし',
  deleteSection: 'まとまりを削除',
  deleteSectionConfirm: (name, nodes, sections, destination) =>
    `「${name}」を削除すると、ノード ${nodes} 個とまとまり ${sections} 個は${destination ? `「${destination}」` : '最上位'}へ移ります。ノードと接続は残ります。`,
  deleteSectionApply: '削除して中身を上へ移す',
  deleteSectionConnections: (connections) =>
    `このまとまりにつながる接続 ${connections} 本も一緒に削除されます。`,
  cancelSectionDeletion: 'まとまりの削除をやめる',
  connectNodes: 'ノードを接続',
  retargetConnection: '接続先を変更',
  relationType: '関係の種類',
  chooseRelation: '関係を選択',
  from: '接続元',
  to: '接続先',
  chooseNode: 'ノードを選択',
  endNodes: 'ノード',
  endSections: 'まとまり',
  connectionLabel: '接続の名前',
  useSelectedConnection: '選択中の接続を使う',
  cancelConnection: '接続の入力をやめる',
  connectionStale: '接続の入力が古くなっています。現在の値を読み込んでください。',
  reloadConnection: '接続を読み込み直す',
  addConnection: '接続を追加',
  applyAttributes: '属性を適用',
  cancelAttributes: '属性の入力をやめる',
  undeclaredRetained: '定義にない属性もそのまま保持されます。',
  diagnostics: (count) => `診断（${count}）`,
  nodesAndConnections: 'ノードと接続',
  graphSummary: 'グラフの概要',
  retainedDeleted: '削除された対象の未確定入力があります',
  discardRetained: '削除された対象の入力を破棄',
  noVisibleNodes:
    '表示するノードがありません。ノードを追加するか、表示の絞り込みを外してください。',
  deleteNodeTitle: 'ノードと関係する接続を削除しますか？',
  deleteNodeBody: (connections) =>
    `接続 ${connections} 本もまとめて削除します。外部の元データは保護された参照の削除を拒むことがあります。`,
  confirmDeletion: '削除する',
  cancelDeletion: '削除をやめる',
};

export const graphSurfaceLabels: Record<GraphLocale, GraphSurfaceLabels> = { ja, en };

export function resolveGraphSurfaceLabels(
  locale: GraphLocale,
  overrides?: Partial<GraphSurfaceLabels>,
): GraphSurfaceLabels {
  const base = graphSurfaceLabels[locale] ?? en;
  return overrides ? { ...base, ...overrides } : base;
}

/** English outside a Surface keeps standalone parts as they were. */
export const GraphLabelsContext = createContext<GraphSurfaceLabels>(en);
export const useGraphLabels = () => useContext(GraphLabelsContext);
