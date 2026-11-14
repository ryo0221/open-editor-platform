import { describe, expect, it } from 'vitest';
import { expandAssembly } from './assembly';
import {
  f63Body,
  f63BodyLayout,
  f63Greenhouse,
  f63SectionScales,
  f63WidthScale,
} from './car-b4-body';
import {
  f63Car,
  f63EndBodies,
  f63Ends,
  f63FaceRef,
  f63Faces,
  f63GlassBodies,
  f63GlassMm,
  f63Layout,
  f63Details,
  f63FittingBodies,
  f63ScreenBodies,
  type F63Face,
} from './car-b4-fixtures';
import type { CadFeature } from './model';
import { parameterValues } from './graph';
import { solveJoints } from './joints';
import { validateCad } from './validation';
import { f25SectionPoints, f25Sections } from './fixtures';
import type { CadSketch } from './sketch';

describe('F63, the whole car (CR7b, TS-1811)', () => {
  const { assembly, closure } = f63Car();
  const lookup = (h: string) => closure.get(h);
  // The kernel test (TS-1810) checks that the body in white gives these frames. Faces of
  // different bodies share names (`side:e:s0`, `-z`): matched by feature and name.
  const body = f63Body();
  const faceFrame = (ref: { featureId?: string; name: unknown }) =>
    (Object.keys(f63Faces) as F63Face[])
      .map((f) => ({ f, r: f63FaceRef(body, f) }))
      .find(
        ({ r }) =>
          r.kind === 'face' &&
          r.featureId === ref.featureId &&
          JSON.stringify(r.name) === JSON.stringify(ref.name),
      )?.f;
  const frameOf = (ref: { featureId?: string; name: unknown }) => {
    const f = faceFrame(ref);
    return f && f63Faces[f].frame;
  };
  const solve = (doc = assembly) =>
    solveJoints(
      doc,
      parameterValues(doc),
      lookup,
      (_at, ref) => {
        const frame = frameOf(ref as { featureId?: string; name: unknown });
        return frame ? { status: 'resolved', frame } : undefined;
      },
      () => true,
    );

  it('is valid and every version it places is in its closure', () => {
    expect(validateCad(assembly)).toEqual([]);
    for (const content of closure.values()) expect(validateCad(content)).toEqual([]);
    const occurrences = expandAssembly(assembly, lookup).occurrences;
    expect(occurrences.every((o) => o.content)).toBe(true);
    // The body in white, 4 closures, 2 seats, 4 lamps, 4 wheels, 2 mirrors and the steering wheel.
    expect(assembly.components.map((c) => c.id).sort()).toEqual(
      [
        'c-biw',
        'c-door',
        'c-door-r',
        'c-hood',
        'c-hood-r',
        'c-headlamp-l',
        'c-headlamp-r',
        'c-mirror-l',
        'c-mirror-r',
        'c-seat-l',
        'c-seat-r',
        'c-steering',
        'c-tail-l',
        'c-tail-r',
        'c-wheel-front-l',
        'c-wheel-front-r',
        'c-wheel-rear-l',
        'c-wheel-rear-r',
      ].sort(),
    );
  });

  it('solves every joint to where each part was placed', () => {
    const solved = solveJoints(
      assembly,
      parameterValues(assembly),
      lookup,
      () => undefined,
      () => true,
    );
    // Without the body in white's frames the face joints wait (the kernel answers them).
    const faceJoints = assembly.joints.filter((j) => j.parent.componentPath[0] === 'c-biw');
    // 2 seats, 4 lamps, 4 wheels and the steering wheel.
    expect(faceJoints.length).toBe(11);
    for (const j of faceJoints) expect(solved.joints[j.id]!.status).toBe('unavailable');
    const result = solve();
    expect(Object.values(result.joints).every((j) => j.status === 'solved')).toBe(true);
    expect(result.mismatch).toEqual([]);
    const near = (id: string, want: number[]) =>
      result.poses[id]!.translationMm.forEach((v, k) =>
        expect(v, `${id} ${k}`).toBeCloseTo(want[k]!, 6),
      );
    const A = f63Layout.axles;
    near('c-wheel-front-l', [A.front, -A.track, A.z]);
    near('c-wheel-rear-r', [A.rear, A.track, A.z]);
    near('c-door', [0, 0, 0]);
    near('c-door-r', [0, 0, 0]);
  });

  // TS-1838 (CR7g-4, E14): the seats slide on their mounts, 0–240 mm forward; 0 is where they
  // were placed (the rearmost slide, CR7d's H-point).
  it('slides each seat forward on its mount within the seat’s travel', () => {
    for (const side of ['l', 'r']) {
      const j = assembly.joints.find((x) => x.id === `j-seat-${side}`)!;
      expect(j.type).toBe('slider');
      expect(j.values).toEqual({ distance: { literalMm: 0 } });
      expect(j.limits).toEqual([{ of: 'distance', min: 0, max: 240 }]);
    }
    const at = solve().poses['c-seat-l']!.translationMm;
    expect(at[0]).toBeCloseTo(f63Layout.seat.x, 6);
    const moved = structuredClone(assembly);
    moved.joints.find((x) => x.id === `j-seat-l`)!.values = { distance: { literalMm: 100 } };
    const result = solve(moved);
    // Solved; the stored pose is the old one until the editor writes the new one back.
    expect(result.joints['j-seat-l']!.status).toBe('solved');
    const after = result.poses['c-seat-l']!.translationMm;
    [at[0] + 100, at[1], at[2]].forEach((v, k) => expect(after[k], `${k}`).toBeCloseTo(v, 6));
  });
  it('names a face for each mount it reads', () => {
    const used = new Set(
      assembly.joints
        .filter((j) => j.parent.componentPath[0] === 'c-biw')
        .map((j) => faceFrame(j.parent.ref as { featureId?: string; name: unknown })),
    );
    expect(used).toEqual(new Set(Object.keys(f63Faces)));
  });
});

