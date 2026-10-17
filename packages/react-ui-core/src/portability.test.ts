import { expect, it, vi } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import {
  createReferenceDocument,
  referenceResolution,
} from '../../../apps/react-ui-reference/src/catalog';
import { exportReactUi, parseReactUiDocument, serializeReactUiDocument } from './index';

it('first native save/reload preserves every export byte regardless of map insertion order', () => {
  const doc = clone(createReferenceDocument('form'));
  doc.inputs = Object.fromEntries(Object.entries(doc.inputs).reverse());
  doc.callbacks = Object.fromEntries(Object.entries(doc.callbacks).reverse());
  for (const node of doc.nodes) {
    node.slots = Object.fromEntries(Object.entries(node.slots).reverse());
    node.bindings = Object.fromEntries(Object.entries(node.bindings).reverse());
  }
  const before = exportReactUi(doc, referenceResolution);
  const saved = serializeReactUiDocument(doc);
  const after = exportReactUi(parseReactUiDocument(saved), referenceResolution);
  expect(after).toEqual(before);
  expect(serializeReactUiDocument(parseReactUiDocument(saved))).toBe(saved);
});
it('optional empty slots omit their prop and populated slots remain explicit', () => {
  const doc = clone(createReferenceDocument());
  const card = doc.nodes.find((n) => n.id === 'card')!;
  const removed = new Set(card.slots.footer);
  doc.nodes = doc.nodes.filter((n) => !removed.has(n.id));
  card.slots.footer = [];
  const output = exportReactUi(doc, referenceResolution).files['Screen.tsx'];
  expect(output).not.toMatch(/footer=\{<Fragment>\s*<\/Fragment>\}/);
  expect(output).toContain('children={<Fragment>');
});
it('generated maps use code-unit order independent of the Host locale', () => {
  const doc = clone(createReferenceDocument('form'));
  doc.inputs.I = { schema: { type: 'string' }, required: false, default: 'upper' };
  doc.inputs.i = { schema: { type: 'string' }, required: false, default: 'lower' };
  const locale = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
    throw Error('Host locale ordering was consulted');
  });
  try {
    const output = exportReactUi(doc, referenceResolution).files['Screen.tsx'];
    expect(output.indexOf('const input_I')).toBeLessThan(output.indexOf('const input_i'));
    expect(locale).not.toHaveBeenCalled();
  } finally {
    locale.mockRestore();
  }
});
