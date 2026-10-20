import { beforeAll, expect, it } from 'vitest';
import { clone, deepFreeze } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import { reactUiContractFixture } from '../../../tests/fixtures/react-ui/contracts';
import {
  loadReactUiDocument,
  inspectReactUiDocument,
  prepareReactUiExport,
  applyReactUiEdits,
  reactUiCommand,
  sealReactEnvironment,
  ReactUiError,
  type ReactUiDocument,
  type ReactRuntimeResolution,
  parseReactUiDocument,
  reactUiLimits,
} from './index';

let base: ReactUiDocument, resolution: ReactRuntimeResolution;
beforeAll(async () => {
  ({ document: base, resolution } = await reactUiContractFixture());
});
const button = (document: ReactUiDocument) => document.nodes.find((node) => node.id === 'buy')!;

it('reuses only an owned immutable document and isolates its original input', () => {
  const input = clone(base),
    owned = loadReactUiDocument(input);
  expect(loadReactUiDocument(owned)).toBe(owned);
  button(input).props.label = 'Caller changed';
  expect(button(owned).props.label).toBe('購入する');
  expect(button(loadReactUiDocument(input)).props.label).toBe('Caller changed');
  expect(() => {
    button(owned).props.label = 'Cannot change';
  }).toThrow();
});
it('keeps the complete native clone boundary for an unknown public input', () => {
  for (const frozen of [false, true]) {
    const input = new Proxy(clone(base), {});
    if (frozen) deepFreeze(input);
    expect(() => loadReactUiDocument(input)).toThrow();
  }
});
it('keeps exact ASCII and non-ASCII UTF-8 byte limits on private JSON admission', () => {
  for (const source of [
    'x'.repeat(reactUiLimits.bytes + 1),
    JSON.stringify('あ'.repeat(Math.floor(reactUiLimits.bytes / 3) + 1)),
  ]) {
    expect(() => parseReactUiDocument(source)).toThrow(/Native JSON exceeds byte budget/);
  }
});
it('clones unknown arrays before schema traversal can call an inherited method', () => {
  let reads = 0;
  class HookArray<T> extends Array<T> {
    override forEach(): void {
      reads++;
      throw Error('Executable traversal');
    }
  }
  const input = clone(base);
  input.nodes = new HookArray(...input.nodes);
  expect(inspectReactUiDocument(input).diagnostics).toEqual([]);
  expect(reads).toBe(0);
});
it('rechecks mutable and shallow-frozen inputs after a successful inspection', () => {
  for (const shallow of [false, true]) {
    const input = clone(base);
    if (shallow) Object.freeze(input);
    expect(inspectReactUiDocument(input).diagnostics).toEqual([]);
    button(input).props.label = 42;
    expect(inspectReactUiDocument(input).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'prop-type' })]),
    );
  }
});
it('does not trust externally deep-frozen data with a forged registration hash', () => {
  const input = clone(base);
  input.components[1].sampleProps.label = 'Changed without a new immutable pin';
  deepFreeze(input);
  expect(inspectReactUiDocument(input).diagnostics).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'registration-hash' })]),
  );
});
it('clones frozen array subclasses before later domain traversal can invoke inherited hooks', () => {
  let reads = 0;
  class HookArray extends Array<string> {
    override [Symbol.iterator](): ArrayIterator<string> {
      reads++;
      throw Error('Executable iteration');
    }
  }
  const input = clone(base);
  input.nodes[0].slots.body = new HookArray(...input.nodes[0].slots.body);
  deepFreeze(input);
  const owned = loadReactUiDocument(input);
  expect(Object.getPrototypeOf(owned.nodes[0].slots.body)).toBe(Array.prototype);
  expect(inspectReactUiDocument(owned).diagnostics).toEqual([]);
  expect(reads).toBe(0);
});
it('rejects newly added accessors before reading them after an earlier valid load', () => {
  const input = clone(base);
  let reads = 0;
  loadReactUiDocument(input);
  Object.defineProperty(button(input).props, 'label', {
    enumerable: true,
    get() {
      reads++;
      return 'Hidden execution';
    },
  });
  expect(() => loadReactUiDocument(input)).toThrow(ReactUiError);
  expect(reads).toBe(0);
});
it('retains semantic errors when callers change or clear returned diagnostics', () => {
  const input = clone(base);
  delete button(input).props.label;
  const owned = loadReactUiDocument(input),
    first = inspectReactUiDocument(owned);
  expect(first.diagnostics.some((value) => value.code === 'prop-required')).toBe(true);
  first.diagnostics[0].code = 'forged';
  first.diagnostics.length = 0;
  expect(
    inspectReactUiDocument(owned).diagnostics.some((value) => value.code === 'prop-required'),
  ).toBe(true);
  expect(() => prepareReactUiExport(owned, resolution)).toThrow(ReactUiError);
});
it('rechecks Host runtime and dependencies even when document inspection/fingerprint were cached', () => {
  const owned = loadReactUiDocument(base),
    current = clone(resolution);
  const fingerprint = prepareReactUiExport(owned, current).fingerprint;
  current.dependencies.pop();
  expect(() => prepareReactUiExport(owned, current)).toThrow(ReactUiError);
  const forged = clone(resolution);
  forged.components[0].implementationHash = '0'.repeat(64);
  expect(() => prepareReactUiExport(owned, forged)).toThrow(ReactUiError);
  expect(prepareReactUiExport(owned, resolution).fingerprint).toBe(fingerprint);
});
it('does not discount repeated owned subtrees from the JSON value budget', () => {
  const owned = loadReactUiDocument(base),
    input = { ...clone(base), nodes: Array(4000).fill(owned.nodes[0]) };
  expect(inspectReactUiDocument(input).diagnostics).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'data-limit' })]),
  );
});
it('rejects newly introduced non-finite data after an earlier valid inspection', () => {
  const input = clone(base);
  expect(inspectReactUiDocument(input).diagnostics).toEqual([]);
  button(input).props.label = Number.NaN;
  expect(() => loadReactUiDocument(input)).toThrow(ReactUiError);
});

