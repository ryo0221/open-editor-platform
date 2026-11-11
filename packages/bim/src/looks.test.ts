import { BimContext, f31BoxBuilding, f51Ramps } from '@editor-platform/bim-core';
import { describe, expect, it } from 'vitest';
import {
  bimElementFaceLooks,
  bimElementLevel,
  bimElementLooks,
  bimKindStyle,
  bimLastLayerFaces,
  bimViewBounds,
} from './view';

describe('element looks (#661)', () => {
  it('keeps the kind colour while the type’s material has no appearance', () => {
    const doc = f31BoxBuilding();
    const look = bimElementLooks(doc);
    for (const el of doc.elements) expect(look(el)).toEqual(bimKindStyle[el.kind]);
  });

  it('draws an element in its type’s surface material’s appearance', () => {
    const doc = f31BoxBuilding();
    const wall = doc.elements.find((e) => e.kind === 'wall')!;
    const type = doc.types.find((t) => 'typeId' in wall && t.id === wall.typeId)!;
    const id = 'layers' in type ? type.layers[0]!.materialId : '';
    doc.materials.find((m) => m.id === id)!.appearance = {
      color: '#a4553d',
      opacity: 1,
      roughness: 0.85,
      metalness: 0,
      preset: 'brick',
    };
    const look = bimElementLooks(doc);
    expect(look(wall)).toEqual({ color: '#a4553d', opacity: 1, roughness: 0.85, metalness: 0 });
    // A window has no material: its kind colour.
    const win = doc.elements.find((e) => e.kind === 'window')!;
    expect(look(win)).toEqual(bimKindStyle.window);
  });
});

describe('the two faces of a layered element (#662, 2c)', () => {
  const look = (color: string) => ({ color, opacity: 1, roughness: 0.8, metalness: 0 });

  it('gives the last layer’s look only when it differs from the first’s', () => {
    const doc = f31BoxBuilding();
    const wall = doc.elements.find((e) => e.id === 'w-south')!;
    const faces = bimElementFaceLooks(doc);
    // Neither material has a look: both faces are the kind's colour.
    expect(faces(wall)).toBeUndefined();
    doc.materials.find((m) => m.id === 'm-finish')!.appearance = look('#f5f5f4');
    expect(bimElementFaceLooks(doc)(wall)).toEqual(look('#f5f5f4'));
    doc.materials.find((m) => m.id === 'm-concrete')!.appearance = look('#f5f5f4');
    expect(bimElementFaceLooks(doc)(wall)).toBeUndefined();
    const win = doc.elements.find((e) => e.kind === 'window')!;
    expect(bimElementFaceLooks(doc)(win)).toBeUndefined();
  });

  it('tells a slab’s top from its other faces', () => {
    const doc = f31BoxBuilding();
    const slab = doc.elements.find((e) => e.kind === 'slab')!;
    // Face 0 looks up (counter-clockwise from above), face 1 down, face 2 sideways.
    const mesh = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0]),
      normals: new Float32Array(18),
      uvs: new Float32Array(12),
      indices: new Uint32Array([0, 1, 2, 0, 2, 1, 3, 4, 5]),
      faceIndices: new Uint32Array([0, 1, 2]),
    };
    expect(bimLastLayerFaces(new BimContext(doc), slab, mesh)).toEqual([true, false, false]);
    // A roof at the steepest slope, 60° (its top's n.z is 0.5, a little less in Float32).
    const rise = 10001 * Math.tan(Math.PI / 3);
    const steep = {
      ...mesh,
      positions: new Float32Array([0, 0, 0, 10001, 0, rise, 0, 1000, 0]),
      indices: new Uint32Array([0, 1, 2]),
      faceIndices: new Uint32Array([0]),
    };
    expect(bimLastLayerFaces(new BimContext(doc), slab, steep)).toEqual([true]);
  });

  it('keeps a wall’s sloped top, cut by a roof, with its edges (Codex)', () => {
    const doc = f31BoxBuilding();
    // w-south runs along +x: its left is +y.
    const wall = doc.elements.find((e) => e.id === 'w-south')!;
    // A vertical face looking +y, a 45° top looking +y and up, and one looking −y.
    const positions = new Float32Array([
      ...[0, 0, 0, 0, 0, 1, 1, 0, 0],
      ...[0, 0, 0, 0, -1, 1, 1, 0, 0],
      ...[0, 0, 0, 1, 0, 0, 0, 0, 1],
    ]);
    const mesh = {
      positions,
      normals: new Float32Array(positions.length),
      uvs: new Float32Array((positions.length / 3) * 2),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]),
      faceIndices: new Uint32Array([0, 1, 2]),
    };
    expect(bimLastLayerFaces(new BimContext(doc), wall, mesh)).toEqual([true, false, false]);
  });

  it('finds the last layer on a leaning wall’s left face (LR2, Codex)', () => {
    const doc = f31BoxBuilding();
    const wall = doc.elements.find((e) => e.id === 'w-south')!;
    if (wall.kind !== 'wall') throw new Error('not a wall');
    // Leaning 15° to its right (−y): its left face looks +y and 15° up.
    wall.lean = (15 * Math.PI) / 180;
    const [c, s] = [Math.cos(wall.lean), Math.sin(wall.lean)];
    // The tilted left face, an upright +y face, and the right face looking −y and down.
    const positions = new Float32Array([
      ...[0, 0, 0, 0, -s, c, 1, 0, 0],
      ...[0, 0, 0, 0, 0, 1, 1, 0, 0],
      ...[0, 0, 0, 1, 0, 0, 0, -s, c],
    ]);
    const mesh = {
      positions,
      normals: new Float32Array(positions.length),
      uvs: new Float32Array((positions.length / 3) * 2),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]),
      faceIndices: new Uint32Array([0, 1, 2]),
    };
    expect(bimLastLayerFaces(new BimContext(doc), wall, mesh)).toEqual([true, false, false]);
  });

  it('keeps an oblique joined end with the first layer (Codex)', () => {
    const doc = f31BoxBuilding();
    const wall = doc.elements.find((e) => e.id === 'w-south')!;
    // A side face looking +y, and an end cut by an oblique butt join looking (1, 1, 0) / √2.
    const positions = new Float32Array([
      ...[0, 0, 0, 0, 0, 1, 1, 0, 0],
      ...[0, 0, 0, 0, 0, 1, 1, -1, 0],
    ]);
    const mesh = {
      positions,
      normals: new Float32Array(positions.length),
      uvs: new Float32Array((positions.length / 3) * 2),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
      faceIndices: new Uint32Array([0, 1]),
    };
    expect(bimLastLayerFaces(new BimContext(doc), wall, mesh)).toEqual([true, false]);
  });
});

