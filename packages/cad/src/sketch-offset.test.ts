import {
  CadSketchError,
  identityQuaternion,
  position,
  sketchElement,
  sketchOffset,
  splinePoints,
  type CadSketch,
} from '@editor-platform/cad-core';
import { describe, expect, it } from 'vitest';
import { addArc, addLine, addOffset, addSpline, addCircle, solveDraft } from './sketch-draft';

type P = [number, number];
const empty = (): CadSketch => ({
  id: 'sk',
  name: 'Sketch 1',
  plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
  entities: [],
  constraints: [],
  solved: {},
});
/** A chain of lines through `pts` (closed back to the first when `closed`). */
function polyline(pts: P[], closed = false) {
  let s = empty();
  const ids: string[] = [];
  let prev: string | undefined;
  let first: string | undefined;
  pts.forEach((p, i) => {
    if (i === 0) return;
    const a = prev ? { id: prev } : { at: pts[i - 1]! };
    const last = closed && i === pts.length - 1;
    const added = addLine(s, a, { at: p });
    s = added.sketch;
    const line = s.entities.find((e) => e.id === added.id) as { start: string; end: string };
    first ??= line.start;
    prev = line.end;
    ids.push(added.id);
    if (last) {
      const back = addLine(s, { id: prev }, { id: first });
      s = back.sketch;
      ids.push(back.id);
    }
  });
  return { s, ids };
}
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof CadSketchError ? e.code : String(e);
  }
  return 'none';
};
const ends = (s: CadSketch, id: string) => {
  const g = sketchElement(s, id)!;
  return 'a' in g ? [g.a.map(round), g.b.map(round)] : [];
};
const round = (v: number) => Math.round(v * 1e6) / 1e6;
const near = (p: P, q: P) => Math.hypot(p[0] - q[0], p[1] - q[1]);

