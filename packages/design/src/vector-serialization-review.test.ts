import { expect, it } from 'vitest';
import { drawingPrimitives, serializeSvg } from '@editor-platform/editor-core';
import {
  designDrawingProjector,
  exportDesignSvg,
  isDesign,
  makeDesignVector,
  createDesign,
  validDesignVector,
  makeDesignElement,
} from '@editor-platform/design/model';
import { checkVector, collidingVectors } from '../../../tests/fixtures/design-reuse/content';

it('gives repeated drawing occurrences unique clip resources without altering native IDs', () => {
  const content = collidingVectors();
  const before = JSON.stringify(content);
  expect(isDesign(content)).toBe(true);
  const drawings = content.elements.flatMap(designDrawingProjector(content));
  // Legacy drawing IDs remain useful for existing text/selection addresses.
  expect(drawings.map((d) => d.id)).toEqual(['a-b', 'a-b']);
  expect(drawings.map((d) => d.vector!.viewBox.width)).toEqual([24, 12]);
  const svg = serializeSvg(drawings.flatMap((d) => drawingPrimitives(d)));
  const ids = [...svg.matchAll(/clipPath id="([^"]+)"/g)].map((match) => match[1]);
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(svg).toContain(`clip-path="url(#${id})"`);
  expect(exportDesignSvg(content)).toBe(exportDesignSvg(content));
  expect(JSON.stringify(content)).toBe(before);
});

it('allows a stable caller-owned resource ID without mutating drawing addresses', () => {
  const content = collidingVectors();
  const drawing = designDrawingProjector(content)(content.elements[0])[0];
  const first = serializeSvg(drawingPrimitives(drawing, 'host-occurrence-0'));
  expect(first).toBe(serializeSvg(drawingPrimitives(drawing, 'host-occurrence-0')));
  expect(first).toContain('vector-host-occurrence-0');
  expect(drawing.id).toBe('a-b');
});

it.each([false, true])(
  'keeps ancestor frame clipping and visibility with colliding native IDs, hidden=%s',
  (hidden) => {
    const source = collidingVectors();
    const instance = { ...source.elements[1], parentId: 'a-b' };
    const frame = {
      ...makeDesignElement('frame'),
      id: 'a-b',
      hidden,
      clipContent: true,
      bounds: { x: 80, y: 0, width: 24, height: 12 },
    };
    const content = { ...source, elements: [frame, instance] };
    expect(isDesign(content)).toBe(true);
    const drawings = designDrawingProjector(content)(instance);
    expect(drawings).toHaveLength(hidden ? 0 : 1);
    if (!hidden) {
      expect(drawings[0].id).toBe('a-b');
      expect(drawings[0].vector!.viewBox.width).toBe(12);
      expect(drawings[0].clipBounds).toEqual([{ ...frame.bounds, rotation: frame.rotation }]);
    }
  },
);

it.each(['\u00a0', '\f', '\v', '\u1680', '\u2003', '\u2028', '\u2029', '\ufeff'])(
  'rejects non-SVG whitespace U+%s at leading, interior and trailing path positions',
  (separator) => {
    for (const path of [
      `${separator}M0 0L24 24`,
      `M0${separator}0L24 24`,
      `M0 0L24 24${separator}`,
    ]) {
      const vector = { ...checkVector, paths: [path] };
      expect(validDesignVector(vector)).toBe(false);
      expect(() => makeDesignVector(vector)).toThrow(/Invalid/);
      const icon = { ...makeDesignVector(checkVector), vector };
      expect(isDesign({ ...createDesign(), elements: [icon] })).toBe(false);
    }
  },
);

it.each([' ', '\t', '\r', '\n'])(
  'keeps supported SVG whitespace %j renderable across native JSON',
  (separator) => {
    const vector = {
      ...checkVector,
      paths: [`${separator}M0${separator}0${separator}L24,${separator}24${separator}`],
    };
    expect(validDesignVector(vector)).toBe(true);
    const content = { ...createDesign(), elements: [makeDesignVector(vector)] };
    expect(isDesign(JSON.parse(JSON.stringify(content)))).toBe(true);
    expect(exportDesignSvg(content)).toContain('d="');
  },
);
