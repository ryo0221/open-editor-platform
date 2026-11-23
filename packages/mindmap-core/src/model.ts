// The Mind Map content: one ordered tree under a single root. No React and no Host code.
// The stored shape is the same as the external mindmap-editor 0.1.5 (artifactKind `mindmap`,
// schemaVersion 1), so files written by that Editor open here unchanged.

export const MINDMAP_ARTIFACT_KIND = 'mindmap' as const;
export const MINDMAP_SCHEMA_VERSION = 1 as const;

export const MINDMAP_LAYOUTS = ['radial', 'right', 'tree'] as const;
export type MindmapLayout = (typeof MINDMAP_LAYOUTS)[number];

export const MINDMAP_MARKS = [
  'question',
  'idea',
  'decision',
  'risk',
  'todo',
  'done',
  'star',
] as const;
export type MindmapMark = (typeof MINDMAP_MARKS)[number];

/** Limits checked on every stored value (code point lengths, as the proposal schema counts). */
export const MINDMAP_LIMITS = {
  nodes: 2000,
  children: 200,
  depth: 16,
  text: 200,
  note: 4000,
  marks: 4,
  linkPart: 128,
  bytes: 524288,
} as const;

export interface MindmapNode {
  id: string;
  text: string;
  /** Child ids in display order. */
  children: string[];
  /** Only on direct children of the root: the side of a radial map. */
  side?: 'left' | 'right';
  collapsed?: boolean;
  /** `#rgb` or `#rrggbb`. */
  color?: string;
  marks?: MindmapMark[];
  note?: string;
  /** A link to an item elsewhere (for example a workflow item id). */
  link?: { namespace: string; id: string };
}

export interface MindmapContent {
  artifactKind: typeof MINDMAP_ARTIFACT_KIND;
  schemaVersion: typeof MINDMAP_SCHEMA_VERSION;
  id: string;
  rootId: string;
  layout: MindmapLayout;
  nodes: Record<string, MindmapNode>;
}

/** A stored Mind Map that failed a check; `message` names the broken rule. */
export class MindmapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MindmapError';
  }
}

