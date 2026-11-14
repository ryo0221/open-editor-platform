import { describe, expect, it } from 'vitest';
import { occupantCheck } from '@editor-platform/character-core';
import { boxMesh } from '@editor-platform/geometry-mesh';
import { occupantPieces } from './occupant';
import type { CharacterPropMesh } from './props';

const still = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
function box(size: [number, number, number], center: [number, number, number]): CharacterPropMesh {
  const m = boxMesh(size, center);
  const indices: number[] = [];
  for (let f = 0; f < 6; f++) {
    const q = [...m.faceIndices.subarray(4 * f, 4 * f + 4)];
    indices.push(q[0]!, q[1]!, q[2]!, q[0]!, q[2]!, q[3]!);
  }
  return {
    positions: new Float32Array(m.positions),
    normals: new Float32Array(m.positions.length),
    indices: new Uint32Array(indices),
    color: '#888',
    opacity: 1,
  };
}

describe('occupantPieces (CR7d, TS-1818)', () => {
  it('leaves a room’s air out: a figure inside a space is not contained, nor its rays stopped', () => {
    const frame = {
      propId: 'building',
      visible: true,
      instances: [
        // The hall's air, 4 m high, and a slab 3 m over the head.
        {
          mesh: box([10000, 10000, 4000], [0, 0, 2000]),
          matrix: [...still],
          piece: { id: 'sp-hall', name: 'Hall', frame: [...still], air: true },
        },
        {
          mesh: box([10000, 10000, 200], [0, 0, 4700]),
          matrix: [...still],
          piece: { id: 'slab', name: 'Slab', frame: [...still] },
        },
      ],
    };
    const { pieces, names, unchecked } = occupantPieces(frame);
    expect(pieces.map((p) => p.id)).toEqual(['slab']);
    expect(unchecked).toEqual([]);
    expect(names.get('sp-hall')).toBe('Hall');
    const figure = box([200, 200, 1600], [0, 0, 800]);
    const r = occupantCheck({ figure: [figure], headTop: [0, 0, 1600], pieces });
    expect(r.interference).toEqual({ status: 'ok', findings: [] });
    expect(r.headroom?.hit).toMatchObject({ piece: 'slab', distanceMm: 3000 });
  });
});
