// Mind Map commands. Each one checks the content before and after, never mutates its input and
// refuses a change that leaves the content as it was. People and proposals use the same commands.
import { immutableCommand, type EditorCommand } from '@editor-platform/editor-core';
import {
  MindmapError,
  validateMindmap,
  type MindmapContent,
  type MindmapLayout,
  type MindmapMark,
  type MindmapNode,
} from './model';

type Change = (content: MindmapContent) => void;

function edit(type: string, label: string, change: Change): EditorCommand<MindmapContent> {
  return immutableCommand<MindmapContent>(type, label, (current) => {
    validateMindmap(current);
    const next = structuredClone(current);
    change(next);
    validateMindmap(next);
    if (JSON.stringify(next) === JSON.stringify(current))
      throw new MindmapError('変更がありません。');
    return next;
  });
}
function node(content: MindmapContent, id: string): MindmapNode {
  if (!Object.hasOwn(content.nodes, id)) throw new MindmapError('枝が見つかりません。');
  return content.nodes[id];
}
function parent(content: MindmapContent, id: string): MindmapNode {
  node(content, id);
  if (id === content.rootId) throw new MindmapError('根には親がありません。');
  const result = Object.values(content.nodes).find((n) => n.children.includes(id));
  if (!result) throw new MindmapError('親が見つかりません。');
  return result;
}
function position(index: number, max: number): void {
  if (!Number.isInteger(index) || index < 0 || index > max)
    throw new MindmapError('位置が不正です。');
}

export function addMindmapNode(
  parentId: string,
  index: number,
  newId: string,
  text: string,
  side?: 'left' | 'right',
): EditorCommand<MindmapContent> {
  return edit('mindmap.add', '枝を足す', (c) => {
    const p = node(c, parentId);
    position(index, p.children.length);
    if (Object.hasOwn(c.nodes, newId)) throw new MindmapError('IDは既に使われています。');
    if (side !== undefined && parentId !== c.rootId)
      throw new MindmapError('左右は根の直接の子だけに指定できます。');
    c.nodes[newId] = { id: newId, text, children: [], ...(side === undefined ? {} : { side }) };
    p.children.splice(index, 0, newId);
  });
}

export function renameMindmapNode(id: string, text: string): EditorCommand<MindmapContent> {
  return edit('mindmap.rename', '名前を変える', (c) => {
    node(c, id).text = text;
  });
}

export function reorderMindmapNode(id: string, index: number): EditorCommand<MindmapContent> {
  return edit('mindmap.reorder', '枝を並べ替える', (c) => {
    const siblings = parent(c, id).children;
    position(index, siblings.length - 1);
    siblings.splice(siblings.indexOf(id), 1);
    siblings.splice(index, 0, id);
  });
}

export function moveMindmapNode(
  id: string,
  parentId: string,
  index: number,
  side?: 'left' | 'right',
): EditorCommand<MindmapContent> {
  return edit('mindmap.move', '枝を移す', (c) => {
    const old = parent(c, id),
      target = node(c, parentId),
      moving = node(c, id);
    const inside = new Set<string>();
    (function collect(key: string): void {
      inside.add(key);
      for (const child of node(c, key).children) collect(child);
    })(id);
    if (inside.has(parentId)) throw new MindmapError('自分や子孫へ移せません。');
    old.children.splice(old.children.indexOf(id), 1);
    position(index, target.children.length);
    if (parentId === c.rootId) {
      if (side !== 'left' && side !== 'right') throw new MindmapError('左右を指定してください。');
      moving.side = side;
    } else {
      if (side !== undefined) throw new MindmapError('左右を指定できません。');
      delete moving.side;
    }
    target.children.splice(index, 0, id);
  });
}

export function deleteMindmapNode(id: string): EditorCommand<MindmapContent> {
  return edit('mindmap.delete', '枝を消す', (c) => {
    const p = parent(c, id);
    p.children.splice(p.children.indexOf(id), 1);
    (function remove(key: string): void {
      for (const child of node(c, key).children) remove(child);
      delete c.nodes[key];
    })(id);
  });
}

export function collapseMindmapNode(id: string, collapsed: boolean): EditorCommand<MindmapContent> {
  return edit('mindmap.collapse', '枝を畳む・開く', (c) => {
    const n = node(c, id);
    if (typeof collapsed !== 'boolean' || (collapsed && !n.children.length))
      throw new MindmapError('折りたたみを変更できません。');
    if ((n.collapsed ?? false) === collapsed) throw new MindmapError('変更がありません。');
    n.collapsed = collapsed;
  });
}

