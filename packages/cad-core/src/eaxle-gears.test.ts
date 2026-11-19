import { describe, expect, it } from 'vitest';
import { f137Bevel, f137GearPairs, f137Helical } from './eaxle-fixtures';
import { checkGearMesh, gearMeshProblems, gearTrainRatios } from './gear-mesh';
import { helicalGear, spurGearRadii } from './gear';
import { coupledJointValues } from './joints';
import { parameterValues } from './graph';
import type { CadDocument } from './model';

// DW7b (docs/cad/drawing-editor.md, 動力系): bevel and helical pairs in mesh. ST-716, TS-2453.
describe('F137 bevel and helical pairs (DW7b)', () => {
  it('meshes a bevel pair on crossed shafts and a helical pair of opposite hands', () => {
    const { assembly, solve, lookup } = f137GearPairs();
    expect(gearMeshProblems(assembly, solve(assembly), lookup).size).toBe(0);
    const ratio = (id: string) =>
      assembly.joints.find((j) => j.id === id)!.couplings!.find((c) => c.of === 'angle')!.ratio;
    // Each about its own axis toward the apex: the ring turns back by z1 / z2.
    expect(ratio('j-ring')).toBeCloseTo(-f137Bevel.z1 / f137Bevel.z2, 12);
    expect(ratio('j-hgear')).toBeCloseTo(-f137Helical.z1 / f137Helical.z2, 12);
    // Turned on, the driven joints follow.
    const turned = structuredClone(assembly);
    turned.joints.find((j) => j.id === 'j-pinion')!.values = { angle: { literalRad: 1.2 } };
    const start = coupledJointValues(assembly, parameterValues(assembly));
    const v = coupledJointValues(turned, parameterValues(turned));
    expect(v.get('j-ring')!.angle! - start.get('j-ring')!.angle!).toBeCloseTo(
      (-1.2 * f137Bevel.z1) / f137Bevel.z2,
      9,
    );
    expect(gearTrainRatios(assembly, 'j-pinion').map((r) => r.joint)).toContain('j-ring');
  });

  it('phases a helical gear by its twist where the pinion’s back face cuts it', () => {
    const { assembly, solve, lookup } = f137GearPairs();
    const offsetAt = (z: number) => {
      const d = structuredClone(assembly);
      d.joints.find((j) => j.id === 'j-hgear')!.parent.offset.translation[2] = { literalMm: z };
      return checkGearMesh(
        d,
        d.gearMeshes!.find((m) => m.id === 'mesh-helical')!,
        solve(d),
        lookup,
      );
    };
    const [at0, at7] = [offsetAt(0), offsetAt(-7)];
    if (at0.status !== 'ok' || at7.status !== 'ok') throw new Error('not meshed');
    // 7 mm lower, the gear's tooth at the pinion's face is 7 mm up its left-hand helix.
    const r2 = helicalGear(
      {
        module: 2,
        teeth: f137Helical.z2,
        pressureAngle: (20 * Math.PI) / 180,
        profileShift: 0,
        addendum: 1,
        dedendum: 1.25,
        bore: 0,
      },
      -f137Helical.helix,
    );
    const twist = (Math.tan(-f137Helical.helix) / spurGearRadii(r2).pitch) * 7;
    const pitch = at0.pitch;
    const diff = at7.coupling.offset - at0.coupling.offset;
    const wrapped = diff - pitch * Math.round(diff / pitch);
    const want = -twist - pitch * Math.round(-twist / pitch);
    expect(wrapped).toBeCloseTo(want, 9);
  });

  it('refuses apexes apart, cones that do not roll, one bevel with a spur, and same hands', () => {
    const { assembly, solve, lookup, versions } = f137GearPairs();
    const codes = (d: CadDocument, look = lookup, id = 'mesh-bevel') =>
      gearMeshProblems(d, solve(d), look)
        .get(id)
        ?.map((p) => p.code);
    // The ring moved along its axis: the apexes part.
    const moved = structuredClone(assembly);
    moved.joints.find((j) => j.id === 'j-ring')!.parent.offset.translation[0] = {
      literalMm: 16,
    };
    expect(codes(moved)).toEqual(['gear-mesh-apex']);
    const swap = (key: keyof typeof versions, edit: (a: Record<string, unknown>) => void) => {
      const other = structuredClone(versions[key].content);
      const g = other.features.find((f) => f.type === 'spurGear')!;
      if (g.type === 'spurGear') edit(g.args as unknown as Record<string, unknown>);
      return (h: string) => (h === versions[key].contentHash ? other : lookup(h));
    };
    // A ring of another cone angle: its cone distance is not the pinion's.
    expect(
      codes(
        assembly,
        swap('ring', (a) => (a.coneAngle = { literalRad: f137Bevel.cone2 - 0.05 })),
      ),
    ).toContain('gear-mesh-cone');
    // A shifted ring against an unshifted pinion: the cones are fixed, so the shifts must cancel.
    expect(
      codes(
        assembly,
        swap('ring', (a) => (a.profileShift = 0.35)),
      ),
    ).toEqual(['gear-mesh-shift']);
    expect(
      codes(
        assembly,
        swap('ring', (a) => delete a.coneAngle),
      ),
    ).toEqual(['gear-mesh-bevel']);
    expect(
      codes(
        assembly,
        swap('helicalGear', (a) => (a.helixAngle = { literalRad: f137Helical.helix })),
        'mesh-helical',
      ),
    ).toContain('gear-mesh-helix');
  });
});