describe('F63 finished: paint and side glass (CR7e, TS-1821)', () => {
  const { assembly, closure } = f63Car();
  const body = (id: string) => assembly.bodies.find((b) => b.id === id)!;
  it('paints the outer panels, the doors and the hoods, on both sides', () => {
    for (const id of ['skin-body', 'skin-body-r', 'hatch-body', 'hatch-body-r'])
      expect(body(id).appearance.material).toBe('paint-gloss');
    const parts = assembly.parts.filter((p) => /^part-(door|hood)/.test(p.id));
    expect(parts).toHaveLength(4);
    for (const p of parts) {
      const content = closure.get(p.source.contentHash)!;
      // CR7g-2: the doors' versions also carry their handle.
      expect(
        content.bodies.filter((b) => b.state === 'active').map((b) => b.appearance.material),
      ).toEqual(/door/.test(p.id) ? ['paint-gloss', 'chrome'] : ['paint-gloss']);
    }
  });
  it('glazes both side windows on each side: glass sheets cut from the skin, 4 mm for their mass', () => {
    // CR7g-2 adds the windscreen and rear window (TS-1834).
    const all = [...f63GlassBodies, ...f63ScreenBodies];
    const glass = assembly.bodies.filter((b) => b.appearance.material === 'glass');
    expect(glass.map((b) => b.id).sort()).toEqual([...all, ...all.map((id) => `${id}-r`)].sort());
    for (const b of glass) {
      expect(b.state).toBe('active');
      expect(b.mass).toEqual({ densityKgM3: 2500, material: 'glass', thicknessMm: f63GlassMm });
    }
    // The left glass is the window trim's own sketch, kept inside: one window each.
    const trims = assembly.features.filter(
      (f): f is Extract<CadFeature, { type: 'trim' }> =>
        f.type === 'trim' && (f63GlassBodies as readonly string[]).includes(`${f.id}-body`),
    );
    const windows = assembly.features.find((f) => f.id === 'windows') as Extract<
      CadFeature,
      { type: 'trim' }
    >;
    type Tool = { sketchId: string; elements: string[] };
    const tool = (t: typeof windows) => t.args.tool as Tool;
    expect(trims.map((t) => [t.args.keep, tool(t).sketchId, t.inputFeatureIds])).toEqual(
      trims.map(() => ['inside', tool(windows).sketchId, windows.inputFeatureIds]),
    );
    expect(trims.map((t) => tool(t).elements)).toEqual([
      tool(windows).elements,
      ...(windows.args.chains ?? []),
    ]);
  });
});

