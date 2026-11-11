import { describe, expect, it } from 'vitest';
import { gearMeshProblems, gearTrainRatios } from './gear-mesh';
import { parameterValues } from './graph';
import { coupledJointValues } from './joints';
import {
  sk01Escapement,
  sk01EscapeOutline,
  sk01EscapePhase,
  sk01Layout,
  sk01Movement,
  sk01Stones,
  sk01Case,
  sk01Exploded,
  sk01Hands,
  sk01Watch,
  sk01FinishTile,
  type Sk01Finish,
} from './sk01';
import { sk01FinishImages } from './sk01-finish';
import type { CadAssetRef } from './model';
import { matchingConfigurations } from './configurations';
import { applyCadOperation } from './operations';
import { validateCad } from './validation';

type Pt = [number, number];
const turn = (p: Pt, about: Pt, a: number): Pt => {
  const [x, y] = [p[0] - about[0], p[1] - about[1]];
  return [
    about[0] + x * Math.cos(a) - y * Math.sin(a),
    about[1] + x * Math.sin(a) + y * Math.cos(a),
  ];
};
/** Whether two simple polygons overlap (an edge crossing, or one inside the other). */
function overlap(a: Pt[], b: Pt[]) {
  const cross = (o: Pt, p: Pt, q: Pt) =>
    (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const meet = (p1: Pt, p2: Pt, q1: Pt, q2: Pt) =>
    cross(p1, p2, q1) * cross(p1, p2, q2) < 0 && cross(q1, q2, p1) * cross(q1, q2, p2) < 0;
  const inside = (p: Pt, poly: Pt[]) => {
    let n = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [u, v] = [poly[i]!, poly[j]!];
      if (
        u[1] > p[1] !== v[1] > p[1] &&
        p[0] < ((v[0] - u[0]) * (p[1] - u[1])) / (v[1] - u[1]) + u[0]
      )
        n++;
    }
    return n % 2 === 1;
  };
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++)
      if (meet(a[i]!, a[(i + 1) % a.length]!, b[j]!, b[(j + 1) % b.length]!)) return true;
  return inside(a[0]!, b) || inside(b[0]!, a);
}

describe('WM5a SK-01 movement (ST-447, TS-1896)', () => {
  it('meshes the train from the escape wheel: a minute for the fourth wheel, an hour, twelve', () => {
    const { assembly } = sk01Movement();
    expect(assembly.gearMeshes?.map((m) => m.id)).toEqual([
      'mesh-escape-fourth',
      'mesh-fourth-third',
      'mesh-third-centre',
      'mesh-centre-barrel',
      'mesh-cannon-minute',
      'mesh-minute-hour',
    ]);
    const ratio = Object.fromEntries(
      gearTrainRatios(assembly, 'j-escape').map((r) => [r.joint, r.ratio]),
    );
    // 12 turns of the escape wheel (a minute at 28,800 beats an hour) per turn of the fourth.
    expect(ratio['j-fourth']).toBeCloseTo(-1 / 12, 12);
    expect(ratio['j-centre']).toBeCloseTo(-1 / 720, 12);
    expect(ratio['j-hour']).toBeCloseTo(-1 / 8640, 12);
    expect(ratio['j-barrel']).toBeCloseTo(1 / 5760, 12);
    expect(ratio['j-minute']).toBeCloseTo(1 / 2160, 12);
    // The balance and the fork are keyed (WM4), not driven.
    expect(Object.keys(ratio)).not.toContain('j-balance');
    expect(Object.keys(ratio)).not.toContain('j-pallet');
  });

  it('keeps the pallet stones clear of the teeth through two beats of the WM4 motion', () => {
    const e = sk01Escapement;
    const pivot: Pt = [e.pallet, 0];
    const phase = sk01EscapePhase();
    const teeth = sk01EscapeOutline();
    const stones = sk01Stones();
    const problems: string[] = [];
    let deepest = 0;
    for (let i = 0; i <= 400; i++) {
      // Through each impulse the fork swings across while the wheel turns half a tooth.
      const t = (2 * i) / 400;
      const k = Math.min(1, Math.floor(t));
      const s = t - k;
      const side = (j: number) => (j % 2 ? e.forkAngle : -e.forkAngle);
      const fork = side(k) + (side(k + 1) - side(k)) * s;
      const wheel = phase + ((k + s) * Math.PI) / e.teeth;
      const outline = teeth.map((p) => turn(p, [0, 0], wheel));
      for (const [name, q] of Object.entries(stones)) {
        const placed = q.map((p) => turn(p, pivot, fork));
        if (overlap(outline, placed)) problems.push(`${name} at ${t.toFixed(3)}`);
        deepest = Math.max(deepest, e.tip - Math.min(...placed.map((p) => Math.hypot(...p))));
      }
    }
    expect(problems).toEqual([]);
    // Each stone does reach below the tips when its side is down.
    expect(deepest).toBeCloseTo(e.dip, 2);
  });

  it('fits a 30 mm movement', () => {
    const r = Math.max(...Object.values(sk01Layout.arbors).map((p) => Math.hypot(...p)));
    expect(r + sk01Escapement.rim.outer).toBeLessThan(sk01Layout.plate.radius);
    const { parts } = sk01Movement();
    expect(parts.map((p) => p.key)).toEqual([
      'plate',
      'train-bridge',
      'barrel-bridge',
      'balance-cock',
      'barrel',
      'centre',
      'third',
      'fourth',
      'escape',
      'pallet',
      'balance',
      'minute',
      'hour',
    ]);
  });
});

