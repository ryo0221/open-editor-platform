import { describe, expect, it } from 'vitest';
import { brushSegment, defaultBrush, followView, type StrokeView } from './weight-paint';

describe('weight paint brush (C5c, TS-1255)', () => {
  it('paints the whole way along a fast drag, not only the sampled ends', () => {
    // Vertices every 10 px along a line, all facing the camera.
    const screen = Array.from({ length: 11 }, (_, k) => [10 * k, 0, 0]);
    const facing = new Uint8Array(11).fill(1);
    const touched = new Map<number, number>();
    brushSegment(screen, facing, [0, 0], [100, 0], { ...defaultBrush, radius: 5 }, touched);
    expect([...touched.keys()].sort((a, b) => a - b)).toEqual([...Array(11).keys()]);
  });
  it('picks where the vertices are after the view moved during a stroke', () => {
    const screen: [number, number, number][] = [
      [0, 0, 0],
      [100, 0, 0],
    ];
    const s: StrokeView = { screen, facing: new Uint8Array([1, 1]), last: [0, 0] };
    expect(
      followView(
        s,
        screen.map((q) => [...q]),
        () => new Uint8Array([0, 0]),
      ),
    ).toBe(false);
    expect(s.last).toEqual([0, 0]);
    // Zoomed in: vertex 1 is now at 200 px and only it faces the camera.
    const zoomed: [number, number, number][] = [
      [0, 0, 0],
      [200, 0, 0],
    ];
    expect(followView(s, zoomed, () => new Uint8Array([0, 1]))).toBe(true);
    expect(s.last).toBeUndefined();
    const touched = new Map<number, number>();
    brushSegment(s.screen, s.facing, [200, 0], [200, 0], { ...defaultBrush, radius: 5 }, touched);
    expect([...touched.keys()]).toEqual([1]);
  });
});