it('keeps edited nodes and retained metadata isolated from a mutable caller', () => {
  const input = clone(base);
  const next = applyReactUiEdits(input, [
    { type: 'set-prop', nodeId: 'buy', prop: 'label', value: 'Edited' },
  ]);
  expect(button(input).props.label).toBe('購入する');
  input.environment.dependencies.length = 0;
  input.components[0].requires.length = 0;
  expect(inspectReactUiDocument(next).diagnostics).toEqual([]);
  expect(button(next).props.label).toBe('Edited');
  expect(() => {
    next.environment.dependencies.length = 0;
  }).toThrow();
});

it.each(['contractHash', 'implementationHash'] as const)(
  'rejects an incorrect %s with matching identity and a certified catalog',
  (pin) => {
    const owned = loadReactUiDocument(base);
    prepareReactUiExport(owned, resolution);
    const changed = { ...owned, nodes: clone(owned.nodes) };
    button(changed).component[pin] = 'f'.repeat(64);
    expect(inspectReactUiDocument(changed).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'component-mismatch' })]),
    );
    expect(() => prepareReactUiExport(changed, resolution)).toThrow(ReactUiError);
  },
);

it('leaves the session and history unchanged when a later edit in a batch fails', () => {
  const original = loadReactUiDocument(base),
    session = new EditorSession(original);
  expect(() =>
    session.executeView(
      reactUiCommand([
        { type: 'set-prop', nodeId: 'buy', prop: 'label', value: 'First edit' },
        { type: 'set-prop', nodeId: 'buy', prop: 'variant', value: 'unsupported' },
      ]),
    ),
  ).toThrow(ReactUiError);
  expect(session.content).toEqual(original);
  expect(session.canUndo).toBe(false);
});
it('keeps earlier changes when the same node and parent are written repeatedly', () => {
  const original = loadReactUiDocument(base);
  const next = applyReactUiEdits(original, [
    { type: 'set-prop', nodeId: 'buy', prop: 'label', value: 'Changed' },
    { type: 'set-prop', nodeId: 'buy', prop: 'variant', value: 'secondary' },
    { type: 'move', nodeId: 'buy', parent: { nodeId: 'card', slotId: 'body' }, beforeId: 'image' },
    { type: 'move', nodeId: 'title', parent: { nodeId: 'card', slotId: 'body' }, beforeId: 'buy' },
  ]);
  expect(button(next).props).toEqual({ label: 'Changed', variant: 'secondary' });
  expect(next.nodes[0].slots.body).toEqual(['title', 'buy', 'image', 'input']);
  expect(button(original).props.label).toBe('購入する');
  expect(original.nodes[0].slots.body).toEqual(['image', 'title', 'input', 'buy']);
});

it('rechecks retained nodes against a changed environment instead of reusing old semantic success', () => {
  const owned = loadReactUiDocument(base);
  expect(inspectReactUiDocument(owned).diagnostics).toEqual([]);
  const { hash: _hash, ...ref } = owned.environment.ref;
  const environment = sealReactEnvironment({
    ...owned.environment,
    ref: { ...ref, version: '2.0.0' },
    dependencies: owned.environment.dependencies.filter(
      (dependency) => dependency.kind !== 'asset',
    ),
  });
  const changed = { ...owned, environment };
  expect(
    inspectReactUiDocument(changed).diagnostics.some((value) => value.code === 'asset-missing'),
  ).toBe(true);
  expect(() => prepareReactUiExport(changed, resolution)).toThrow(ReactUiError);
});

it('owns inserted mutable data while retaining unchanged immutable nodes', () => {
  const original = loadReactUiDocument(base),
    inserted = clone(button(original));
  inserted.id = 'inserted';
  const next = applyReactUiEdits(original, [
    { type: 'insert', node: inserted, parent: null, beforeId: null },
  ]);
  inserted.props.label = 'Caller edit';
  inserted.id = 'changed-after-insert';
  expect(next.nodes.find((node) => node.id === 'inserted')!.props.label).toBe('購入する');
  expect(next.nodes[0]).toBe(original.nodes[0]);
  expect(() => {
    next.nodes.at(-1)!.props.label = 'Mutate retained history';
  }).toThrow();
});

it('rechecks global ownership when an inserted subtree refers to a retained root', () => {
  const original = loadReactUiDocument(base),
    inserted = clone(original.nodes[0]);
  inserted.id = 'second-card';
  inserted.slots = { body: [original.roots[0]], footer: [] };
  const session = new EditorSession(original);
  expect(() =>
    session.executeView(
      reactUiCommand([{ type: 'insert', node: inserted, parent: null, beforeId: null }]),
    ),
  ).toThrow(ReactUiError);
  expect(session.content).toEqual(original);
  expect(session.canUndo).toBe(false);
});
