import { BoxGeometry, InstancedMesh, LineSegments, Raycaster, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  instancePath,
  instancesGroup,
  lodLevel,
  viewLod,
  type ViewLevel,
  type ViewMesh,
  type ViewSolid,
} from './instances';

const square = (size: number): ViewMesh => ({
  origin: [0, 0, 0],
  positions: new Float32Array([0, 0, 0, size, 0, 0, size, size, 0, 0, size, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
});
const standard = square(10);
const coarse = square(10);
const at = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
const solid = (): ViewSolid => ({
  meshes: [{ mesh: standard, color: '#888888', opacity: 1, sheet: false }],
  coarse: [{ mesh: coarse, color: '#888888', opacity: 1, sheet: false }],
  bounds: [
    [0, 0, 0],
    [10, 10, 1],
  ],
  instances: [
    { path: ['e1'], matrix: at(0), selected: false },
    { path: ['e2'], matrix: at(100), selected: false },
    { path: ['e3'], matrix: at(200), selected: false },
  ],
});
/** The instanced meshes of a group and how many instances each draws. */
const drawn = (parts: ViewSolid[], level?: (path: string) => ViewLevel) => {
  const group = instancesGroup(parts, level && ((_, inst) => level(inst.path[0]!)));
  const meshes = group.children.filter((c): c is InstancedMesh => c instanceof InstancedMesh);
  return {
    group,
    standard: meshes.filter(
      (m) => m.geometry.getAttribute('position').array === standard.positions,
    ),
    coarse: meshes.filter((m) => m.geometry.getAttribute('position').array === coarse.positions),
    boxes: meshes.filter((m) => m.geometry instanceof BoxGeometry),
    outlines: group.children.filter((c) => c instanceof LineSegments).length,
  };
};
const down = (x: number) => new Raycaster(new Vector3(x, 5, 50), new Vector3(0, 0, -1));

describe('levels of detail of instanced solids (R2b-4, CAD50)', () => {
  it('chooses the level by size on screen, keeping it near a threshold', () => {
    const { standardPx, coarsePx, margin } = viewLod;
    expect(lodLevel(standardPx)).toBe('standard');
    expect(lodLevel(standardPx - 1)).toBe('coarse');
    expect(lodLevel(coarsePx)).toBe('coarse');
    expect(lodLevel(coarsePx - 1)).toBe('box');
    // Within the margin an instance keeps its level, going up or down.
    expect(lodLevel(standardPx * 1.1, 'coarse')).toBe('coarse');
    expect(lodLevel(standardPx * margin, 'coarse')).toBe('standard');
    expect(lodLevel(standardPx / 1.1, 'standard')).toBe('standard');
    expect(lodLevel(standardPx / margin - 1, 'standard')).toBe('coarse');
    expect(lodLevel(coarsePx / 1.1, 'coarse')).toBe('coarse');
    expect(lodLevel(coarsePx * 1.1, 'box')).toBe('box');
    expect(lodLevel(0, 'standard')).toBe('box');
  });

  it('draws each instance at its level, picking every level by its path', () => {
    const levels: Record<string, ViewLevel> = { e1: 'standard', e2: 'coarse', e3: 'box' };
    const d = drawn([solid()], (p) => levels[p]!);
    expect(d.standard.map((m) => m.count)).toEqual([1]);
    expect(d.coarse.map((m) => m.count)).toEqual([1]);
    expect(d.boxes.map((m) => m.count)).toEqual([1]);
    // Outlines only on the standard mesh; the coarse mesh carries no mesh to pick on.
    expect(d.outlines).toBe(1);
    expect(d.standard[0]!.userData.mesh).toBe(standard);
    expect(d.coarse[0]!.userData.mesh).toBeUndefined();
    for (const [x, path] of [
      [5, 'e1'],
      [105, 'e2'],
      [205, 'e3'],
    ] as const)
      expect(instancePath(down(x).intersectObjects(d.group.children, false)[0])).toEqual([path]);
  });

  it('draws the standard mesh without a level, and the other level a solid lacks', () => {
    expect(drawn([solid()]).standard.map((m) => m.count)).toEqual([3]);
    // Without coarse meshes a coarse instance draws the standard ones.
    const plain = { ...solid(), coarse: undefined };
    expect(drawn([plain], () => 'coarse').standard.map((m) => m.count)).toEqual([3]);
    // A simplified solid with its coarse meshes only draws them at the standard level.
    const reduced = { ...solid(), meshes: undefined };
    const d = drawn([reduced], () => 'standard');
    expect(d.standard).toEqual([]);
    expect(d.coarse.map((m) => m.count)).toEqual([3]);
    // A box reason still draws boxes, whatever the level.
    const pending = drawn([{ ...solid(), box: 'pending' }], () => 'standard');
    expect([pending.standard.length, pending.coarse.length, pending.boxes.length]).toEqual([
      0, 0, 1,
    ]);
  });
});
