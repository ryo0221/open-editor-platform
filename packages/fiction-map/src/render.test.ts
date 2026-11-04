import { it, expect } from 'vitest';
import { createFictionMap, validateFictionMap } from './model';
import { renderFictionMapSvg } from './render';
import { exportFictionMapPng } from './image-export';
const native = () => {
  const r = validateFictionMap({
    ...createFictionMap(),
    coordinateSpace: {
      kind: 'local-plane',
      bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      unit: { name: 'map-unit' },
      yAxis: 'down',
    },
    layers: [{ id: 'l', name: 'Layer', purpose: 'annotation', visibleByDefault: true }],
    features: [
      {
        id: 'p',
        name: 'A<&"',
        featureKind: 'place',
        layerId: 'l',
        geometry: { type: 'point', coordinates: [20, 30] },
      },
      {
        id: 'r',
        name: 'Area',
        featureKind: 'region',
        layerId: 'l',
        geometry: {
          type: 'polygon',
          outer: [
            [0, 0],
            [50, 0],
            [0, 50],
            [0, 0],
          ],
        },
      },
    ],
    namedViews: [
      {
        id: 'default',
        name: 'Actual default-named view',
        extent: { minX: 10, minY: 10, maxX: 50, maxY: 50 },
        visibleLayerIds: ['l'],
      },
    ],
  });
  if (!r.ok) throw Error(r.diagnostic.code);
  return r.value;
};
it('renders deterministic default/named views, y axes, paint and escaped labels', () => {
  const c = native(),
    a = renderFictionMapSvg(c, { width: 100, height: 100, background: 'transparent' });
  expect(a.svg).toBe(
    renderFictionMapSvg(c, { width: 100, height: 100, background: 'transparent' }).svg,
  );
  expect(a.svg).toContain('cx="20" cy="30"');
  expect(a.svg).toContain('A&lt;&amp;&quot;');
  expect(a.svg.indexOf('data-feature-id="p"')).toBeLessThan(a.svg.indexOf('data-feature-id="r"'));
  expect(a.svg).not.toContain('fill="#ffffff"');
  expect(
    renderFictionMapSvg(
      { ...c, coordinateSpace: { ...c.coordinateSpace, yAxis: 'up' } },
      { width: 100, height: 100 },
    ).svg,
  ).toContain('cx="20" cy="70"');
  expect(
    renderFictionMapSvg(c, { width: 100, height: 100, view: { kind: 'named', id: 'default' } }).svg,
  ).toContain('cx="25" cy="50"');
  expect(a.svg).not.toMatch(/handle|Inspector|camera/);
  const layered = {
    ...c,
    layers: [{ ...c.layers[0], id: 'terrain' }, c.layers[0]],
    features: [c.features[0], { ...c.features[1], layerId: 'terrain' }],
  };
  const paint = renderFictionMapSvg(layered, { width: 100, height: 100 }).svg;
  // Native layer order takes priority over the input feature array's order.
  expect(paint.indexOf('data-feature-id="r"')).toBeLessThan(paint.indexOf('data-feature-id="p"'));
});
it('rejects missing targets, invalid native and numeric/output budgets', () => {
  const c = native();
  for (const size of [0, 4097, Infinity, NaN, 1.5])
    expect(() => renderFictionMapSvg(c, { width: size, height: 100 })).toThrow();
  expect(() =>
    renderFictionMapSvg(c, { width: 100, height: 100, view: { kind: 'named', id: 'missing' } }),
  ).toThrow('missing');
  expect(() =>
    renderFictionMapSvg(c, { width: 100, height: 100, featureIds: ['missing'] }),
  ).toThrow('missing');
  expect(() =>
    renderFictionMapSvg({ ...c, schemaVersion: 99 }, { width: 100, height: 100 }),
  ).toThrow();
  expect(() =>
    renderFictionMapSvg(c, { width: 100, height: 100, background: 'url(javascript:1)' }),
  ).toThrow();
  expect(() =>
    renderFictionMapSvg(
      {
        ...c,
        namedViews: [
          {
            ...c.namedViews[0],
            extent: { minX: 0, minY: 0, maxX: Number.MIN_VALUE, maxY: Number.MIN_VALUE },
          },
        ],
      },
      { width: 100, height: 100, view: { kind: 'named', id: 'default' } },
    ),
  ).toThrow('projected');
});
it('rejects stale asynchronous raster results without mutating native', async () => {
  const c = native(),
    before = JSON.stringify(c);
  let current = true;
  await expect(
    exportFictionMapPng(
      c,
      { width: 100, height: 100 },
      {
        isCurrent: () => current,
        rasterize: async () => {
          current = false;
          return new Uint8Array([1]);
        },
      },
    ),
  ).rejects.toThrow('stale-output');
  expect(JSON.stringify(c)).toBe(before);
});
