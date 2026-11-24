import { describe, expect, it } from 'vitest';
import { canonicalJson, clone } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import { readItems } from '@editor-platform/extension-runtime/items';
import {
  graphItemsDeclaration,
  isGraphDocument,
  isGraphProfile,
  readGraphDocument,
  upgradeGraphProfile,
  validateGraph,
  type GraphDocument,
} from '@editor-platform/structured-graph/model';
import {
  createFishboneGraph,
  createFtaGraph,
  evaluateFta,
  formatProbability,
  fishboneProfile,
  fishboneProfileV1,
  ftaProfile,
  ftaProfileV1,
  useAnalysisItems,
} from './analysis-graph-templates';
import { graphProfileFor } from './graph-templates';

const none = () => undefined;
/** A diagram saved with the older (version 1) analysis Profile. */
const older = (graph: GraphDocument, version = 1): GraphDocument => {
  const g = clone(graph);
  g.profile = { ...g.profile, version };
  return g;
};

describe('fishbone and FTA structured analysis prototypes', () => {
  it('uses valid, registered Graph Profile schemas without new Artifact kinds', () => {
    expect(isGraphProfile(fishboneProfile)).toBe(true);
    expect(isGraphProfile(ftaProfile)).toBe(true);
    for (const [graph, profile] of [
      [createFishboneGraph(), fishboneProfile],
      [createFtaGraph(), ftaProfile],
    ] as const) {
      expect(isGraphDocument(graph)).toBe(true);
      expect(validateGraph(graph, profile)).toEqual([]);
      expect(JSON.parse(JSON.stringify(graph))).toEqual(graph);
    }
  });

  it('retains cause identity and evidence separately from node coordinates', () => {
    const graph = createFishboneGraph();
    const cause = graph.nodes.find((node) => node.id === 'temperature')!;
    expect(cause.attributes.evidence).toBe('温度ログを確認する');
    cause.attributes.status = 'confirmed';
    graph.presentation.nodes.temperature.x += 80;
    expect(cause.id).toBe('temperature');
    expect(cause.attributes.status).toBe('confirmed');
    expect(validateGraph(graph, fishboneProfile)).toEqual([]);
  });

  it('calculates OR and AND probabilities for the sample independent leaf events', () => {
    const graph = createFtaGraph();
    expect(evaluateFta(graph)).toEqual({
      ok: true,
      probability: 0.02980000000000005,
      topId: 'top',
      basicEventIds: ['controller', 'power'],
    });
    graph.nodes.find((node) => node.id === 'gate-or')!.type = 'and';
    const and = evaluateFta(graph);
    expect(and.ok).toBe(true);
    if (and.ok) expect(and.probability).toBeCloseTo(0.0002, 10);
  });

  it('rejects missing or invalid probability rather than displaying a calculated success', () => {
    const graph = createFtaGraph();
    graph.nodes.find((node) => node.id === 'power')!.attributes.probability = -0.1;
    expect(evaluateFta(graph).ok).toBe(false);
    graph.nodes.find((node) => node.id === 'power')!.attributes.probability = 1.1;
    expect(evaluateFta(graph).ok).toBe(false);
    delete graph.nodes.find((node) => node.id === 'power')!.attributes.probability;
    expect(evaluateFta(graph).ok).toBe(false);
  });

  it('rejects incomplete gate, unreachable nodes, and multiple top events', () => {
    const graph = createFtaGraph();
    graph.edges = graph.edges.filter((edge) => edge.from !== 'controller');
    expect(evaluateFta(graph).ok).toBe(false);
    graph.edges.push({
      id: 'controller-to-gate',
      type: 'input',
      from: 'controller',
      to: 'gate-or',
      attributes: {},
    });
    graph.nodes.push({ id: 'extra-top', type: 'top', attributes: { name: '重複' } });
    graph.presentation.nodes['extra-top'] = { x: 100, y: 800 };
    expect(evaluateFta(graph).ok).toBe(false);
  });

  it('rejects repeated basic events shared between branches', () => {
    const graph = createFtaGraph();
    graph.nodes.push({ id: 'extra-gate', type: 'and', attributes: { name: 'AND' } });
    graph.presentation.nodes['extra-gate'] = { x: 200, y: 650 };
    graph.edges.push(
      { id: 'reuse-power', type: 'input', from: 'power', to: 'extra-gate', attributes: {} },
      {
        id: 'reuse-controller',
        type: 'input',
        from: 'controller',
        to: 'extra-gate',
        attributes: {},
      },
      { id: 'reuse-gate', type: 'input', from: 'extra-gate', to: 'gate-or', attributes: {} },
    );
    const result = evaluateFta(graph);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(' ')).toContain('同じ基本事象');
  });

  it('does not evaluate a Fishbone graph as an FTA', () => {
    const result = evaluateFta(createFishboneGraph());
    expect(result.ok).toBe(false);
  });

  it('formats very small top-event probabilities without rounding them to zero', () => {
    expect(formatProbability(0.0298)).toBe('2.9800%');
    expect(formatProbability(0)).toBe('0%');
    expect(formatProbability(1e-9)).toBe('1.00e-7%');
  });
});

