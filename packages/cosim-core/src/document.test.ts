import { describe, expect, it } from 'vitest';
import {
  cosimLimits,
  cosimSelfHoldBindings,
  cosimStarter,
  isCosimDocument,
  validateCosim,
} from './index';

const ref = { artifactId: 'a1', versionId: 'v1', contentHash: 'h1' };
const codes = (doc: unknown) => validateCosim(doc).map((d) => `${d.code} ${d.path}`);

// TS-2117: the co-simulation document.
describe('cosim document (TS-2117)', () => {
  it('accepts the starter and a full document', () => {
    expect(isCosimDocument(cosimStarter())).toBe(true);
    expect(
      codes({
        ...cosimStarter(),
        schematic: ref,
        ladder: ref,
        bindings: cosimSelfHoldBindings(),
      }),
    ).toEqual([]);
  });
  it('refuses wrong shapes, references and bindings with paths', () => {
    expect(codes(null)).toEqual(['shape $']);
    expect(codes({ ...cosimStarter(), schemaVersion: 2, extra: 1 })).toEqual([
      'shape $.extra',
      'schema-version $.schemaVersion',
    ]);
    expect(codes({ ...cosimStarter(), schematic: { ...ref, contentHash: '' } })).toEqual([
      'source $.schematic',
    ]);
    const [start, lamp] = cosimSelfHoldBindings();
    expect(
      codes({
        ...cosimStarter(),
        bindings: [
          start,
          { ...lamp, variable: 'start' },
          { ...lamp, net: 'GPIO27', variable: 'X' },
          { variable: 'Y', net: 'N', kind: 'output', pull: 'up' },
          { variable: 'Z', net: 'M', kind: 'both' },
        ],
      }),
    ).toEqual([
      'binding-duplicate $.bindings[1].variable',
      'binding-duplicate $.bindings[2].net',
      'shape $.bindings[3].pull',
      'shape $.bindings[4].kind',
    ]);
    const many = Array.from({ length: cosimLimits.bindings + 1 }, (_, i) => ({
      variable: `V${i}`,
      net: `N${i}`,
      kind: 'input',
    }));
    expect(codes({ ...cosimStarter(), bindings: many })).toEqual(['limit-bindings $.bindings']);
  });
});
