import { expect, it } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import { createReferenceDocument } from '../../../apps/react-ui-reference/src/catalog';
import {
  diffReactUiComposition,
  diffReactRegistrationCandidates,
  sealReactComponent,
} from './index';
const snapshot = (doc = createReferenceDocument()) => ({
  sourceRevision: 'source-1',
  candidates: doc.components,
});
it('observes props, binding, slot/order, layout and adoption by stable ID without mutation', () => {
  const before = clone(createReferenceDocument('form')),
    after = clone(before);
  after.nodes.find((n) => n.id === 'title')!.props.text = 'Changed';
  after.nodes.find((n) => n.id === 'title')!.bindings = {};
  after.nodes.find((n) => n.id === 'card')!.slots.body.reverse();
  after.nodes.find((n) => n.id === 'card')!.layout.base.padding = { kind: 'literal', value: 24 };
  const bytes = JSON.stringify(before);
  const diff = diffReactUiComposition(before, after);
  expect(diff.changes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'prop', nodeId: 'title', field: 'text', after: 'Changed' }),
      expect.objectContaining({ kind: 'binding', nodeId: 'title', field: 'text' }),
      expect.objectContaining({ kind: 'slot', nodeId: 'card', field: 'body' }),
      expect.objectContaining({ kind: 'layout', nodeId: 'card', field: 'base.padding' }),
    ]),
  );
  expect(JSON.stringify(before)).toBe(bytes);
  expect(Object.isFrozen(diff.changes[0])).toBe(true);
});
it('node/map insertion order is ignored; additions/removals are explicit and null differs from absent', () => {
  const before = clone(createReferenceDocument()),
    after = clone(before);
  after.nodes.reverse();
  expect(diffReactUiComposition(before, after).changes).toEqual([]);
  after.fixture.optional = null;
  expect(diffReactUiComposition(before, after).changes).toContainEqual({
    kind: 'fixture',
    field: 'optional',
    after: null,
  });
  after.nodes = after.nodes.filter((n) => n.id !== 'footer');
  expect(diffReactUiComposition(before, after).changes).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: 'node-removed', nodeId: 'footer' })]),
  );
});
it('compares immutable versions, detects narrowing/removal and keeps old published contracts', () => {
  const before = snapshot(),
    old = before.candidates.find((c) => c.ref.componentId === 'Text')!;
  const { contractHash: _hash, ...ref } = old.ref;
  const next = sealReactComponent({
    ...clone(old),
    ref: { ...ref, version: '2.0.0' },
    props: { content: old.props.text },
    sampleProps: { content: old.sampleProps.text },
  });
  const after = {
    sourceRevision: 'source-2',
    candidates: before.candidates.map((c) => (c === old ? next : c)),
  };
  const result = diffReactRegistrationCandidates(before, after);
  expect(result.changes).toHaveLength(1);
  expect(result.changes[0]).toMatchObject({
    kind: 'changed',
    breaking: true,
    reasons: expect.arrayContaining(['prop-removed:text', 'prop-required:content']),
  });
  expect(before.candidates.find((c) => c.ref.componentId === 'Text')!.props).toHaveProperty('text');
  expect(next.ref.version).toBe('2.0.0');
  expect(Object.isFrozen(result.changes[0].before)).toBe(true);
  const rewritten = sealReactComponent({ ...clone(old), ref, sampleProps: { text: 'new sample' } });
  expect(
    diffReactRegistrationCandidates(before, {
      ...after,
      candidates: before.candidates.map((c) => (c === old ? rewritten : c)),
    }).changes[0].reasons,
  ).toContain('immutable-version-rewritten');
});
it('never chooses latest from multiple candidate versions or ignores invalid candidates', () => {
  const before = snapshot(),
    old = before.candidates[0],
    { contractHash: _hash, ...ref } = old.ref;
  const newer = sealReactComponent({ ...clone(old), ref: { ...ref, version: '2.0.0' } });
  expect(() =>
    diffReactRegistrationCandidates(before, {
      sourceRevision: 'source-2',
      candidates: [...before.candidates, newer],
    }),
  ).toThrow(/one exact version/);
  expect(() =>
    diffReactRegistrationCandidates(before, { sourceRevision: 'source-2', candidates: [{}] }),
  ).toThrow(/diagnostics/);
});