describe('analysis items in the Fishbone and FTA Profiles (AR1)', () => {
  it('declares causes, top events and basic events as items in Profile schema 3', () => {
    for (const p of [fishboneProfile, ftaProfile]) {
      expect(p.schemaVersion).toBe(3);
      expect(p.version).toBe(2);
      expect(isGraphProfile(p)).toBe(true);
    }
    expect(graphItemsDeclaration(fishboneProfile)).toEqual({
      version: 'items@1-draft',
      collections: [
        {
          at: 'nodes',
          where: { type: 'cause' },
          id: 'attributes.itemId',
          title: 'attributes.name',
          rootRefs: ['attributes.problemRef'],
        },
      ],
    });
    expect(
      graphItemsDeclaration(ftaProfile)!.collections.map((c) => [c.where.type, c.refs]),
    ).toEqual([
      ['top', ['attributes.problemRef']],
      ['basic', ['attributes.failureCauseRefs']],
    ]);
    expect(graphItemsDeclaration(fishboneProfileV1)).toBeUndefined();
  });

  it('reads business IDs and citations from a diagram, and nodes without an ID are not items', () => {
    const g = createFishboneGraph();
    g.attributes.problemRef = 'PB-01';
    g.nodes.find((n) => n.id === 'temperature')!.attributes.itemId = 'CC-01';
    g.nodes.find((n) => n.id === 'lots')!.attributes.itemId = 'CC-02';
    expect(validateGraph(g, fishboneProfile)).toEqual([]);
    const r = readItems(graphItemsDeclaration(fishboneProfile)!, g, none);
    expect(r.problems).toEqual([]);
    expect(r.items.map((i) => [i.id, i.title, i.refs])).toEqual([
      ['CC-01', '設備温度の変動', ['PB-01']],
      ['CC-02', '材料ロット差', ['PB-01']],
    ]);
    const fta = createFtaGraph();
    const power = fta.nodes.find((n) => n.id === 'power')!;
    power.attributes.itemId = 'BE-01';
    power.attributes.failureCauseRefs = ['FC-01', 'FC-02'];
    expect(validateGraph(fta, ftaProfile)).toEqual([]);
    expect(
      readItems(graphItemsDeclaration(ftaProfile)!, fta, none).items.map((i) => [i.id, i.refs]),
    ).toEqual([['BE-01', ['FC-01', 'FC-02']]]);
  });

  it('refuses items on a schema 2 Profile and item attributes that are not plain IDs', () => {
    const v2 = { ...clone(fishboneProfile), schemaVersion: 2 };
    expect(isGraphProfile(v2)).toBe(false);
    expect(upgradeGraphProfile(v2)).toBeUndefined();
    const bad = (edit: (p: typeof fishboneProfile) => void) => {
      const p = clone(fishboneProfile);
      edit(p);
      return isGraphProfile(p);
    };
    expect(bad(() => undefined)).toBe(true);
    expect(bad((p) => (p.nodes.cause!.items!.id = 'missing'))).toBe(false);
    expect(bad((p) => (p.nodes.cause!.items!.id = 'status'))).toBe(false);
    expect(bad((p) => (p.nodes.cause!.items!.refs = ['status']))).toBe(false);
    expect(bad((p) => (p.nodes.cause!.items!.rootRefs = ['notes', 'missing']))).toBe(false);
    // 項目の node type は items@1-draft のコレクションの上限（16）まで
    const many = (n: number) =>
      bad((p) => {
        for (let i = 0; i < n; i++) p.nodes[`c${i}`] = clone(p.nodes.cause!);
      });
    expect(many(15)).toBe(true);
    expect(many(16)).toBe(false);
    // 業務 ID・題・引用の属性は items@1-draft の道筋の一つの区切りになれる名前だけ
    for (const name of ['business.id', '業務ID']) {
      expect(
        bad((p) => {
          p.nodes.cause!.schema[name] = { type: 'string' };
          p.nodes.cause!.items!.id = name;
        }),
      ).toBe(false);
      expect(
        bad((p) => {
          p.nodes.cause!.schema[name] = { type: 'string' };
          p.nodes.cause!.items!.title = name;
        }),
      ).toBe(false);
    }
    expect(bad((p) => Object.assign(p.nodes.cause!.items!, { where: { type: 'cause' } }))).toBe(
      false,
    );
  });

  it('keeps diagrams of the older Profiles as they are: open, validate, save and reload without changes', () => {
    for (const [graph, old] of [
      [older(createFishboneGraph()), fishboneProfileV1],
      [older(createFtaGraph()), ftaProfileV1],
    ] as const) {
      expect(graphProfileFor(graph)).toBe(old);
      expect(validateGraph(graph, old)).toEqual([]);
      const saved = canonicalJson(graph);
      const reloaded = readGraphDocument(JSON.parse(saved));
      expect(canonicalJson(reloaded)).toBe(saved);
      expect(reloaded.profile).toEqual({ id: old.id, version: 1 });
      expect(graphItemsDeclaration(graphProfileFor(reloaded)!)).toBeUndefined();
    }
    expect(evaluateFta(older(createFtaGraph())).ok).toBe(true);
  });

  it('moves an older diagram to the items Profile only by the explicit command, and Undo restores it', () => {
    const before = older(createFishboneGraph());
    const session = new EditorSession(before);
    session.execute(useAnalysisItems(before)!);
    const after = session.content;
    expect(after.profile).toEqual({ id: 'analysis-fishbone', version: 2 });
    expect(
      after.nodes.filter((n) => n.type === 'cause').every((n) => n.attributes.itemId === ''),
    ).toBe(true);
    expect(after.nodes.find((n) => n.type === 'problem')!.attributes.itemId).toBeUndefined();
    expect(validateGraph(after, graphProfileFor(after)!)).toEqual([]);
    session.undo();
    expect(canonicalJson(session.content)).toBe(canonicalJson(before));
    expect(useAnalysisItems(createFishboneGraph())).toBeUndefined();
    const fta = older(createFtaGraph());
    const up = useAnalysisItems(fta)!.apply(clone(fta));
    expect(up.profile.version).toBe(2);
    expect(validateGraph(up, ftaProfile)).toEqual([]);
  });
});