describe('F63 closed at both ends (CR7e-2b, TS-1830)', () => {
  const { assembly } = f63Car();
  const sketch = (id: string) => assembly.sketches.find((x) => x.id === id) as CadSketch;
  it('closes each end with a plate cut to the skin’s end section, open for the lamps', () => {
    for (const [id, end, row] of [
      ['front-plate-line', 'front', f25Sections.at(-1)!],
      ['rear-plate-line', 'rear', f25Sections[0]!],
    ] as const) {
      const s = sketch(id);
      // On the end section (the rear plate 2 mm behind it), across the whole width.
      if (!('origin' in s.plane)) throw new Error(`${id} not on a plane`);
      expect(s.plane.origin.map((l) => ('literalMm' in l ? l.literalMm : NaN))).toEqual([
        f63Ends[end].x,
        0,
        0,
      ]);
      // F25's end section as F63 widens it and leans its roof side in (CR7g-1).
      const ends = f25SectionPoints({ w: row.w * f63SectionScales[0] }, row.top, f63Greenhouse);
      const [crown, rocker] = [ends[0]!, ends.at(-1)!];
      const sides = s.entities.filter((e) => e.type === 'spline');
      expect(sides).toHaveLength(2);
      const at = (p: string) => s.solved[p]!;
      const [l, r] = sides as Extract<CadSketch['entities'][number], { type: 'spline' }>[];
      expect(at(l!.poles[0]!)).toEqual(crown);
      expect(at(l!.poles.at(-1)!)).toEqual(rocker);
      expect(at(r!.poles[0]!)).toEqual([-rocker[0], rocker[1]]);
      expect(r!.poles.at(-1)).toBe(l!.poles[0]);
      const plate = assembly.features.find(
        (f): f is Extract<CadFeature, { type: 'extrude' }> =>
          f.type === 'extrude' && 'sketchId' in f.args && f.args.sketchId === id,
      )!;
      const region = (plate.args as { region: { outer: string[]; holes: string[][] } }).region;
      expect(region.outer).toEqual(['side-l', 'bottom', 'side-r']);
      expect(region.holes).toHaveLength(2);
      expect(plate.args.direction).toBe(end === 'front' ? 1 : -1);
    }
  });
  it('adds the grille and both bumpers, in plastic, as the car’s own bodies', () => {
    const bodies = assembly.bodies.filter((b) =>
      (f63EndBodies as readonly string[]).includes(b.id),
    );
    expect(bodies.map((b) => b.id).sort()).toEqual([...f63EndBodies].sort());
    for (const b of bodies) {
      expect(b.state).toBe('active');
      expect(b.mass).toEqual({ densityKgM3: 900, material: 'polypropylene' });
    }
    expect(validateCad(assembly)).toEqual([]);
  });
});

describe('F63 widened (CR7g-1, TS-1831)', () => {
  const { assembly } = f63Car();
  const sketch = (id: string) => assembly.sketches.find((x) => x.id === id) as CadSketch;
  it('widens the skin’s sections, the middle more than the ends, and leans the roof side in', () => {
    expect(f63SectionScales).toHaveLength(f25Sections.length);
    expect(f63SectionScales[0]).toBeLessThan(f63WidthScale);
    expect(f63SectionScales.at(-1)).toBeLessThan(f63WidthScale);
    expect(Math.max(...f63SectionScales)).toBe(f63WidthScale);
    f25Sections.forEach((row, j) => {
      const s = sketch(`section-${j}`);
      const w = row.w * f63SectionScales[j]!;
      // The section's shoulder lies the widened half width out; the roof side half of it.
      const ys = Object.values(s.solved).map(([y]) => y);
      expect(Math.min(...ys)).toBeLessThan(-w + 50);
      expect(f25SectionPoints({ w }, row.top, f63Greenhouse)[1]![0]).toBeCloseTo(-0.5 * w, 6);
    });
  });
  it('lays the body in white, the track and the parts out 1.18 times as wide', () => {
    expect(f63Layout.axles.track).toBe(Math.round(700 * f63WidthScale));
    expect(f63BodyLayout.floor.y).toBe(Math.round(590 * f63WidthScale));
    expect(f63BodyLayout.sill.y0).toBe(Math.round(-700 * f63WidthScale));
    expect(f63Faces.strutLeft.frame.translationMm[1]).toBe(f63BodyLayout.strutMount.centre[1]);
    // The overall width: the widest section, both halves.
    expect(2 * Math.max(...f25Sections.map((r, j) => r.w * f63SectionScales[j]!))).toBeGreaterThan(
      1650,
    );
  });
});

