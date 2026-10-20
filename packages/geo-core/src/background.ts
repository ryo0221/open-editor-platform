import { checkedJson } from './json-boundary';
import { hash, id, record } from './validation';
import type { Geometry } from './model';

/** Only references/settings belong to a saved view; dataset geometry never does. */
export interface GeoBackgroundSetting {
  id: string;
  version: string;
  hash: string;
  enabled: boolean;
  color: string;
}
export interface GeoBackgroundLayer {
  setting: GeoBackgroundSetting;
  attribution: string;
  licenseUrl: string;
  sourceUrl: string;
  geometries: readonly Geometry[];
}
export interface GeoBackgroundResolution {
  layers: readonly GeoBackgroundLayer[];
  diagnostics: readonly { id: string; reason: string }[];
}
export function assertGeoBackgroundSettings(
  value: unknown,
): asserts value is GeoBackgroundSetting[] {
  checkedJson(value, { actions: 1, bytes: 4096, depth: 4, layers: 1, features: 3, vertices: 1 });
  if (
    !Array.isArray(value) ||
    value.length > 3 ||
    new Set(value.map((v) => v?.id)).size !== value.length ||
    value.some(
      (v) =>
        !record(v) ||
        Object.keys(v).length !== 5 ||
        !['id', 'version', 'hash', 'enabled', 'color'].every((key) => Object.hasOwn(v, key)) ||
        !id(v.id) ||
        !id(v.version) ||
        !hash(v.hash) ||
        typeof v.enabled !== 'boolean' ||
        typeof v.color !== 'string' ||
        !/^#[a-fA-F0-9]{6}$/.test(v.color),
    )
  )
    throw Error('Invalid geographic background settings');
}
