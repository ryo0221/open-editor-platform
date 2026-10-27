import { describe, expect, it } from 'vitest';
import { canonicalJson, clone } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import {
  GraphBinding,
  type PresentationSidecar,
  type GraphIntent,
  assertGraph,
} from '@editor-platform/structured-graph/model';
import {
  createDefinitionAdapter,
  definitionProfile,
  publishedDefinition,
  projectDefinition,
  reorderReferencePhase,
  type ReferenceDefinition,
  referenceEdgeId,
  isReferenceDefinition,
} from './definition';
function host(validator?: Parameters<typeof createDefinitionAdapter>[0]) {
  const session = new EditorSession(clone(publishedDefinition)),
    adapter = createDefinitionAdapter(validator);
  let layout: PresentationSidecar | undefined,
    readOnly = false;
  const binding = new GraphBinding({
    adapter,
    sourceId: 'definition',
    read: () => ({ content: session.content, revision: canonicalJson(session.revision), readOnly }),
    execute: (cmd) => {
      session.execute(cmd);
    },
    getPresentation: () => layout,
    setPresentation: (value) => {
      layout = value;
    },
  });
  return {
    session,
    binding,
    adapter,
    get layout() {
      return layout;
    },
    setReadOnly(value: boolean) {
      readOnly = value;
    },
  };
}
const edit: GraphIntent = {
  type: 'set-attribute',
  scope: 'node',
  id: 'phase-research',
  path: ['purpose'],
  value: 'Changed purpose',
};
describe('independent fictional Definition adapter', () => {
  it('rejects noncanonical added IDs atomically and retains proposal edge references through apply/Undo/Redo', () => {
    for (const sourceId of ['phase-research', 'p'.repeat(512)]) {
      const h = host();
      h.session.execute({
        type: 'fixture.disconnect',
        label: 'Disconnected reference',
        apply: (source) => {
          const next = clone(source);
          const phase = next.phases[0];
          phase.id = sourceId;
          delete phase.output;
          next.gates[0].target = sourceId;
          return next;
        },
      });
      const initial = h.session.content;
      const projection = h.binding.project();
      const edge = {
        id: referenceEdgeId(
          'output',
          sourceId,
          new Set([projection.graph.id, ...projection.graph.nodes.map((n) => n.id)]),
        ),
        type: 'output',
        from: sourceId,
        to: initial.shapes[0].id,
        attributes: {},
      };
      const revision = h.session.revision;
      expect(() =>
        h.binding.apply(
          [{ type: 'add-edge', edge: { ...edge, id: 'random-edge' } }],
          projection.stamp,
        ),
      ).toThrow(/canonical edge ID/);
      expect(h.session.content).toEqual(initial);
      expect(h.session.revision).toEqual(revision);
      const preview = h.binding.preview([{ type: 'add-edge', edge }]);
      expect(preview.projection.graph.edges.find((e) => e.id === edge.id)).toEqual(edge);
      h.binding.applyProposal(preview.proposal);
      expect(h.binding.project().graph.edges.find((e) => e.id === edge.id)).toEqual(edge);
      expect(h.session.content.phases[0].output).toBe(edge.to);
      h.session.undo();
      expect(h.session.content).toEqual(initial);
      h.session.redo();
      expect(h.binding.project().graph.edges.find((e) => e.id === edge.id)).toEqual(edge);
    }
  });
  it('preserves unmapped object children on edits and atomically refuses null/removal or hidden-child overwrites', () => {
    const h = host(),
      initial = h.session.content;
    h.binding.apply(
      [
        {
          type: 'set-attribute',
          scope: 'node',
          id: 'gate-check',
          path: ['config'],
          value: { note: 'Allowed' },
        },
      ],
      h.binding.project().stamp,
    );
    expect(h.session.content.gates[0].config).toEqual({
      note: 'Allowed',
      retained: 'Keep unshown nested values',
    });
    expect(h.session.undo()).toEqual(initial);
    for (const intent of [
      { type: 'set-attribute', scope: 'node', id: 'gate-check', path: ['config'], value: null },
      { type: 'remove-attribute', scope: 'node', id: 'gate-check', path: ['config'] },
      {
        type: 'set-attribute',
        scope: 'node',
        id: 'gate-check',
        path: ['config'],
        value: { note: 'Allowed', retained: 'Overwrite' },
      },
    ] as GraphIntent[]) {
      const revision = h.session.revision;
      expect(() => h.binding.apply([edit, intent], h.binding.project().stamp)).toThrow(
        /undeclared/,
      );
      expect(h.session.content).toEqual(initial);
      expect(h.session.revision).toEqual(revision);
      expect(h.session.canUndo).toBe(false);
    }
  });
  it('allows clearing a declared-only object and restores it with Undo', () => {
    const h = host();
    h.session.execute({
      type: 'host.fixture',
      label: 'Declared-only config',
      apply: (d) => ({ ...d, gates: d.gates.map((g) => ({ ...g, config: { note: 'Declared' } })) }),
    });
    const initial = h.session.content;
    h.binding.apply(
      [{ type: 'set-attribute', scope: 'node', id: 'gate-check', path: ['config'], value: null }],
      h.binding.project().stamp,
    );
    expect(h.session.content.gates[0].config).toBeNull();
    expect(h.session.undo()).toEqual(initial);
    h.binding.apply(
      [{ type: 'remove-attribute', scope: 'node', id: 'gate-check', path: ['config'] }],
      h.binding.project().stamp,
    );
    expect(h.session.content.gates[0].config).toBeUndefined();
    expect(h.session.undo()).toEqual(initial);
  });
  it('roundtrips untouched source and preserves unpublished/unknown fields and array order', () => {
    const h = host(),
      source = h.session.content;
    expect(JSON.parse(JSON.stringify(source))).toEqual(publishedDefinition);
    h.binding.apply([edit], h.binding.project().stamp);
    const next = h.session.content;
    expect(next.phases[0].purpose).toBe('Changed purpose');
    expect(next.phases.map((p) => p.id)).toEqual(source.phases.map((p) => p.id));
    expect(next.unshown).toEqual(source.unshown);
    expect(next.phases[0].unshown).toEqual(source.phases[0].unshown);
    expect(next.history).toEqual(source.history);
    expect(next.kernel).toBe(source.kernel);
    expect(publishedDefinition.phases[0].purpose).toBe('Collect public facts');
    expect(h.session.undo()).toEqual(source);
  });
  it('moving nodes saves only sidecar layout; semantic values/version/order/history are unchanged', () => {
    const h = host(),
      before = h.session.content,
      revision = h.session.revision;
    h.binding.apply(
      [{ type: 'move-node', id: 'phase-research', position: { x: 22, y: 33 } }],
      h.binding.project().stamp,
    );
    expect(h.session.content).toEqual(before);
    expect(h.session.revision).toEqual(revision);
    expect(h.session.canUndo).toBe(false);
    expect(h.layout?.presentation.nodes['phase-research']).toEqual({ x: 22, y: 33 });
    expect(h.binding.project().graph.presentation.nodes['phase-research']).toEqual({
      x: 22,
      y: 33,
    });
  });
  it('refuses mixed sidecar and semantic batch without either partial result', () => {
    const h = host(),
      before = h.session.content;
    expect(() =>
      h.binding.apply(
        [edit, { type: 'move-node', id: 'phase-research', position: { x: 1, y: 2 } }],
        h.binding.project().stamp,
      ),
    ).toThrow('separate');
    expect(h.session.content).toEqual(before);
    expect(h.layout).toBeUndefined();
  });
  it('derived phase-order edges are readonly and reorder is explicit, undoable and retains source IDs', () => {
    const h = host(),
      before = h.session.content;
    expect(() =>
      h.binding.apply(
        [{ type: 'delete-edge', id: 'next:phase-research' }],
        h.binding.project().stamp,
      ),
    ).toThrow('read only');
    expect(h.session.content).toEqual(before);
    h.session.execute(reorderReferencePhase('phase-plan', 'phase-research'));
    expect(h.session.content.phases.map((p) => p.id)).toEqual(['phase-plan', 'phase-research']);
    expect(projectDefinition(h.session.content).edges.find((e) => e.type === 'next')?.from).toBe(
      'phase-plan',
    );
    expect(h.session.undo()).toEqual(before);
  });
  it('maps safe connections to original fields and retains unknown gate config', () => {
    const h = host();
    h.binding.apply(
      [
        {
          type: 'reconnect-edge',
          id: 'target:gate-check',
          from: 'gate-check',
          to: 'phase-research',
        },
        {
          type: 'set-attribute',
          scope: 'node',
          id: 'gate-check',
          path: ['config'],
          value: { note: 'Changed' },
        },
      ],
      h.binding.project().stamp,
    );
    expect(h.session.content.gates[0].target).toBe('phase-research');
    expect(h.session.content.gates[0].config).toEqual({
      note: 'Changed',
      retained: 'Keep unshown nested values',
    });
  });
  it('never changes published identity/version and injects existing domain diagnostics at stable fields', () => {
    let calls = 0;
    const h = host((source) => {
      calls++;
      return [
        {
          scope: 'node',
          elementId: source.phases[0].id,
          path: ['purpose'],
          code: 'domain',
          message: 'Domain warning',
          severity: 'warning',
          blocking: false,
        },
      ];
    });
    expect(h.binding.project().diagnostics[0].elementId).toBe('phase-research');
    h.binding.apply([edit], h.binding.project().stamp);
    expect(calls).toBeGreaterThan(0);
    expect(() =>
      h.binding.apply(
        [
          {
            type: 'set-attribute',
            scope: 'graph',
            id: 'reference-definition-graph',
            path: ['version'],
            value: 2,
          },
        ],
        h.binding.project().stamp,
      ),
    ).toThrow('read only');
    expect(h.session.content.version).toBe(1);
  });
  it('preview/reject leave source unchanged; adoption one Undo; stale projection/permission/Profile/adapter refuse', () => {
    const h = host(),
      before = h.session.content,
      preview = h.binding.preview([edit]);
    expect(h.session.content).toEqual(before);
    expect(h.session.canUndo).toBe(false);
    h.binding.applyProposal(preview.proposal);
    expect(h.session.undo()).toEqual(before);
    expect(h.session.canUndo).toBe(false);
    expect(() => h.binding.applyProposal(preview.proposal)).toThrow('Stale');
    const next = h.binding.preview([edit]);
    h.setReadOnly(true);
    expect(() => h.binding.applyProposal(next.proposal)).toThrow('read only');
    h.setReadOnly(false);
    h.adapter.version = 2;
    expect(() => h.binding.applyProposal(next.proposal)).toThrow('Stale');
    const current = h.binding.project().stamp;
    h.adapter.profile = () => ({ ...definitionProfile, version: 2 });
    expect(() => h.binding.apply([edit], current)).toThrow('Stale');
  });
  it('keeps stale sidecar positions only for existing IDs and uses deterministic fallback for new nodes', () => {
    const h = host();
    h.binding.apply(
      [{ type: 'move-node', id: 'phase-research', position: { x: 1, y: 2 } }],
      h.binding.project().stamp,
    );
    const next = clone(h.session.content);
    next.shapes.push({ id: 'new-shape', name: 'New shape' });
    expect(
      projectDefinition(next, h.layout?.presentation.nodes).presentation.nodes['new-shape'],
    ).toBeDefined();
    expect(
      projectDefinition(next, { removed: { x: 1, y: 2 } }).presentation.nodes.removed,
    ).toBeUndefined();
  });
  it('does not require framework/product code for another profile/adapter', () => {
    const source: ReferenceDefinition = clone(publishedDefinition);
    expect(projectDefinition(source).nodes.map((n) => n.type)).toContain('phase');
    expect(createDefinitionAdapter().profile(source).id).toBe('fictional-definition');
  });
});
it('pins sidecar revisions and rejects an older layout preview without changing the Definition', () => {
  const h = host(),
    old = h.binding.project().stamp,
    before = h.session.content;
  h.binding.apply([{ type: 'move-node', id: 'phase-research', position: { x: 20, y: 30 } }], old);
  expect(() =>
    h.binding.apply(
      [{ type: 'move-node', id: 'phase-research', position: { x: 100, y: 100 } }],
      old,
    ),
  ).toThrow('Stale');
  expect(h.layout?.presentation.nodes['phase-research']).toEqual({ x: 20, y: 30 });
  expect(h.session.content).toEqual(before);
});