describe('the level an element is listed on (LR3)', () => {
  it('lists a ramp on its base level', () => {
    const doc = f51Ramps();
    expect(doc.elements.map((e) => bimElementLevel(doc, e.id))).toEqual(['l-gl', 'l-gl', 'l-1']);
  });
});

describe('zoom to selection (FU1)', () => {
  it('frames a door by its host wall', () => {
    const doc = f31BoxBuilding();
    const box = (x: number) => ({
      status: 'ok',
      measure: {
        bounds: [
          [x, 0, 0],
          [x + 10, 10, 10],
        ],
      },
    });
    const evaluation = {
      status: 'ok',
      elements: new Map([
        ['w-south', box(0)],
        ['w-north', box(1000)],
      ]),
    } as unknown as Parameters<typeof bimViewBounds>[0];
    expect(bimViewBounds(evaluation, doc, ['d-entrance'])).toEqual([
      [0, 0, 0],
      [10, 10, 10],
    ]);
    expect(bimViewBounds(evaluation, doc, ['w-north', 'd-entrance'])![1][0]).toBe(1010);
  });

  it('frames a door by its own panel once it has a shape (FU7)', () => {
    const doc = f31BoxBuilding();
    const box = (x: number, w = 10) => ({
      status: 'ok',
      measure: {
        bounds: [
          [x, 0, 0],
          [x + w, 10, 10],
        ],
      },
    });
    const evaluation = {
      status: 'ok',
      elements: new Map([
        ['w-south', box(0, 10000)],
        ['d-entrance', box(4000, 900)],
      ]),
    } as unknown as Parameters<typeof bimViewBounds>[0];
    expect(bimViewBounds(evaluation, doc, ['d-entrance'])).toEqual([
      [4000, 0, 0],
      [4900, 10, 10],
    ]);
    // With its wall selected too: both.
    expect(bimViewBounds(evaluation, doc, ['d-entrance', 'w-south'])![1][0]).toBe(10000);
    // A failed panel: its wall, as before.
    const failed = {
      status: 'ok',
      elements: new Map<string, unknown>([
        ['w-south', box(0, 10000)],
        ['d-entrance', { status: 'error' }],
      ]),
    } as unknown as Parameters<typeof bimViewBounds>[0];
    expect(bimViewBounds(failed, doc, ['d-entrance'])![1][0]).toBe(10000);
  });
});
