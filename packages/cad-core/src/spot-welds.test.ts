import { describe, expect, it } from 'vitest';
import {
  applyCadOperation,
  cadSpotWeldLimits,
  compareCad,
  f49SpotWelds,
  validateCad,
  type CadDocument,
} from './index';

const codes = (doc: unknown) => validateCad(doc).map((d) => `${d.code}@${d.path}`);
const withWeld = (edit: (w: Record<string, unknown>) => void) => {
  const doc = structuredClone(f49SpotWelds()) as unknown as Record<string, unknown> & {
    spotWelds: Record<string, unknown>[];
  };
  edit(doc.spotWelds[0]!);
  return doc;
};

// TS-1549, ST-265.
describe('spot welds (CR4e)', () => {
  it('keeps a row of spot welds between two bodies’ flanges, and refuses a bad one', () => {
    const doc = f49SpotWelds({ both: true });
    expect(doc.spotWelds!.map((w) => w.id)).toEqual(['welds-l', 'welds-r']);
    expect(codes(doc)).toEqual([]);
    const [lo, hi] = cadSpotWeldLimits.pitchMm;
    expect(codes(withWeld((w) => (w.pitchMm = lo - 1)))).toEqual([
      'spot-weld-pitch@$.spotWelds[0].pitchMm',
    ]);
    expect(codes(withWeld((w) => (w.pitchMm = hi + 1)))).toEqual([
      'spot-weld-pitch@$.spotWelds[0].pitchMm',
    ]);
    expect(codes(withWeld((w) => (w.endDistanceMm = -1)))).toEqual([
      'spot-weld-end-distance@$.spotWelds[0].endDistanceMm',
    ]);
    expect(codes(withWeld((w) => (w.maxGapMm = 0)))).toEqual([
      'spot-weld-gap@$.spotWelds[0].maxGapMm',
    ]);
    // Both flanges on one body, a body that is not there, an edge, a feature not in the body.
    const flanges = (w: Record<string, unknown>) =>
      w.flanges as { bodyId: string; face: Record<string, unknown> }[];
    expect(codes(withWeld((w) => (flanges(w)[1]!.bodyId = 'member-body')))).toContain(
      'spot-weld-same-body@$.spotWelds[0].flanges',
    );
    expect(codes(withWeld((w) => (flanges(w)[1]!.bodyId = 'gone')))).toEqual([
      'spot-weld-body@$.spotWelds[0].flanges[1].bodyId',
    ]);
    expect(codes(withWeld((w) => (flanges(w)[0]!.face.kind = 'edge')))).toContain(
      'reference-kind@$.spotWelds[0].flanges[0].face.kind',
    );
    expect(codes(withWeld((w) => (flanges(w)[0]!.face.featureId = 'closure')))).toEqual([
      'reference-feature@$.spotWelds[0].flanges[0].face.featureId',
    ]);
    expect(codes(withWeld((w) => (w.flanges = [flanges(w)[0]])))).toEqual([
      'spot-weld-flanges@$.spotWelds[0].flanges',
    ]);
    // An empty list is not kept: no rows means no key.
    const empty = { ...structuredClone(doc), spotWelds: [] };
    expect(codes(empty)).toEqual(['spot-welds@$.spotWelds']);
  });

  it('changes, renames and removes a row, and drops it with its body', () => {
    let doc: CadDocument = f49SpotWelds({ both: true });
    const before = doc;
    const weld = { ...doc.spotWelds![0]!, pitchMm: 60 };
    doc = applyCadOperation(doc, { type: 'setSpotWeld', weld });
    expect(doc.spotWelds![0]!.pitchMm).toBe(60);
    expect(() => applyCadOperation(doc, { type: 'setSpotWeld', weld })).toThrow(
      'spot-weld-unchanged',
    );
    expect(compareCad(before, doc).map((c) => c.path)).toEqual(['spotWelds.pitchMm']);
    doc = applyCadOperation(doc, { type: 'rename', targetId: 'welds-r', name: 'Right' });
    expect(doc.spotWelds![1]!.name).toBe('Right');
    doc = applyCadOperation(doc, { type: 'removeSpotWeld', id: 'welds-r' });
    expect(doc.spotWelds!.map((w) => w.id)).toEqual(['welds-l']);
    expect(() => applyCadOperation(doc, { type: 'removeSpotWeld', id: 'welds-r' })).toThrow(
      'target-missing',
    );
    // Deleting the closure plate takes the row with it, and the key with the last row.
    doc = applyCadOperation(doc, { type: 'deleteClosure', ids: ['closure-body'], cascade: true });
    expect(doc.spotWelds).toBeUndefined();
    expect(codes(doc)).toEqual([]);
  });
});
