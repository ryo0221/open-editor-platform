import { expect, it } from 'vitest';
import { Authority, initial, type DomainCodec, type Principal } from '@editor-platform/collaboration-core';
import { immutableCommand } from '@editor-platform/editor-core';
import { createAnalysis } from '@editor-platform/analysis-core';
import { createEstimate } from '@editor-platform/estimate-core';
import { createFictionMap } from '@editor-platform/fiction-map/model';
import { ladderSelfHoldExample } from '@editor-platform/ladder-core';
import { schematicStarter } from '@editor-platform/schematic-core';
import { createGraph } from '@editor-platform/structured-graph/model';
import { emptyGeo, type VectorLayer } from '@editor-platform/geo-core';
import {
  analysisEditorCodec,
  estimateEditorCodec,
  fictionMapEditorCodec,
  geoEditorCodec,
  ladderEditorCodec,
  prepareEditorCommand,
  schematicEditorCodec,
  structuredGraphEditorCodec,
} from './index';

const principal = (id: string): Principal => ({
  actorId: id, clientId: id, sessionId: id, writable: true, scopes: ['*'],
});
const a = principal('a'), b = principal('b');

function scenario<T>(codec: DomainCodec<T>, content: T) {
  const snapshot = initial(codec.domain, codec, content);
  const authority = new Authority(codec, snapshot);
  return {
    authority,
    edit(actor: Principal, change: (content: T) => T) {
      return prepareEditorCommand(codec, snapshot, actor, immutableCommand('test-edit', 'Edit', change))!;
    },
  };
}

const layer = (id: string): VectorLayer => ({
  id, name: id, crs: 'OGC:CRS84', axis: 'longitude-latitude', fields: [], features: [],
});

it('combines Geo layer renames from the same base and only undoes the author’s rename', () => {
  const { edit, authority } = scenario(geoEditorCodec, { ...emptyGeo(), layers: [layer('one'), layer('two')] });
  const rename = (id: string) => (map: ReturnType<typeof emptyGeo>) => ({
    ...map, layers: map.layers.map((l) => l.id === id ? { ...l, name: l.name + '-renamed' } : l),
  });
  const first = edit(a, rename('one'));
  expect(authority.submit(a, first).status).toBe('accepted');
  expect(authority.submit(b, edit(b, rename('two'))).status).toBe('accepted');
  expect(authority.undo(a, first.operationId).status).toBe('accepted');
  expect(authority.snapshot().content.layers.map((l) => l.name)).toEqual(['one', 'two-renamed']);
});

it('rejects a graph edge to a missing node, including when sent directly', () => {
  const graph = createGraph();
  expect(structuredGraphEditorCodec.validate(graph)).toBe(true);
  expect(() => structuredGraphEditorCodec.apply(graph, {
    type: 'structured-graph.edit', target: '*',
    payload: { reads: [], changes: [{
      kind: 'insert', collection: 'edges', id: 'bad',
      value: { id: 'bad', type: 'relation', from: 'one', to: 'two', attributes: {} },
    }] },
  }, 0)).toThrow(/invariants/);
  expect(structuredGraphEditorCodec.validate({ ...graph, profile: { id: 'unknown', version: 1 } })).toBe(false);
});

it('edits Analysis note text and preserves a peer change to the title', () => {
  const content = {
    ...createAnalysis(),
    blocks: [{ id: 'note', kind: 'note' as const, text: 'Before', targetId: null }],
  };
  const { edit, authority } = scenario(analysisEditorCodec, content);
  const note = edit(a, (doc) => ({ ...doc, blocks: doc.blocks.map((x) => ({ ...x, text: 'After' })) }));
  expect(authority.submit(a, note).status).toBe('accepted');
  expect(authority.submit(b, edit(b, (doc) => ({ ...doc, title: 'Peer title' }))).status).toBe('accepted');
  expect(authority.undo(a, note.operationId).status).toBe('accepted');
  expect(authority.snapshot().content).toMatchObject({ title: 'Peer title', blocks: content.blocks });
});

it('keeps null as a native Estimate value', () => {
  const estimate = {
    ...createEstimate(),
    quantities: [{ id: 'manual', name: 'Area', unit: 'm2', value: '1', quality: 'manual' as const, evidence: 'Measured area', inclusion: 'include' as const, exclusionReason: '' }],
  };
  const { edit, authority } = scenario(estimateEditorCodec, estimate);
  expect(authority.submit(a, edit(a, (doc) => ({
    ...doc, quantities: doc.quantities.map((q) => ({ ...q, value: null })),
  }))).status).toBe('accepted');
  expect(authority.snapshot().content.quantities[0].value).toBe(null);
});

it('shares the name of a Fiction Map layer', () => {
  const { edit, authority } = scenario(fictionMapEditorCodec, {
    ...createFictionMap(),
    layers: [{ id: 'places', name: 'Locations', purpose: 'settlement', visibleByDefault: true }],
  });
  const operation = edit(a, (map) => ({
    ...map, layers: map.layers.map((l, i) => i === 0 ? { ...l, name: 'Places' } : l),
  }));
  expect(authority.submit(a, operation).status).toBe('accepted');
  expect(authority.snapshot().content.layers[0].name).toBe('Places');
});

it('shares rung comments and schematic sheet information with their native invariants', () => {
  const ladder = scenario(ladderEditorCodec, ladderSelfHoldExample());
  expect(ladder.authority.submit(a, ladder.edit(a, (doc) => ({
    ...doc, rungs: doc.rungs.map((rung, i) => i === 0 ? { ...rung, comment: 'Shared comment' } : rung),
  }))).status).toBe('accepted');
  expect(ladder.authority.snapshot().content.rungs[0].comment).toBe('Shared comment');

  const schematic = scenario(schematicEditorCodec, schematicStarter());
  expect(schematic.authority.submit(a, schematic.edit(a, (doc) => ({
    ...doc, sheet: { ...doc.sheet, title: 'Shared circuit' },
  }))).status).toBe('accepted');
  expect(schematic.authority.snapshot().content.sheet.title).toBe('Shared circuit');
});
