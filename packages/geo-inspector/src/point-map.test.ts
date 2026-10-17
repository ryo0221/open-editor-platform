import { describe, it, expect } from 'vitest';
import { prepareGeoInspection } from './index';
import { preparePointScene } from './point-map';
import { pointFixture } from '../test-host/point-fixture';
import { budgets } from '../test-host/fixture';
const layer = () => pointFixture().layers[0];
describe('local Point frame policy / AC02,04,07 subsets', () => {
  it('keeps source-free native and coincident IDs; east/right and north/up', async () => {
    const input = pointFixture(),
      before = JSON.stringify(input);
    const prepared = await prepareGeoInspection(input, budgets);
    const scene = prepared.pointScenes[0];
    expect(JSON.stringify(input)).toBe(before);
    expect(prepared.content.sources).toEqual([]);
    expect(scene.status).toBe('ready');
    expect(scene.points.map((p) => p.featureId)).toEqual(['point-1', 'point-2', 'point-3']);
    expect(scene.points[1].x).toBeGreaterThan(scene.points[0].x);
    expect(scene.points[1].y).toBeLessThan(scene.points[0].y);
    expect(scene.points[0].x).toBe(scene.points[2].x);
    expect(scene.points[0].y).toBe(scene.points[2].y);
    expect(scene.omitted.map((p) => p.featureId)).toEqual(['point-4', 'point-5']);
    expect(Object.isFrozen(scene.points)).toBe(true);
  });
  it('exact span 5 passes; any representable excess blocks the whole layer', () => {
    const l = layer();
    l.features = l.features.slice(0, 2);
    l.features[0].geometry = { type: 'Point', coordinates: [0, 0] };
    l.features[1].geometry = { type: 'Point', coordinates: [5, 5] };
    expect(preparePointScene(l).status).toBe('ready');
    for (const coordinates of [
      [5 + 1e-12, 5],
      [5, 5 + 1e-12],
    ] as [number, number][]) {
      l.features[1].geometry = { type: 'Point', coordinates };
      const s = preparePointScene(l);
      expect(s.status).toBe('unsupported');
      expect(s.points).toEqual([]);
    }
  });
  it('absolute latitude threshold excludes both poles without conversion', () => {
    const l = layer();
    l.features = l.features.slice(0, 1);
    for (const latitude of [69.999, -69.999, 70, -70, 90, -90]) {
      l.features[0].geometry = { type: 'Point', coordinates: [0, latitude] };
      expect(preparePointScene(l).status).toBe(Math.abs(latitude) < 70 ? 'ready' : 'unsupported');
    }
  });
  it('dateline and global span are explicit refusals, never wrapped', () => {
    const s = preparePointScene(pointFixture('dateline').layers[0]);
    expect(s.points).toEqual([]);
    expect(s.reasons.join(' ')).toContain('Dateline');
    expect(s.extent).toEqual([-179, 0, 179, 0]);
  });
  it('all-null/non-Point empty map keeps every diagnostic and native structure', () => {
    const l = pointFixture('unsupported').layers[0],
      before = JSON.stringify(l);
    const s = preparePointScene(l);
    expect(s.status).toBe('empty');
    expect(s.points).toEqual([]);
    expect(s.omitted).toHaveLength(3);
    expect(JSON.stringify(l)).toBe(before);
  });
  it('singleton and identical locations give finite centered markers without rounding native', () => {
    const l = layer();
    l.features = l.features.slice(0, 1);
    l.features[0].geometry = { type: 'Point', coordinates: [12.123456789, 34.123456789] };
    const s = preparePointScene(l);
    expect(s.points[0]).toMatchObject({
      x: 320,
      y: 160,
      longitude: 12.123456789,
      latitude: 34.123456789,
    });
  });
  it('array order never defines identity or frame; malformed native is refused before scene', async () => {
    const input = pointFixture();
    const a = preparePointScene(input.layers[0]);
    input.layers[0].features.reverse();
    const b = preparePointScene(input.layers[0]);
    expect(b.extent).toEqual(a.extent);
    expect(b.points.find((p) => p.featureId === 'point-1')).toEqual(a.points[0]);
    input.layers[0].features.find((f) => f.id === 'point-1')!.geometry = {
      type: 'Point',
      coordinates: [NaN, 0],
    };
    await expect(prepareGeoInspection(input, budgets)).rejects.toThrow();
  });
});
