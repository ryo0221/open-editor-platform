import { describe, expect, it } from 'vitest';
import { easingProgress } from './index';

describe('easingProgress', () => {
  it('holds, runs linearly and follows a bezier curve', () => {
    expect(easingProgress({ type: 'hold' }, 0.5)).toBe(0);
    expect(easingProgress({ type: 'linear' }, 0.25)).toBe(0.25);
    const ease = { type: 'bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 } as const;
    expect(easingProgress(ease, 0)).toBe(0);
    expect(easingProgress(ease, 1)).toBe(1);
    expect(easingProgress(ease, 0.5)).toBeCloseTo(0.5, 9);
    expect(easingProgress(ease, 0.25)).toBeLessThan(0.25);
  });
});
