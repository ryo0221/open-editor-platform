import { describe, expect, it } from 'vitest';
import { contentHash } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import {
  assertGeo,
  assertGeoBackgroundSettings,
  emptyGeoWorkspace,
  renderGeoSvg,
  prepareGeoDataExport,
  type GeoDocument,
} from './index';
import {
  bundledGeoBackgrounds,
  createGeoBackgroundCatalog,
  defaultGeoBackgroundSettings,
  resolveGeoBackgrounds,
} from '@editor-platform/geo-core/backgrounds';
const limits = { actions: 10, bytes: 65536, depth: 24, layers: 1, features: 200, vertices: 1000 };
function content(): GeoDocument {
  return {
    schemaVersion: 1,
    sources: [],
    layers: [
      {
        id: 'points',
        name: 'Places',
        crs: 'OGC:CRS84',
        axis: 'longitude-latitude',
        fields: [],
        features: [
          {
            id: 'tokyo',
            rowId: 'tokyo',
            values: {},
            geometry: { type: 'Point', coordinates: [139.75, 35.68] },
          },
        ],
      },
    ],
  };
}
const on = () => defaultGeoBackgroundSettings().map((setting) => ({ ...setting, enabled: true }));
async function smallEntry() {
  const data = {
    schemaVersion: 1,
    id: 'small',
    version: '1',
    scale: 1000000,
    features: [[[[0, 0, 1000000, 0, 0, 1000000, -1000000, -1000000]]]],
  };
  return {
    id: data.id,
    version: data.version,
    hash: 'sha256:' + (await contentHash(data)),
    label: 'Small',
    attribution: 'Synthetic data',
    sourceUrl: 'https://example.com/source',
    licenseUrl: 'https://example.com/license',
    data,
  };
}
const enabled = (entry: { id: string; version: string; hash: string }) => [
  { id: entry.id, version: entry.version, hash: entry.hash, enabled: true, color: '#123456' },
];
describe('bundled read-only geographic backgrounds (#280)', () => {
  it('paints the country fill below every stroke even when the saved settings put countries last', () => {
    const settings = on().reverse();
    const svg = renderGeoSvg(
      content(),
      {
        extent: [138, 34, 142, 38],
        width: 960,
        height: 600,
        backgrounds: resolveGeoBackgrounds(settings),
      },
      limits,
    );
    for (const setting of settings) {
      expect(svg.indexOf('data-background-fill="world-countries"')).toBeLessThan(
        svg.indexOf(`data-background-id="${setting.id}"`),
      );
      expect(svg).toContain(
        `data-background-id="${setting.id}" aria-hidden="true" pointer-events="none"><path`,
      );
    }
    expect(svg.match(/fill="none" stroke="#8b9ba7"/g)).toHaveLength(3);
    expect(settings.at(-1)!.id).toBe('world-countries');
  });
  it.each([240, 600])(
    'retains all 16 native attribution lines and optional background credits at height %i',
    (height) => {
      const d = content();
      d.sources = [
        {
          id: 'source',
          resourceId: 'resource',
          bytesHash: 'sha256:' + 'a'.repeat(64),
          pin: { artifactId: 'source', versionId: 'v1', contentHash: 'sha256:' + 'b'.repeat(64) },
          format: 'geojson',
          adapterVersion: '1',
          declaredCrs: 'OGC:CRS84',
          axis: 'longitude-latitude',
          attribution: 'S'.repeat(90 * 16),
        },
      ];
      const options = {
        extent: [138, 34, 142, 38] as [number, number, number, number],
        width: 960,
        height,
      };
      expect(() => renderGeoSvg(d, options, limits)).not.toThrow();
      const svg = renderGeoSvg(d, { ...options, backgrounds: resolveGeoBackgrounds(on()) }, limits);
      expect(svg.match(new RegExp('S'.repeat(90), 'g'))).toHaveLength(16);
      expect(svg).toContain('OpenStreetMap / Wambacher');
      expect(svg).toContain('https://creativecommons.org/licenses/by-sa/2.0/');
      expect(svg).toContain('data-feature-id="tokyo"');
      expect(
        Number(svg.match(/clipPath[^>]*><rect width="[^"]+" height="([^"]+)"/)![1]),
      ).toBeGreaterThanOrEqual(24);
      d.sources[0].attribution += 'S';
      expect(() => renderGeoSvg(d, options, limits)).toThrow('Attribution exceeds image budget');
    },
  );
  it.each([
    ['id', 'invalid id'],
    ['version', ''],
    ['hash', 'bad'],
    ['label', ''],
    ['label', 'x'.repeat(129)],
    ['attribution', undefined],
    ['attribution', null],
    ['attribution', 42],
    ['attribution', '   '],
    ['attribution', 'x'.repeat(181)],
    ['sourceUrl', undefined],
    ['sourceUrl', 'not a URL'],
    ['sourceUrl', 'javascript:alert(1)'],
    ['licenseUrl', null],
    ['licenseUrl', 'file:///tmp/license'],
    ['licenseUrl', 'https://fixture@example.test/license'],
  ])('omits malformed catalog metadata %s=%j instead of rendering it', async (key, value) => {
    const entry = await smallEntry();
    const resolve = createGeoBackgroundCatalog([{ ...entry, [key as string]: value } as never]);
    const result = resolve(enabled(entry));
    expect(result.layers).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(() =>
      renderGeoSvg(
        content(),
        { extent: [-1, -1, 2, 2], width: 960, height: 600, backgrounds: result },
        limits,
      ),
    ).not.toThrow();
  });
  it('owns catalog metadata and data before a caller can mutate either', async () => {
    const entry = await smallEntry();
    const resolve = createGeoBackgroundCatalog([entry]);
    entry.attribution = 'Altered';
    entry.licenseUrl = 'javascript:alert(1)';
    entry.data.features[0][0][0][0] = 999;
    const result = resolve(enabled(entry));
    expect(result.diagnostics).toEqual([]);
    expect(result.layers[0].attribution).toBe('Synthetic data');
    expect(result.layers[0].licenseUrl).toBe('https://example.com/license');
    expect(result.layers[0].geometries[0]).toMatchObject({
      coordinates: [
        [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      ],
    });
  });
  it.each(['attribution', 'data', 'id'])(
    'rejects descriptor accessors for %s without invoking them',
    async (key) => {
      const entry = await smallEntry();
      let reads = 0;
      const bad = Object.defineProperty({ ...entry }, key, {
        enumerable: true,
        get() {
          reads++;
          return entry[key as keyof typeof entry];
        },
      });
      const result = createGeoBackgroundCatalog([bad])(enabled(entry));
      expect(reads).toBe(0);
      expect(result.layers).toEqual([]);
      expect(result.diagnostics).toHaveLength(1);
    },
  );
  it('verifies every pinned dataset and decodes all country, region and Japanese municipality features', () => {
    const settings = on(),
      resolution = resolveGeoBackgrounds(settings);
    expect(resolution.diagnostics).toEqual([]);
    expect(resolution.layers.map((l) => l.geometries.length)).toEqual([177, 4596, 1742]);
    expect(resolution.layers.map((l) => l.setting.hash)).toEqual(
      bundledGeoBackgrounds.map((l) => l.hash),
    );
    expect(Object.isFrozen(resolution.layers[2].geometries[0])).toBe(true);
    expect(resolution.layers[2].licenseUrl).toContain('by-sa/2.0');
  });
  it('keeps background geometry outside native feature/vertex/byte budgets, content hash and local history', async () => {
    const s = new EditorSession(content()),
      before = s.content,
      hash = await contentHash(before),
      revision = s.revision;
    const svg = renderGeoSvg(
      s.content,
      {
        extent: [138, 34, 142, 38],
        width: 960,
        height: 600,
        backgrounds: resolveGeoBackgrounds(on()),
      },
      limits,
    );
    assertGeo(s.content, { ...limits, features: 1, vertices: 1 });
    expect(await contentHash(s.content)).toBe(hash);
    expect(s.content).toEqual(before);
    expect(s.revision).toEqual(revision);
    expect([s.canUndo, s.canRedo]).toEqual([false, false]);
    expect(svg.indexOf('data-background-id')).toBeLessThan(svg.indexOf('data-feature-id'));
    expect(svg.match(/data-feature-id=/g)).toHaveLength(1);
    expect(svg).toContain('aria-hidden="true" pointer-events="none"');
    expect(svg).toContain('Natural Earth');
    expect(svg).toContain('OpenStreetMap / Wambacher');
    expect(svg).not.toContain('<script');
  });
  it('produces a network-free world reference within the unchanged 2 MiB SVG projection budget', () => {
    const svg = renderGeoSvg(
      content(),
      {
        extent: [-180, -90, 180, 90],
        width: 1000,
        height: 700,
        backgrounds: resolveGeoBackgrounds(on()),
      },
      limits,
    );
    expect(new TextEncoder().encode(svg).length).toBeLessThan(2097152);
    expect(svg).not.toMatch(/(?:href|src)=/);
  });
  it('keeps old views readable and retains only settings/pins in a saved native view', () => {
    const d = content();
    d.workspace = emptyGeoWorkspace();
    const view = {
      id: 'tokyo',
      name: 'Tokyo',
      extent: [138, 34, 142, 38] as [number, number, number, number],
      styles: [],
      annotations: [],
    };
    d.workspace.views.push(view);
    assertGeo(d, limits);
    expect(d.workspace.views[0]).not.toHaveProperty('backgrounds');
    d.workspace.views[0].backgrounds = on();
    assertGeo(d, limits);
    const wire = JSON.parse(JSON.stringify(d));
    expect(resolveGeoBackgrounds(wire.workspace.views[0].backgrounds).diagnostics).toEqual([]);
    expect(JSON.stringify(wire.workspace.views[0].backgrounds)).not.toContain('coordinates');
    expect(new TextEncoder().encode(JSON.stringify(wire)).length).toBeLessThan(65536);
  });
  it('keeps backgrounds out of both CSV and GeoJSON data exports', () => {
    const d = content(),
      pin = { artifactId: 'map', versionId: 'v1', contentHash: 'sha256:' + 'a'.repeat(64) };
    for (const format of ['csv', 'geojson'] as const) {
      const selection = { layerId: 'points', fieldIds: [], format },
        budget = { native: limits, outputBytes: 65536 };
      const before = prepareGeoDataExport({ content: d, pin }, selection, budget).data.text;
      const changed = {
        ...d,
        workspace: {
          ...emptyGeoWorkspace(),
          views: [
            {
              id: 'v',
              name: 'View',
              extent: [138, 34, 142, 38] as [number, number, number, number],
              styles: [],
              annotations: [],
              backgrounds: on(),
            },
          ],
        },
      };
      expect(prepareGeoDataExport({ content: changed, pin }, selection, budget).data.text).toBe(
        before,
      );
      expect(before).not.toContain('world-countries');
    }
  });
  it('keeps both visible halves of a boundary ring crossing the world dateline', async () => {
    const pack = {
      schemaVersion: 1,
      id: 'wrap',
      version: '1',
      scale: 1000000,
      features: [[[[179000000, 10000000, -358000000, 0, 0, 10000000, 358000000, 0, 0, -10000000]]]],
    };
    const hash = 'sha256:' + (await contentHash(pack));
    const resolve = createGeoBackgroundCatalog([
      {
        id: 'wrap',
        version: '1',
        hash,
        label: 'Wrap',
        attribution: 'Synthetic',
        sourceUrl: 'https://example.com',
        licenseUrl: 'https://example.com',
        data: pack,
      },
    ]);
    const backgrounds = resolve([
      { id: 'wrap', version: '1', hash, enabled: true, color: '#000000' },
    ]);
    expect(backgrounds.diagnostics).toEqual([]);
    const svg = renderGeoSvg(
      content(),
      { extent: [-180, -90, 180, 90], width: 1000, height: 700, backgrounds },
      limits,
    );
    const path = svg.match(/data-background-id="wrap"[^>]*><path d="([^"]*)"/)![1];
    expect(path.match(/M/g)).toHaveLength(2);
  });
  it('displays without missing, old-version or mismatched datasets, diagnosing each exact pin', () => {
    const settings = on();
    settings[0].version = 'unknown';
    settings[1].hash = 'sha256:' + '0'.repeat(64);
    const result = resolveGeoBackgrounds(settings);
    expect(result.layers.map((l) => l.setting.id)).toEqual(['japan-municipalities']);
    expect(result.diagnostics.map((d) => d.id)).toEqual(['world-countries', 'world-regions']);
    const empty = createGeoBackgroundCatalog([])(on());
    expect(empty.layers).toEqual([]);
    expect(empty.diagnostics).toHaveLength(3);
    const svg = renderGeoSvg(
      content(),
      { extent: [138, 34, 142, 38], width: 960, height: 600, backgrounds: empty },
      limits,
    );
    expect(svg).toContain('Background unavailable: world-countries');
    expect(svg).toContain('data-feature-id="tokyo"');
  });
  it('rejects corrupt bytes without changing previously verified data or following latest', () => {
    const entry = bundledGeoBackgrounds[0];
    const forged = createGeoBackgroundCatalog([
      { ...entry, data: { ...(entry.data as object), scale: 100 } },
    ]);
    const settings = on().slice(0, 1);
    expect(forged(settings).diagnostics[0].reason).toContain('hash mismatch');
    expect(resolveGeoBackgrounds(settings).diagnostics).toEqual([]);
    const first = resolveGeoBackgrounds(settings);
    settings[0].color = '#123456';
    expect(first.layers[0].setting.color).toBe('#8b9ba7');
    expect(resolveGeoBackgrounds(settings).layers[0].setting.color).toBe('#123456');
    expect(first.layers[0].geometries).toBe(resolveGeoBackgrounds(settings).layers[0].geometries);
  });
  it.each(
    [
      [{ id: 'x', version: '1', hash: 'bad', color: '#000000', enabled: true }],
      [{ ...on()[0], color: 'url(https://example.com)' }],
      [{ ...on()[0], enabled: 'yes' }],
      [...on(), on()[0]],
      [{ ...on()[0], coordinates: [] }],
    ].map((value) => [value] as const),
  )('refuses malformed saved background references: %j', (value) => {
    expect(() => assertGeoBackgroundSettings(value)).toThrow();
    const d = content();
    d.workspace = {
      ...emptyGeoWorkspace(),
      views: [
        {
          id: 'v',
          name: 'View',
          extent: [130, 30, 140, 40],
          styles: [],
          annotations: [],
          backgrounds: value as never,
        },
      ],
    };
    expect(() => assertGeo(d, limits)).toThrow();
  });
  it('rejects settings accessors before invocation', () => {
    let reads = 0;
    expect(() =>
      assertGeoBackgroundSettings([
        {
          ...on()[0],
          get enabled() {
            reads++;
            return true;
          },
        },
      ]),
    ).toThrow();
    expect(reads).toBe(0);
  });
});
