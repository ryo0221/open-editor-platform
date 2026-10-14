import { expect, it } from 'vitest';
import {
  createDesign,
  exportDesignSvg,
  isDesign,
  makeDesignVector,
  validDesignVector,
} from '@editor-platform/design/model';
import { checkVector, compactArcPaths } from '../../../tests/fixtures/design-reuse/content';

it.each(['source', 'name', 'version', 'license'] as const)(
  'rejects XML-forbidden characters in vector %s',
  (field) => {
    for (const invalid of [
      '\0',
      '\u0001',
      '\u0007',
      '\v',
      '\f',
      '\ud800',
      '\udfff',
      '\ufffe',
      '\uffff',
    ]) {
      const vector = {
        ...checkVector,
        provenance: { ...checkVector.provenance, [field]: `Before${invalid}after` },
      };
      expect(validDesignVector(vector)).toBe(false);
      expect(() => makeDesignVector(vector)).toThrow(/Invalid/);
      const icon = { ...makeDesignVector(checkVector), vector };
      expect(isDesign({ ...createDesign(), elements: [icon] })).toBe(false);
    }
  },
);

it('keeps XML-valid Unicode and escaped provenance through native JSON and export', () => {
  const name = '許諾 🚀 <&"\t\n\r \ud7ff\ue000\ufffd\u{10000}\u{10ffff}';
  const vector = { ...checkVector, provenance: { ...checkVector.provenance, name } };
  const content = { ...createDesign(), elements: [makeDesignVector(vector)] };
  expect(validDesignVector(vector)).toBe(true);
  const restored = JSON.parse(JSON.stringify(content));
  expect(isDesign(restored)).toBe(true);
  expect(restored.elements[0].vector.provenance.name).toBe(name);
  expect(exportDesignSvg(restored)).toContain('許諾 🚀 &lt;&amp;&quot;');
});

it('keeps undeclared view-box metadata out of SVG clip attributes', () => {
  const vector = {
    ...checkVector,
    viewBox: { ...checkVector.viewBox, onload: 'ignored', extra: '\u0001' },
  };
  const icon = makeDesignVector(vector);
  const content = { ...createDesign(), elements: [icon] };
  expect(isDesign(content)).toBe(true);
  const svg = exportDesignSvg(content);
  expect(svg).not.toContain('onload');
  expect(svg).not.toContain('\u0001');
  expect(icon.vector).toEqual(vector);
});

it.each(compactArcPaths)('accepts optimized arc flags: %s', (path) => {
  const vector = { ...checkVector, paths: [path] };
  expect(validDesignVector(vector)).toBe(true);
  const icon = makeDesignVector(vector);
  const content = { ...createDesign(), elements: [icon] };
  expect(isDesign(JSON.parse(JSON.stringify(content)))).toBe(true);
  expect(icon.vector!.paths[0]).toBe(path);
});

it.each([
  'M0 0A5 5 0 2010 10',
  'M0 0A5 5 0 +0110 10',
  'M0 0A5 5 0 0-110 10',
  'M0 0A5 5 0 .0110 10',
  'M0 0A5 5 0 1e1 10 10',
  'M0 0A-5 5 0 0110 10',
  'M0 0A5 5 0 011000001 10',
])('rejects malformed flags, radii or oversized compact coordinates: %s', (path) => {
  expect(validDesignVector({ ...checkVector, paths: [path] })).toBe(false);
});
