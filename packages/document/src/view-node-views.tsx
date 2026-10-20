import { createRoot, type Root } from 'react-dom/client';
import { type Node as ProseMirrorNode } from 'prosemirror-model';
import { type EditorView, type NodeView } from 'prosemirror-view';
import { Embedded } from './view-parts';
import { type DocumentCallbacks } from './view-model';

export interface DocumentNodeViewContext {
  callbacks: { current: DocumentCallbacks };
  embeddedViews: { current: Set<() => void> };
  roots: Set<Root>;
}

export function embeddedNodeView(node: ProseMirrorNode, ctx: DocumentNodeViewContext): NodeView {
  const dom = document.createElement('div');
  dom.className = 'ep-embedded';
  dom.contentEditable = 'false';
  dom.dataset.blockId = node.attrs.id;
  const root = createRoot(dom);
  ctx.roots.add(root);
  const render = () =>
    root.render(
      <Embedded block={node.attrs.block} references={ctx.callbacks.current.references} />,
    );
  ctx.embeddedViews.current.add(render);
  render();
  return {
    dom,
    update(next) {
      if (next.type !== node.type) return false;
      node = next;
      dom.dataset.blockId = node.attrs.id;
      render();
      return true;
    },
    destroy() {
      ctx.embeddedViews.current.delete(render);
      ctx.roots.delete(root);
      queueMicrotask(() => root.unmount());
    },
    stopEvent: (e) =>
      e.target instanceof Element && !!e.target.closest('input,textarea,button,iframe'),
  } satisfies NodeView;
}

export function listItemNodeView(
  node: ProseMirrorNode,
  editor: EditorView,
  getPos: () => number | undefined,
  callbacks: { current: DocumentCallbacks },
): NodeView {
  const dom = document.createElement('li'),
    body = document.createElement('div'),
    check = document.createElement('input');
  body.className = 'ep-list-body';
  check.type = 'checkbox';
  check.contentEditable = 'false';
  check.setAttribute('aria-label', 'Complete checklist item');
  check.onchange = () => {
    const pos = getPos();
    if (pos !== undefined && !callbacks.current.readOnly)
      editor.dispatch(
        editor.state.tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          checked: check.checked,
        }),
      );
  };
  dom.append(check, body);
  const update = () => {
    check.hidden = node.attrs.checked === null;
    check.checked = !!node.attrs.checked;
    check.disabled = callbacks.current.readOnly;
    dom.dataset.checked = node.attrs.checked === null ? '' : String(node.attrs.checked);
  };
  update();
  return {
    dom,
    contentDOM: body,
    update(next) {
      if (next.type !== node.type) return false;
      node = next;
      update();
      return true;
    },
    stopEvent: (e) => e.target === check,
  } satisfies NodeView;
}
