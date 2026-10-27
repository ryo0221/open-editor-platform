import { describe, expect, it } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import {
  arrangeGraph,
  createRelationGraph,
  graphCommand,
  relationProfile,
  validateGraph,
  type GraphDocument,
} from './headless';

/** Production > (Frontend → Backend), with an outside Cloud that Backend calls. */
function architecture(): GraphDocument {
  const g = createRelationGraph();
  const named = (name: string) => ({ name });
  g.sections = [
    { id: 'prod', type: 'group', attributes: named('Production') },
    { id: 'front', type: 'group', attributes: named('Frontend'), parentId: 'prod' },
    { id: 'back', type: 'group', attributes: named('Backend'), parentId: 'prod' },
  ];
  g.presentation.sections = {
    prod: { x: 0, y: 0, width: 100, height: 100 },
    front: { x: 0, y: 0, width: 50, height: 50 },
    back: { x: 0, y: 0, width: 50, height: 50 },
  };
  g.nodes = [
    { id: 'web', type: 'entity', attributes: named('Web'), sectionId: 'front' },
    { id: 'api', type: 'entity', attributes: named('API'), sectionId: 'back' },
    { id: 'db', type: 'entity', attributes: named('Database'), sectionId: 'back' },
    { id: 'cloud', type: 'entity', attributes: named('Payments') },
  ];
  const rel = (id: string, from: string, to: string) => ({
    id,
    type: 'related',
    from,
    to,
    attributes: {},
  });
  g.edges = [rel('e1', 'web', 'api'), rel('e2', 'api', 'db'), rel('e3', 'api', 'cloud')];
  g.presentation.nodes = {};
  return g;
}
const inside = (
  p: { x: number; y: number },
  size: { width: number; height: number },
  f: { x: number; y: number; width: number; height: number },
) =>
  p.x >= f.x &&
  p.y >= f.y &&
  p.x + size.width <= f.x + f.width &&
  p.y + size.height <= f.y + f.height;

describe('arrangeGraph', () => {
  it('places members inside their Sections, follows connections and keeps membership', () => {
    const g = architecture();
    const intents = arrangeGraph(g);
    expect(intents.map((i) => i.type).sort()).toEqual([
      ...Array(4).fill('move-node'),
      ...Array(3).fill('resize-section'),
    ]);
    const next = graphCommand(relationProfile, intents).apply(g);
    const frame = (id: string) => next.presentation.sections[id],
      at = (id: string) => next.presentation.nodes[id],
      size = { width: 200, height: 70 };
    expect(inside(at('web'), size, frame('front'))).toBe(true);
    expect(inside(at('api'), size, frame('back'))).toBe(true);
    expect(inside(at('db'), size, frame('back'))).toBe(true);
    expect(inside(frame('front'), frame('front'), frame('prod'))).toBe(true);
    expect(inside(frame('back'), frame('back'), frame('prod'))).toBe(true);
    // Frontend → Backend left to right; API → Database inside Backend; the Cloud after Production.
    expect(frame('front').x).toBeLessThan(frame('back').x);
    expect(at('api').x).toBeLessThan(at('db').x);
    expect(at('cloud').x).toBeGreaterThanOrEqual(frame('prod').x + frame('prod').width);
    // Nothing overlaps at the top level.
    expect(frame('prod').x + frame('prod').width).toBeLessThanOrEqual(at('cloud').x);
    expect(next.nodes.map((n) => n.sectionId)).toEqual(g.nodes.map((n) => n.sectionId));
    expect(next.edges).toEqual(g.edges);
    expect(
      validateGraph(next, relationProfile).filter((d) => d.code === 'outside-section'),
    ).toEqual([]);
    // Arranging again changes nothing, and the result does not depend on old positions.
    expect(arrangeGraph(next)).toEqual([]);
    const moved = clone(g);
    moved.presentation.nodes.web = { x: 9000, y: 9000 };
    expect(graphCommand(relationProfile, arrangeGraph(moved)).apply(moved).presentation).toEqual(
      next.presentation,
    );
  });

  it('uses the drawn node sizes and keeps cycles finite', () => {
    const g = architecture();
    g.edges.push({ id: 'loop', type: 'related', from: 'db', to: 'web', attributes: {} });
    const tall = arrangeGraph(g, { nodeSize: () => ({ width: 300, height: 140 }) });
    const next = graphCommand(relationProfile, tall).apply(g);
    const f = next.presentation.sections.back;
    expect(inside(next.presentation.nodes.db, { width: 300, height: 140 }, f)).toBe(true);
  });

  it('keeps a loop back to an earlier step from reordering the steps', () => {
    const g = createRelationGraph();
    g.sections = [];
    g.presentation.sections = {};
    g.nodes = ['start', 'step', 'check', 'done'].map((id) => ({
      id,
      type: 'entity',
      attributes: { name: id },
    }));
    const rel = (from: string, to: string) => ({
      id: `${from}-${to}`,
      type: 'related',
      from,
      to,
      attributes: {},
    });
    g.edges = [
      rel('start', 'step'),
      rel('step', 'check'),
      rel('check', 'done'),
      rel('check', 'step'),
    ];
    g.presentation.nodes = Object.fromEntries(g.nodes.map((n) => [n.id, { x: 5000, y: 5000 }]));
    const p = graphCommand(relationProfile, arrangeGraph(g)).apply(g).presentation.nodes;
    expect(p.start.x).toBeLessThan(p.step.x);
    expect(p.step.x).toBeLessThan(p.check.x);
    expect(p.check.x).toBeLessThan(p.done.x);
  });

  it.each([
    ['a chain', true],
    ['unconnected nodes', false],
  ])('wraps %s of 1,000 nodes inside the coordinate limit', (_, chained) => {
    const g = createRelationGraph();
    g.sections = [];
    g.presentation.sections = {};
    g.nodes = Array.from({ length: 1000 }, (_, i) => ({
      id: `n${i}`,
      type: 'entity',
      attributes: { name: `n${i}` },
    }));
    g.edges = chained
      ? g.nodes.slice(1).map((n, i) => ({
          id: `e${i}`,
          type: 'related',
          from: `n${i}`,
          to: n.id,
          attributes: {},
        }))
      : [];
    g.presentation.nodes = {};
    const next = graphCommand(relationProfile, arrangeGraph(g)).apply(g);
    const xs = Object.values(next.presentation.nodes);
    expect(Math.max(...xs.map((p) => p.x))).toBeLessThan(30_000);
    expect(Math.max(...xs.map((p) => p.y))).toBeLessThan(30_000);
  });

  it('keeps shapes and styles while it moves nodes', () => {
    const g = architecture();
    g.presentation.nodes.db = { x: 0, y: 0, shape: 'cylinder', style: { fill: '#dcfce7' } };
    const next = graphCommand(relationProfile, arrangeGraph(g)).apply(g);
    expect(next.presentation.nodes.db).toMatchObject({
      shape: 'cylinder',
      style: { fill: '#dcfce7' },
    });
  });
});
