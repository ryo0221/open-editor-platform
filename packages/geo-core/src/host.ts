/** Host port for reading external vector features into Geo (docs/external-sources/editor-host-contract.md).
 * Types and pure helpers only. The Host resolves principals, permissions, providers and CRS;
 * handles are not proof of permission, and the Editor never fetches a URL from a read. */
import type { Geometry, Scalar } from './model';

/** `[west, south, east, north]` in CRS84. west > east crosses the antimeridian. */
export type GeoBbox = [number, number, number, number];

export interface GeoFeatureSourceInfo {
  /** Opaque Host handle for one collection the current principal may read. */
  handle: string;
  label: string;
  provider: string;
  /** The connection or public deployment the Host reads through, as plain text. */
  account: string;
  /** Source and terms of use as plain text, kept with anything imported from this source. */
  attribution: string;
}
/** One feature as the Host read it. CRS84 longitude/latitude only. */
export interface GeoExternalFeature {
  /** Provider feature id as a string; null when the provider gave none. */
  id: string | null;
  geometry: Geometry | null;
  /** Scalar properties only. Strings are untrusted plain text, never HTML or links to open. */
  properties: Record<string, Scalar>;
}
export type GeoFeatureRejection =
  | 'invalid-feature'
  | 'invalid-geometry'
  | 'unsupported-geometry'
  | 'unsupported-crs';
export interface GeoFeatureRead {
  sourceHandle: string;
  /** Connection generation; a read from an older generation is never shown. */
  generation: string;
  bbox: GeoBbox;
  /** false when a page failed or a Host limit stopped the read. The rest is unknown, not empty. */
  complete: boolean;
  /** Features the provider reported for the query, when it reported one. */
  matched: number | null;
  /** Features the Host left out, with their reason. Never dropped silently. */
  rejected: { index: number; id: string | null; reason: GeoFeatureRejection }[];
  /** Non-scalar property names the Host left out of `properties`. */
  omittedProperties: string[];
  fetchedAt: number;
  features: GeoExternalFeature[];
}
export interface GeoSourceNotice {
  kind: 'changed' | 'revoked';
  sourceHandle?: string;
}
export interface GeoFeatureReadPort {
  listSources(signal: AbortSignal): Promise<GeoFeatureSourceInfo[]>;
  readFeatures(
    request: { sourceHandle: string; bbox: GeoBbox; limit: number },
    signal: AbortSignal,
  ): Promise<GeoFeatureRead>;
  /** Change or revocation signals only; never content or commands. */
  watch?(notify: (notice: GeoSourceNotice) => void): () => void;
}

/** The upper bound the Editor asks for in one read. */
export const geoFeatureReadLimit = 400;

/** Checks a bbox typed by a person: CRS84 ranges, south <= north. */
export function parseGeoBbox(text: string): GeoBbox | undefined {
  const parts = text.split(',').map((part) => part.trim());
  // Number('') is 0: an empty field must not become the equator or the prime meridian.
  if (parts.length !== 4 || parts.some((part) => part === '')) return undefined;
  const values = parts.map(Number);
  if (!values.every(Number.isFinite)) return undefined;
  const [west, south, east, north] = values as GeoBbox;
  const lon = (v: number) => v >= -180 && v <= 180;
  const lat = (v: number) => v >= -90 && v <= 90;
  if (!lon(west) || !lon(east) || !lat(south) || !lat(north) || south > north) return undefined;
  return [west, south, east, north];
}