describe('WM5b SK-01 watch: case, hands and forms (ST-448, TS-1898)', () => {
  it('validates, and keeps the hands inside the chapter ring and off each other’s arbors', () => {
    const w = sk01Watch();
    expect(validateCad(w.assembly).map((d) => d.code)).toEqual([]);
    expect(w.parts.map((p) => p.key).slice(13)).toEqual([
      'case',
      'bezel',
      'case-back',
      'chapter-ring',
    ]);
    const L = sk01Layout;
    const H = L.z.hands;
    // The hands sweep inside the chapter ring, and the hour and minute hands pass over the
    // fourth arbor's end (it stops at the seconds hand) with room to spare.
    for (const h of Object.values(sk01Hands))
      expect(h.length).toBeLessThan(sk01Case.chapterRing.inner);
    expect(Math.hypot(...L.arbors.fourth) + sk01Hands.seconds.length).toBeLessThan(
      sk01Case.chapterRing.inner,
    );
    expect(H.hour[1]).toBeLessThan(H.seconds[0] - 0.05);
    expect(H.minute[1]).toBeLessThan(H.hour[0] - 0.05);
    // Below the minute pinion and the hour wheel; the chapter ring under the plate.
    expect(H.seconds[1]).toBeLessThan(L.z.minute.pinion[0]);
    expect(L.z.chapterRing[1]).toBeLessThan(L.plate.z[0]);
    // The case's rings clear the plate and each other.
    expect(sk01Case.inner).toBeGreaterThan(L.plate.radius);
    expect(sk01Case.bezel[1]).toBeLessThan(sk01Case.middle[0]);
    expect(sk01Case.back[0]).toBeGreaterThan(sk01Case.middle[1]);
    expect(sk01Case.front.z[1]).toBeLessThan(H.minute[0]);
  });

  it('turns the hands with the train: twelve hours on the hour hand is one turn', () => {
    const { assembly } = sk01Watch();
    const ratio = Object.fromEntries(
      gearTrainRatios(assembly, 'j-escape').map((r) => [r.joint, r.ratio]),
    );
    // Seconds on the fourth arbor, minutes on the centre, hours on the hour wheel.
    expect([ratio['j-fourth'], ratio['j-centre'], ratio['j-hour']].map((r) => 1 / r!)).toEqual([
      expect.closeTo(-12, 9),
      expect.closeTo(-720, 9),
      expect.closeTo(-8640, 9),
    ]);
  });

  it('recalls Exploded as one edit, lifting the bridges, back and bezel, and Assembled again', () => {
    const { assembly, solve } = sk01Watch();
    expect(matchingConfigurations(assembly)).toEqual(['form-assembled']);
    // The poses as the joints place them (an edit leaves solving to the app).
    const z = (d: typeof assembly, c: string) => solve(d).poses[c]!.translationMm[2];
    const exploded = applyCadOperation(assembly, {
      type: 'recallConfiguration',
      id: 'form-exploded',
    });
    expect(matchingConfigurations(exploded)).toEqual(['form-exploded']);
    for (const [key, d] of Object.entries(sk01Exploded))
      expect(z(exploded, `c-${key}`) - z(assembly, `c-${key}`)).toBeCloseTo(d, 9);
    // The wheels and the plate stay where they are.
    for (const c of ['c-plate', 'c-centre', 'c-balance', 'c-case'])
      expect(solve(exploded).poses[c] ?? null).toEqual(solve(assembly).poses[c] ?? null);
    const back = applyCadOperation(exploded, { type: 'recallConfiguration', id: 'form-assembled' });
    expect(matchingConfigurations(back)).toEqual(['form-assembled']);
  });
});

describe('WM5c SK-01 at 0, 30 and 60 s of the escapement (ST-449, TS-1901)', () => {
  it('keeps every wheel at its ratio and in mesh, the seconds hand a turn a minute', () => {
    const { assembly, lookup, solve } = sk01Watch();
    // 28,800 beats an hour: 8 a second, each half a tooth of the 20-tooth escape wheel.
    const escapeAt = (s: number) => (8 * s * Math.PI) / 20;
    // Each mesh has its phase offset (the teeth between each other's at rest): turns are counted
    // from the values at 0 s.
    const at0 = new Map<string, number>();
    for (const s of [0, 30, 60]) {
      const doc = structuredClone(assembly);
      doc.joints.find((j) => j.id === 'j-escape')!.values = {
        angle: { literalRad: escapeAt(s) },
      };
      doc.solvedPoses = solve(doc).poses;
      expect(gearMeshProblems(doc, solve(doc), lookup).size, `${s} s`).toBe(0);
      const v = coupledJointValues(doc, parameterValues(doc));
      const turns = (j: string) => {
        const t = v.get(j)!.angle! / (2 * Math.PI);
        if (!at0.has(j)) at0.set(j, t);
        return t - at0.get(j)!;
      };
      // Escape 12 turns a minute; seconds (fourth) one; minutes (centre) 1/60; hours 1/720.
      expect(turns('j-escape')).toBeCloseTo(s / 5, 9);
      expect(turns('j-fourth')).toBeCloseTo(-s / 60, 9);
      expect(turns('j-centre')).toBeCloseTo(-s / 3600, 9);
      expect(turns('j-hour')).toBeCloseTo(-s / 43200, 9);
    }
  });
});

