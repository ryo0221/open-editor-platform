import { describe, expect, it } from 'vitest';
import {
  configurationLimitViolations,
  configurationStale,
  matchingConfigurations,
} from './configurations';
import { parameterValues } from './graph';
import { jointValues, posesForJointValues, solveJoints } from './joints';
import { jinraiRobot, jinraiTransform } from './mecha-jinrai';
import { poseGap } from './mount-gaps';
import { validateCad } from './validation';

const formPoses = (f: ReturnType<typeof jinraiRobot>, name: string) => {
  const form = f.assembly.configurations!.find((c) => c.name === name)!;
  const doc = {
    ...f.assembly,
    mounts: f.assembly.mounts!.map((m) => ({ ...m, active: form.mounts![m.id]! })),
  };
  const params = parameterValues(doc);
  const solved = solveJoints(
    doc,
    params,
    (h) => f.closure.get(h),
    () => undefined,
    () => true,
  );
  const values = new Map(
    doc.joints
      .filter((j) => form.values[j.id])
      .map((j) => [j.id, jointValues({ type: j.type, values: form.values[j.id]! }, params)]),
  );
  return posesForJointValues(doc, solved, values, params);
};

describe('迅雷 (D5 armour, D6 detail, D7 colour, D8 transform): the assembly the look process builds', () => {
  const f = jinraiRobot();
  it('is a valid assembly of valid parts, built the same way every time', () => {
    expect(validateCad(f.assembly).map((d) => d.code)).toEqual([]);
    for (const part of f.closure.values()) expect(validateCad(part).map((d) => d.code)).toEqual([]);
    expect(f.assembly.parts).toHaveLength(55);
    expect(jinraiRobot().hash).toBe(f.hash);
  });
  it('cuts the D6 detail into the plates and adds the nozzles and antennas', () => {
    const doc = (id: string) => {
      const p = f.assembly.parts.find((x) => x.id === id)!;
      return f.closure.get(p.source.kind === 'version' ? p.source.contentHash : '')!;
    };
    const torso = doc('p-torso');
    // a body's placement takes the shape's last feature
    const source = (d: typeof torso, id: string) =>
      (d.features.find((x) => x.id === `${id}-placement`)!.inputFeatureIds as string[])[0];
    const feature = (d: typeof torso, id: string) => d.features.find((x) => x.id === id)!;
    // the chest side plate ends in its fourth slit, each a cut of the one before
    expect(source(torso, 'chest-side-l')).toBe('chest-side-l-cut3');
    expect(feature(torso, 'chest-side-l-cut3')).toMatchObject({
      type: 'boolean',
      inputFeatureIds: ['chest-side-l-cut2', 'chest-side-l-c3-extrude'],
      args: { mode: 'cut' },
    });
    expect(source(torso, 'pack-nozzle-r')).toBe('pack-nozzle-r-cut0');
    expect(doc('p-head').bodies.map((b) => b.id)).toEqual(
      expect.arrayContaining(['antenna-r', 'antenna-l']),
    );
    expect(doc('p-wing1-l').bodies.map((b) => b.id)).toContain('covert-1-l');
  });
  it('paints the D7 scheme and carries the unit marks on the shield and shoulders', () => {
    const colour = (part: string, body: string) => {
      const p = f.assembly.parts.find((x) => x.id === part)!;
      const d = f.closure.get(p.source.kind === 'version' ? p.source.contentHash : '')!;
      return d.bodies.find((b) => b.id === body)?.appearance?.color;
    };
    expect(colour('p-torso', 'chest')).toBe('#eef0f3');
    expect(colour('p-torso', 'sternum')).toBe('#f0a92c');
    expect(colour('p-torso', 'pack-nozzle-r')).toBe('#9aa0aa');
    expect(colour('p-shield', 'mark-bolt')).toBe('#f0a92c');
    expect(colour('p-shield', 'mark-no0')).toBe('#f0a92c');
    expect(colour('p-upper-l', 'mark-bolt-l')).toBe('#f0a92c');
  });
  it('stands in the Stand form and keeps both forms inside the joint limits', () => {
    expect(matchingConfigurations(f.assembly)).toEqual(['form-stand']);
    for (const form of f.assembly.configurations!) {
      expect(configurationLimitViolations(f.assembly, form.values)).toEqual([]);
      expect(configurationStale(f.assembly, form)).toBe(false);
    }
  });
  it('holds the shield and rifle in Stand and stows them as hood and belly gun in Flight', () => {
    const forms = f.assembly.configurations!;
    expect(forms.map((c) => c.name)).toEqual([
      'Stand',
      'Handover',
      'Lift',
      'Flip',
      'Stow',
      'Takeoff',
      'Flight',
    ]);
    const [stand, , , , , , flight] = forms;
    expect(stand!.mounts).toEqual({ 'm-shield': 'j-shield-arm', 'm-rifle': 'j-rifle-hand' });
    expect(flight!.mounts).toEqual({ 'm-shield': 'j-shield-head', 'm-rifle': 'j-rifle-belly' });
  });
  it('pitches forward 90° in Flight: the head ends up ahead of the hips, the wings spread wide', () => {
    const s = formPoses(f, 'Stand');
    const fl = formPoses(f, 'Flight');
    // a point of a component's part frame, placed by its pose
    const at = (p: typeof s, c: string, [x, y, z]: number[]) => {
      const {
        translationMm: t,
        rotation: [qx, qy, qz, qw],
      } = p[c]!;
      const [ux, uy, uz] = [
        qy * z - qz * y + qw * x,
        qz * x - qx * z + qw * y,
        qx * y - qy * x + qw * z,
      ];
      return [
        x + 2 * (qy * uz - qz * uy) + t[0]!,
        y + 2 * (qz * ux - qx * uz) + t[1]!,
        z + 2 * (qx * uy - qy * ux) + t[2]!,
      ];
    };
    const head = (p: typeof s) => at(p, 'c-head', [0, 0, 340]);
    const span = (p: typeof s) =>
      Math.abs(at(p, 'c-wing2-r', [0, 0, 0])[0]! - at(p, 'c-wing2-l', [0, 0, 0])[0]!);
    // standing, the head is above the hips; flying, it points forward (−y) about 15 cm ahead of the hips
    expect(head(s)[2]).toBeGreaterThan(300);
    expect(head(fl)[1]).toBeLessThan(-120);
    expect(span(fl)).toBeGreaterThan(span(s) * 2);
  });
});

