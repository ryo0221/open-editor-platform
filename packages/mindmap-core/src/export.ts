// Files written from a map: an SVG picture, a Markdown outline and the native JSON.
import { layoutMindmap, mindmapEdgePath, MINDMAP_BOX } from './layout';
import { MINDMAP_MARK_NAMES, validateMindmap, type MindmapContent } from './model';

const escapeXml = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export interface MindmapSvgOptions {
  /** Draw only this node and its descendants. */
  nodeId?: string;
  /** Folds for this picture; absent, the stored `collapsed` values apply. */
  folded?: ReadonlyMap<string, boolean>;
}

/** The map as a standalone SVG (the same layout as the editor). */
export function exportMindmapSvg(content: MindmapContent, options: MindmapSvgOptions = {}): string {
  validateMindmap(content);
  let source = content;
  if (options.nodeId !== undefined) {
    if (!Object.hasOwn(content.nodes, options.nodeId)) throw new Error('枝が見つかりません。');
    source = { ...content, rootId: options.nodeId };
  }
  const { boxes, width, height } = layoutMindmap(source, options.folded);
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const tree = content.layout === 'tree';
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="'Noto Sans JP', 'Hiragino Sans', sans-serif" font-size="14">`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
  ];
  for (const box of boxes)
    if (box.parentId)
      parts.push(
        `<path d="${mindmapEdgePath(byId.get(box.parentId)!, box, tree)}" fill="none" stroke="#a6b2c2" stroke-width="1.5"/>`,
      );
  for (const box of boxes) {
    const n = source.nodes[box.id];
    const root = box.id === source.rootId;
    parts.push(
      `<g data-node-id="${box.id}"><rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="8" fill="${root ? '#eef3fb' : '#ffffff'}" stroke="${escapeXml(n.color ?? '#5b6b80')}" stroke-width="${n.color ? 2.5 : 1.2}"/>`,
    );
    box.lines.forEach((line, i) =>
      parts.push(
        `<text x="${box.x + MINDMAP_BOX.padX}" y="${box.y + MINDMAP_BOX.padY + (i + 1) * MINDMAP_BOX.lineHeight - 5}" fill="#17202c"${root ? ' font-weight="700"' : ''}>${escapeXml(line)}</text>`,
      ),
    );
    if (n.marks?.length)
      parts.push(
        `<text x="${box.x + MINDMAP_BOX.padX}" y="${box.y + box.height - MINDMAP_BOX.padY - 4}" font-size="11" fill="#4a5668">${escapeXml(n.marks.map((m) => MINDMAP_MARK_NAMES[m]).join('・'))}</text>`,
      );
    if (box.folded)
      parts.push(
        `<circle cx="${box.side === -1 && !tree ? box.x : tree ? box.x + box.width / 2 : box.x + box.width}" cy="${tree ? box.y + box.height : box.y + box.height / 2}" r="7" fill="#5b6b80"/>`,
      );
    parts.push('</g>');
  }
  parts.push('</svg>');
  return parts.join('');
}

/**
 * The tree as a Markdown outline: the root as a heading, branches as nested list items, notes
 * as indented quote lines and marks in brackets. Folded branches are written in full.
 */
export function exportMindmapMarkdown(content: MindmapContent): string {
  validateMindmap(content);
  const root = content.nodes[content.rootId];
  const out: string[] = [`# ${escapeMarkdown(root.text || '（無題）')}`];
  if (root.note) out.push('', ...root.note.split('\n').map((l) => `> ${l}`));
  out.push('');
  (function walk(id: string, depth: number) {
    for (const childId of content.nodes[id].children) {
      const n = content.nodes[childId];
      const indent = '  '.repeat(depth);
      const marks = n.marks?.length
        ? ` [${n.marks.map((m) => MINDMAP_MARK_NAMES[m]).join('・')}]`
        : '';
      out.push(`${indent}- ${escapeMarkdown(n.text || '（無題）')}${marks}`);
      if (n.note) for (const line of n.note.split('\n')) out.push(`${indent}  > ${line}`);
      walk(childId, depth + 1);
    }
  })(content.rootId, 0);
  return `${out.join('\n').trimEnd()}\n`;
}

/** Escapes the characters that would start Markdown syntax inside one line. */
function escapeMarkdown(text: string): string {
  return text
    .replace(/([\\`*_[\]#|<>])/g, '\\$1')
    .replace(/^(\d+)\./, '$1\\.')
    .replace(/^([-+])(\s)/, '\\$1$2');
}

/** The native JSON, readable again as a map (and by the external editor 0.1.5). */
export function exportMindmapJson(content: MindmapContent): string {
  validateMindmap(content);
  return `${JSON.stringify(content, null, 2)}\n`;
}
