import { describe, expect, it } from 'vitest';
import { bimElementMass, deriveBim, type BimDocument } from '@editor-platform/bim-core';
import {
  BoxIndex,
  checkCranes,
  checkCranesInSlices,
  f87Building,
  f87OfficeCranes,
  f160ClimbingCrane,
  f161RaisedRoof,
  scheduleConstruction,
  siteTerrain,
  type Box,
  type ConstructionDocument,
  type CraneWorld,
  type LiftBody,
} from './index';

/** Bodies as boxes, from the derived shapes (as the crane tests do). */
function world(bim: BimDocument, doc: ConstructionDocument): CraneWorld {
  const derived = deriveBim(bim);
  const terrain = siteTerrain(doc.site);
  const bodies = new Map<string, LiftBody>();
  for (const [id, s] of derived.shapes) {
    if (s.kind === 'column') {
      const p = s.profile as { widthMm?: number; depthMm?: number; diameterMm?: number };
      const w = (p.widthMm ?? p.diameterMm ?? 500) / 2;
      const d = (p.depthMm ?? p.diameterMm ?? 500) / 2;
      bodies.set(id, {
        bounds: [
          [s.at[0] - w, s.at[1] - d, s.zBase],
          [s.at[0] + w, s.at[1] + d, s.zTop],
        ],
      });
    } else if (s.kind === 'beam') {
      const half = 200;
      bodies.set(id, {
        bounds: [
          [
            Math.min(s.start[0], s.end[0]) - half,
            Math.min(s.start[1], s.end[1]) - half,
            s.zTop - 600,
          ],
          [Math.max(s.start[0], s.end[0]) + half, Math.max(s.start[1], s.end[1]) + half, s.zTop],
        ],
      });
    } else if (s.kind === 'slab') {
      const xs = s.boundary.map((p) => p[0]);
      const ys = s.boundary.map((p) => p[1]);
      bodies.set(id, {
        bounds: [
          [Math.min(...xs), Math.min(...ys), s.zBottom],
          [Math.max(...xs), Math.max(...ys), s.zTop],
        ],
      });
    }
  }
  return {
    bodies,
    mass: (id) => {
      const m = bimElementMass(bim, derived, id);
      return m.status === 'ok' ? { kg: m.kg } : { reason: m.status };
    },
    ground: (p) => terrain.heightAt(p),
  };
}

describe('TT4 the crane check through a grid index (ST-803, TS-2607)', () => {
  it('finds every box near the query, the long ones always (ST-803#1)', () => {
    const boxes: (Box | undefined)[] = [
      [
        [0, 0, 0],
        [1000, 1000, 1000],
      ],
      [
        [20000, 0, 0],
        [21000, 1000, 1000],
      ],
      undefined,
      // 2 km long: kept apart, returned for every query.
      [
        [-1e6, 0, 0],
        [1e6, 100, 100],
      ],
      [
        [4000, 4000, 4000],
        [6000, 6000, 6000],
      ],
    ];
    const index = new BoxIndex(boxes, 5000, 64);
    const q = (b: Box) => index.query(b).sort((x, y) => x - y);
    // By cell: the boxes sharing the query's 5 m cell, never the one 20 m off.
    expect(
      q([
        [100, 100, 100],
        [200, 200, 200],
      ]),
    ).toEqual([0, 3, 4]);
    expect(
      q([
        [20500, 500, 500],
        [20600, 600, 600],
      ]),
    ).toEqual([1, 3]);
    expect(
      q([
        [5500, 5500, 5500],
        [5600, 5600, 5600],
      ]),
    ).toEqual([3, 4]);
    expect(
      q([
        [-50000, -50000, -50000],
        [50000, 50000, 50000],
      ]),
    ).toEqual([0, 1, 3, 4]);
    // Each item once, however many cells it shares with the query.
    expect(
      index.query([
        [0, 0, 0],
        [30000, 30000, 30000],
      ]).length,
    ).toBe(4);
    // A thin box padded inside out (low above high) still finds the cells at both its ends.
    const thin = new BoxIndex(
      [
        [
          [4990, 0, 0],
          [5010, 100, 100],
        ],
      ],
      5000,
      64,
    );
    expect(
      thin.query([
        [5004, 0, 0],
        [4996, 100, 100],
      ]),
    ).toEqual([0]);
    // Extra items join the result once, with the ones found.
    expect(
      index
        .query(
          [
            [100, 100, 100],
            [200, 200, 200],
          ],
          [0, 1, 1, 3],
        )
        .sort((x, y) => x - y),
    ).toEqual([0, 1, 3, 4]);
  });

  it('gives the same problems, in the same order, as testing every standing body (ST-803#2)', () => {
    const bim = f87Building();
    const cases: ConstructionDocument[] = [f87OfficeCranes(bim), f160ClimbingCrane(bim)];
    // A clashing plan: picks inside the frame, an overloaded far lift, a raised roof lifted low.
    const bad = f87OfficeCranes(bim);
    bad.site!.lifts!.forEach(
      (l, k) => (l.pick = [5000 + (k % 7) * 8000, 4000 + (k % 5) * 9000, 0]),
    );
    cases.push(bad);
    const raised = f161RaisedRoof(bim);
    raised.site!.lifts!.push({
      id: 'lift-roof',
      craneId: 'tc-1',
      taskId: 'roof',
      elementId: 'r-roof',
      pick: [52000, 11000, 1000],
    });
    cases.push(raised);
    let problems = 0;
    for (const doc of cases) {
      const plan = scheduleConstruction(doc);
      const w = world(bim, doc);
      const a = checkCranes(doc, plan, w);
      expect(a).toEqual(checkCranes(doc, plan, w, { index: false }));
      problems += a.length;
    }
    expect(problems).toBeGreaterThan(10);
  }, 120_000);
});

describe('#1334 the crane check in slices (ST-805, TS-2609)', () => {
  it('gives the same problems, in the same order, pausing between slices (ST-805#1)', async () => {
    const bim = f87Building();
    const doc = f87OfficeCranes(bim);
    // A clashing plan, so that there is something to find.
    doc.site!.lifts!.forEach(
      (l, k) => (l.pick = [5000 + (k % 7) * 8000, 4000 + (k % 5) * 9000, 0]),
    );
    const plan = scheduleConstruction(doc);
    const w = world(bim, doc);
    const whole = checkCranes(doc, plan, w);
    expect(whole.length).toBeGreaterThan(10);
    let pauses = 0;
    const seen: number[] = [];
    const sliced = await checkCranesInSlices(doc, plan, w, {
      sliceMs: 0,
      pause: async () => void pauses++,
      onProgress: (done) => seen.push(done),
    });
    expect(sliced).toEqual(whole);
    // With no time to a slice, a pause after every lift but the last.
    expect(pauses).toBe(doc.site!.lifts!.length - 1);
    expect(seen.slice(0, 3)).toEqual([1, 2, 3]);
  }, 120_000);

  it('stops between slices when asked (ST-805#2)', async () => {
    const bim = f87Building();
    const doc = f87OfficeCranes(bim);
    const plan = scheduleConstruction(doc);
    const w = world(bim, doc);
    const abort = new AbortController();
    let pauses = 0;
    await expect(
      checkCranesInSlices(doc, plan, w, {
        sliceMs: 0,
        signal: abort.signal,
        pause: async () => {
          if (++pauses === 3) abort.abort(new Error('stopped'));
        },
      }),
    ).rejects.toThrow('stopped');
    expect(pauses).toBe(3);
  }, 120_000);
});
