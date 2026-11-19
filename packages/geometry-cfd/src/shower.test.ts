import { describe, expect, it } from 'vitest';
import { CfdError } from './errors';
import { runShower, showerStates, type ShowerInput, type ShowerSeal } from './shower';
import type { Vec3 } from './triangle-grid';
import type { TriangleSurface } from './voxelize';

/** A plate over [x0, x1] × [y0, y1] at height z(x, y), n × m cells, wound up (+z). */
function plate(
  x: [number, number],
  y: [number, number],
  z: (x: number, y: number) => number,
  n = 20,
  m = 20,
  down = false,
): TriangleSurface {
  const positions: number[] = [];
  const triangles: number[] = [];
  for (let j = 0; j <= m; j++)
    for (let i = 0; i <= n; i++) {
      const px = x[0] + ((x[1] - x[0]) * i) / n;
      const py = y[0] + ((y[1] - y[0]) * j) / m;
      positions.push(px, py, z(px, py));
    }
  for (let j = 0; j < m; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      if (down) triangles.push(a, a + n + 2, a + 1, a, a + n + 1, a + n + 2);
      else triangles.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1);
    }
  return { positions: new Float64Array(positions), triangles: new Uint32Array(triangles) };
}

const tan30 = Math.tan(Math.PI / 6);
const nozzle = (origin: Vec3, over: Partial<ShowerInput> = {}): ShowerInput => ({
  surface: plate([-100, 100], [0, 200], (_, y) => y * tan30),
  seals: [],
  emitters: [
    {
      kind: 'nozzle',
      origin,
      direction: [0, 0, -1],
      coneDeg: 0,
      speedMmPerS: 1000,
      flowLPerMin: 0.1,
    },
  ],
  durationS: 4,
  stepS: 0.002,
  particlesPerS: 200,
  emitUntilS: 0.5,
  ...over,
});

/** A square ribbon of side 2h round (cx, cy) on the plane z(x, y), 12 mm high, `leak` per point. */
function squareSeal(
  cx: number,
  cy: number,
  h: number,
  z: (x: number, y: number) => number,
  leak: (p: Vec3) => boolean,
): ShowerSeal {
  const ribbon: ShowerSeal['ribbon'][number][] = [];
  const corners: [number, number][] = [
    [cx - h, cy - h],
    [cx + h, cy - h],
    [cx + h, cy + h],
    [cx - h, cy + h],
  ];
  for (let c = 0; c < 4; c++) {
    const [a, b] = [corners[c]!, corners[(c + 1) % 4]!];
    for (let k = 0; k < 20; k++) {
      const x = a[0] + ((b[0] - a[0]) * k) / 20;
      const y = a[1] + ((b[1] - a[1]) * k) / 20;
      const base: Vec3 = [x, y, z(x, y)];
      ribbon.push({ base, top: [x, y, base[2] + 12], leak: leak(base) });
    }
  }
  return { id: 'square', ribbon };
}

/** A ribbon round the loop `corners` (x, y; anticlockwise or not) on z(x, y), `height` high. */
function loopSeal(
  corners: [number, number][],
  z: (x: number, y: number) => number,
  leak: (p: Vec3) => boolean,
  height = 12,
): ShowerSeal {
  const ribbon: ShowerSeal['ribbon'][number][] = [];
  for (let c = 0; c < corners.length; c++) {
    const [a, b] = [corners[c]!, corners[(c + 1) % corners.length]!];
    const n = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4));
    for (let k = 0; k < n; k++) {
      const x = a[0] + ((b[0] - a[0]) * k) / n;
      const y = a[1] + ((b[1] - a[1]) * k) / n;
      const base: Vec3 = [x, y, z(x, y)];
      ribbon.push({ base, top: [x, y, base[2] + height], leak: leak(base) });
    }
  }
  return { id: 'loop', ribbon };
}

/** A vertical plate in x = 0 over y ∈ [−50, 50], z ∈ [0, 200], wound towards +x. */
function wall(): TriangleSurface {
  const positions: number[] = [];
  const triangles: number[] = [];
  const n = 10;
  const m = 20;
  for (let j = 0; j <= m; j++)
    for (let i = 0; i <= n; i++) positions.push(0, -50 + (100 * i) / n, (200 * j) / m);
  for (let j = 0; j < m; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      // (0, dy, 0) × (0, 0, dz) = +x.
      triangles.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1);
    }
  return { positions: new Float64Array(positions), triangles: new Uint32Array(triangles) };
}

