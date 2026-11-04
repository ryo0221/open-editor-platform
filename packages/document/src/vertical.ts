import type { Node as PMNode } from 'prosemirror-model';
import { Decoration } from 'prosemirror-view';
import { uprightDigitRanges } from './model';

export { uprightDigitRanges };

const cache = new WeakMap<PMNode, Decoration[]>();
/** View-only decorations; the text, positions and addresses stay those of horizontal text.
 * Runs are found over the whole text block, so formatting never redefines a number; a run split
 * across formatting runs stays in the text direction, as one upright group cannot span them. */
export function uprightDigitDecorations(doc: PMNode): Decoration[] {
  let found = cache.get(doc);
  if (found) return found;
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // One character per position: a leaf such as a line break counts as one non-digit.
    const text = node.textBetween(0, node.content.size, '', '\n');
    for (const [start, end] of uprightDigitRanges(text)) {
      const from = node.childBefore(start + 1);
      if (from.node?.isText && from.offset + from.node.nodeSize >= end)
        decorations.push(Decoration.inline(pos + 1 + start, pos + 1 + end, { class: 'ep-tcy' }));
    }
    return false;
  });
  found = decorations;
  cache.set(doc, found);
  return found;
}
