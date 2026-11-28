import { describe, expect, it } from 'vitest';
import { canonicalJson, clone } from '@editor-platform/artifact-core';
import {
  GraphBinding,
  createRelationGraph,
  graphCommand,
  relationProfile,
  type GraphAdapter,
  type GraphDocument,
  type GraphIntent,
  type GraphNodePresentations,
  type GraphPresentationCommit,
  type GraphProfile,
  type PresentationSidecar,
} from './headless';

/** A source that holds Sections and membership but no presentation, as an OWD definition does. */
interface Source {
  graph: Omit<GraphDocument, 'presentation'>;
}
const profile: GraphProfile = (() => {
  const p = clone(relationProfile);
  p.sections.locked = { ...clone(p.sections.group), readOnly: true };
  return p;
})();
/** The adapter's own frame for a Section the sidecar has not saved. */
const defaultFrame = (index: number) => ({ x: 1000 + index * 500, y: 0, width: 400, height: 300 });
function project(source: Source, nodes?: GraphNodePresentations): GraphDocument {
  return {
    ...clone(source.graph),
    presentation: {
      nodes: clone(nodes ?? {}),
      sections: Object.fromEntries(source.graph.sections.map((s, i) => [s.id, defaultFrame(i)])),
    },
  };
}
const presentationTypes = new Set([
  'move-node',
  'set-node-shape',
  'set-node-style',
  'move-section',
  'resize-section',
  'set-section-style',
]);
const adapter: GraphAdapter<Source> = {
  id: 'sections-test',
  version: 1,
  presentationMode: 'sidecar',
  sections: true,
  profile: () => profile,
  project,
  prepare: (_source, intents) => {
    if (intents.some((i) => presentationTypes.has(i.type)))
      throw new Error('Presentation belongs to the Host sidecar');
    return {
      type: 'test.edit',
      label: 'Edit',
      apply: (current) => {
        const { presentation, ...graph } = graphCommand(profile, intents).apply(project(current));
        void presentation;
        return { graph };
      },
    };
  },
};
function start(): Source {
  const { presentation, ...graph } = createRelationGraph();
  void presentation;
  graph.sections = [
    { id: 'plan', type: 'group', attributes: { name: 'Plan' } },
    { id: 'vault', type: 'locked', attributes: { name: 'Vault' } },
  ];
  graph.nodes[0].sectionId = 'plan';
  return { graph };
}
interface State {
  source: Source;
  sidecar: PresentationSidecar | undefined;
}
/**
 * A Host with one Undo history for source edits. With `commit`, it applies the source command and
 * the sidecar write of one change together (or neither) as one history record.
 */
function host(options: { commit?: boolean; failSidecar?: boolean; readOnly?: boolean } = {}) {
  let state: State = { source: start(), sidecar: undefined },
    revision = 1;
  const past: State[] = [],
    future: State[] = [];
  let commits = 0;
  const commitWithPresentation = ({ command, presentation }: GraphPresentationCommit<Source>) => {
    const before = clone(state),
      beforeRevision = revision;
    try {
      state = { ...state, source: command.apply(clone(state.source)) };
      revision++;
      if (options.failSidecar) throw new Error('Sidecar write failed');
      state = { ...state, sidecar: clone(presentation) };
    } catch (error) {
      state = before;
      revision = beforeRevision;
      throw error;
    }
    past.push(before);
    future.length = 0;
    commits++;
  };
  const binding = new GraphBinding<Source>({
    adapter,
    sourceId: 'src',
    read: () => ({
      content: state.source,
      revision: String(revision),
      readOnly: !!options.readOnly,
    }),
    execute: (cmd) => {
      past.push(clone(state));
      future.length = 0;
      state = { ...state, source: cmd.apply(clone(state.source)) };
      revision++;
    },
    getPresentation: () => state.sidecar,
    // Presentation alone stays out of the definition's Undo, as the Graph contract says.
    setPresentation: (sidecar) => {
      state = { ...state, sidecar: clone(sidecar) };
    },
    ...(options.commit ? { commitWithPresentation } : {}),
  });
  return {
    binding,
    get state() {
      return state;
    },
    get commits() {
      return commits;
    },
    edit: (intents: GraphIntent[]) => binding.apply(intents, binding.project().stamp),
    undo: () => {
      future.push(clone(state));
      state = past.pop()!;
      revision++;
    },
    redo: () => {
      past.push(clone(state));
      state = future.pop()!;
      revision++;
    },
  };
}
const node = (h: ReturnType<typeof host>, id: string) =>
  h.binding.project().graph.nodes.find((n) => n.id === id)!;