describe('D8 迅雷 transforming (ST-407, TS-1721)', () => {
  const f = jinraiRobot();
  const doc = f.assembly;
  const params = parameterValues(doc);
  const solved = solveJoints(
    doc,
    params,
    (h) => f.closure.get(h),
    () => undefined,
    () => true,
  );
  const form = (name: string) => doc.configurations!.find((c) => c.name === name)!;
  const values = (name: string) =>
    new Map(
      doc.joints
        .filter((j) => form(name).values[j.id])
        .map((j) => [
          j.id,
          jointValues({ type: j.type, values: form(name).values[j.id]! }, params),
        ]),
    );
  it('steps form to form, each changed joint in one eased group inside its step', () => {
    const { stages } = jinraiTransform;
    const names = doc.configurations!.map((c) => c.name);
    expect(stages.map((s) => s.from)).toEqual(names.slice(0, -1));
    expect(stages.map((s) => s.to)).toEqual(names.slice(1));
    for (const s of stages) {
      const [a, b] = [values(s.from), values(s.to)];
      const grouped = s.groups.flatMap((g) => g.joints);
      expect(new Set(grouped).size).toBe(grouped.length);
      const changed = [...a.keys()].filter(
        (j) => JSON.stringify(a.get(j)) !== JSON.stringify(b.get(j)),
      );
      expect(changed.filter((j) => !grouped.includes(j))).toEqual([]);
      expect(grouped.filter((j) => !changed.includes(j))).toEqual([]);
      for (const g of s.groups) {
        expect(g.start).toBeGreaterThanOrEqual(0);
        expect(g.start + g.length).toBeLessThanOrEqual(s.seconds + 1e-9);
        expect(g.easing).toEqual({ type: 'bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 });
      }
    }
  });
  it('hands the shield to the crane and the rifle to the holster where they are (no jump)', () => {
    // The mounts switch from Handover on: there, each part sits in the same place either way.
    const v = values('Handover');
    const hands = new Map(Object.entries(form('Handover').mounts!));
    const stowed = new Map(Object.entries(form('Lift').mounts!));
    const a = posesForJointValues(doc, solved, v, params, hands);
    const b = posesForJointValues(doc, solved, v, params, stowed);
    for (const c of ['c-shield', 'c-rifle']) {
      const gap = poseGap(a[c]!, b[c]!);
      expect(gap.within).toBe(true);
      expect(gap.mm).toBeLessThan(0.01);
    }
  });
  it('parks the crane behind the head and the holster under the chest in Stand and Flight', () => {
    for (const name of ['Stand', 'Flight']) {
      for (const j of ['j-crane-2', 'j-crane-3', 'j-crane-4', 'j-holster'])
        expect(form(name).values[j]).toEqual({ angle: { literalRad: 0 } });
      expect(form(name).values['j-holster-slide']).toEqual({ distance: { literalMm: 0 } });
    }
  });
});