const fail = (message: string): never => {
  throw new MindmapError(message);
};
const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
function keys(
  v: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts v is Record<string, unknown> {
  if (
    !isObject(v) ||
    required.some((k) => !Object.hasOwn(v, k)) ||
    Reflect.ownKeys(v).some((k) => typeof k !== 'string' || ![...required, ...optional].includes(k))
  )
    fail('フィールドまたは型が不正');
}

/** Code point length (an emoji counts once). */
export const textLength = (s: string) => [...s].length;

/** UTF-8 byte count, without TextEncoder so validation runs anywhere. */
export function utf8Length(s: string): number {
  let n = 0;
  for (const c of s) {
    const p = c.codePointAt(0)!;
    n += p < 0x80 ? 1 : p < 0x800 ? 2 : p < 0x10000 ? 3 : 4;
  }
  return n;
}

function compareCodePoints(a: string, b: string): number {
  const x = [...a].map((c) => c.codePointAt(0)!),
    y = [...b].map((c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObject(v))
    return `{${Object.keys(v)
      .sort(compareCodePoints)
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

export const NODE_ID = /^n-[0-9a-f]{32}$/;
export const DOCUMENT_ID = /^d-[0-9a-f]{32}$/;
const COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Checks a whole stored Mind Map; throws a MindmapError naming the first broken rule. */
export function validateMindmap(value: unknown): asserts value is MindmapContent {
  keys(value, ['artifactKind', 'schemaVersion', 'id', 'rootId', 'layout', 'nodes']);
  if (
    value.artifactKind !== MINDMAP_ARTIFACT_KIND ||
    value.schemaVersion !== MINDMAP_SCHEMA_VERSION
  )
    fail('形式または版が不正');
  if (typeof value.id !== 'string' || !DOCUMENT_ID.test(value.id)) fail('文書IDが不正');
  if (!(MINDMAP_LAYOUTS as readonly unknown[]).includes(value.layout)) fail('配置が不正');
  if (!isObject(value.nodes)) fail('ノードが不正');
  const nodes = value.nodes as Record<string, unknown>,
    ids = Object.keys(nodes);
  if (ids.length < 1 || ids.length > MINDMAP_LIMITS.nodes) fail('ノード数の上限');
  if (typeof value.rootId !== 'string' || !Object.hasOwn(nodes, value.rootId))
    fail('根が存在しない');
  const rootId = value.rootId as string;
  const parents = new Map(ids.map((id) => [id, 0]));
  for (const id of ids) {
    const n = nodes[id];
    keys(n, ['id', 'text', 'children'], ['side', 'collapsed', 'color', 'marks', 'note', 'link']);
    if (!NODE_ID.test(id) || n.id !== id) fail('ノードIDが不正');
    if (
      typeof n.text !== 'string' ||
      textLength(n.text) > MINDMAP_LIMITS.text ||
      /[\r\n]/.test(n.text)
    )
      fail('本文が不正または上限超過');
    if (!Array.isArray(n.children) || n.children.length > MINDMAP_LIMITS.children)
      fail('子の数が不正または上限超過');
    for (const child of n.children as unknown[]) {
      if (typeof child !== 'string' || !parents.has(child)) fail('参照先が存在しない');
      parents.set(child as string, parents.get(child as string)! + 1);
    }
    if ('side' in n && n.side !== 'left' && n.side !== 'right') fail('左右が不正');
    if ('collapsed' in n && typeof n.collapsed !== 'boolean') fail('折りたたみが不正');
    if ('color' in n && (typeof n.color !== 'string' || !COLOR.test(n.color))) fail('色が不正');
    if (
      'marks' in n &&
      (!Array.isArray(n.marks) ||
        n.marks.length > MINDMAP_LIMITS.marks ||
        new Set(n.marks).size !== n.marks.length ||
        n.marks.some((m) => !(MINDMAP_MARKS as readonly unknown[]).includes(m)))
    )
      fail('印が不正');
    if ('note' in n && (typeof n.note !== 'string' || textLength(n.note) > MINDMAP_LIMITS.note))
      fail('メモが不正または上限超過');
    if ('link' in n) {
      keys(n.link, ['namespace', 'id']);
      for (const s of [n.link.namespace, n.link.id])
        if (typeof s !== 'string' || textLength(s) < 1 || textLength(s) > MINDMAP_LIMITS.linkPart)
          fail('参照が不正');
    }
  }
  const typed = nodes as unknown as Record<string, MindmapNode>;
  const active = new Set<string>(),
    done = new Set<string>();
  function visit(id: string, depth: number): void {
    if (active.has(id)) fail('循環を検出');
    if (depth > MINDMAP_LIMITS.depth) fail('深さの上限');
    if (done.has(id)) return;
    active.add(id);
    for (const child of typed[id].children) visit(child, depth + 1);
    active.delete(id);
    done.add(id);
  }
  visit(rootId, 0);
  for (const id of ids) if (!done.has(id)) visit(id, 0);
  if (parents.get(rootId) !== 0) fail('根に親がある');
  for (const id of ids) if (id !== rootId && parents.get(id) !== 1) fail('親は一つ必要');
  const reachable = new Set<string>();
  (function reach(id: string): void {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const c of typed[id].children) reach(c);
  })(rootId);
  if (reachable.size !== ids.length) fail('根から到達できない');
  for (const id of ids)
    if ('side' in typed[id] && !typed[rootId].children.includes(id)) fail('左右は根の直接の子のみ');
  if (utf8Length(canonical(value)) > MINDMAP_LIMITS.bytes) fail('ファイルの大きさの上限');
}

export function isMindmap(value: unknown): value is MindmapContent {
  try {
    validateMindmap(value);
    return true;
  } catch {
    return false;
  }
}

/** Why a value is not a Mind Map, or undefined when it is one. */
export function mindmapProblem(value: unknown): string | undefined {
  try {
    validateMindmap(value);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const hex32 = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) =>
    n.toString(16).padStart(2, '0'),
  ).join('');

/** A fresh node id in the stored form (`n-` and 32 hex digits). */
export const newMindmapNodeId = () => `n-${hex32()}`;

/** A new map holding only its central topic. */
export function createMindmap(topic = '中心のテーマ'): MindmapContent {
  const rootId = newMindmapNodeId();
  return {
    artifactKind: MINDMAP_ARTIFACT_KIND,
    schemaVersion: MINDMAP_SCHEMA_VERSION,
    id: `d-${hex32()}`,
    rootId,
    layout: 'radial',
    nodes: { [rootId]: { id: rootId, text: topic, children: [] } },
  };
}

/** The parent of a node, or undefined for the root and unknown ids. */
export function mindmapParent(content: MindmapContent, id: string): MindmapNode | undefined {
  if (id === content.rootId) return undefined;
  return Object.values(content.nodes).find((n) => n.children.includes(id));
}

/** A node and all of its descendants, in depth-first order. */
export function mindmapSubtree(content: MindmapContent, id: string): string[] {
  const out: string[] = [];
  (function walk(key: string) {
    const n = content.nodes[key];
    if (!n) return;
    out.push(key);
    n.children.forEach(walk);
  })(id);
  return out;
}

/** Japanese display names of the marks, in their stored order. */
export const MINDMAP_MARK_NAMES: Readonly<Record<MindmapMark, string>> = {
  question: '疑問',
  idea: 'アイデア',
  decision: '決定',
  risk: 'リスク',
  todo: 'やること',
  done: '済み',
  star: '重要',
};

/** The colour swatches offered in the editor; the first is no colour. */
export const MINDMAP_PALETTE: readonly (readonly [label: string, value: string])[] = [
  ['色なし', ''],
  ['赤', '#d64545'],
  ['橙', '#e8862a'],
  ['黄', '#d9b310'],
  ['緑', '#3a9d5d'],
  ['水色', '#2fa4c9'],
  ['青', '#3d6fc4'],
  ['紫', '#8a5cc2'],
  ['桃', '#d9669b'],
  ['灰', '#7a8594'],
];
