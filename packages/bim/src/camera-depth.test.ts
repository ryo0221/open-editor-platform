import { describe, expect, it } from 'vitest';
import { bimCameraDepth } from './viewport';

describe('near and far planes follow the camera (#19)', () => {
  it('keeps a sub-centimetre part close up in front of the near plane in a kilometre scene', () => {
    // A 5 mm part framed from about 7 mm away, in a site 2 km across.
    const { near, far } = bimCameraDepth(7, 1_000_000);
    expect(near).toBeLessThan(1);
    expect(far).toBeGreaterThan(2_000_000);
  });
  it('still reaches the whole scene from far out, and keeps a usable near plane', () => {
    const { near, far } = bimCameraDepth(3_000_000, 1_000_000);
    expect(near).toBe(3_000);
    expect(far).toBeGreaterThanOrEqual(8_000_000);
    for (const d of [0, NaN, -1]) expect(bimCameraDepth(d, 1_000).near).toBeGreaterThan(0);
  });
  it('reaches a scene that lies beyond a target outside it (Codex on #30)', () => {
    // A 10 m scene round the origin, seen from 100 m south looking at a point 100 mm ahead.
    const { far } = bimCameraDepth(100, 10_000, 100_000);
    expect(far).toBeGreaterThan(110_000);
  });
  it('keeps the scene in front of the near plane when the target is far beyond it (Codex on #30)', () => {
    // A 20 m building round the origin, the camera 100 m south looking at a target 1,000 km away.
    const { near } = bimCameraDepth(1_000_000_000, 10_000, 100_000);
    expect(near).toBeLessThan(90_000);
    // Inside the scene's sphere, the near plane stays within the scene's size.
    expect(bimCameraDepth(1_000_000_000, 10_000, 5_000).near).toBeLessThanOrEqual(10);
  });
});