describe('F63 details (CR7g-2, TS-1834)', () => {
  const { assembly, closure } = f63Car();
  const feature = <T extends CadFeature['type']>(id: string) =>
    assembly.features.find((f) => f.id === id) as Extract<CadFeature, { type: T }>;
  type Tool = { sketchId: string; elements: string[] };
  it('cuts the windscreen and rear window from above and glazes them as the side windows', () => {
    const screens = feature<'trim'>('screens');
    expect(screens.args.keep).toBe('outside');
    expect((screens.args.tool as Tool).sketchId).toBe('screen-line');
    expect(screens.args.chains).toHaveLength(f63Details.screens.length - 1);
    // The glass: the same chains, kept inside, from the skin the screens trim cuts.
    f63ScreenBodies.forEach((id, k) => {
      const glass = feature<'trim'>(id.replace('-body', ''));
      expect(glass.args.keep).toBe('inside');
      expect(glass.inputFeatureIds).toEqual(screens.inputFeatureIds);
      expect((glass.args.tool as Tool).elements).toEqual(
        k ? screens.args.chains![k - 1] : (screens.args.tool as Tool).elements,
      );
    });
    // Inside the roof's side (half the widened half width), past the centreline.
    const sketch = assembly.sketches.find((x) => x.id === 'screen-line') as CadSketch;
    const ys = Object.values(sketch.solved).map(([, y]) => y);
    expect(Math.min(...ys)).toBeGreaterThan(-0.5 * 780 * f63SectionScales[5]!);
    expect(Math.max(...ys)).toBeGreaterThan(0);
    // The inner panel opened behind the side windows and the screens.
    expect(feature<'trim'>('inner-windows').args.keep).toBe('outside');
    expect(feature<'trim'>('inner-screens').args.keep).toBe('outside');
  });
  it('keeps the front side window’s top below the roof’s side', () => {
    const front = f63Details.sideWindows[1] as [number, number][];
    // F28's ran to z 1,180 at x 2,600, above the roof's side there (about 1,080).
    const rear = front.filter(([x]) => x >= 2500).map(([, z]) => z);
    expect(Math.max(...rear)).toBeLessThanOrEqual(1050);
  });
  it('puts a handle on each door and the lamps flush with the end plates', () => {
    for (const p of assembly.parts.filter((x) => /^part-door/.test(x.id))) {
      const content = closure.get(p.source.contentHash)!;
      const handle = content.bodies.find((b) => b.name === 'Door handle');
      // Weighed as the rest (CR7a): aluminium for its chrome look.
      expect(handle?.mass?.material).toBe('aluminium');
    }
    // The headlamp's face (its part reaches x +30) on the front plate's face, the tail lamp's
    // (turned, its part reaches −20 behind) on the rear plate's.
    expect(f63Layout.headlamp[0] + 30).toBe(f63Ends.front.x + f63Ends.plateMm);
    expect(f63Layout.tail[0] - 20).toBe(f63Ends.rear.x - f63Ends.plateMm);
  });
  it('adds the exhaust and the number plates as the car’s own bodies', () => {
    const bodies = assembly.bodies.filter((b) =>
      (f63FittingBodies as readonly string[]).includes(b.id),
    );
    expect(bodies.map((b) => b.id).sort()).toEqual([...f63FittingBodies].sort());
    expect(feature<'boolean'>('exhaust').args).toEqual({ mode: 'cut' });
    // Below the rear plate's bottom (the rocker, z 200) and the bumper.
    const x = f63Details.exhaust;
    expect(x.z + x.radius).toBeLessThan(200);
    expect(validateCad(assembly)).toEqual([]);
  });
});
