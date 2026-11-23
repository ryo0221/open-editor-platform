import { describe, expect, it } from 'vitest';
import {
  isGraphDocument,
  isGraphProfile,
  validateGraph,
} from '@editor-platform/structured-graph/model';
import {
  createFishboneGraph,
  createFtaGraph,
  evaluateFta,
  formatProbability,
  fishboneProfile,
  ftaProfile,
} from './analysis-graph-templates';

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
