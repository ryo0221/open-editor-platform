import { expect, it } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import { createReferenceDocument } from '../../../apps/react-ui-reference/src/catalog';
import {
  applyReactUiEdits,
  duplicateReactUiCommand,
  makeReactUiNode,
  reactUiCommand,
  reactUiInsertionProblem,
  sealReactComponent,
} from './index';
it('required-slot Library recovery leaves complete atomic parent/child insertion available', () => {
  const d = clone(createReferenceDocument());
  const old = d.components.find((c) => c.name === 'Card')!;
  const { contractHash: _hash, ...ref } = old.ref;
  const c = sealReactComponent({
    ...old,
    ref,
    slots: { ...old.slots, body: { ...old.slots.body, minimum: 1 } },
  });
  d.components = d.components.map((r) => (r === old ? c : r));
  d.nodes.find((n) => n.id === 'card')!.component = c.ref;
  expect(reactUiInsertionProblem(c)).toMatch(/Card requires body.*Import composition JSON/);
  const parent = makeReactUiNode(c),
    child = makeReactUiNode(d.components.find((c) => c.name === 'Button')!);
  const insert = { type: 'insert' as const, node: parent, parent: null, beforeId: null };
  expect(() => applyReactUiEdits(d, [insert])).toThrow(/cardinality/);
  const next = applyReactUiEdits(d, [
    insert,
    { type: 'insert', node: child, parent: { nodeId: parent.id, slotId: 'body' }, beforeId: null },
  ]);
  expect(next.nodes.find((n) => n.id === parent.id)!.slots.body).toEqual([child.id]);
  expect(d.roots).toEqual(['card']);
});
it('reorders children atomically and rejects cycles, unknown slots and invalid props without mutating the draft', () => {
  const original = createReferenceDocument();
  const next = applyReactUiEdits(original, [
    { type: 'move', nodeId: 'buy', parent: { nodeId: 'card', slotId: 'body' }, beforeId: 'image' },
  ]);
  expect(next.nodes[0].slots.body).toEqual(['buy', 'image', 'title']);
  expect(original.nodes[0].slots.body).toEqual(['image', 'title', 'buy']);
  expect(() =>
    applyReactUiEdits(original, [
      { type: 'move', nodeId: 'card', parent: { nodeId: 'card', slotId: 'body' }, beforeId: null },
    ]),
  ).toThrow();
  expect(() =>
    applyReactUiEdits(original, [
      {
        type: 'move',
        nodeId: 'buy',
        parent: { nodeId: 'card', slotId: 'missing' },
        beforeId: null,
      },
    ]),
  ).toThrow();
  expect(() =>
    reactUiCommand([{ type: 'set-prop', nodeId: 'buy', prop: 'variant', value: 'bad' }]).apply(
      original,
    ),
  ).toThrow();
});
it('duplicates nested nodes with new stable IDs, preserving bindings, and deletes complete subtrees', () => {
  const original = createReferenceDocument('form');
  const copy = duplicateReactUiCommand(original, 'card').apply(original);
  expect(copy.roots).toHaveLength(2);
  expect(new Set(copy.nodes.map((n) => n.id)).size).toBe(copy.nodes.length);
  expect(copy.nodes.filter((n) => n.bindings.onChange)).toHaveLength(2);
  const deleted = applyReactUiEdits(copy, [{ type: 'delete', nodeId: copy.roots[1] }]);
  expect(deleted).toEqual(original);
});
it('samples initialize inserted nodes, while optional defaults reset without changing registrations', () => {
  const original = createReferenceDocument();
  const node = makeReactUiNode(original.components.find((c) => c.name === 'Button')!);
  const inserted = applyReactUiEdits(original, [
    { type: 'insert', node, parent: { nodeId: 'card', slotId: 'footer' }, beforeId: null },
    { type: 'reset-prop', nodeId: node.id, prop: 'variant' },
  ]);
  expect(inserted.nodes.at(-1)!.props).toEqual({ label: 'Continue' });
  expect(inserted.components).toEqual(original.components);
});