const dropIntoPlan: GraphIntent[] = [
  { type: 'move-node', id: 'resource-b', position: { x: 1050, y: 60 } },
  { type: 'set-node-section', id: 'resource-b', sectionId: 'plan' },
];

describe('Sections with a presentation sidecar (schema 3)', () => {
  it('saves Section frames in the sidecar, apart from the source', () => {
    const h = host(),
      before = canonicalJson(h.state.source);
    h.edit([
      { type: 'resize-section', id: 'plan', bounds: { x: 0, y: 0, width: 800, height: 500 } },
      { type: 'set-section-style', id: 'plan', style: { fill: '#eeeeee' } },
    ]);
    expect(canonicalJson(h.state.source)).toBe(before);
    expect(h.state.sidecar?.schemaVersion).toBe(3);
    expect(h.state.sidecar?.presentation.sections.plan).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 500,
      style: { fill: '#eeeeee' },
    });
    const graph = h.binding.project().graph;
    expect(graph.presentation.sections.plan).toMatchObject({ width: 800 });
    // The Section the sidecar has not changed keeps the adapter's frame.
    expect(graph.presentation.sections.vault).toEqual(defaultFrame(1));
    // Moving a Section moves its member nodes too, all in the sidecar.
    h.edit([{ type: 'move-section', id: 'plan', position: { x: 100, y: 100 } }]);
    expect(h.state.sidecar?.presentation.sections.plan).toMatchObject({ x: 100, y: 100 });
    expect(canonicalJson(h.state.source)).toBe(before);
  });

  it('ignores frames of removed Sections and drops them on the next write', () => {
    const h = host();
    h.edit([{ type: 'move-section', id: 'plan', position: { x: 10, y: 10 } }]);
    h.edit([{ type: 'delete-section', id: 'plan' }]);
    const graph = h.binding.project().graph;
    expect(graph.sections.map((s) => s.id)).toEqual(['vault']);
    expect(Object.keys(graph.presentation.sections)).toEqual(['vault']);
    expect(node(h, 'resource-a').sectionId).toBeUndefined();
    h.edit([{ type: 'move-node', id: 'resource-a', position: { x: 5, y: 5 } }]);
    expect(Object.keys(h.state.sidecar!.presentation.sections)).toEqual(['vault']);
  });

  it('refuses a sidecar frame that is not a valid frame', () => {
    const h = host();
    h.edit([{ type: 'move-section', id: 'plan', position: { x: 10, y: 10 } }]);
    const saved = clone(h.state.sidecar!);
    for (const bad of [
      { ...saved, presentation: { ...saved.presentation, sections: { plan: { x: 0, y: 0 } } } },
      {
        ...saved,
        presentation: {
          ...saved.presentation,
          sections: { plan: { x: 0, y: 0, width: 10, height: 10 } },
        },
      },
      { ...saved, presentation: { ...saved.presentation, extra: {} } },
      { ...saved, adapter: null },
      7,
    ]) {
      const other = new GraphBinding<Source>({
        ...h.binding.options,
        getPresentation: () => bad as unknown as PresentationSidecar,
      });
      expect(() => other.project()).toThrow(/presentation sidecar/);
    }
  });

  describe('without commitWithPresentation', () => {
    it('asks the Surface to only move on a drop', () => {
      expect(host().binding.sectionDrop).toBe('move-only');
      expect(host({ commit: true }).binding.sectionDrop).toBe('membership');
    });

    it('refuses a move with a membership change and changes nothing', () => {
      const h = host(),
        before = clone(h.state);
      expect(() => h.edit(dropIntoPlan)).toThrow(/separate transactions/);
      expect(h.state).toEqual(before);
    });

    it('changes the membership alone as one source edit, and adds a Section with its default frame', () => {
      const h = host();
      h.edit([{ type: 'set-node-section', id: 'resource-b', sectionId: 'plan' }]);
      expect(node(h, 'resource-b').sectionId).toBe('plan');
      expect(h.state.sidecar).toBeUndefined();
      h.edit([
        {
          type: 'add-section',
          section: { id: 'later', type: 'group', attributes: { name: 'Later' } },
          bounds: { x: 0, y: 900, width: 300, height: 200 },
        },
      ]);
      expect(h.binding.project().graph.presentation.sections.later).toEqual(defaultFrame(2));
      h.undo();
      expect(h.binding.project().graph.sections.map((s) => s.id)).toEqual(['plan', 'vault']);
    });
  });

  describe('with commitWithPresentation', () => {
    it('moves a node into a Section and saves both as one Undo record', () => {
      const h = host({ commit: true });
      h.edit(dropIntoPlan);
      expect(h.commits).toBe(1);
      expect(h.state.source.graph.nodes[1].sectionId).toBe('plan');
      expect(h.state.sidecar?.presentation.nodes['resource-b']).toEqual({ x: 1050, y: 60 });
      h.undo();
      expect(h.state.source.graph.nodes[1].sectionId).toBeUndefined();
      expect(h.state.sidecar).toBeUndefined();
      h.redo();
      expect(node(h, 'resource-b').sectionId).toBe('plan');
      expect(h.binding.project().graph.presentation.nodes['resource-b']).toEqual({
        x: 1050,
        y: 60,
      });
    });

    it('saves a new Section frame and a new node position with the source edit', () => {
      const h = host({ commit: true });
      h.edit([
        {
          type: 'add-section',
          section: { id: 'later', type: 'group', attributes: { name: 'Later' } },
          bounds: { x: 0, y: 900, width: 300, height: 200 },
        },
        { type: 'set-node-section', id: 'resource-b', sectionId: 'later' },
      ]);
      const graph = h.binding.project().graph;
      expect(graph.presentation.sections.later).toEqual({ x: 0, y: 900, width: 300, height: 200 });
      expect(graph.nodes[1].sectionId).toBe('later');
      h.edit([
        {
          type: 'add-node',
          node: { id: 'n', type: 'entity', attributes: { name: 'New' } },
          position: { x: 20, y: 920 },
        },
      ]);
      expect(h.binding.project().graph.presentation.nodes.n).toEqual({ x: 20, y: 920 });
      expect(h.commits).toBe(2);
    });

    it('changes nothing when the sidecar write fails', () => {
      const h = host({ commit: true, failSidecar: true }),
        before = clone(h.state);
      expect(() => h.edit(dropIntoPlan)).toThrow(/Sidecar write failed/);
      expect(h.state).toEqual(before);
      expect(h.commits).toBe(0);
    });

    it('refuses the whole batch when one part is refused', () => {
      const h = host({ commit: true }),
        before = clone(h.state);
      for (const intents of [
        [dropIntoPlan[0], { type: 'set-node-section', id: 'resource-b', sectionId: 'vault' }],
        [dropIntoPlan[0], { type: 'set-node-section', id: 'resource-b', sectionId: 'gone' }],
      ] as GraphIntent[][])
        expect(() => h.edit(intents)).toThrow();
      expect(h.state).toEqual(before);
    });

    it('refuses a stale projection and a read-only source', () => {
      const h = host({ commit: true }),
        stale = h.binding.project().stamp;
      h.edit([{ type: 'move-node', id: 'resource-a', position: { x: 1, y: 1 } }]);
      const before = clone(h.state);
      expect(() => h.binding.apply(dropIntoPlan, stale)).toThrow(/Stale/);
      expect(h.state).toEqual(before);
      const locked = host({ commit: true, readOnly: true });
      expect(() => locked.edit(dropIntoPlan)).toThrow(/read only/);
      expect(locked.state.sidecar).toBeUndefined();
    });

    it('previews a mixed batch without changing the source or the sidecar', () => {
      const h = host({ commit: true }),
        before = clone(h.state);
      const { proposal, projection } = h.binding.preview(dropIntoPlan);
      expect(projection.graph.nodes[1].sectionId).toBe('plan');
      expect(projection.graph.presentation.nodes['resource-b']).toEqual({ x: 1050, y: 60 });
      expect(h.state).toEqual(before);
      h.binding.applyProposal(proposal);
      expect(h.commits).toBe(1);
      expect(node(h, 'resource-b').sectionId).toBe('plan');
    });
  });
});
