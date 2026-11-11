import { describe, expect, it } from 'vitest';
import { checkCadInterferenceAlong } from './interference';
import { parameterValues } from './graph';
import { composePoses } from './assembly';
import {
  invertPose,
  jointValues,
  posesForJointValues,
  solveJoints,
  type CadResolvedJointValues,
} from './joints';
import { m1Robot, tr01Robot, tr01Transform } from './mecha-fixtures';
import { check, meshes } from './mecha-test-kit';

type Values = Map<string, CadResolvedJointValues>;
type Stage = (typeof tr01Transform.stages)[number];
type Group = Stage['groups'][number];

/** The joint values of a form, resolved (radians, mm). */
function formValues(f: ReturnType<typeof tr01Robot>, name: string): Values {
  const doc = f.assembly;
  const params = parameterValues(doc);
  const form = doc.configurations!.find((c) => c.name === name)!;
  return new Map(
    doc.joints
      .filter((j) => form.values[j.id])
      .map((j) => [j.id, jointValues({ type: j.type, values: form.values[j.id]! }, params)]),
  );
}
function formMounts(f: ReturnType<typeof tr01Robot>, name: string) {
  const form = f.assembly.configurations!.find((c) => c.name === name)!;
  return new Map(Object.entries(form.mounts ?? {}));
}
/** The values at `t` seconds, from form `a` to form `b`, each group moving linearly. */
function at(a: Values, b: Values, groups: readonly Group[], t: number): Values {
  const out = new Map(a);
  for (const g of groups) {
    const s = Math.min(1, Math.max(0, (t - g.start) / g.length));
    for (const j of g.joints) {
      const from = a.get(j)!;
      const to = b.get(j)!;
      out.set(
        j,
        Object.fromEntries(
          Object.keys(from).map((k) => {
            const key = k as keyof CadResolvedJointValues;
            return [k, from[key]! + (to[key]! - from[key]!) * s];
          }),
        ),
      );
    }
  }
  return out;
}
/**
 * The overlaps and mount jumps along a step sampled every 0.05 s, as "time: pair". The mounts
 * switch at the step's start (`switchAt` 'start') or its end: a sample at that time is taken under
 * the mounts before and after.
 */
function sweep(
  f: ReturnType<typeof tr01Robot>,
  from: string,
  to: string,
  seconds: number,
  groups: readonly Group[],
  switchAt: 'start' | 'end' = 'start',
) {
  // The robot as the step finds it: in its first form's mounts (the forms before put it there).
  const before = formMounts(f, from);
  const doc = {
    ...f.assembly,
    mounts: f.assembly.mounts!.map((m) => ({ ...m, active: before.get(m.id) ?? m.active })),
  };
  const lookup = (h: string) => f.closure.get(h);
  const { joints } = solveJoints(
    doc,
    parameterValues(doc),
    lookup,
    () => undefined,
    () => true,
  );
  const [a, b] = [formValues(f, from), formValues(f, to)];
  const [ma, mb] = [formMounts(f, from), formMounts(f, to)];
  const n = Math.round(seconds * 20);
  const samples = Array.from({ length: n + 1 }, (_, i) => ({
    tick: i * 2 + 1,
    values: at(a, b, groups, i / 20),
    mounts: switchAt === 'start' ? mb : ma,
  }));
  // The other side of the switch, a tick before or after the sample at its time.
  const edge = switchAt === 'start' ? samples[0]! : samples[n]!;
  samples.push({
    ...edge,
    tick: switchAt === 'start' ? 0 : n * 2 + 2,
    mounts: switchAt === 'start' ? ma : mb,
  });
  const r = checkCadInterferenceAlong(
    { doc, lookup, meshesOf: (h) => meshes(f.closure.get(h)!), joints },
    samples,
  );
  if (r.status !== 'ok') return [r.code];
  const time = (tick: number) => Math.max(0, Math.min(n, (tick - 1) / 2)) / 20;
  return [
    ...r.hits.flatMap((h) => h.findings.map((x) => `${time(h.tick)}: ${x.a}–${x.b}`)),
    ...r.jumps.map((j) => `${time(j.tick)}: ${j.mount} jumps ${j.mm.toFixed(1)} mm`),
  ];
}
/** Each step played backwards: from its `to` form to its `from`, each group at the mirrored time. */
function reversed(s: Stage) {
  return {
    ...s,
    from: s.to,
    to: s.from,
    groups: s.groups.map((g) => ({ ...g, start: s.seconds - g.start - g.length })),
  };
}

