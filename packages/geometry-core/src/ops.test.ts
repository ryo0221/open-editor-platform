import { describe, expect, it } from 'vitest';
import { f30Fixtures } from './fixtures';
import { geometryNodeKey, validateGeometry, type GeometryGraph } from './ops';

const codes = (graph: GeometryGraph, requests = []) =>
  validateGeometry(graph, requests).map((i) => `${i.code}@${i.node}`);

describe('geometry ops (R2c-1b)', () => {
  it('accepts every F30 fixture', () => {
    for (const [name, f] of Object.entries(f30Fixtures)) {
      const { graph, requests } = f();
      expect(validateGeometry(graph, requests), name).toEqual([]);
    }
  });

  it('refuses missing nodes, cycles, bad loops, frames, vectors and rotations', () => {
    const { graph } = f30Fixtures.boolean();
    expect(
      codes({
        nodes: { ...graph.nodes, x: { op: 'boolean', kind: 'cut', target: 'a', tools: ['q'] } },
      }),
    ).toEqual(['node-missing@x']);
    // A compound needs inputs, and each must exist (R2c-5).
    expect(codes({ nodes: { ...graph.nodes, c: { op: 'compound', inputs: [] } } })).toEqual([
      'node-missing@c',
    ]);
    expect(codes({ nodes: { ...graph.nodes, c: { op: 'compound', inputs: ['a', 'q'] } } })).toEqual(
      ['node-missing@c'],
    );
    expect(
      codes({
        nodes: {
          p: {
            op: 'transform',
            input: 'q',
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [0, 0, 0],
          },
          q: {
            op: 'transform',
            input: 'p',
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [0, 0, 0],
          },
        },
      }),
    ).toContain('node-cycle@p');
    const prism = (patch: object) =>
      ({
        nodes: {
          p: {
            op: 'prism' as const,
            frame: { origin: [0, 0, 0], x: [1, 0, 0], z: [0, 0, 1] },
            outer: [
              [0, 0],
              [10, 0],
              [10, 10],
            ],
            vector: [0, 0, 10],
            ...patch,
          },
        },
      }) as GeometryGraph;
    expect(codes(prism({}))).toEqual([]);
    expect(
      codes(
        prism({
          outer: [
            [0, 0],
            [10, 0],
          ],
        }),
      ),
    ).toEqual(['loop-invalid@p']);
    // Two arcs make a circle; a repeated vertex is no edge.
    expect(
      codes(
        prism({
          outer: [
            [0, 0, 1],
            [10, 0, 1],
          ],
        }),
      ),
    ).toEqual([]);
    expect(
      codes(
        prism({
          outer: [
            [0, 0],
            [0, 0],
            [10, 0],
            [10, 10],
          ],
        }),
      ),
    ).toEqual(['loop-invalid@p']);
    expect(
      codes(
        prism({
          outer: [
            [0, 0, 2],
            [10, 0, 1],
          ],
        }),
      ),
    ).toEqual(['bulge-invalid@p']);
    expect(codes(prism({ frame: { origin: [0, 0, 0], x: [1, 0, 1], z: [0, 0, 1] } }))).toEqual([
      'frame-invalid@p',
    ]);
    expect(codes(prism({ vector: [5, 5, 0] }))).toEqual(['vector-in-plane@p']);
    expect(codes(prism({ vector: [0, 0, 2e6] }))).toEqual(['coordinate-range@p']);
    expect(codes(prism({ vector: [0, 0, Number.NaN] }))).toEqual(['not-finite@p']);
    // A mirror is not a placement.
    expect(
      codes({
        nodes: {
          ...prism({}).nodes,
          m: {
            op: 'transform',
            input: 'p',
            rotation: [-1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [0, 0, 0],
          },
        },
      }),
    ).toEqual(['rotation-invalid@m']);
  });

  it('refuses requests it cannot answer', () => {
    const { graph } = f30Fixtures.projection();
    expect(
      validateGeometry(graph, [
        { node: 'z', measure: true },
        { node: 'a', mesh: { deflectionMm: 0, angularDeflectionRad: 0.1 } },
        {
          node: 'a',
          projection: {
            direction: [0, 0, -1],
            up: [0, 0, 1],
            deflectionMm: 0.5,
            angularDeflectionRad: 0.1,
          },
        },
      ]).map((i) => i.code),
    ).toEqual(['node-missing', 'request-invalid', 'request-invalid']);
  });

  it('keys a node by its content and its children, not by IDs or key order', () => {
    const { graph } = f30Fixtures.boolean();
    const renamed: GeometryGraph = {
      nodes: {
        first: graph.nodes.a!,
        second: graph.nodes.b!,
        c: { tools: ['second'], target: 'first', kind: 'cut', op: 'boolean' },
      },
    };
    expect(geometryNodeKey(renamed, 'c')).toBe(geometryNodeKey(graph, 'cut'));
    expect(geometryNodeKey(graph, 'cut')).not.toBe(geometryNodeKey(graph, 'common'));
  });

  it('treats only own keys as nodes, so inherited names are missing', () => {
    const { graph } = f30Fixtures.boolean();
    for (const name of ['toString', '__proto__', 'constructor'])
      expect(
        validateGeometry(graph, [{ node: name, measure: true }]).map((i) => i.code),
        name,
      ).toContain('node-missing');
  });

  const transform = (input: string): GeometryGraph['nodes'][string] => ({
    op: 'transform' as const,
    input,
    rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    translation: [0, 0, 1],
  });

  it('walks a long chain without recursion', () => {
    const { graph } = f30Fixtures.prism();
    const base = Object.keys(graph.nodes)[0]!;
    const nodes: GeometryGraph['nodes'] = { ...graph.nodes };
    let last = base;
    for (let i = 0; i < 20_000; i++) {
      nodes[`t${i}`] = transform(last);
      last = `t${i}`;
    }
    expect(validateGeometry({ nodes }, [])).toEqual([]);
    expect(geometryNodeKey({ nodes }, last).split('\n')).toHaveLength(20_001);
    nodes[base] = transform(last);
    expect(codes({ nodes })).toContain(`node-cycle@${base}`);
  });

  it('writes a node read many times once in the key', () => {
    const { graph } = f30Fixtures.prism();
    const nodes: GeometryGraph['nodes'] = { ...graph.nodes };
    let last = Object.keys(graph.nodes)[0]!;
    // Each level reads the one below twice: 2^30 paths, 31 distinct nodes.
    for (let i = 0; i < 30; i++) {
      nodes[`u${i}`] = { op: 'boolean', kind: 'union', target: last, tools: [last] };
      last = `u${i}`;
    }
    expect(validateGeometry({ nodes }, [])).toEqual([]);
    expect(geometryNodeKey({ nodes }, last).length).toBeLessThan(10_000);
  });
});