describe('WM6a SK-01 finishes (ST-452, TS-1906)', () => {
  const ref = (id: string, n: number): CadAssetRef => ({
    id,
    kind: 'texture-png',
    sha256: `sha256:${String(n).repeat(64)}`,
    byteLength: 1000 + n,
    mediaType: 'image/png',
  });
  const finish: Sk01Finish = {
    perlage: { color: ref('tex-perlage-color', 1), normal: ref('tex-perlage-normal', 2) },
    cotes: { color: ref('tex-cotes-color', 3), normal: ref('tex-cotes-normal', 4) },
  };
  it('chamfers the top edges of the plate and bridges, every edge of the outline and windows', () => {
    const { parts } = sk01Movement();
    for (const [key, d] of [
      ['plate', 0.08],
      ['train-bridge', 0.06],
      ['barrel-bridge', 0.06],
      ['balance-cock', 0.06],
    ] as const) {
      const doc = parts.find((p) => p.key === key)!.content;
      const chamfer = doc.features.find((f) => f.type === 'chamfer');
      expect(chamfer?.name, key).toBe('Anglage');
      if (chamfer?.type !== 'chamfer') continue;
      expect(chamfer.args.distance).toEqual({ literalMm: d });
      const sketch = doc.sketches[0]!;
      const sides = sketch.entities.filter((e) => e.type !== 'point').length;
      expect(chamfer.args.edges.length, key).toBe(sides);
      expect(chamfer.args.edges.every((e) => e.name.some((f) => f[0] === 'end'))).toBe(true);
      expect(validateCad(doc), key).toEqual([]);
    }
  });
  it('maps perlage on the plate and Côtes de Genève on the bridges, ruby clear', () => {
    const { parts, assembly } = sk01Watch(undefined, finish);
    expect(validateCad(assembly)).toEqual([]);
    const plate = parts.find((p) => p.key === 'plate')!.content;
    const main = plate.bodies.find((b) => b.name === 'Main plate')!;
    expect(main.appearance.textures).toMatchObject({
      maps: { color: 'tex-perlage-color', normal: 'tex-perlage-normal' },
      sizeMm: [sk01FinishTile.perlage, sk01FinishTile.perlage],
      normal: 'gl',
    });
    expect(plate.assets.map((a) => a.id).sort()).toEqual([
      'tex-perlage-color',
      'tex-perlage-normal',
    ]);
    for (const key of ['train-bridge', 'barrel-bridge', 'balance-cock']) {
      const doc = parts.find((p) => p.key === key)!.content;
      expect(doc.bodies[0]!.appearance.textures?.maps, key).toEqual({
        color: 'tex-cotes-color',
        normal: 'tex-cotes-normal',
      });
      expect(validateCad(doc)).toEqual([]);
    }
    const jewel = plate.bodies.find((b) => b.name.startsWith('Jewel'))!;
    expect(jewel.appearance).toMatchObject({ transmission: 0.6, ior: 1.77 });
    // Without the finish the parts carry no assets.
    expect(sk01Watch().parts.every((p) => p.content.assets.length === 0)).toBe(true);
  });
  it('draws seamless decoration images', () => {
    const size = 64;
    const all = sk01FinishImages(size);
    for (const [name, img] of [
      ['perlage color', all.perlage.color],
      ['perlage normal', all.perlage.normal],
      ['cotes color', all.cotes.color],
      ['cotes normal', all.cotes.normal],
    ] as const) {
      expect(img.rgb.length).toBe(size * size * 3);
      // Opposite edges differ no more than neighbouring columns or rows do inside.
      const px = (x: number, y: number) => img.rgb[(y * size + x) * 3]!;
      let wrap = 0;
      let inner = 0;
      for (let y = 0; y < size; y++) {
        wrap = Math.max(wrap, Math.abs(px(size - 1, y) - px(0, y)));
        inner = Math.max(inner, Math.abs(px(size / 2, y) - px(size / 2 - 1, y)));
      }
      expect(wrap, name).toBeLessThanOrEqual(Math.max(inner, 8) * 1.5);
    }
    expect(sk01FinishImages(size)).toEqual(all);
    expect(() => sk01FinishImages(8)).toThrow('sk01-finish-size');
  });
});
