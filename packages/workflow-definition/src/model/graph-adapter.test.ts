import { describe, expect, it } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import {
  GraphBinding,
  assertGraph,
  type GraphIntent,
  type GraphPresentationCommit,
  type PresentationSidecar,
} from '@editor-platform/structured-graph/model';
import { fixture, owdCheck, owdFixtures, sampleDefinition } from './fixtures';
import {
  createOwdGraphAdapter,
  owdGraphAdapter,
  owdGraphProfile,
  projectOwdGraph,
  type OwdDefinition,
  type OwdSection,
} from './index';

interface State {
  source: OwdDefinition;
  sidecar?: PresentationSidecar;
}
/** A reference Host: one Undo history; with `commit`, source and sidecar change together. */
function host(
  definition = sampleDefinition(),
  options: { commit?: boolean; readOnly?: boolean } = {},
) {
  let state: State = { source: definition },
    revision = 1;
  const past: State[] = [];
  const binding = new GraphBinding<OwdDefinition>({
    adapter: createOwdGraphAdapter({ check: owdCheck }),
    sourceId: 'definition',
    read: () => ({
      content: state.source,
      revision: String(revision),
      readOnly: !!options.readOnly,
    }),
    execute: (cmd) => {
      past.push(clone(state));
      state = { ...state, source: cmd.apply(clone(state.source)) };
      revision++;
    },
    getPresentation: () => state.sidecar,
    setPresentation: (sidecar) => {
      state = { ...state, sidecar: clone(sidecar) };
    },
    ...(options.commit
      ? {
          commitWithPresentation: ({
            command,
            presentation,
          }: GraphPresentationCommit<OwdDefinition>) => {
            const before = clone(state);
            const source = command.apply(clone(state.source));
            past.push(before);
            state = { source, sidecar: clone(presentation) };
            revision++;
          },
        }
      : {}),
  });
  return {
    binding,
    get source() {
      return state.source;
    },
    get sidecar() {
      return state.sidecar;
    },
    edit: (intents: GraphIntent[]) => binding.apply(intents, binding.project().stamp),
    undo: () => {
      state = past.pop()!;
      revision++;
    },
  };
}
const phase = (d: OwdDefinition, id: string) => d.phases.find((p) => p.id === id)!;
const sectionsOf = (d: OwdDefinition) => d.sections as OwdSection[];

describe('projection', () => {
  it.each(Object.keys(owdFixtures))('%s projects as a valid Graph with prefixed IDs', (id) => {
    const d = fixture(id),
      graph = projectOwdGraph(d);
    assertGraph(graph, owdGraphProfile);
    expect(graph.nodes.filter((n) => n.type === 'phase')).toHaveLength(d.phases.length);
    expect(graph.nodes.every((n) => n.id === `${n.type}:${n.attributes.id}`)).toBe(true);
    expect(graph.sections.map((s) => s.id)).toEqual(
      ((d.sections ?? []) as { id: string }[]).map((s) => `section:${s.id}`),
    );
    const h = host(d);
    expect(h.binding.project().diagnostics).toEqual([]);
  });
  it('draws each phase in its section and the references as relations', () => {
    const graph = projectOwdGraph(sampleDefinition());
    expect(graph.nodes.find((n) => n.id === 'phase:plan')?.sectionId).toBe('section:early');
    expect(graph.edges.map((e) => e.id).sort()).toEqual(
      [
        'after|phase:research|phase:plan',
        'after|phase:plan|phase:review',
        'makes|phase:research|deliverable:notes',
        'makes|phase:plan|deliverable:plan-doc',
        'makes|phase:review|deliverable:plan-doc',
        'ends-with|phase:research|acceptance:notes.ok',
        'ends-with|phase:plan|acceptance:plan.ok',
        'ends-with|phase:review|acceptance:plan.ok',
        'uses|deliverable:plan-doc|deliverable:notes',
        'checks|acceptance:notes.ok|deliverable:notes',
        'checks|acceptance:plan.ok|deliverable:plan-doc',
        'approved-by|acceptance:plan.ok|role:lead',
      ].sort(),
    );
  });
  it('still projects a definition with duplicate IDs and missing references', () => {
    const d = sampleDefinition();
    d.phases.push(clone(d.phases[0]));
    d.phases[1].after = ['gone'];
    const graph = projectOwdGraph(d);
    assertGraph(graph, owdGraphProfile);
    expect(graph.nodes.filter((n) => n.id === 'phase:research')).toHaveLength(1);
    const codes = owdGraphAdapter.diagnostics!(d).map((x) => x.code);
    expect(codes).toContain('duplicate-id');
    expect(codes).toContain('missing-reference');
  });
});