describe('runShower (VS10a)', () => {
  it('runs film down a tilted plate along its slope, then drops it off the low edge', () => {
    // TS-2255, ST-631: a 30° plate (z = y · tan 30°), a nozzle straight down at y = 120.
    const frames: { t: number; p: Float32Array; s: Uint8Array }[] = [];
    const r = runShower(
      nozzle([0, 120, 200], {
        frameEvery: 250,
        onFrame: (f) => frames.push({ t: f.timeS, p: f.positions, s: f.states }),
      }),
    );
    expect(r.particles).toBe(100);
    // Every particle ran off the low edge (y = 0) and fell below the plate.
    expect(r.counts.drained).toBe(100);
    expect(r.counts.pond + r.counts.film + r.counts.entered).toBe(0);
    // At 0.5 s the film runs down the slope at 150 · sin 30° = 75 mm/s, on the plate, at x = 0.
    const half = frames.find((f) => Math.abs(f.t - 0.5) < 1e-9)!;
    const film = [...half.s.keys()].filter((i) => showerStates[half.s[i]!] === 'film');
    expect(film.length).toBeGreaterThan(50);
    for (const i of film) {
      const [x, y, z] = [half.p[3 * i]!, half.p[3 * i + 1]!, half.p[3 * i + 2]!];
      expect(Math.abs(x)).toBeLessThan(1e-3);
      expect(y).toBeLessThanOrEqual(120 + 1e-3);
      expect(z).toBeCloseTo(y * tan30, 2);
    }
    // The first particle met the plate at about 0.08 s and has run ≈ 0.42 · 75 mm down the slope.
    const first = film[0]!;
    const along = (120 - half.p[3 * first + 1]!) / Math.cos(Math.PI / 6);
    expect(along).toBeGreaterThan(28);
    expect(along).toBeLessThan(34);
  });

  it('ponds on a level face, and drips from an overhang', () => {
    const level = runShower(
      nozzle([0, 100, 200], { surface: plate([-100, 100], [0, 200], () => 0) }),
    );
    expect(level.counts.pond).toBe(100);
    expect(level.ponds.length).toBe(1);
    expect(level.ponds[0]!.position[1]).toBeCloseTo(100, 6);
    // A plate facing down, sprayed from below: the film is on its underside and drips at once.
    let reached = false;
    const under = runShower(
      nozzle([0, 100, -200], {
        frameEvery: 1,
        onFrame: (f) => {
          for (let i = 0; i < f.states.length; i++)
            if (Math.abs(f.positions[3 * i + 2]!) < 0.5) reached = true;
        },
        surface: plate([-100, 100], [0, 200], () => 0, 20, 20, true),
        emitters: [
          {
            kind: 'nozzle',
            origin: [0, 100, -200],
            direction: [0, 0, 1],
            coneDeg: 0,
            speedMmPerS: 3000,
            flowLPerMin: 0.1,
          },
        ],
      }),
    );
    expect(under.counts.drained).toBe(100);
    // They met the underside first (Codex on #1269: a drop under the surfaces going up lives on).
    expect(reached).toBe(true);
  });

  it('stops film at a closed seal and lets it in where the seal leaks', () => {
    // TS-2255: a 5° plate (falling to −y) with a square seal of side 80 round (0, 100); water
    // lands uphill of it at y = 170 and runs down onto its back side (y = 140).
    const z = (_: number, y: number) => y * Math.tan((5 * Math.PI) / 180);
    const surface = plate([-100, 100], [0, 200], z, 40, 40);
    const shut = runShower(
      nozzle([0, 170, 200], { surface, seals: [squareSeal(0, 100, 40, z, () => false)] }),
    );
    expect(shut.counts.entered).toBe(0);
    expect(shut.enteredBySeal.square).toBe(0);
    // Held against the back of the ribbon: it ponds there.
    expect(shut.counts.pond).toBe(100);
    for (const p of shut.ponds) expect(p.position[1]).toBeGreaterThan(139);
    // The back side open between x = −10 and 10: the water goes in there.
    const open = runShower(
      nozzle([0, 170, 200], {
        surface,
        seals: [squareSeal(0, 100, 40, z, (p) => p[1] > 139 && Math.abs(p[0]) <= 10)],
      }),
    );
    expect(open.counts.entered).toBe(100);
    expect(open.entries.every((e) => e.sealId === 'square')).toBe(true);
    expect(open.enteredBySeal.square).toBeCloseTo(100 * open.particleVolumeMm3, 6);
    for (const e of open.entries) {
      expect(Math.abs(e.position[0])).toBeLessThanOrEqual(10);
      expect(e.position[1]).toBeCloseTo(140, 6);
    }
  });

  it('keeps film on the back of a face it hit at the end of a step, and holds it at a ribbon', () => {
    // Codex on #1269: a drop meets the wall (wound to +x) on its back at exactly 10 steps; the
    // film runs down the back onto a closed ribbon standing out towards −x at z = 100.
    const seal: ShowerSeal = {
      id: 'loop',
      ribbon: [
        [-40, 100],
        [40, 100],
        [40, 60],
        [-40, 60],
      ].flatMap(([y0, z0], c, all) => {
        const [y1, z1] = all[(c + 1) % all.length]!;
        return Array.from({ length: 20 }, (_, k) => {
          const base: Vec3 = [0, y0! + ((y1! - y0!) * k) / 20, z0! + ((z1! - z0!) * k) / 20];
          return {
            base,
            top: [-12, base[1], base[2]] as Vec3,
            normal: [-1, 0, 0] as Vec3,
            leak: false,
          };
        });
      }),
    };
    const r = runShower(
      nozzle([-20, 0, 150], {
        surface: wall(),
        seals: [seal],
        emitters: [
          {
            kind: 'nozzle',
            origin: [-20, 0, 150],
            direction: [1, 0, 0],
            coneDeg: 0,
            speedMmPerS: 1000,
            flowLPerMin: 0.1,
          },
        ],
        emitUntilS: 0.05,
        durationS: 2,
      }),
    );
    expect(r.particles).toBe(10);
    expect(r.counts.pond).toBe(10);
    for (const p of r.ponds) expect(p.position[2]).toBeGreaterThan(99);
  });

  it('holds a drop at a closed seal just past a leaking one it fell out of in the same step', () => {
    // Codex on #1271: at 20 ms steps a drop falls out of a leaking loop (low side z = 100.3) and
    // onto a closed one (top side z = 100) in one step.
    const loop = (id: string, top: number, bottom: number, leak: boolean): ShowerSeal => ({
      id,
      ribbon: [
        [-40, top],
        [40, top],
        [40, bottom],
        [-40, bottom],
      ].flatMap(([y0, z0], c, all) => {
        const [y1, z1] = all[(c + 1) % all.length]!;
        return Array.from({ length: 20 }, (_, k) => {
          const base: Vec3 = [0, y0! + ((y1! - y0!) * k) / 20, z0! + ((z1! - z0!) * k) / 20];
          return { base, top: [-12, base[1], base[2]] as Vec3, leak };
        });
      }),
    });
    const r = runShower(
      nozzle([-5, 0, 130], {
        surface: wall(),
        seals: [loop('open', 150, 100.3, true), loop('shut', 100, 60, false)],
        emitters: [
          {
            kind: 'nozzle',
            origin: [-5, 0, 130],
            direction: [0, 0, -1],
            coneDeg: 0,
            speedMmPerS: 100,
            flowLPerMin: 0.1,
          },
        ],
        emitUntilS: 0.1,
        durationS: 1,
        stepS: 0.02,
      }),
    );
    expect(r.counts.entered).toBe(0);
    expect(r.counts.pond).toBe(r.particles);
    for (const q of r.ponds) expect(q.position[2]).toBeCloseTo(100, 3);
  });

  it('holds a drop falling onto a closed seal and lets it in through a leaking one', () => {
    // VS10b: a drop falling down the gap beside the wall (x = −5) meets the ribbon standing out
    // 12 mm from it at z = 100.
    const seal = (leak: boolean): ShowerSeal => ({
      id: 'loop',
      ribbon: [
        [-40, 100],
        [40, 100],
        [40, 60],
        [-40, 60],
      ].flatMap(([y0, z0], c, all) => {
        const [y1, z1] = all[(c + 1) % all.length]!;
        return Array.from({ length: 20 }, (_, k) => {
          const base: Vec3 = [0, y0! + ((y1! - y0!) * k) / 20, z0! + ((z1! - z0!) * k) / 20];
          return { base, top: [-12, base[1], base[2]] as Vec3, leak };
        });
      }),
    });
    const fall = (leak: boolean) =>
      runShower(
        nozzle([-5, 0, 190], {
          surface: wall(),
          seals: [seal(leak)],
          emitters: [
            {
              kind: 'nozzle',
              origin: [-5, 0, 190],
              direction: [0, 0, -1],
              coneDeg: 0,
              speedMmPerS: 100,
              flowLPerMin: 0.1,
            },
          ],
          emitUntilS: 0.05,
          durationS: 1,
        }),
      );
    const held = fall(false);
    expect(held.counts.pond).toBe(held.particles);
    for (const p of held.ponds) expect(p.position[2]).toBeCloseTo(100, 3);
    const open = fall(true);
    expect(open.counts.entered).toBe(open.particles);
  });

  it('counts water in through a concave seal’s notch', () => {
    // Codex on #1269: a U-shaped loop (its notch x ∈ [−15, 15], y ∈ [0, 40] open at y = 40),
    // all leaking, on a 5° plate falling to −y: water landing in the notch runs over its bottom
    // edge (y = 0) into the loop.
    const z = (_: number, y: number) => y * Math.tan((5 * Math.PI) / 180);
    const u: [number, number][] = [
      [-40, -40],
      [40, -40],
      [40, 40],
      [15, 40],
      [15, 0],
      [-15, 0],
      [-15, 40],
      [-40, 40],
    ];
    const r = runShower(
      nozzle([0, 130, 200], {
        surface: plate([-100, 100], [0, 200], z, 40, 40),
        seals: [
          loopSeal(
            u.map(([x, y]) => [x, y + 100]),
            z,
            () => true,
          ),
        ],
        emitUntilS: 0.05,
        durationS: 3,
        stepS: 0.01,
      }),
    );
    expect(r.counts.entered).toBe(r.particles);
    for (const e of r.entries) expect(e.position[1]).toBeCloseTo(100, 6);
  });

  it('runs short film steps off a free edge, and stops at a seal pressed nearly flat', () => {
    // Codex on #1269: on a 5° plate at 2 ms steps the film moves 0.026 mm a step.
    const z = (_: number, y: number) => y * Math.tan((5 * Math.PI) / 180);
    const surface = plate([-100, 100], [0, 200], z, 40, 40);
    const off = runShower(
      nozzle([0, 20, 200], { surface, emitUntilS: 0.05, durationS: 3, stepS: 0.002 }),
    );
    expect(off.counts.drained).toBe(off.particles);
    // A closed ribbon 0.25 mm high still holds the water.
    const flat = runShower(
      nozzle([0, 170, 200], {
        surface,
        seals: [
          loopSeal(
            [
              [-40, 60],
              [40, 60],
              [40, 140],
              [-40, 140],
            ],
            z,
            () => false,
            0.25,
          ),
        ],
        emitUntilS: 0.05,
        durationS: 4,
        stepS: 0.01,
      }),
    );
    expect(flat.counts.pond).toBe(flat.particles);
    for (const p of flat.ponds) expect(p.position[1]).toBeGreaterThan(139);
  });

  it('holds film at a closed ribbon just past an open one it left in the same step', () => {
    // Codex on #1269: on the 30° plate at 10 ms steps the film moves 0.75 mm a step; it starts in
    // an open loop whose low side (y = 140.2) is 0.2 mm above a closed ribbon's back (y = 140).
    const z = (_: number, y: number) => y * tan30;
    const surface = plate([-100, 100], [0, 200], z, 40, 40);
    const closed = loopSeal(
      [
        [-40, 60],
        [40, 60],
        [40, 140],
        [-40, 140],
      ],
      z,
      () => false,
    );
    const open = {
      ...loopSeal(
        [
          [-20, 140.2],
          [20, 140.2],
          [20, 180],
          [-20, 180],
        ],
        z,
        () => true,
      ),
      id: 'open',
    };
    const r = runShower(
      nozzle([0, 160, 300], {
        surface,
        seals: [open, closed],
        emitUntilS: 0.05,
        durationS: 4,
        stepS: 0.01,
      }),
    );
    expect(r.counts.entered).toBe(0);
    expect(r.counts.pond).toBe(r.particles);
    for (const q of r.ponds) expect(q.position[1]).toBeGreaterThan(139.9);
  });

  it('holds film at a wall standing across the face', () => {
    // Codex on #1269: a 40 mm wall across the 30° plate at y = 100 (through it, z 37.7..97.7).
    const z = (_: number, y: number) => y * tan30;
    const base = plate([-100, 100], [0, 200], z, 40, 40);
    const positions = [...base.positions];
    const triangles = [...base.triangles];
    const first = positions.length / 3;
    const z0 = z(0, 100) - 20;
    positions.push(-100, 100, z0, 100, 100, z0, 100, 100, z0 + 60, -100, 100, z0 + 60);
    triangles.push(first, first + 1, first + 2, first, first + 2, first + 3);
    const surface = {
      positions: new Float64Array(positions),
      triangles: new Uint32Array(triangles),
    };
    const r = runShower(nozzle([0, 170, 300], { surface, emitUntilS: 0.05, durationS: 3 }));
    expect(r.counts.pond).toBe(r.particles);
    for (const q of r.ponds) expect(q.position[1]).toBeGreaterThan(99.9);
  });

  it('drops film through a slit between two pieces narrower than a step', () => {
    // Codex on #1269: two 30° plates 0.4 mm apart; the film moves 0.75 mm a step. A wall across
    // the lower one at y = 50 would hold film that crossed the slit.
    const z = (_: number, y: number) => y * tan30;
    const low = plate([-100, 100], [0, 99.8], z, 20, 20);
    const high = plate([-100, 100], [100.2, 200], z, 20, 20);
    const n = low.positions.length / 3;
    const z0 = z(0, 50) - 20;
    const surface = {
      positions: new Float64Array([
        ...low.positions,
        ...high.positions,
        ...[-100, 50, z0, 100, 50, z0, 100, 50, z0 + 60, -100, 50, z0 + 60],
      ]),
      triangles: new Uint32Array([
        ...low.triangles,
        ...[...high.triangles].map((v) => v + n),
        ...[0, 1, 2, 0, 2, 3].map((v) => v + 2 * n),
      ]),
    };
    const r = runShower(
      nozzle([0, 170, 300], { surface, emitUntilS: 0.05, durationS: 4, stepS: 0.01 }),
    );
    expect(r.counts.drained).toBe(r.particles);
  });

  it('ends at the duration asked for, the last step cut short', () => {
    // Codex on #1269: 0.015 s at 0.01 s steps; a drop 300 mm over the plate cannot reach it.
    const frames: number[] = [];
    const r = runShower(
      nozzle([0, 100, 400], {
        emitUntilS: 0.01,
        durationS: 0.015,
        stepS: 0.01,
        frameEvery: 1,
        onFrame: (f) => frames.push(f.timeS),
      }),
    );
    expect(frames).toEqual([0.01, 0.015]);
    expect(r.counts.drop).toBe(r.particles);
  });

  it('drops film off a sharp bend rather than wrapping it round', () => {
    // Codex on #1269: a 30° plate bends down to 80° at y = 100; water lands at y = 101.
    const top = 100 * tan30;
    const tan80 = Math.tan((80 * Math.PI) / 180);
    const z = (_: number, y: number) => (y >= 100 ? y * tan30 : top - (100 - y) * tan80);
    const surface = plate([-100, 100], [80, 200], z, 20, 120);
    const states: number[] = [];
    runShower(
      nozzle([0, 101, 300], {
        surface,
        emitUntilS: 0.01,
        durationS: 0.5,
        stepS: 0.01,
        frameEvery: 1,
        onFrame: (f) => states.push(f.states[0] ?? -1),
      }),
    );
    // Drop, film on the 30° plate, then a drop again at the bend.
    const film = states.indexOf(1);
    expect(film).toBeGreaterThanOrEqual(0);
    expect(states.indexOf(0, film)).toBeGreaterThan(film);
  });

  it('sprays off a surface a nozzle sits on', () => {
    // Codex on #1269: a nozzle on a level plate aimed up flies, not sticking to the underside.
    const r = runShower(
      nozzle([0, 100, 0], {
        surface: plate([-100, 100], [0, 200], () => 0),
        emitters: [
          {
            kind: 'nozzle',
            origin: [0, 100, 0],
            direction: [0, 0, 1],
            coneDeg: 0,
            speedMmPerS: 3000,
            flowLPerMin: 0.1,
          },
        ],
        emitUntilS: 0.01,
        durationS: 0.1,
        stepS: 0.002,
      }),
    );
    expect(r.counts.drop).toBe(r.particles);
  });

  it('runs film on into a valley however long the step', () => {
    // Codex on #1269: a 60° slope turning to 30° at y = 100; at 50 ms steps the lifted ray meets
    // the 30° face, which is the way on, not a wall.
    const tan60 = Math.tan(Math.PI / 3);
    const z = (_: number, y: number) => (y <= 100 ? y * tan30 : 100 * tan30 + (y - 100) * tan60);
    const surface = plate([-100, 100], [0, 200], z, 20, 200);
    const end: number[] = [];
    runShower(
      nozzle([0, 110, 600], {
        surface,
        emitUntilS: 0.05,
        durationS: 1,
        stepS: 0.05,
        frameEvery: 1,
        onFrame: (f) => (end[0] = f.positions[1]!),
      }),
    );
    expect(end[0]).toBeLessThan(90);
  });

  it('drops film into a slot it would step over', () => {
    // Codex on #1277: a 2 mm slot across the 30° plate (y 100..102), the plate joined round its
    // ends; at 20 ms steps and 1000 mm/s the film moves 10 mm a step. A wall at y = 50 would hold
    // film that stepped over the slot.
    const z = (_: number, y: number) => y * tan30;
    const parts = [
      plate([-100, 100], [0, 100], z, 20, 50),
      plate([-100, 100], [102, 200], z, 20, 49),
      plate([-110, -100], [0, 200], z, 1, 100),
      plate([100, 110], [0, 200], z, 1, 100),
    ];
    const positions: number[] = [];
    const triangles: number[] = [];
    for (const q of parts) {
      const n = positions.length / 3;
      positions.push(...q.positions);
      for (const t of q.triangles) triangles.push(t + n);
    }
    const n = positions.length / 3;
    const z0 = z(0, 50) - 20;
    positions.push(-100, 50, z0, 100, 50, z0, 100, 50, z0 + 60, -100, 50, z0 + 60);
    triangles.push(n, n + 1, n + 2, n, n + 2, n + 3);
    const surface = {
      positions: new Float64Array(positions),
      triangles: new Uint32Array(triangles),
    };
    const r = runShower(
      nozzle([0, 150, 300], {
        surface,
        emitUntilS: 0.05,
        durationS: 2,
        stepS: 0.02,
        filmSpeedMmPerS: 1000,
      }),
    );
    expect(r.counts.drained).toBe(r.particles);
  });

  it('emits every particle due whatever the step', () => {
    // Codex on #1269: a running sum of 10 × 0.01 fell just short of 1 at the end.
    const count = (particlesPerS: number, stepS: number) =>
      runShower(nozzle([0, 100, 200], { particlesPerS, stepS, emitUntilS: 1, durationS: 2 }))
        .particles;
    expect(count(10, 0.01)).toBe(10);
    expect(count(1, 0.1)).toBe(1);
    expect(count(10, 0.02)).toBe(10);
  });

  it('starts rain over its rectangle at its rate', () => {
    const r = runShower({
      surface: plate([-100, 100], [0, 200], () => 0),
      seals: [],
      emitters: [
        {
          kind: 'rain',
          rateMmPerH: 36,
          direction: [0, 0, -1],
          speedMmPerS: 6000,
          min: [-50, 50],
          max: [50, 150],
          heightMm: 300,
        },
      ],
      durationS: 1,
      stepS: 0.005,
      particlesPerS: 1000,
    });
    // 36 mm/h on 100 × 100 mm: 100 mm³/s over 1000 particles a second.
    expect(r.particleVolumeMm3).toBeCloseTo(0.1, 9);
    expect(r.particles).toBe(1000);
    for (const p of r.ponds) {
      expect(Math.abs(p.position[0])).toBeLessThan(51);
      expect(p.position[1]).toBeGreaterThan(49);
    }
    // The last drops are still falling or have only just met the plate.
    expect(r.counts.drained + r.counts.entered).toBe(0);
    expect(r.counts.pond).toBeGreaterThanOrEqual(940);
  });

  it('refuses runs past its limits and bad emitters', () => {
    expect(() => runShower(nozzle([0, 0, 100], { particlesPerS: 1e6 }))).toThrow(CfdError);
    expect(() => runShower(nozzle([0, 0, 100], { stepS: 0 }))).toThrow(/stepS/);
    expect(() => runShower(nozzle([0, 0, 100], { emitters: [] }))).toThrow(/emitters/);
    // Codex on #1269: NaN settings would hang the ray queries.
    expect(() => runShower(nozzle([0, 0, 100], { filmSpeedMmPerS: NaN }))).toThrow(/filmSpeed/);
    expect(() => runShower(nozzle([0, 0, 100], { stallS: -1 }))).toThrow(/stall/);
    expect(() => runShower(nozzle([0, 0, 100], { gravity: [0, 0, 0] }))).toThrow(/gravity/);
    expect(() =>
      runShower(
        nozzle([0, 0, 100], {
          seals: [{ id: 's', ribbon: [] }],
        }),
      ),
    ).toThrow(/ribbon/);
  });
});
