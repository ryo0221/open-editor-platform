import { DOMSerializer, type Node as PMNode } from 'prosemirror-model';
import type { NodeView } from 'prosemirror-view';

/** Keep the native composing DOM when an independent paragraph style changes.
 * The schema still owns serialization, and ProseMirror still owns all inline content. */
export function textBlockView(node: PMNode): NodeView {
  const render = (value: PMNode) =>
    DOMSerializer.renderSpec(document, value.type.spec.toDOM!(value)).dom as HTMLElement;
  const dom = render(node);
  let owned = new Set(dom.getAttributeNames());
  return {
    dom,
    contentDOM: dom,
    update(next) {
      if (next.type !== node.type) return false;
      const template = render(next);
      if (template.tagName !== dom.tagName) return false;
      const names = new Set(template.getAttributeNames());
      for (const name of owned) if (!names.has(name)) dom.removeAttribute(name);
      for (const name of names) {
        const value = template.getAttribute(name)!;
        if (dom.getAttribute(name) !== value) dom.setAttribute(name, value);
      }
      owned = names;
      node = next;
      return true;
    },
  };
}