export function colorMindmapNode(id: string, color?: string): EditorCommand<MindmapContent> {
  return edit('mindmap.color', '色を変える', (c) => {
    const n = node(c, id);
    if (color === undefined) delete n.color;
    else n.color = color;
  });
}

export function markMindmapNode(id: string, marks?: MindmapMark[]): EditorCommand<MindmapContent> {
  const copy = marks === undefined ? undefined : [...marks];
  return edit('mindmap.marks', '印を変える', (c) => {
    const n = node(c, id);
    if (copy === undefined) delete n.marks;
    else n.marks = [...copy];
  });
}

export function noteMindmapNode(id: string, note?: string): EditorCommand<MindmapContent> {
  return edit('mindmap.note', 'メモを変える', (c) => {
    const n = node(c, id);
    if (note === undefined) delete n.note;
    else n.note = note;
  });
}

/** A node's link to an element elsewhere (for example `owd:<definition id>` / `phase:concept`). */
export interface MindmapLink {
  namespace: string;
  id: string;
}
/**
 * Sets, replaces or removes (`null`) a node's link, the root's too; one Undo step. Each part is 1
 * to {@link MINDMAP_LIMITS.linkPart} characters, as the content validation requires.
 */
export function setMindmapNodeLink(
  id: string,
  link: MindmapLink | null,
): EditorCommand<MindmapContent> {
  if (
    link !== null &&
    (!link ||
      typeof link !== 'object' ||
      Object.keys(link).some((k) => k !== 'namespace' && k !== 'id') ||
      typeof link.namespace !== 'string' ||
      typeof link.id !== 'string')
  )
    throw new MindmapError('つながりが不正です。');
  const copy = link && { namespace: link.namespace, id: link.id };
  return edit('mindmap.link', copy ? 'つながりを付ける' : 'つながりを外す', (c) => {
    const n = node(c, id);
    if (copy) n.link = { ...copy };
    else {
      if (!n.link) throw new MindmapError('つながりはありません。');
      delete n.link;
    }
  });
}

export function setMindmapLayout(layout: MindmapLayout): EditorCommand<MindmapContent> {
  return edit('mindmap.layout', '配置を切り替える', (c) => {
    c.layout = layout;
  });
}

/** The fields of one node edited together; one Undo step. */
export interface MindmapNodeFields {
  text?: string;
  /** `''` removes the colour. */
  color?: string;
  /** An empty list removes the marks. */
  marks?: MindmapMark[];
  /** `''` removes the note. */
  note?: string;
}

/**
 * Applies the changed fields of one node as one command, refused when the node no longer equals
 * `before` (another edit changed or removed it while the fields were being edited).
 */
export function editMindmapNodeFields(
  id: string,
  before: MindmapNode,
  fields: MindmapNodeFields,
): EditorCommand<MindmapContent> {
  const expected = JSON.stringify(before);
  const text = fields.text !== undefined && fields.text !== before.text;
  const color = fields.color !== undefined && fields.color !== (before.color ?? '');
  const marks =
    fields.marks !== undefined &&
    JSON.stringify(fields.marks) !== JSON.stringify(before.marks ?? []);
  const note = fields.note !== undefined && fields.note !== (before.note ?? '');
  const next = structuredClone(fields);
  const markList = next.marks ?? [];
  // All fields change on one private copy and the combined result is validated once, so a
  // valid edit is not refused for an intermediate state (e.g. near the size limit).
  const change = edit('mindmap.fields', '枝の情報を編集', (c) => {
    const n = node(c, id);
    if (text) n.text = next.text!;
    if (color) {
      if (next.color) n.color = next.color;
      else delete n.color;
    }
    if (marks) {
      if (markList.length) n.marks = [...markList];
      else delete n.marks;
    }
    if (note) {
      if (next.note) n.note = next.note;
      else delete n.note;
    }
  });
  return immutableCommand<MindmapContent>('mindmap.fields', '枝の情報を編集', (current) => {
    if (!(text || color || marks || note)) throw new MindmapError('変更がありません。');
    if (!current.nodes[id] || JSON.stringify(current.nodes[id]) !== expected)
      throw new MindmapError('編集中にこの枝が変更されました。');
    return change.apply(current);
  });
}
