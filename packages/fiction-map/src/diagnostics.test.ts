import { expect, it } from 'vitest';
import { canonicalJson } from '@editor-platform/artifact-core';
import {
  validateFictionMap,
  parseFictionMap,
  prepareFictionMapChange,
  prepareFictionMapImport,
} from '@editor-platform/fiction-map/model';
import { EditorSession } from '@editor-platform/editor-core';
import { draft, native, layer, pointFeature } from './test-data';

it('structural field order, unknown-key code unit order, and precise capacity paths', () => {
  expect(validateFictionMap({ ...draft(), z: 1, a: 1 })).toMatchObject({
    ok: false,
    diagnostic: { code: 'unknown-field', path: '/a' },
  });
  expect(validateFictionMap({ ...draft(), schemaVersion: 2, a: 1 })).toMatchObject({
    ok: false,
    diagnostic: { code: 'unsupported-schema', path: '/schemaVersion' },
  });
  expect(
    validateFictionMap({
      ...draft(),
      features: [{ ...pointFeature(), id: '', description: '\0' }],
    }),
  ).toMatchObject({ ok: false, diagnostic: { code: 'invalid-string', path: '/features/0/id' } });
  for (const [key, count, code] of [
    ['layers', 11, 'layer-limit'],
    ['features', 201, 'feature-limit'],
    ['namedViews', 11, 'view-limit'],
  ] as const)
    expect(validateFictionMap({ ...draft(), [key]: Array(count) })).toMatchObject({
      ok: false,
      diagnostic: { code, path: '/' + key },
    });
  const features = Array.from({ length: 200 }, (_, i) =>
    pointFeature('p' + i, {
      type: 'polyline',
      coordinates: Array.from({ length: i ? 5 : 6 }, (_, j) => [i, j]),
    }),
  );
  expect(validateFictionMap({ ...draft(), layers: [layer()], features })).toMatchObject({
    ok: false,
    diagnostic: { code: 'map-vertex-limit', path: '/features' },
  });
  expect(
    validateFictionMap({
      ...draft(),
      coordinateSpace: {
        ...draft().coordinateSpace,
        bounds: { minX: 1, maxX: 1, minY: 0, maxY: 1 },
      },
    }),
  ).toMatchObject({
    ok: false,
    diagnostic: { code: 'invalid-bounds', path: '/coordinateSpace/bounds' },
  });
});
it('input value budget rejects before parsing or schema without changing input', () => {
  const values = Array(20000).fill(0),
    before = canonicalJson(values);
  expect(validateFictionMap(values)).toMatchObject({
    ok: false,
    diagnostic: { code: 'input-structure-limit', path: '/19999' },
  });
  expect(parseFictionMap(before)).toMatchObject({
    ok: false,
    diagnostic: { code: 'input-structure-limit', path: '/19999' },
  });
  expect(canonicalJson(values)).toBe(before);
});
it('remaining semantic diagnostics and command paths are explicit', () => {
  const c = native(),
    session = new EditorSession(c),
    base = { content: c, revision: session.revision };
  expect(prepareFictionMapChange(base, { delete: ['gone'] })).toMatchObject({
    ok: false,
    diagnostic: { code: 'missing-feature', path: '/delete/0' },
  });
  expect(prepareFictionMapChange(base, { create: [pointFeature()] })).toMatchObject({
    ok: false,
    diagnostic: { code: 'duplicate-id', path: '/create/0/id' },
  });
  expect(
    prepareFictionMapImport(base, c, {
      mode: 'append',
      remap: { layers: [{ from: 'gone', to: 'x' }] },
    }),
  ).toMatchObject({ ok: false, diagnostic: { code: 'invalid-remap', path: '/remap/layers/0' } });
  expect(
    prepareFictionMapImport(
      base,
      { ...c, coordinateSpace: { ...c.coordinateSpace, unit: { name: 'different' } } },
      { mode: 'append' },
    ),
  ).toMatchObject({
    ok: false,
    diagnostic: { code: 'import-space-mismatch', path: '/coordinateSpace' },
  });
  expect(
    validateFictionMap({ ...c, features: [{ ...pointFeature(), featureKind: 'region' }] }),
  ).toMatchObject({
    ok: false,
    diagnostic: { code: 'geometry-kind-mismatch', path: '/features/0/geometry/type' },
  });
  expect(parseFictionMap('{"name":"a","\\u006eame":"b"}')).toMatchObject({
    ok: false,
    diagnostic: { code: 'invalid-json', path: '/name' },
  });
  expect(
    validateFictionMap({ ...c, layers: [], precision: { minEdgeLength: -1, minPolygonArea: 0 } }),
  ).toMatchObject({
    ok: false,
    diagnostic: { code: 'missing-layer', path: '/features/0/layerId' },
  });
  expect(session.revision.sequence).toBe(0);
  expect(session.canUndo).toBe(false);
});
