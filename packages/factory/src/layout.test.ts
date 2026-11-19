import { describe, expect, it } from 'vitest';
import { factoryPlanBounds } from './layout';

// TS-2659: FT4a the plan keeps a large building in view.
describe('FT4a plan bounds (TS-2659)', () => {
  it('takes more points than a call takes arguments', () => {
    const points = Array.from({ length: 200_000 }, (_, i) => ({ x: i, y: -i }));
    const b = factoryPlanBounds(new Map(), points);
    expect(b.maxX).toBeGreaterThan(199_999);
    expect(b.minY).toBeLessThan(-199_999);
  });
});
