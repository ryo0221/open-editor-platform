import { describe, expect, it } from 'vitest';
import { withMirrorCopy } from './car-fixtures';
import { f02Plate, f17Sheets } from './fixtures';
import { featureKind } from './graph';
import { position } from './model';
import { validateCad } from './validation';

const codes = (doc: unknown) => validateCad(doc).map((d) => `${d.code}@${d.path}`);

describe('mirror copy (CR4b)', () => {
  it('reflects a sheet or a solid into a new body and keeps the source', () => {
    // TS-1529, ST-261.
    for (const doc of [f17Sheets('extrude'), f02Plate()]) {
      const next = withMirrorCopy(doc);
      expect(codes(next)).toEqual([]);
      const kind = featureKind(doc, doc.bodies[0]!.resultFeatureId);
      expect(featureKind(next, 'copy')).toBe(kind);
      expect(next.bodies.map((b) => [b.id, b.state])).toEqual([
        ...doc.bodies.map((b) => [b.id, b.state]),
        ['copy-body', 'active'],
      ]);
      expect(next.bodies.find((b) => b.id === 'copy-body')!.kind).toBe(kind);
    }
    const sheet = f17Sheets('extrude');
    const bad = (args: unknown) => {
      try {
        withMirrorCopy(sheet, args);
      } catch (e) {
        return (e as Error).message;
      }
      return 'accepted';
    };
    const plane = { origin: position(0, 0, 0), normal: [1, 0, 0] };
    expect(bad({ source: { featureId: 'nope' }, plane })).toContain('reference-feature');
    expect(bad({ plane })).toContain('missing-field');
    expect(
      bad({
        source: { featureId: sheet.bodies[0]!.resultFeatureId },
        plane: { ...plane, normal: [2, 0, 0] },
      }),
    ).toContain('mirror-normal');
    expect(bad({ source: { featureId: sheet.bodies[0]!.resultFeatureId }, plane: 'y' })).toContain(
      'mirror-plane',
    );
  });
});
