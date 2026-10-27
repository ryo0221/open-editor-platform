import { type GraphDiagnostic, type GraphDocument } from './model';
import { type GraphProfile } from './profile';
export type GraphLocale = 'ja' | 'en';
const messages: Record<string, [string, string]> = {
  required: [
    '値が未入力です。必須項目を入力してください。',
    'A value is required. Fill in this field.',
  ],
  type: [
    '値の型が定義と異なります。データ定義に合う値へ変更してください。',
    'The value has the wrong type. Use the declared field type.',
  ],
  length: [
    '文字数が上限を超えています。本文を短くしてください。',
    'Text is too long. Shorten this value.',
  ],
  range: [
    '数値が範囲外です。データ定義の範囲に修正してください。',
    'The number is outside the declared range. Adjust this value.',
  ],
  items: [
    '項目数が上限を超えています。項目を減らしてください。',
    'There are too many items. Remove an item.',
  ],
  self: [
    '自分自身への接続は禁止されています。別のノードを選択してください。',
    'Self connections are prohibited. Choose another node.',
  ],
  parallel: [
    '同じ種類の接続が既にあります。既存の接続を変更してください。',
    'Parallel connections are prohibited. Edit the existing connection.',
  ],
  cycle: [
    '循環する接続は禁止されています。循環しない接続先を選択してください。',
    'Cycles are prohibited. Choose a target outside this cycle.',
  ],
  degree: [
    '接続数が上限を超えています。既存の接続を解除してください。',
    'There are too many connections. Remove an existing connection.',
  ],
  'connection-type': [
    'この種類のノード同士は接続できません。データ定義で許可された種類を選択してください。',
    'These node types cannot be connected. Choose an allowed type.',
  ],
  'node-type': [
    'ノードの種類が未定義です。所有元のデータ定義を確認してください。',
    'The node type is unknown. Check its owner’s definition.',
  ],
  'section-type': [
    'まとまりの種類が未定義です。所有元のデータ定義を確認してください。',
    'The section type is unknown. Check its owner’s definition.',
  ],
  'section-contains': [
    'この種類はこのまとまりに入れられません。許可された種類のまとまりへ移してください。',
    'This type is not allowed in this section. Move it to a section that allows it.',
  ],
  'outside-section': [
    'ノードが所属するまとまりの範囲の外にあります。ノードを移すか範囲を広げてください。',
    'This node is drawn outside its section. Move the node or enlarge the section.',
  ],
  'edge-type': [
    '接続の種類が未定義です。所有元のデータ定義を確認してください。',
    'The connection type is unknown. Check its owner’s definition.',
  ],
};
export function graphElementLabel(graph: GraphDocument, profile: GraphProfile, id: string): string {
  const node = graph.nodes.find((node) => node.id === id);
  if (node)
    return String(
      node.attributes[profile.nodes[node.type]?.ui?.labelField ?? 'name'] ??
        profile.nodes[node.type]?.ui?.label ??
        id,
    );
  const section = graph.sections.find((section) => section.id === id);
  if (section) {
    const ui = profile.sections[section.type]?.ui,
      value = section.attributes[ui?.labelField ?? 'name'];
    return typeof value === 'string' && value.trim() ? value : (ui?.label ?? id);
  }
  const edge = graph.edges.find((edge) => edge.id === id);
  if (edge)
    return `${graphElementLabel(graph, profile, edge.from)} → ${graphElementLabel(graph, profile, edge.to)}`;
  return profile.graph.ui?.label ?? 'Graph';
}
export function formatGraphDiagnostic(
  diagnostic: GraphDiagnostic,
  graph: GraphDocument,
  profile: GraphProfile,
  locale: GraphLocale,
): string {
  const node = graph.nodes.find((node) => node.id === diagnostic.elementId);
  const edge = graph.edges.find((edge) => edge.id === diagnostic.elementId);
  const section = graph.sections.find((section) => section.id === diagnostic.elementId);
  const type = node
    ? profile.nodes[node.type]
    : edge
      ? profile.edges[edge.type]
      : section
        ? profile.sections[section.type]
        : profile.graph;
  const field =
    diagnostic.path[0] &&
    (type?.ui?.fields?.[diagnostic.path[0]]?.label ?? diagnostic.path.join('.'));
  const message = messages[diagnostic.code]?.[locale === 'ja' ? 0 : 1] ?? diagnostic.message;
  return `${graphElementLabel(graph, profile, diagnostic.elementId)}${field ? ` / ${field}` : ''}: ${message}`;
}
