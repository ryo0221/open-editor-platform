import { clone, deepFreeze } from '@editor-platform/artifact-core';
import {
  checkExportAbort,
  hashExportBytes,
  validFontProfile,
  type ExportFontProfile,
  type ReadonlyTree,
} from '@editor-platform/export-core';

declare const brand: unique symbol;
export interface OfficeFontManifest extends ExportFontProfile {
  faces: (ExportFontProfile['faces'][number] & { file: string })[];
}
export interface OfficeFonts {
  readonly [brand]: true;
  readonly profile: ReadonlyTree<ExportFontProfile>;
}
const bundles = new WeakMap<OfficeFonts, Uint8Array[]>();
export function ownedOfficeFonts(bundle: OfficeFonts): Uint8Array[] {
  const buffers = bundles.get(bundle);
  if (!buffers) throw Error('Prepare fixed Office fonts first');
  return buffers;
}
/** Hash the actual files, never a system fallback; retain owned buffers for raster rendering. */
export async function prepareOfficeFonts(
  profile: ExportFontProfile,
  input: readonly Uint8Array[],
  signal?: AbortSignal,
): Promise<OfficeFonts> {
  const manifest = deepFreeze(clone(profile)),
    buffers = input.map((b) => new Uint8Array(b));
  if (!validFontProfile(manifest, manifest.id) || buffers.length !== manifest.faces.length)
    throw Error('Invalid fixed font manifest');
  for (const [i, b] of buffers.entries()) {
    checkExportAbort(signal);
    if ((await hashExportBytes(b)) !== manifest.faces[i].sha256)
      throw Error('Fixed font hash mismatch');
  }
  checkExportAbort(signal);
  const bundle = Object.freeze({ profile: manifest }) as unknown as OfficeFonts;
  bundles.set(bundle, buffers);
  return bundle;
}