it('semantic proposal previews retain the pinned layout and recompute domain diagnostics from proposed source', () => {
  const h = host((source) =>
    source.phases[0].purpose === 'Incomplete'
      ? [
          {
            scope: 'node',
            elementId: source.phases[0].id,
            path: ['purpose'],
            code: 'domain',
            message: 'Incomplete purpose',
            severity: 'error',
            blocking: false,
          },
        ]
      : [],
  );
  h.binding.apply(
    [{ type: 'move-node', id: 'phase-research', position: { x: 123, y: 234 } }],
    h.binding.project().stamp,
  );
  const before = h.session.content,
    layout = h.binding.project().graph.presentation.nodes;
  const preview = h.binding.preview([{ ...edit, value: 'Incomplete' }]);
  expect(preview.proposal.base).toBe(h.binding.project().stamp);
  expect(preview.projection.stamp).not.toBe(preview.proposal.base);
  expect(() => h.binding.apply(preview.proposal.intents, preview.projection.stamp)).toThrow(
    'Stale',
  );
  expect(preview.projection.graph.presentation.nodes).toEqual(layout);
  expect(preview.projection.diagnostics.map((d) => d.code)).toEqual(['domain']);
  expect(h.session.content).toEqual(before);
  h.binding.applyProposal(preview.proposal);
  const fixed = h.binding.preview([edit]);
  expect(fixed.projection.graph.presentation.nodes).toEqual(layout);
  expect(fixed.projection.diagnostics).toEqual([]);
  expect(h.binding.project().diagnostics).toHaveLength(1);
  expect(h.layout?.presentation.nodes['phase-research']).toEqual({ x: 123, y: 234 });
});
it('bounds long derived Definition identities and retains native IDs through retargeting and Undo', () => {
  const initial = clone(publishedDefinition),
    id = 'p'.repeat(512);
  initial.phases[0].id = id;
  const session = new EditorSession(initial),
    binding = new GraphBinding({
      adapter: createDefinitionAdapter(),
      sourceId: 'long-definition',
      read: () => ({
        content: session.content,
        revision: canonicalJson(session.revision),
        readOnly: false,
      }),
      execute: (cmd) => {
        session.execute(cmd);
      },
    });
  const view = binding.project(),
    output = view.graph.edges.find((e) => e.type === 'output' && e.from === id)!;
  expect(view.graph.edges.every((e) => e.id.length <= 512)).toBe(true);
  expect(view.graph.nodes[0].id).toBe(id);
  binding.apply(
    [{ type: 'reconnect-edge', id: output.id, from: id, to: 'shape-plan' }],
    view.stamp,
  );
  expect(session.content.phases[0].id).toBe(id);
  expect(session.content.phases[0].output).toBe('shape-plan');
  expect(binding.project().graph.edges.find((e) => e.type === 'output' && e.from === id)?.id).toBe(
    output.id,
  );
  expect(session.undo()).toEqual(initial);
});
it('keeps derived edge IDs disjoint from native nodes, root and deliberately occupied hash namespaces', () => {
  const initial = clone(publishedDefinition);
  initial.shapes[0].id = 'output:phase-research';
  initial.phases[0].output = initial.shapes[0].id;
  const occupied = referenceEdgeId('output', 'phase-research', new Set([initial.shapes[0].id]));
  initial.components.push(
    ...[occupied, 'target:gate-check', 'uses:gate-check', 'next:phase-research'].map((id) => ({
      id,
      name: 'Reserved identity',
    })),
  );
  expect(isReferenceDefinition(initial)).toBe(true);
  const graph = projectDefinition(initial),
    all = [graph.id, ...graph.nodes.map((n) => n.id), ...graph.edges.map((e) => e.id)];
  assertGraph(graph, definitionProfile);
  expect(new Set(all).size).toBe(all.length);
  expect(graph.edges.find((e) => e.type === 'output' && e.from === 'phase-research')?.id).not.toBe(
    occupied,
  );
  expect(graph.nodes.map((n) => n.id)).toContain('output:phase-research');
  const invalid = clone(initial);
  invalid.components[0].id = graph.id;
  expect(isReferenceDefinition(invalid)).toBe(false);
  expect(() => projectDefinition(invalid)).toThrow('Unsupported');
});
it.each(['output', 'target', 'component', 'wrong-type'] as const)(
  'explicitly refuses unresolved mapped references (%s) without hiding raw source or changing history',
  (field) => {
    const initial = clone(publishedDefinition);
    if (field === 'output') initial.phases[0].output = 'missing-shape';
    if (field === 'target') initial.gates[0].target = 'missing-phase';
    if (field === 'component') initial.gates[0].component = 'missing-component';
    if (field === 'wrong-type') initial.phases[0].output = 'phase-plan';
    expect(isReferenceDefinition(initial)).toBe(true);
    const session = new EditorSession(initial),
      revision = session.revision,
      adapter = createDefinitionAdapter();
    const binding = new GraphBinding({
      adapter,
      sourceId: 'invalid-definition',
      read: () => ({
        content: session.content,
        revision: canonicalJson(session.revision),
        readOnly: false,
      }),
      execute: (cmd) => {
        session.execute(cmd);
      },
    });
    expect(() => binding.project()).toThrow('Unresolved or unsupported Definition reference');
    expect(() => binding.preview([edit])).toThrow('Unresolved or unsupported Definition reference');
    expect(() => session.execute(adapter.prepare(initial, [edit]))).toThrow(
      'Unresolved or unsupported Definition reference',
    );
    expect(session.content).toEqual(initial);
    expect(session.revision).toEqual(revision);
    expect(session.canUndo).toBe(false);
  },
);
