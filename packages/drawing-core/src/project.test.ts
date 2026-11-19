import { describe, expect, it } from 'vitest';
import { circleOf, drawingProject, drawingViewAxes, type DrawingMeshBody } from './project';
import { box, cylinder } from './test-shapes';
import {
  drawingCadViewGraphics,
  drawingFitScale,
  drawingProjectedSize,
  drawingThreeViewLayout,
} from './view-graphics';

// DW2 (docs/cad/drawing-editor.md, 寸法のアンカー). ST-701, TS-2403.

describe('projection (DW2)', () => {
  it('has the JIS third-angle frames: right is +x in front, top and bottom views', () => {
    expect(drawingViewAxes('front').right).toEqual([1, 0, 0]);
    expect(drawingViewAxes('top').right).toEqual([1, 0, 0]);
    expect(drawingViewAxes('right').right).toEqual([0, 1, 0]);
    expect(drawingViewAxes('top').up).toEqual([0, 1, 0]);
    const iso = drawingViewAxes('iso');
    expect(iso.up[2]).toBeGreaterThan(0.8);
  });

  it('draws a box front view: 4 visible edges; the back ones coincide and are left out', () => {
    const p = drawingProject([box(40, 20, 10)], 'front', {
      step: 0.5,
      hidden: true,
      centers: false,
    });
    const visible = p.lines.filter((l) => !l.hidden);
    const hidden = p.lines.filter((l) => l.hidden);
    // Front face's 4 edges are visible; the 4 back edges lie under them (JIS: the visible line
    // is drawn).
    expect(new Set(visible.map((l) => (l.anchor as { edge: number }).edge)).size).toBe(4);
    expect(hidden).toEqual([]);
    expect(p.bounds).toEqual([
      [0, 0],
      [40, 10],
    ]);
  });

  it('hides part of an edge behind another body, keeping the anchor path', () => {
    const back = { ...box(40, 10, 10, [0, 50, 0]), bodyId: 'back', path: ['c-back'] };
    const front = { ...box(10, 10, 20, [15, 0, 0]), bodyId: 'front', path: ['c-front'] };
    const p = drawingProject([back, front], 'front', { step: 0.25, hidden: true, centers: false });
    // The back box's top edge (z=10, y=50 front side) runs behind the front box from x=15 to 25.
    const top = p.lines.filter(
      (l) => l.anchor.path[0] === 'c-back' && l.points.every((q) => Math.abs(q[1] - 10) < 1e-9),
    );
    const hiddenLen = top
      .filter((l) => l.hidden && Math.abs(l.points[0]![0] - l.points.at(-1)![0]) < 15)
      .reduce((s, l) => s + Math.abs(l.points.at(-1)![0] - l.points[0]![0]), 0);
    expect(hiddenLen).toBeGreaterThan(9);
    expect(hiddenLen).toBeLessThan(11);
  });

  it('outlines a cylinder side-on with silhouettes, and draws its axis and centre cross', () => {
    const side = drawingProject([cylinder(10, 30)], 'front', {
      step: 0.5,
      hidden: false,
      centers: true,
    });
    const sil = side.lines.filter((l) => l.anchor.kind === 'silhouette');
    const xs = sil.map((l) => Math.round(l.points[0]![0]));
    expect(xs.sort((a, b) => a - b)).toEqual([-10, 10]);
    expect(side.centers).toHaveLength(1);
    expect(side.centers[0]!.anchor).toEqual({
      kind: 'axis',
      path: ['c-1'],
      bodyId: 'cyl',
      edge: 0,
    });
    const end = drawingProject([cylinder(10, 30)], 'top', {
      step: 0.5,
      hidden: false,
      centers: true,
    });
    expect(end.lines.filter((l) => l.anchor.kind === 'silhouette')).toEqual([]);
    // The two circles share one centre cross.
    expect(end.centers).toHaveLength(2);
  });

  it.each([0, Math.PI / 48])(
    'meets the two sides of a seam (roundoff) and of an edge-on strip (offset %f, Codex on #1203)',
    (offset) => {
      // As a kernel mesh: the seam's column repeated at 2π, in Float32. With the offset, the
      // strips at x = ±10 lie along the view.
      const n = 48;
      const pts: number[] = [];
      for (let i = 0; i <= n; i++) {
        const t = offset + (2 * Math.PI * i) / n;
        pts.push(10 * Math.cos(t), 10 * Math.sin(t), 0, 10 * Math.cos(t), 10 * Math.sin(t), 30);
      }
      const indices: number[] = [];
      const faces: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = 2 * i;
        const b = 2 * (i + 1);
        indices.push(a, b, b + 1, a, b + 1, a + 1);
        faces.push(0, 0);
      }
      const body: DrawingMeshBody = {
        path: [],
        bodyId: 'cyl',
        positions: Float32Array.from(pts),
        indices,
        faces,
        edges: [],
      };
      const p = drawingProject([body], 'front', { step: 0.5, hidden: false, centers: false });
      const xs = p.lines
        .filter((l) => l.anchor.kind === 'silhouette')
        .map((l) => Math.round(l.points[0]![0]));
      expect(xs.sort((a, b) => a - b)).toEqual([-10, 10]);
    },
  );

  it('recognises circles and refuses other polylines', () => {
    const pts: number[] = [];
    for (let i = 0; i <= 24; i++) pts.push(5 + 3 * Math.cos(i / 4), 2, 3 * Math.sin(i / 4));
    const c = circleOf(pts)!;
    expect(c.r).toBeCloseTo(3, 6);
    expect(c.c.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([5, 2, 0]);
    expect(Math.abs(c.n[1])).toBeCloseTo(1, 6);
    expect(circleOf([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0])).toBeUndefined();
  });
});

