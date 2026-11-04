import type { DesignElement } from './model';

/** Attribution bound to exact native image bytes. Same field meanings as vector.provenance. */
export interface DesignRasterSource {
  src: string;
  source: string;
  license: string;
  name?: string;
  version?: string;
}
/** A retained original, not a second artifact authority or executable reference. */
export interface DesignRasterAncestor extends DesignRasterSource {
  elementId?: string;
  artifactId?: string;
  versionId?: string;
}
export interface DesignRasterProvenance extends DesignRasterSource {
  /** Ordered retained originals, oldest first. No recursive provenance graph. */
  lineage?: DesignRasterAncestor[];
}
const text = (v: unknown) => typeof v === 'string' && !!v.trim() && v.length <= 4096;
const image = (v: unknown) =>
  typeof v === 'string' && /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,/.test(v);
function source(value: unknown, extra: string[]): value is DesignRasterSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).every((key) =>
      ['src', 'source', 'license', 'name', 'version', ...extra].includes(key),
    ) &&
    ['src', 'source', 'license'].every((key) => Object.hasOwn(v, key)) &&
    image(v.src) &&
    text(v.source) &&
    text(v.license) &&
    ['name', 'version', ...extra.filter((k) => k !== 'lineage')].every(
      (key) => v[key] === undefined || text(v[key]),
    )
  );
}
export function validDesignRasterProvenance(value: unknown): value is DesignRasterProvenance {
  if (!source(value, ['lineage'])) return false;
  const v = value as DesignRasterProvenance;
  return (
    v.lineage === undefined ||
    (Array.isArray(v.lineage) &&
      v.lineage.length > 0 &&
      v.lineage.length <= 32 &&
      Array.from(v.lineage).every((ancestor) =>
        source(ancestor, ['elementId', 'artifactId', 'versionId']),
      ))
  );
}
/** Hosts may use this for future derived crops/splits; it does not split or discard originals. */
export function deriveDesignRasterProvenance(
  original: DesignRasterProvenance,
  src: string,
  origin: Pick<DesignRasterAncestor, 'elementId' | 'artifactId' | 'versionId'> = {},
): DesignRasterProvenance {
  if (
    !validDesignRasterProvenance(original) ||
    !image(src) ||
    Object.keys(origin).some((key) => !['elementId', 'artifactId', 'versionId'].includes(key))
  )
    throw new Error('Invalid raster provenance or original reference');
  const { lineage = [], ...parent } = original;
  const result = { ...parent, src, lineage: [...lineage, { ...parent, ...origin }] };
  if (!validDesignRasterProvenance(result))
    throw new Error('Invalid raster lineage or lineage limit');
  return structuredClone(result);
}
/** Remove inherited attribution when a patch selects different source bytes. */
export function rasterSourcePatch<T extends Partial<DesignElement>>(
  element: T,
  patch: Partial<DesignElement>,
): T {
  const next = { ...element, ...patch };
  // Partial overrides may repeat type: 'image' while inheriting src. Only an
  // owned source establishes a mismatch here; the content boundary resolves
  // inherited sources before validating/cleaning the complete image.
  if (next.provenance && Object.hasOwn(next, 'src') && next.provenance.src !== next.src)
    delete next.provenance;
  // Absence is portable; an undefined marker would mask inheritance until JSON.
  if (Object.hasOwn(next, 'provenance') && next.provenance === undefined) delete next.provenance;
  return next;
}
