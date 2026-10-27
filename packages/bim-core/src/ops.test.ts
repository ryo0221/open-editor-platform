import { geometryNodeKey, validateGeometry } from '@editor-platform/geometry-core';
import { describe, expect, it } from 'vitest';
import { f31BoxBuilding, f33Types, f37Office, f39Roofs } from './fixtures';
import { bimGeometry } from './ops';

describe('bim op graph (R2c-3a)', () => {
  const fixtures = {
    f31: f31BoxBuilding,
    f33: f33Types,
    f37: f37Office,
    gable: () => f39Roofs('gable'),
    hip: () => f39Roofs('hip'),
  };

  it('gives every element with a solid a node of a valid graph', () => {
    for (const [name, f] of Object.entries(fixtures)) {
      const doc = f();
      const g = bimGeometry(doc);
      expect(validateGeometry(g.graph, []), name).toEqual([]);
      const solid = doc.elements.filter((e) => e.kind !== 'opening');
      expect([...g.elements.keys()].sort(), name).toEqual(solid.map((e) => e.id).sort());
      for (const [id, el] of g.elements)
        expect(g.graph.nodes[el.node], `${name} ${id}`).toBeDefined();
    }
  });

  it('builds one solid for the windows of one type and size', () => {
    const doc = f33Types();
    const g = bimGeometry(doc);
    const keys = new Set(
      [...g.elements]
        .filter(([id]) => id.startsWith('win-'))
        .map(([, el]) => geometryNodeKey(g.graph, el.node)),
    );
    expect(keys.size).toBe(1);
    // A wider type changes the windows' solid and the wall they open, nothing else.
    const wider = f33Types();
    const t = wider.types.find((x) => x.id === 't-window-600')!;
    if (t.kind === 'window') t.widthMm = 500;
    const h = bimGeometry(wider);
    const before = (id: string) => geometryNodeKey(g.graph, g.elements.get(id)!.node);
    const after = (id: string) => geometryNodeKey(h.graph, h.elements.get(id)!.node);
    expect(doc.elements.filter((e) => before(e.id) !== after(e.id)).length).toBe(41);
  });

  it('shares the columns of one type and height across the office', () => {
    const doc = f37Office();
    const g = bimGeometry(doc);
    const columns = doc.elements.filter((e) => e.kind === 'column');
    const keys = new Set(columns.map((e) => geometryNodeKey(g.graph, g.elements.get(e.id)!.node)));
    expect(columns.length).toBeGreaterThan(100);
    expect(keys.size).toBeLessThanOrEqual(2);
    expect(columns.every((e) => g.elements.get(e.id)!.placement)).toBe(true);
  });

  it('clips walls under a roof and keeps their solid before openings', () => {
    const doc = f39Roofs('gable');
    const g = bimGeometry(doc);
    const clipped = doc.elements.filter((e) => e.kind === 'wall' && e.clipBy);
    expect(clipped.length).toBeGreaterThan(0);
    for (const w of clipped) {
      const el = g.elements.get(w.id)!;
      expect(g.graph.nodes[el.gross!]!.op).toBe('halfSpace');
    }
  });

  it('keeps every element’s nodes apart, whatever its ID holds', () => {
    const doc = f31BoxBuilding();
    const before = bimGeometry(doc);
    const wall = doc.elements.find((e) => e.kind === 'wall')!;
    const slab = doc.elements.find((e) => e.kind === 'slab')!;
    // An ID that looks like another element's node: '#' and ':' are allowed in IDs.
    slab.id = `${wall.id}#prism`;
    const after = bimGeometry(doc);
    expect(validateGeometry(after.graph, [])).toEqual([]);
    const key = (g: typeof after, id: string) => geometryNodeKey(g.graph, g.elements.get(id)!.node);
    expect(key(after, wall.id)).toBe(key(before, wall.id));
    expect(after.elements.get(slab.id)!.node).not.toBe(after.elements.get(wall.id)!.node);
  });
});