describe('editing through the Graph', () => {
  it('adds a phase with an entered ID and connects it', () => {
    const h = host();
    h.edit([
      {
        type: 'add-node',
        node: {
          id: 'phase:scope',
          type: 'phase',
          attributes: { name: '範囲', purpose: '範囲を決める' },
        },
        position: { x: 0, y: 0 },
      },
      {
        type: 'add-edge',
        edge: {
          id: 'e1',
          type: 'after',
          from: 'phase:research',
          to: 'phase:scope',
          attributes: {},
        },
      },
      {
        type: 'add-edge',
        edge: {
          id: 'e2',
          type: 'makes',
          from: 'phase:scope',
          to: 'deliverable:notes',
          attributes: {},
        },
      },
    ]);
    expect(phase(h.source, 'scope')).toEqual({
      id: 'scope',
      name: '範囲',
      purpose: '範囲を決める',
      after: ['research'],
      deliverables: ['notes'],
      acceptance: [],
    });
    // Without an ID in the OWD form, the node is refused.
    expect(() =>
      h.edit([
        {
          type: 'add-node',
          node: { id: 'node-123', type: 'phase', attributes: { name: 'x' } },
          position: { x: 0, y: 0 },
        },
      ]),
    ).toThrow(/not an element/);
  });
  it('keeps the order when a relation end is moved, and refuses to cut the checked deliverable', () => {
    const h = host();
    h.edit([
      {
        type: 'reconnect-edge',
        id: 'after|phase:plan|phase:review',
        from: 'phase:research',
        to: 'phase:review',
      },
    ]);
    expect(phase(h.source, 'review').after).toEqual(['research']);
    h.edit([
      {
        type: 'reconnect-edge',
        id: 'checks|acceptance:plan.ok|deliverable:plan-doc',
        from: 'acceptance:plan.ok',
        to: 'deliverable:notes',
      },
    ]);
    expect(h.source.acceptance[1].target).toBe('notes');
    expect(() =>
      h.edit([{ type: 'delete-edge', id: 'checks|acceptance:notes.ok|deliverable:notes' }]),
    ).toThrow(/always checks one/);
    h.edit([{ type: 'delete-edge', id: 'approved-by|acceptance:plan.ok|role:lead' }]);
    expect(h.source.acceptance[1].approvers).toBeUndefined();
  });
  it('refuses to move a check to another acceptance', () => {
    const d = sampleDefinition();
    // An acceptance without a target yet (an incomplete draft) has no checks relation.
    d.acceptance.find((a) => a.id === 'notes.ok')!.target = '';
    const h = host(d);
    expect(() =>
      h.edit([
        {
          type: 'reconnect-edge',
          id: 'checks|acceptance:plan.ok|deliverable:plan-doc',
          from: 'acceptance:notes.ok',
          to: 'deliverable:plan-doc',
        },
      ]),
    ).toThrow(/stays with its acceptance/);
  });
  it('still projects a phase that comes after itself', () => {
    const d = sampleDefinition();
    d.phases[0].after = [d.phases[0].id];
    const h = host(d);
    const { diagnostics, graph } = h.binding.project();
    expect(
      graph.edges.some((e) => e.id === `after|phase:${d.phases[0].id}|phase:${d.phases[0].id}`),
    ).toBe(true);
    expect(diagnostics.some((x) => x.code === 'phase-cycle' && !x.blocking)).toBe(true);
  });
  it('still projects a deliverable that uses itself', () => {
    const d = fixture('editor-development');
    d.deliverables[0].uses = [d.deliverables[0].id];
    expect(() => host(d).binding.project()).not.toThrow();
  });
  it('addresses definition-level problems to the projected graph', () => {
    const d = sampleDefinition();
    d.version = 'broken';
    const { graph, diagnostics } = host(d).binding.project();
    expect(diagnostics.find((x) => x.code === 'version-form')?.elementId).toBe(graph.id);
  });
  it('follows a relation moved twice in one batch', () => {
    const h = host();
    const edge = 'makes|phase:research|deliverable:notes';
    h.edit([
      { type: 'reconnect-edge', id: edge, from: 'phase:plan', to: 'deliverable:notes' },
      { type: 'reconnect-edge', id: edge, from: 'phase:review', to: 'deliverable:notes' },
    ]);
    expect(phase(h.source, 'research').deliverables).not.toContain('notes');
    expect(phase(h.source, 'plan').deliverables).not.toContain('notes');
    expect(phase(h.source, 'review').deliverables).toContain('notes');
  });
  it('projects relations of a duplicated acceptance from its first record only', () => {
    const d = fixture('editor-development');
    const copy = clone(d.acceptance[0]);
    copy.target = d.deliverables.find((x) => x.id !== copy.target)!.id;
    d.acceptance.push(copy);
    const { graph, diagnostics } = host(d).binding.project();
    expect(
      graph.edges.filter((e) => e.from === `acceptance:${copy.id}` && e.type === 'checks'),
    ).toHaveLength(1);
    expect(diagnostics.some((x) => x.code === 'duplicate-id')).toBe(true);
  });
  it('allows a cycle and shows it as a warning', () => {
    const h = host();
    h.edit([
      {
        type: 'add-edge',
        edge: {
          id: 'e',
          type: 'after',
          from: 'phase:review',
          to: 'phase:research',
          attributes: {},
        },
      },
    ]);
    expect(phase(h.source, 'research').after).toEqual(['review']);
    const diagnostics = h.binding.project().diagnostics;
    expect(
      diagnostics
        .filter((d) => d.code === 'phase-cycle')
        .map((d) => d.elementId)
        .sort(),
    ).toEqual(['phase:plan', 'phase:research', 'phase:review']);
    expect(diagnostics.every((d) => !d.blocking)).toBe(true);
  });
  it('deletes a used deliverable only with cascade, as one edit', () => {
    const h = host();
    expect(() =>
      h.edit([{ type: 'delete-node', id: 'deliverable:notes', cascade: false }]),
    ).toThrow();
    h.edit([{ type: 'delete-node', id: 'deliverable:notes', cascade: true }]);
    expect(h.source.deliverables.map((d) => d.id)).toEqual(['plan-doc']);
    h.undo();
    expect(h.source.deliverables).toHaveLength(2);
  });
  it('edits definition and element fields and refuses ID changes and presentation in the source', () => {
    const h = host();
    h.edit([
      {
        type: 'set-attribute',
        scope: 'graph',
        id: 'owd:sample-plan',
        path: ['strictCites'],
        value: true,
      },
      { type: 'set-attribute', scope: 'node', id: 'phase:plan', path: ['name'], value: '設計' },
      { type: 'remove-attribute', scope: 'node', id: 'phase:review', path: ['icon'] },
    ]);
    expect(h.source.strictCites).toBe(true);
    expect(phase(h.source, 'plan').name).toBe('設計');
    expect(phase(h.source, 'review').icon).toBeUndefined();
    expect(() =>
      owdGraphAdapter.prepare(h.source, [
        { type: 'move-node', id: 'phase:plan', position: { x: 1, y: 1 } },
      ]),
    ).toThrow(/sidecar/);
    h.edit([{ type: 'move-node', id: 'phase:plan', position: { x: 5, y: 6 } }]);
    expect(h.sidecar?.presentation.nodes['phase:plan']).toEqual({ x: 5, y: 6 });
    expect(phase(h.source, 'plan').name).toBe('設計');
  });
  it('refuses every edit of a read-only definition', () => {
    const h = host(sampleDefinition(), { readOnly: true });
    expect(() =>
      h.edit([
        { type: 'set-attribute', scope: 'node', id: 'phase:plan', path: ['name'], value: 'x' },
      ]),
    ).toThrow(/read only/);
  });
});

