import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { contentToNode, documentPlugins, documentSchema } from './engine';

describe('Document mark key bindings', () => {
  for (const [mark, key, shiftKey] of [
    ['bold', 'b', false],
    ['italic', 'i', false],
    ['underline', 'u', false],
    ['strike', 'x', true],
    ['code', '`', false],
  ] as const)
    for (const collapsed of [true, false])
      for (const editable of [false, true])
        it(`${mark}, ${collapsed ? 'caret' : 'range'}, ${editable ? 'editable' : 'read-only'}`, () => {
          const plugins = documentPlugins();
          let state = EditorState.create({
            doc: contentToNode({
              schemaVersion: 2,
              blocks: [{ id: 'p', type: 'paragraph', text: 'plain' }],
            }),
            plugins,
          });
          state = state.apply(
            state.tr.setSelection(TextSelection.create(state.doc, 1, collapsed ? 1 : 6)),
          );
          const original = state;
          let dispatched = 0;
          const view = {
            get state() {
              return state;
            },
            editable,
            dispatch(tr: Transaction) {
              dispatched++;
              state = state.apply(tr);
            },
          } as unknown as EditorView;
          const event = {
            key,
            ctrlKey: true,
            shiftKey,
            metaKey: false,
            altKey: false,
          } as KeyboardEvent;
          // Hosts can invoke a plugin key handler directly, bypassing DOM's editable gate.
          for (const plugin of plugins)
            if (plugin.props.handleKeyDown?.call(plugin, view, event)) break;
          expect(dispatched).toBe(editable ? 1 : 0);
          if (!editable) expect(state).toBe(original);
          else if (collapsed)
            expect(state.storedMarks).toContainEqual(documentSchema.marks[mark].create());
          else expect(state.doc.rangeHasMark(1, 6, documentSchema.marks[mark])).toBe(true);
        });
});