describe('sketch chain offset (CR3a, 86M5)', () => {
  it('moves a closed rectangle out and in with sharp corners, and refuses one that collapses', () => {
    const { s, ids } = polyline(
      [
        [0, 0],
        [100, 0],
        [100, 50],
        [0, 50],
      ],
      true,
    );
    const out = addOffset(s, ids, 5);
    expect(out.ids).toHaveLength(4);
    expect(out.ids.map((id) => ends(out.sketch, id))).toEqual([
      [
        [-5, -5],
        [105, -5],
      ],
      [
        [105, -5],
        [105, 55],
      ],
      [
        [105, 55],
        [-5, 55],
      ],
      [
        [-5, 55],
        [-5, -5],
      ],
    ]);
    // New elements share their corners and take no constraints; the drawing still solves.
    const lines = out.ids.map((id) => out.sketch.entities.find((e) => e.id === id)) as {
      start: string;
      end: string;
    }[];
    lines.forEach((l, i) => expect(l.end).toBe(lines[(i + 1) % 4]!.start));
    expect(solveDraft(out.sketch, new Map()).dof).toBe(solveDraft(s, new Map()).dof + 8);
    const inner = addOffset(s, ids, -5);
    expect(ends(inner.sketch, inner.ids[0]!)).toEqual([
      [5, 5],
      [95, 5],
    ]);
    expect(code(() => addOffset(s, ids, -30))).toBe('sketch-offset-self-intersects');
    expect(code(() => addOffset(s, ids, -25))).toBe('sketch-offset-self-intersects');
  });

  it('moves an open chain to the left of its first selected element and extends the corner', () => {
    const { s, ids } = polyline([
      [0, 0],
      [100, 0],
      [100, 50],
    ]);
    const l = addOffset(s, ids, 10);
    expect(l.ids.map((id) => ends(l.sketch, id))).toEqual([
      [
        [0, 10],
        [90, 10],
      ],
      [
        [90, 10],
        [90, 50],
      ],
    ]);
    const r = addOffset(s, ids, -10);
    expect(r.ids.map((id) => ends(r.sketch, id))).toEqual([
      [
        [0, -10],
        [110, -10],
      ],
      [
        [110, -10],
        [110, 50],
      ],
    ]);
    // The order of the selection does not matter while its first element runs the same way.
    expect(addOffset(s, [ids[1]!, ids[0]!], 10)).toEqual(l);
  });

  it('keeps lines and arcs of a slot tangent, arcs about their own centres', () => {
    let s = empty();
    const l1 = addLine(s, { at: [0, 0] }, { at: [100, 0] });
    s = l1.sketch;
    const [p1, p2] = ['p1', 'p2'];
    const a1 = addArc(s, { at: [100, 25] }, { id: p2 }, { at: [100, 50] }, false);
    s = a1.sketch;
    const arc1 = s.entities.find((e) => e.id === a1.id) as { end: string; center: string };
    const l2 = addLine(s, { id: arc1.end }, { at: [0, 50] });
    s = l2.sketch;
    const line2 = s.entities.find((e) => e.id === l2.id) as { end: string };
    const a2 = addArc(s, { at: [0, 25] }, { id: line2.end }, { id: p1 }, false);
    s = a2.sketch;
    const ids = [l1.id, a1.id, l2.id, a2.id];
    const out = addOffset(s, ids, 5);
    const kinds = out.ids.map((id) => out.sketch.entities.find((e) => e.id === id)!.type);
    expect(kinds).toEqual(['line', 'arc', 'line', 'arc']);
    expect(ends(out.sketch, out.ids[0]!)).toEqual([
      [0, -5],
      [100, -5],
    ]);
    const moved = out.sketch.entities.find((e) => e.id === out.ids[1]) as { center: string };
    expect(moved.center).toBe(arc1.center);
    const g = sketchElement(out.sketch, out.ids[1]!)!;
    expect(g.type === 'arc' && round(g.r)).toBe(30);
    expect(g.type === 'arc' && round(g.sweep)).toBe(round(Math.PI));
    // Inward past the arcs' radius the arcs vanish.
    expect(code(() => addOffset(s, ids, -25))).toBe('sketch-offset-self-intersects');
    expect(solveDraft(out.sketch, new Map()).sketch.solved).toBeDefined();
  });

  it('grows and shrinks a circle about the same centre point', () => {
    const c = addCircle(empty(), { at: [10, 10] }, 20);
    const out = addOffset(c.sketch, [c.id], 5);
    const e = out.sketch.entities.find((x) => x.id === out.ids[0]) as { center: string };
    expect(e.center).toBe(
      (c.sketch.entities.find((x) => x.id === c.id) as { center: string }).center,
    );
    expect(out.sketch.solved[out.ids[0]!]).toEqual([25, 0]);
    expect(addOffset(c.sketch, [c.id], -5).sketch.solved[out.ids[0]!]).toEqual([15, 0]);
    expect(code(() => addOffset(c.sketch, [c.id], -20))).toBe('sketch-offset-self-intersects');
  });

  it('fits a moved spline within 0.01 mm of the exact offset, its degree kept', () => {
    const poles: P[] = [
      [0, 0],
      [200, 120],
      [450, -40],
      [700, 160],
      [900, 60],
      [1100, 200],
    ];
    const sp = addSpline(
      empty(),
      poles.map((at) => ({ at })),
      3,
      false,
    );
    const out = addOffset(sp.sketch, [sp.id], 8);
    const e = out.sketch.entities.find((x) => x.id === out.ids[0]) as {
      type: string;
      degree: number;
      poles: string[];
    };
    expect(e.type).toBe('spline');
    expect(e.degree).toBe(3);
    const src = sketchElement(sp.sketch, sp.id) as { pts: P[] };
    const dense = splinePoints(poles, 3, false, 256);
    const got = sketchElement(out.sketch, out.ids[0]!) as { pts: P[] };
    // Every point of the result is 8 mm from the source curve (within the fit and the sampling).
    const seg = (a: P, b: P, q: P) => {
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
      const t = Math.max(
        0,
        Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (dx * dx + dy * dy)),
      );
      return near(q, [a[0] + t * dx, a[1] + t * dy]);
    };
    const gap = (q: P) => Math.min(...dense.slice(1).map((b, i) => seg(dense[i]!, b, q)));
    for (const q of splinePoints(
      e.poles.map((id) => out.sketch.solved[id] as P),
      3,
      false,
      16,
    ))
      expect(Math.abs(gap(q) - 8)).toBeLessThan(0.011);
    expect(src.pts.length).toBeGreaterThan(0);
    expect(got.pts.length).toBeGreaterThan(0);
    // Left of its run from the first pole: the start moves along the start normal.
    const start = out.sketch.solved[e.poles[0]!] as P;
    expect(near(start, [0, 0])).toBeCloseTo(8, 6);
    expect(start[1]).toBeGreaterThan(0);
  });

  it('joins a moved spline to a moved line at their corner', () => {
    let s = empty();
    const l = addLine(s, { at: [-300, 0] }, { at: [0, 0] });
    s = l.sketch;
    const line = s.entities.find((e) => e.id === l.id) as { end: string };
    const sp = addSpline(
      s,
      [{ id: line.end }, { at: [100, 100] }, { at: [250, 120] }, { at: [400, 300] }],
      3,
      false,
    );
    s = sp.sketch;
    for (const d of [6, -6]) {
      const out = addOffset(s, [l.id, sp.id], d);
      expect(out.ids).toHaveLength(2);
      const [lineOut, splineOut] = out.ids.map((id) =>
        out.sketch.entities.find((e) => e.id === id),
      ) as unknown as [{ end: string }, { poles: string[] }];
      expect(splineOut.poles[0]).toBe(lineOut.end);
      const corner = out.sketch.solved[lineOut.end] as P;
      expect(round(corner[1])).toBe(d);
    }
  });

  it('goes round the outside of a hairpin with an arc about the corner', () => {
    const { s, ids } = polyline([
      [0, 0],
      [100, 0],
      [0, 1],
    ]);
    const out = addOffset(s, ids, -10);
    const kinds = out.ids.map((id) => out.sketch.entities.find((e) => e.id === id)!.type);
    expect(kinds).toEqual(['line', 'arc', 'line']);
    const arc = out.sketch.entities.find((e) => e.id === out.ids[1]) as { center: string };
    expect(arc.center).toBe('p2');
    const g = sketchElement(out.sketch, out.ids[1]!)!;
    expect(g.type === 'arc' && round(g.r)).toBe(10);
    // Inside the hairpin the moved lines cross before the corner.
    expect(code(() => addOffset(s, ids, 10))).toBe('sketch-offset-self-intersects');
  });

  it('moves a closed spline out, and an arc walked against its own direction to the walk’s left', () => {
    const ring = addSpline(
      empty(),
      [
        [0, 0],
        [80, -10],
        [120, 40],
        [60, 90],
        [-20, 50],
      ].map((at) => ({ at: at as P })),
      3,
      true,
    );
    const out = addOffset(ring.sketch, [ring.id], 4);
    const e = out.sketch.entities.find((x) => x.id === out.ids[0]) as { closed?: boolean };
    expect(e.closed).toBe(true);
    const area = (pts: P[]) =>
      pts.reduce((a, p, i) => {
        const q = pts[(i + 1) % pts.length]!;
        return a + (p[0] * q[1] - p[1] * q[0]) / 2;
      }, 0);
    const before = area((sketchElement(ring.sketch, ring.id) as { pts: P[] }).pts);
    const after = area((sketchElement(out.sketch, out.ids[0]!) as { pts: P[] }).pts);
    expect(after).toBeGreaterThan(before);
    // A line, then an arc drawn the other way (clockwise from its far end back to the line).
    let s = empty();
    const l = addLine(s, { at: [0, 0] }, { at: [100, 0] });
    s = l.sketch;
    const a = addArc(s, { at: [100, 30] }, { at: [100, 60] }, { id: 'p2' }, true);
    s = a.sketch;
    const moved = addOffset(s, [l.id, a.id], 5);
    const g = sketchElement(moved.sketch, moved.ids[1]!)!;
    // Walking from the line the arc turns left (counter-clockwise); its left is the centre side.
    expect(g.type === 'arc' && round(g.r)).toBe(25);
    expect(g.type === 'arc' && g.sweep).toBeGreaterThan(0);
    expect(ends(moved.sketch, moved.ids[0]!)).toEqual([
      [0, 5],
      [100, 5],
    ]);
  });

  it('offsets a construction rectangle, and refuses a closed spline moved in past its collapse (#940 review)', () => {
    const { s, ids } = polyline(
      [
        [0, 0],
        [100, 0],
        [100, 50],
        [0, 50],
      ],
      true,
    );
    const drawn: CadSketch = {
      ...s,
      entities: s.entities.map((e) => (e.type === 'line' ? { ...e, construction: true } : e)),
    };
    const out = addOffset(drawn, ids, 5);
    expect(ends(out.sketch, out.ids[0]!)).toEqual([
      [-5, -5],
      [105, -5],
    ]);
    expect(
      out.ids.every(
        (id) =>
          (out.sketch.entities.find((e) => e.id === id) as { construction?: boolean }).construction,
      ),
    ).toBe(true);
    // Eight poles on a 20 mm circle: 100 mm in has passed through the centre, not a larger loop.
    const ring = addSpline(
      empty(),
      Array.from({ length: 8 }, (_, i) => ({
        at: [20 * Math.cos((i * Math.PI) / 4), 20 * Math.sin((i * Math.PI) / 4)] as P,
      })),
      3,
      true,
    );
    expect(code(() => addOffset(ring.sketch, [ring.id], -100))).toBe(
      'sketch-offset-self-intersects',
    );
    expect(code(() => addOffset(ring.sketch, [ring.id], -5))).toBe('none');
  });

  it('refuses through the core API a result whose first and last pieces cross (#940 review)', () => {
    const { s, ids } = polyline([
      [80, 80],
      [10, 90],
      [10, 30],
      [40, 10],
      [30, 80],
    ]);
    expect(code(() => sketchOffset(s, ids, 10))).toBe('sketch-offset-self-intersects');
    expect(code(() => addOffset(s, ids, 10))).toBe('sketch-offset-self-intersects');
  });

  it('refuses a selection that is not one chain, and a distance out of range', () => {
    const { s, ids } = polyline([
      [0, 0],
      [100, 0],
      [100, 50],
      [200, 50],
    ]);
    expect(code(() => sketchOffset(s, [ids[0]!, ids[2]!], 5))).toBe('sketch-offset-chain');
    expect(code(() => sketchOffset(s, ['p1'], 5))).toBe('sketch-offset-chain');
    expect(code(() => sketchOffset(s, [], 5))).toBe('sketch-offset-chain');
    expect(code(() => sketchOffset(s, ids, 0.05))).toBe('sketch-offset-distance');
    expect(code(() => sketchOffset(s, ids, -201))).toBe('sketch-offset-distance');
    expect(code(() => sketchOffset(s, ids, Number.NaN))).toBe('sketch-offset-distance');
    expect(code(() => sketchOffset(s, ids.slice(0, 1), 200))).toBe('none');
    const c = addCircle(s, { at: [0, 200] }, 10);
    expect(code(() => sketchOffset(c.sketch, [ids[0]!, c.id], 5))).toBe('sketch-offset-chain');
  });

  it('gives the same result for the same input', () => {
    const { s, ids } = polyline([
      [0, 0],
      [100, 20],
      [180, -30],
    ]);
    expect(addOffset(s, ids, 7)).toEqual(addOffset(s, ids, 7));
  });
});
