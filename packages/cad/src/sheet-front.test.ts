import { describe, expect, it } from 'vitest';
import { sheetFront } from './sheet-front';

const mesh = (positions: number[], normals: number[], indices: number[]) => ({
  positions: Float32Array.from(positions),
  normals: Float32Array.from(normals),
  indices: Uint32Array.from(indices),
});

describe('sheet front (CR4b)', () => {
  it('names the axis a sheet’s front mostly faces, from its mesh normals', () => {
    // TS-1530, ST-261: a unit square in the XZ plane wound towards +y, its normals −y.
    const square = [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1];
    const down = Array(4).fill([0, -1, 0]).flat();
    expect(sheetFront(mesh(square, down, [0, 2, 1, 0, 3, 2]))).toEqual({ axis: '−Y', share: 1 });
    // The winding does not matter: the normals say which side is the front.
    expect(sheetFront(mesh(square, down, [0, 1, 2, 0, 2, 3]))).toEqual({ axis: '−Y', share: 1 });
    const up = Array(4).fill([0, 1, 0]).flat();
    expect(sheetFront(mesh(square, up, [0, 1, 2, 0, 2, 3]))?.axis).toBe('+Y');
    // Two halves facing each other cancel: no direction.
    const both = [...square, ...square];
    const opposite = [...down, ...up];
    expect(sheetFront(mesh(both, opposite, [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]))).toBeUndefined();
    expect(sheetFront(mesh([], [], []))).toBeUndefined();
  });
});
