import { canonicalJson, deepFreeze } from '@editor-platform/artifact-core';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { assertGeo, hash, id, record } from './validation';
import { checkedJson } from './json-boundary';
import {
  assertGeoBackgroundSettings,
  type GeoBackgroundSetting,
  type GeoBackgroundResolution,
} from './background';
import type { Geometry, Position } from './model';
import manifest from '../data/manifest.json' with { type: 'json' };
import countries from '../data/world-countries.json' with { type: 'json' };
import municipalities from '../data/japan-municipalities.json' with { type: 'json' };
import regions0 from '../data/world-regions.0.json' with { type: 'json' };
import regions1 from '../data/world-regions.1.json' with { type: 'json' };
import regions2 from '../data/world-regions.2.json' with { type: 'json' };
import regions3 from '../data/world-regions.3.json' with { type: 'json' };
import regions4 from '../data/world-regions.4.json' with { type: 'json' };
import regions5 from '../data/world-regions.5.json' with { type: 'json' };
import regions6 from '../data/world-regions.6.json' with { type: 'json' };
import regions7 from '../data/world-regions.7.json' with { type: 'json' };
import regions8 from '../data/world-regions.8.json' with { type: 'json' };
import regions9 from '../data/world-regions.9.json' with { type: 'json' };
const regions = {
  schemaVersion: 1,
  id: 'world-regions',
  version: '5.1.2-display.1',
  scale: 1000000,
  features: [
    ...regions0,
    ...regions1,
    ...regions2,
    ...regions3,
    ...regions4,
    ...regions5,
    ...regions6,
    ...regions7,
    ...regions8,
    ...regions9,
  ],
};

export interface GeoBackgroundCatalogEntry {
  id: string;
  version: string;
  hash: string;
  label: string;
  attribution: string;
  sourceUrl: string;
  licenseUrl: string;
  data: unknown;
}
const data: Record<string, unknown> = {
  'world-countries': countries,
  'world-regions': regions,
  'japan-municipalities': municipalities,
};
export const bundledGeoBackgrounds = deepFreeze(
  manifest.map((entry) => ({ ...entry, data: data[entry.id] })),
);
export const defaultGeoBackgroundSettings = (): GeoBackgroundSetting[] =>
  bundledGeoBackgrounds.map(({ id, version, hash }) => ({
    id,
    version,
    hash,
    color: '#8b9ba7',
    enabled: false,
  }));
const budget = {
  actions: 1,
  bytes: 16000000,
  depth: 16,
  layers: 1,
  features: 10000,
  vertices: 500000,
};
/** Trusted bundled code only, no fetch or dynamic code. An exact missing/corrupt pin never follows latest. */
export function createGeoBackgroundCatalog(entries: readonly GeoBackgroundCatalogEntry[]) {
  const owned = entries.map((entry) => {
    // Read only plain own pin values so even a rejected descriptor can be diagnosed
    // without invoking metadata accessors. The complete accepted entry is then owned.
    const own = (key: string): unknown =>
      entry && typeof entry === 'object'
        ? Object.getOwnPropertyDescriptor(entry, key)?.value
        : undefined;
    const pin = { id: own('id'), version: own('version'), hash: own('hash') };
    try {
      const value: unknown = JSON.parse(checkedJson(entry, budget));
      const text = (v: unknown, max: number): v is string =>
        typeof v === 'string' && v.trim().length > 0 && v.length <= max;
      const url = (v: unknown) => {
        if (!text(v, 512)) return false;
        try {
          const parsed = new URL(v);
          return (
            ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
          );
        } catch {
          return false;
        }
      };
      if (
        !record(value) ||
        !id(value.id) ||
        !id(value.version) ||
        !hash(value.hash) ||
        !text(value.label, 128) ||
        !text(value.attribution, 180) ||
        !url(value.sourceUrl) ||
        !url(value.licenseUrl) ||
        !Object.hasOwn(value, 'data')
      )
        throw Error('Invalid boundary catalog descriptor');
      return { ...pin, value: value as unknown as GeoBackgroundCatalogEntry };
    } catch {
      return { ...pin, value: null };
    }
  });
  const cache = new Map<GeoBackgroundCatalogEntry, readonly Geometry[]>();
  return (settings: readonly GeoBackgroundSetting[]): GeoBackgroundResolution => {
    assertGeoBackgroundSettings(settings);
    const layers: GeoBackgroundResolution['layers'][number][] = [],
      diagnostics: { id: string; reason: string }[] = [];
    for (const setting of settings.filter((s) => s.enabled)) {
      const candidate = owned.find(
        (e) => e.id === setting.id && e.version === setting.version && e.hash === setting.hash,
      );
      if (!candidate) {
        diagnostics.push({
          id: setting.id,
          reason: 'Pinned boundary dataset unavailable; displaying without this background',
        });
        continue;
      }
      try {
        const entry = candidate.value;
        if (!entry) throw Error('Invalid boundary catalog descriptor');
        let geometries = cache.get(entry);
        if (!geometries) {
          checkedJson(entry.data, budget);
          if ('sha256:' + bytesToHex(sha256(canonicalJson(entry.data))) !== entry.hash)
            throw Error('Boundary dataset hash mismatch');
          const pack = entry.data as {
            schemaVersion: number;
            id: string;
            version: string;
            scale: number;
            features: number[][][][];
          };
          if (
            pack.schemaVersion !== 1 ||
            pack.id !== entry.id ||
            pack.version !== entry.version ||
            pack.scale !== 1000000 ||
            !Array.isArray(pack.features) ||
            pack.features.length > budget.features
          )
            throw Error('Invalid boundary dataset');
          geometries = pack.features.map(
            (polygons): Geometry => ({
              type: 'MultiPolygon',
              coordinates: polygons.map((rings) =>
                rings.map((deltas) => {
                  if (
                    !Array.isArray(deltas) ||
                    deltas.length % 2 ||
                    deltas.length > budget.vertices * 2
                  )
                    throw Error('Invalid boundary ring');
                  let x = 0,
                    y = 0;
                  const points: Position[] = [];
                  for (let i = 0; i < deltas.length; i += 2) {
                    if (!Number.isSafeInteger(deltas[i]) || !Number.isSafeInteger(deltas[i + 1]))
                      throw Error('Invalid boundary delta');
                    x += deltas[i];
                    y += deltas[i + 1];
                    points.push([x / pack.scale, y / pack.scale]);
                  }
                  return points;
                }),
              ),
            }),
          );
          assertGeo(
            {
              schemaVersion: 1,
              sources: [],
              layers: [
                {
                  id: 'background',
                  name: entry.label,
                  crs: 'OGC:CRS84',
                  axis: 'longitude-latitude',
                  fields: [],
                  features: geometries.map((geometry, i) => ({
                    id: 'boundary-' + i,
                    rowId: 'boundary-' + i,
                    values: {},
                    geometry,
                  })),
                },
              ],
            },
            budget,
          );
          deepFreeze(geometries);
          cache.set(entry, geometries);
        }
        layers.push({
          setting: { ...setting },
          attribution: entry.attribution,
          licenseUrl: entry.licenseUrl,
          sourceUrl: entry.sourceUrl,
          geometries,
        });
      } catch (error) {
        diagnostics.push({
          id: setting.id,
          reason: String(error instanceof Error ? error.message : error),
        });
      }
    }
    return deepFreeze({ layers, diagnostics });
  };
}
export const resolveGeoBackgrounds = createGeoBackgroundCatalog(bundledGeoBackgrounds);
