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
});
