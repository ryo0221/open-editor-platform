import { BoxGeometry, Mesh, MeshBasicMaterial, type Object3D, PlaneGeometry, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { bimClearDirection, bimViewDirections, bimVisibleSamples } from './view-direction';

type Bounds = [[number, number, number], [number, number, number]];

/** A box solid of element `id` from `lo` to `hi`, opaque unless `opacity` < 1. */
function box(id: string, lo: number[], hi: number[], opacity = 1): Object3D {
  const size = hi.map((h, k) => h - lo[k]!);
  const mesh = new Mesh(
    new BoxGeometry(size[0], size[1], size[2]),
    new MeshBasicMaterial({ transparent: opacity < 1, opacity }),
  );
  mesh.position.set(...(hi.map((h, k) => (h + lo[k]!) / 2) as [number, number, number]));
  mesh.updateMatrixWorld();
  mesh.userData.path = [id];
  return mesh;
}

// A window 1 m across on the north face of a 10 m core at the origin.
const win: Bounds = [
  [-500, 5000, 1000],
  [500, 5100, 2000],
];
const scene = () => [box('core', [-5000, -5000, 0], [5000, 5000, 4000]), box('w', ...win)];

describe('turning to a view of the selection (FU5)', () => {
  it('tries the current direction first, then round it nearest first, each once', () => {
    const d = bimViewDirections(new Vector3(0, -1, 0));
    expect(d[0]!.distanceTo(new Vector3(0, -1, 0))).toBeLessThan(1e-12);
    // 12 round at its height, then 12 at each of 35° and 65°.
    expect(d).toHaveLength(36);
    const angle = (v: Vector3) => v.angleTo(new Vector3(0, -1, 0));
    for (let k = 1; k < 12; k++)
      expect(angle(d[k]!)).toBeGreaterThanOrEqual(angle(d[k - 1]!) - 1e-9);
    expect(d.every((v) => Math.abs(v.length() - 1) < 1e-12)).toBe(true);
    // Round from the outward side when given, after the current one.
    const out = bimViewDirections(new Vector3(0, -1, 0), new Vector3(0, 5, 0));
    expect(out[1]!.distanceTo(new Vector3(0, 1, 0))).toBeLessThan(1e-12);
    // Half a turn from it is the current one, tried once.
    expect(out).toHaveLength(36);
  });

  it('keeps a direction from which nothing hides the selection', () => {
    const north = new Vector3(0, 1, 0.2).normalize();
    const dir = bimClearDirection(scene(), win, north, 20_000, new Set(['w']));
    expect(dir.distanceTo(north)).toBeLessThan(1e-12);
  });

  it('turns round to the side of a window the core hides it from', () => {
    const south = new Vector3(0, -1, 0.2).normalize();
    expect(bimVisibleSamples(scene(), win, south, 20_000, new Set(['w']))).toBe(0);
    // Without the building's middle: the fewest steps round, a quarter turn along the face.
    const side = bimClearDirection(scene(), win, south, 20_000, new Set(['w']));
    expect(bimVisibleSamples(scene(), win, side, 20_000, new Set(['w']))).toBe(9);
    expect(side.y).toBeCloseTo(0, 9);
    // With it: straight out of the face, at the same height.
    const core: Bounds = [
      [-5000, -5000, 0],
      [5000, 5100, 4000],
    ];
    const dir = bimClearDirection(scene(), win, south, 20_000, new Set(['w']), core);
    expect(dir.distanceTo(new Vector3(0, 1, 0.2).normalize())).toBeLessThan(1e-12);
  });

  it('sees through transparent solids and counts the selection itself as no cover', () => {
    const glass = box('glass', [-6000, 5500, 0], [6000, 5600, 4000], 0.3);
    const north = new Vector3(0, 1, 0);
    expect(bimVisibleSamples([...scene(), glass], win, north, 20_000, new Set(['w']))).toBe(9);
    const wall = box('wall', [-6000, 5500, 0], [6000, 5600, 4000]);
    expect(bimVisibleSamples([...scene(), wall], win, north, 20_000, new Set(['w']))).toBe(0);
    expect(bimVisibleSamples([...scene(), wall], win, north, 20_000, new Set(['w', 'wall']))).toBe(
      9,
    );
  });

  it('meets the faces drawn towards the camera, not their backs (Codex)', () => {
    // One opaque face towards the camera in the north, drawn from the front only: from the
    // window it is its back, which a ray from the window would pass through.
    const face = new Mesh(new PlaneGeometry(12000, 4000), new MeshBasicMaterial());
    face.rotation.x = -Math.PI / 2;
    face.position.set(0, 5600, 2000);
    face.updateMatrixWorld();
    face.userData.path = ['face'];
    // Its front looks north (+y), at the camera.
    const north = new Vector3(0, 1, 0);
    expect(bimVisibleSamples([...scene(), face], win, north, 20_000, new Set(['w']))).toBe(0);
  });

  it('keeps the current direction when every try is hidden', () => {
    // Inside a closed box: nothing sees it.
    const shell = [
      box('a', [-9000, -9000, -9000], [9000, 9000, -8000]),
      box('b', [-9000, -9000, 8000], [9000, 9000, 9000]),
      box('c', [-9000, -9000, -9000], [-8000, 9000, 9000]),
      box('d', [8000, -9000, -9000], [9000, 9000, 9000]),
      box('e', [-9000, -9000, -9000], [9000, -8000, 9000]),
      box('f', [-9000, 8000, -9000], [9000, 9000, 9000]),
    ];
    const inside: Bounds = [
      [-100, -100, -100],
      [100, 100, 100],
    ];
    const start = new Vector3(1, 0, 0);
    const dir = bimClearDirection(shell, inside, start, 20_000, new Set(['x']));
    expect(dir.distanceTo(start)).toBeLessThan(1e-12);
  });
});
