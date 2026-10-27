/** Deterministic mock Host for Geo external features: tests and the reference Host only.
 * Synthetic data: no network, no credentials, no real places. It proves Editor reactions,
 * not provider behavior; real connections belong in a real Host. */
import type { Geometry, Position } from './model';
import type {
  GeoBbox,
  GeoExternalFeature,
  GeoFeatureRead,
  GeoFeatureReadPort,
  GeoFeatureSourceInfo,
  GeoSourceNotice,
} from './host';

export interface MockGeoFeatureHost {
  read: GeoFeatureReadPort;
  /** Test controls. A real Host has none of these. */
  controls: {
    /** false: the read stops after the first half of the matching features. */
    setComplete(complete: boolean): void;
    failReads(fail: boolean): void;
    /** Hold the next reads until released, to deliver them late. */
    holdReads(hold: boolean): void;
    releaseReads(): void;
    /** The provider changed: later reads return the edited features. */
    changeSource(): void;
    switchAccount(): void;
    readonly calls: { list: number; read: number };
  };
}

const square = (lon: number, lat: number, size: number): Position[][] => [
  [
    [lon, lat],
    [lon + size, lat],
    [lon + size, lat + size],
    [lon, lat + size],
    [lon, lat],
  ],
];
const baseFeatures: GeoExternalFeature[] = [
  {
    id: 'pond-1',
    geometry: { type: 'Polygon', coordinates: square(139.7, 35.6, 0.02) },
    properties: { name: 'North pond (synthetic)', area_ha: 12.5, protected: true },
  },
  {
    id: 'pond-2',
    geometry: { type: 'Polygon', coordinates: square(139.76, 35.66, 0.01) },
    properties: { name: 'East pond (synthetic)', area_ha: 3.2, protected: false },
  },
  {
    id: 'station-1',
    geometry: { type: 'Point', coordinates: [139.72, 35.64] },
    properties: {
      name: 'Gauge <b>A</b> (synthetic)',
      area_ha: null,
      protected: false,
    },
  },
  {
    id: 'station-2',
    geometry: { type: 'Point', coordinates: [139.79, 35.69] },
    properties: { name: 'Gauge B (synthetic)', area_ha: null, protected: null },
  },
  { id: 'unknown-location', geometry: null, properties: { name: 'No location (synthetic)' } },
];
/** A provider feature the Host could not express in Geo's geometry types. */
const unsupportedId = 'collection-1';

function anchor(geometry: Geometry | null): Position | undefined {
  if (!geometry) return undefined;
  let value: unknown = geometry.coordinates;
  while (Array.isArray(value) && Array.isArray(value[0])) value = value[0];
  return value as Position;
}
function inside(position: Position, [west, south, east, north]: GeoBbox) {
  const [lon, lat] = position;
  const inLon = west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
  return inLon && lat >= south && lat <= north;
}

export function createMockGeoFeatureHost(): MockGeoFeatureHost {
  let complete = true,
    fail = false,
    hold = false,
    account = 1,
    edition = 1;
  const calls = { list: 0, read: 0 };
  const held: (() => void)[] = [];
  const watchers = new Set<(notice: GeoSourceNotice) => void>();
  const notify = (notice: GeoSourceNotice) => watchers.forEach((w) => w(notice));
  const sources = (): GeoFeatureSourceInfo[] => [
    {
      handle: `mock-ponds-${account}`,
      label: 'Ponds and gauges (synthetic)',
      provider: 'Mock OGC API Features',
      account: `public deployment ${account} (synthetic)`,
      attribution: 'Synthetic sample data for the reference Host. Not a real place.',
    },
  ];
  const features = () =>
    edition === 1
      ? baseFeatures
      : baseFeatures.map((f) =>
          f.id === 'pond-2'
            ? { ...f, properties: { ...f.properties, area_ha: 4.1 } }
            : structuredClone(f),
        );
  const read: GeoFeatureReadPort = {
    async listSources() {
      calls.list++;
      return sources();
    },
    readFeatures({ sourceHandle, bbox, limit }, signal) {
      calls.read++;
      // Checked when asked: a held read answers late with the generation it started in.
      const generation = String(account),
        connected = sourceHandle === sources()[0].handle;
      const respond = (): GeoFeatureRead => {
        const matching = features().filter((f) => {
          const at = anchor(f.geometry);
          return at === undefined || inside(at, bbox);
        });
        const kept = complete ? matching : matching.slice(0, Math.ceil(matching.length / 2));
        const limited = kept.slice(0, limit);
        return {
          sourceHandle,
          generation,
          bbox,
          complete: complete && limited.length === matching.length,
          matched: matching.length + 1,
          rejected: [{ index: matching.length, id: unsupportedId, reason: 'unsupported-geometry' }],
          omittedProperties: ['tags'],
          fetchedAt: Date.UTC(2026, 9, 26, 0, edition),
          features: structuredClone(limited),
        };
      };
      return new Promise((resolve, reject) => {
        const finish = () =>
          signal.aborted
            ? reject(new DOMException('Aborted', 'AbortError'))
            : !connected
              ? reject(new Error('This source is no longer connected.'))
              : fail
                ? reject(new Error('The features could not be read.'))
                : resolve(respond());
        if (hold) held.push(finish);
        else queueMicrotask(finish);
      });
    },
    watch(listener) {
      watchers.add(listener);
      return () => watchers.delete(listener);
    },
  };
  return {
    read,
    controls: {
      setComplete: (value) => void (complete = value),
      failReads: (value) => void (fail = value),
      holdReads: (value) => void (hold = value),
      releaseReads: () => held.splice(0).forEach((finish) => finish()),
      changeSource() {
        edition++;
        notify({ kind: 'changed', sourceHandle: sources()[0].handle });
      },
      switchAccount() {
        account++;
        notify({ kind: 'revoked' });
      },
      calls,
    },
  };
}
