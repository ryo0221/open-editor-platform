import { BoxGeometry, CylinderGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import {
  draftColor,
  draftSummary,
  partCheckColors,
  partCheckColorsOf,
  partDraft,
  partThickness,
  thicknessColor,
  type PartCheckMesh,
} from './part-checks';

const meshOf = (g: BoxGeometry | CylinderGeometry, origin: [number, number, number] = [0, 0, 0]) =>
  ({
    origin,
    positions: g.getAttribute('position').array as Float32Array,
    normals: g.getAttribute('normal').array as Float32Array,
    indices: Uint32Array.from(g.getIndex()!.array),
  }) satisfies PartCheckMesh;

describe('part checks on the display mesh (CR6b, TS-1594)', () => {
  it('measures a plate’s wall through its faces and its edge across', () => {
    const plate = meshOf(new BoxGeometry(40, 20, 2, 8, 4, 1), [100, 0, 0]);
    const indices = plate.indices.slice();
    const { values, min, max, missing } = partThickness(plate);
    // The mesh's own triangles keep their order (the face ids follow it).
    expect(plate.indices).toEqual(indices);
    expect(missing).toBe(0);
    expect(min!.mm).toBeCloseTo(2, 3);
    expect(max!.mm).toBeCloseTo(40, 3);
    // The places are in the model, the origin added.
    expect(Math.abs(max!.at[0] - 100)).toBeCloseTo(20, 3);
    // A node on the top face: the plate's thickness.
    const n = plate.normals;
    const top = [...Array(values.length).keys()].filter((i) => n[i * 3 + 2] === 1);
    for (const i of top) expect(values[i]).toBeCloseTo(2, 3);
    expect(thicknessColor(values[top[0]!]!, 1.5, 3)).toEqual([...partCheckColors.ok]);
    expect(thicknessColor(1, 1.5, 3)).toEqual([...partCheckColors.thin]);
    expect(thicknessColor(5, 1.5, 3)).toEqual([...partCheckColors.thick]);
    expect(thicknessColor(NaN, 1.5, 3)).toEqual([...partCheckColors.none]);
  });

  it('measures a wall thinner than 0.01 mm', () => {
    // 0.005 mm: over the smallest CAD dimension (0.001 mm); the ray starts at its node.
    const foil = meshOf(new BoxGeometry(40, 20, 0.005));
    const { values, min, missing } = partThickness(foil);
    expect(missing).toBe(0);
    expect(min!.mm).toBeCloseTo(0.005, 5);
    const n = foil.normals;
    for (let i = 0; i < values.length; i++)
      if (Math.abs(n[i * 3 + 2]!) === 1) expect(values[i]).toBeCloseTo(0.005, 5);
  });

  it('gives no value where the ray leaves an open shell', () => {
    // An open tube's wall with its normals turned in: each ray goes out of the tube, away from
    // every other face, and meets nothing.
    const open = meshOf(new CylinderGeometry(10, 10, 20, 24, 1, true));
    const { values, missing } = partThickness({
      ...open,
      normals: open.normals.map((v) => -v),
    });
    expect(missing).toBe(values.length);
  });

  it('classes a box’s faces by their draft to the pull direction', () => {
    const box = meshOf(new BoxGeometry(10, 10, 10));
    const draft = partDraft(box, [0, 0, 1]);
    const n = box.normals;
    for (let i = 0; i < draft.length; i++)
      expect(draft[i]).toBeCloseTo(n[i * 3 + 2]! === 1 ? 90 : n[i * 3 + 2]! === -1 ? -90 : 0, 6);
    // A split mould: the sides (0°) are too small, the bottom releases into the other half.
    const split = draftSummary(box, draft, 1, true);
    expect(split).toEqual({ withPull: 100, againstPull: 100, tooSmall: 400, undercut: 0 });
    // A smallest draft of 0°: the sides (exactly 0°) are still no draft, not an undercut.
    expect(draftSummary(box, draft, 0, false)).toEqual({
      withPull: 100,
      againstPull: 0,
      tooSmall: 400,
      undercut: 100,
    });
    expect(draftColor(0, 0, false)).toEqual([...partCheckColors.tooSmall]);
    // One half: the bottom is an undercut.
    expect(draftSummary(box, draft, 1, false)).toMatchObject({ againstPull: 0, undercut: 100 });
    expect(draftColor(-90, 1, false)).toEqual([...partCheckColors.undercut]);
    // A larger smallest draft never hides an undercut in one half: −0.5° against the pull.
    expect(draftColor(-0.5, 1, false)).toEqual([...partCheckColors.undercut]);
    expect(draftColor(-0.5, 1, true)).toEqual([...partCheckColors.tooSmall]);
    expect(draftColor(-90, 1, true)).toEqual([...partCheckColors.againstPull]);
    expect(draftColor(0.5, 1, true)).toEqual([...partCheckColors.tooSmall]);
    expect(draftColor(3, 1, false)).toEqual([...partCheckColors.withPull]);
    // A wall drafted 3°: its normal 3° toward the pull.
    const s = Math.sin((3 * Math.PI) / 180);
    const c = Math.cos((3 * Math.PI) / 180);
    const wall = partDraft(
      {
        origin: [0, 0, 0],
        positions: new Float32Array(3),
        normals: Float32Array.of(c, 0, s),
        indices: new Uint32Array(),
      },
      [0, 0, 1],
    );
    expect(wall[0]).toBeCloseTo(3, 4);
    const colours = partCheckColorsOf(Float32Array.of(3, NaN), (v) => draftColor(v, 1, true));
    expect(Array.from(colours.slice(3))).toEqual([...partCheckColors.none].map(Math.fround));
  });
});
