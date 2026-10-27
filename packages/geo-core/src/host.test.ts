import { describe, expect, it } from 'vitest';
import { geoFeatureReadLimit, parseGeoBbox } from './host';
import { createMockGeoFeatureHost } from './mock-host';

const signal = () => new AbortController().signal;
const bbox = parseGeoBbox('139.6,35.5,139.9,35.8')!;

describe('Geo external feature port', () => {
  it('checks typed areas in CRS84 and accepts antimeridian crossings', () => {
    expect(parseGeoBbox(' 170, -10, -170, 10 ')).toEqual([170, -10, -170, 10]);
    expect(parseGeoBbox('0,10,1,5')).toBeUndefined();
    expect(parseGeoBbox('0,0,181,1')).toBeUndefined();
    expect(parseGeoBbox('0,0,1')).toBeUndefined();
    expect(parseGeoBbox('139.6,,139.9,35.8')).toBeUndefined();
    expect(parseGeoBbox('139.6, ,139.9,35.8')).toBeUndefined();
  });

  it('reads synthetic features and says what it left out', async () => {
    const host = createMockGeoFeatureHost();
    const [source] = await host.read.listSources(signal());
    const read = await host.read.readFeatures(
      { sourceHandle: source.handle, bbox, limit: geoFeatureReadLimit },
      signal(),
    );
    expect(read.complete).toBe(true);
    expect(read.features.map((f) => f.id)).toContain('station-1');
    expect(read.rejected).toEqual([expect.objectContaining({ reason: 'unsupported-geometry' })]);
    expect(read.omittedProperties).toEqual(['tags']);
    // The area filters located features; a feature without a location is still reported.
    const narrow = await host.read.readFeatures(
      { sourceHandle: source.handle, bbox: [139.71, 35.63, 139.73, 35.65], limit: 10 },
      signal(),
    );
    expect(narrow.features.map((f) => f.id)).toEqual(['station-1', 'unknown-location']);
  });

  it('reports a cut read as incomplete and answers a held read with its old generation', async () => {
    const host = createMockGeoFeatureHost();
    const [source] = await host.read.listSources(signal());
    host.controls.setComplete(false);
    const cut = await host.read.readFeatures(
      { sourceHandle: source.handle, bbox, limit: 400 },
      signal(),
    );
    expect(cut.complete).toBe(false);
    host.controls.setComplete(true);
    const notices: string[] = [];
    host.read.watch!((n) => notices.push(n.kind));
    host.controls.holdReads(true);
    const late = host.read.readFeatures(
      { sourceHandle: source.handle, bbox, limit: 400 },
      signal(),
    );
    host.controls.switchAccount();
    host.controls.releaseReads();
    expect((await late).generation).toBe('1');
    expect(notices).toEqual(['revoked']);
    const [next] = await host.read.listSources(signal());
    expect(next.handle).not.toBe(source.handle);
    host.controls.holdReads(false);
    await expect(
      host.read.readFeatures({ sourceHandle: source.handle, bbox, limit: 400 }, signal()),
    ).rejects.toThrow(/no longer connected/);
  });
});