describe('sections', () => {
  it('moves a phase into a section in phase order and saves the drop as one edit', () => {
    const h = host(sampleDefinition(), { commit: true });
    expect(h.binding.sectionDrop).toBe('membership');
    h.edit([
      { type: 'move-node', id: 'phase:review', position: { x: 300, y: 90 } },
      { type: 'set-node-section', id: 'phase:review', sectionId: 'section:early' },
    ]);
    expect(h.source.sections).toEqual([
      { id: 'early', name: '前半', phases: ['research', 'plan', 'review'] },
      { id: 'late', name: '後半', phases: [] },
    ]);
    expect(h.sidecar?.presentation.nodes['phase:review']).toEqual({ x: 300, y: 90 });
    // An empty section is an incomplete draft that the OWD check reports.
    expect(
      h.binding
        .project()
        .diagnostics.some((d) => d.elementId === 'section:late' && d.code === 'owd-check'),
    ).toBe(true);
    h.undo();
    expect(sectionsOf(h.source)[1].phases).toEqual(['review']);
    expect(h.sidecar).toBeUndefined();
  });
  it('adds a phase inside a section in the same edit', () => {
    const h = host(sampleDefinition(), { commit: true });
    h.edit([
      {
        type: 'add-node',
        node: {
          id: 'phase:scope',
          type: 'phase',
          sectionId: 'section:late',
          attributes: { name: '範囲', purpose: '範囲を決める' },
        },
        position: { x: 0, y: 0 },
      },
    ]);
    expect(sectionsOf(h.source)[1].phases).toContain('scope');
    expect(h.binding.project().graph.nodes.find((n) => n.id === 'phase:scope')?.sectionId).toBe(
      'section:late',
    );
  });
  it('adds a section with its frame and removes it again', () => {
    const h = host(sampleDefinition(), { commit: true });
    h.edit([
      {
        type: 'add-section',
        section: { id: 'section:extra', type: 'section', attributes: { name: '追加' } },
        bounds: { x: 0, y: 600, width: 400, height: 200 },
      },
      { type: 'set-node-section', id: 'phase:review', sectionId: 'section:extra' },
    ]);
    expect(sectionsOf(h.source).map((s) => [s.id, s.phases])).toEqual([
      ['early', ['research', 'plan']],
      ['late', []],
      ['extra', ['review']],
    ]);
    expect(h.binding.project().graph.presentation.sections['section:extra']).toEqual({
      x: 0,
      y: 600,
      width: 400,
      height: 200,
    });
    h.edit([{ type: 'delete-section', id: 'section:extra' }]);
    expect(sectionsOf(h.source).map((s) => s.id)).toEqual(['early', 'late']);
    expect(() =>
      h.edit([{ type: 'set-section-parent', id: 'section:late', parentId: 'section:early' }]),
    ).toThrow();
  });
  it('only moves on a drop for a Host without commitWithPresentation', () => {
    const h = host();
    expect(h.binding.sectionDrop).toBe('move-only');
    expect(() =>
      h.edit([
        { type: 'move-node', id: 'phase:review', position: { x: 300, y: 90 } },
        { type: 'set-node-section', id: 'phase:review', sectionId: 'section:early' },
      ]),
    ).toThrow(/separate transactions/);
    h.edit([{ type: 'set-node-section', id: 'phase:review', sectionId: 'section:early' }]);
    expect(sectionsOf(h.source)[0].phases).toEqual(['research', 'plan', 'review']);
  });
});
