// GV2b: new levels, steps, railings and openings are drawn at the size of the building's people.
import {
  applyBimOperation,
  bimStarter,
  validateBim,
  type BimDocument,
} from '@editor-platform/bim-core';
import { describe, expect, it } from 'vitest';
import { draftLevel, draftStair, type BimSnap } from './drafting';

const snap = (x: number, y: number): BimSnap => ({
  xy: [x, y],
  point: { xy: [x, y] },
  kind: 'step',
});
function lilliput(): BimDocument {
  const doc = bimStarter();
  doc.inhabitantHeightMm = 146;
  doc.levels = [
    { id: 'l-1', name: '1', elevationMm: 0 },
    { id: 'l-2', name: '2', elevationMm: 250 },
  ];
  doc.types = [
    ...doc.types.filter((t) => t.kind !== 'door' && t.kind !== 'window'),
    {
      id: 't-waist',
      kind: 'slab',
      name: 'Waist',
      layers: [{ materialId: 'm-concrete', thicknessMm: 20 }],
    },
  ];
  return doc;
}

describe('drafting for the building people (ST-642, TS-2303)', () => {
  it('adds a level one Lilliput storey up and a stair with Lilliput steps', () => {
    const doc = lilliput();
    const level = draftLevel(doc);
    expect(level).toMatchObject({ entities: { levels: [{ elevationMm: 250 + 250 }] } });
    const stair = draftStair(doc, 'l-1', snap(0, 0), snap(400, 0), 't-waist');
    const el = (
      stair as { entities: { elements: { widthMm: number; risers: number; treadMm: number }[] } }
    ).entities.elements[0];
    expect(el.widthMm).toBe(100);
    expect(el.risers).toBe(17);
    expect(el.treadMm).toBe(25);
    const next = applyBimOperation(doc, stair);
    expect(validateBim(next).filter((d) => d.severity === 'error')).toEqual([]);
  });
  it('leaves 1,750 mm buildings as before', () => {
    const doc = bimStarter();
    expect(draftLevel(doc)).toMatchObject({ entities: { levels: [{ elevationMm: 9000 }] } });
  });
});