describe('M2 TR-01 transforming (TS-1715)', () => {
  it('stands and flies clear, the head down in its bay and the wing tips out', () => {
    const f = tr01Robot();
    const forms = f.assembly.configurations!.map((c) => c.name);
    expect(forms).toEqual(['Stand', 'Ready', 'Stow', 'Release', 'Flight']);
    for (const i of forms.keys()) expect(check(f, f.assembly, i)).toEqual([]);
    const names = f.assembly.joints.map((j) => j.id);
    expect(names).toEqual(expect.arrayContaining(['j-head-slide', 'j-wing-ext-l', 'j-wing-ext-r']));
    // Every version carried with it is placed (an import refuses one that is not).
    const used = new Set(
      f.assembly.components.map(
        (c) => f.assembly.parts.find((p) => p.id === c.partId)!.source.contentHash,
      ),
    );
    expect([...f.closure.keys()].filter((h) => !used.has(h))).toEqual([]);
    // The M1 robot is as M1 accepted it.
    expect(m1Robot().assembly.joints.some((j) => j.id === 'j-head-slide')).toBe(false);
  });
  it('finds the arms sweeping through the wings when they rise before the wings open', () => {
    const f = tr01Robot();
    const s = tr01Transform.stages[1]!;
    const early = s.groups.map((g) =>
      g.name === 'Arms' ? { ...g, start: 0 } : g.name === 'Wings' ? { ...g, start: 0.8 } : g,
    );
    const hits = sweep(f, s.from, s.to, s.seconds, early);
    expect(
      hits.some((h) => /c-(upper|fore|hand)-r–c-wing-r|c-rifle–c-wing|c-wing-r–c-rifle/.test(h)),
    ).toBe(true);
  });
});

describe('MR7d TR-01 stowing the rifle and shield, the legs folding (TS-1720)', () => {
  it('transforms both ways without an overlap or a jump at any 0.05 s, in the planned order', () => {
    const f = tr01Robot();
    const { stages } = tr01Transform;
    // The steps run Stand → … → Flight, each from where the last ended.
    expect(stages.map((s) => s.from)).toEqual(['Stand', 'Ready', 'Stow', 'Release']);
    expect(stages.map((s) => s.to)).toEqual(['Ready', 'Stow', 'Release', 'Flight']);
    for (const s of stages) {
      const [a, b] = [formValues(f, s.from), formValues(f, s.to)];
      // Every joint that changes is in exactly one group, and every group ends in its step.
      const grouped = s.groups.flatMap((g) => g.joints);
      expect(new Set(grouped).size).toBe(grouped.length);
      const changed = [...a.keys()].filter(
        (j) => JSON.stringify(a.get(j)) !== JSON.stringify(b.get(j)),
      );
      expect(changed.filter((j) => !grouped.includes(j))).toEqual([]);
      for (const g of s.groups) expect(g.start + g.length).toBeLessThanOrEqual(s.seconds);
      expect(sweep(f, s.from, s.to, s.seconds, s.groups)).toEqual([]);
      // Back: the parts switch to the hands at the end, once they are back where the hands are.
      const r = reversed(s);
      expect(sweep(f, r.from, r.to, r.seconds, r.groups, 'end')).toEqual([]);
    }
  });
  it('flies with the legs folded, the rifle down the back and the shield in the middle', () => {
    const f = tr01Robot();
    const doc = f.assembly;
    const params = parameterValues(doc);
    const solved = solveJoints(
      doc,
      params,
      (h) => f.closure.get(h),
      () => undefined,
      () => true,
    );
    const poses = posesForJointValues(
      doc,
      solved,
      formValues(f, 'Flight'),
      params,
      formMounts(f, 'Flight'),
    );
    // In the torso's frame: +y is its back, +z up, x across.
    const inTorso = (c: string) =>
      composePoses(invertPose(poses['c-torso']!), poses[c]!).translationMm.map((v) =>
        Math.round(v),
      );
    // The rifle's grip behind the back pack (its back face at y 64), the barrel along the back.
    expect(inTorso('c-rifle')[1]).toBeGreaterThan(64);
    // The shield's hinge in front of the chest, 35 mm to the side of the plate's middle line,
    // which lies on the body's centre line.
    expect(inTorso('c-shield')).toEqual([-35, -53, 180]);
    const knee = doc.configurations!.find((c) => c.name === 'Flight')!.values['j-knee-r']!;
    expect(knee.angle).toEqual({ literalRad: (165 * Math.PI) / 180 });
  });
  it('finds the rifle cutting through the forearm when the wrist turns straight to Stow', () => {
    const f = tr01Robot();
    const s = tr01Transform.stages[1]!;
    const hits = sweep(f, 'Stand', 'Stow', s.seconds, s.groups);
    expect(hits.some((h) => /c-fore-r–c-rifle/.test(h))).toBe(true);
  });
  it('finds a jump when the parts switch to the body before they reach their places', () => {
    const f = tr01Robot();
    const s = tr01Transform.stages[2]!;
    const r = reversed(s);
    // Going back, switching to the hands at the start: the rifle is still down the back.
    const hits = sweep(f, r.from, r.to, r.seconds, r.groups, 'start');
    expect(hits).toEqual(
      expect.arrayContaining([expect.stringMatching(/^0: m-rifle jumps 190\.0 mm$/)]),
    );
  });
});