describe('views on the paper (DW2)', () => {
  it('keeps a hidden line as one polyline, so its dashes run along it', () => {
    // A box hides the far edge of a smaller box behind it seen from the front.
    const r = drawingProject([box(10, 10, 10), box(20, 4, 4, [-5, 20, 3])], 'front', {
      step: 0.1,
      hidden: true,
      centers: false,
    });
    const hidden = r.lines.filter((l) => l.hidden);
    expect(hidden.length).toBeGreaterThan(0);
    for (const l of hidden) expect(l.points.length).toBeLessThan(5);
    const g = drawingCadViewGraphics(
      { at: [100, 100], scale: '2:1', hiddenLines: true, centerLines: true },
      r,
    );
    expect(g.items.every((i) => i.type === 'polyline')).toBe(true);
    // The projected box's centre sits at `at`: x from −5 to 15, z from 0 to 10.
    expect(g.bounds[0][0]).toBeCloseTo(100 - 20, 6);
    expect(g.bounds[1][1]).toBeCloseTo(100 + 10, 6);
  });

  it('lays out three views in third and first angle, at the largest scale that fits', () => {
    const b: [[number, number, number], [number, number, number]] = [
      [0, 0, 0],
      [100, 50, 20],
    ];
    const sizes = {
      front: drawingProjectedSize(b, 'front'),
      top: drawingProjectedSize(b, 'top'),
      right: drawingProjectedSize(b, 'right'),
    };
    expect(sizes).toEqual({ front: [100, 20], top: [100, 50], right: [50, 20] });
    const area = { x: 0, y: 0, width: 380, height: 200 };
    const scale = drawingFitScale(sizes, area);
    expect(scale).toBe('2:1');
    const third = drawingThreeViewLayout(sizes, scale, area, 'third-angle');
    expect(third.top[0]).toBe(third.front[0]);
    expect(third.top[1]).toBeGreaterThan(third.front[1]);
    expect(third.right[0]).toBeGreaterThan(third.front[0]);
    const first = drawingThreeViewLayout(sizes, scale, area, 'first-angle');
    expect(first.top[1]).toBeLessThan(first.front[1]);
    expect(first.right[0]).toBeLessThan(first.front[0]);
  });
});
