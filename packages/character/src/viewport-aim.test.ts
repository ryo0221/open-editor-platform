// GV2c (TS-2305): a keyed camera far out widens the view's planes for that pose only.
import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { aim } from './viewport';

describe('keyed camera planes (ST-643, TS-2305)', () => {
  const framed = () => {
    const camera = new PerspectiveCamera(35, 1, 2, 200_000);
    camera.userData.planes = { near: 2, far: 200_000 };
    return camera;
  };
  const look = (camera: PerspectiveCamera, position: number[], target: number[]) =>
    aim(
      camera,
      new Vector3(),
      { position: position as never, target: target as never },
      new Vector3(),
      new Vector3(),
    );
  it('widens for a far camera and returns to the framed planes for a close one', () => {
    const camera = framed();
    look(camera, [0, -10_000_000, 0], [0, 0, 0]);
    expect(camera.far).toBe(40_000_000);
    expect(camera.near).toBe(40);
    look(camera, [0, -20, 0], [0, 0, 0]);
    expect([camera.near, camera.far]).toEqual([2, 200_000]);
    // The same close-up straight from the framed view.
    const fresh = framed();
    look(fresh, [0, -20, 0], [0, 0, 0]);
    expect([fresh.near, fresh.far]).toEqual([2, 200_000]);
  });
  it('a capture clone keeps the framed planes after the view widened', () => {
    const camera = framed();
    look(camera, [0, -10_000_000, 0], [0, 0, 0]);
    const capture = camera.clone();
    look(capture, [0, -20, 0], [0, 0, 0]);
    expect([capture.near, capture.far]).toEqual([2, 200_000]);
  });
});
