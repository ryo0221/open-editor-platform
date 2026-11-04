/**
 * Reading a texture set from the files a user downloaded from a free texture site (#662): a zip
 * as the site gives it, or the images themselves. Each image is checked against the limits and
 * given its map from its name. Shared by CAD and the building domain.
 */
import { unzipSync } from 'fflate';
import {
  geometryTextureFileRole,
  geometryTextureImageSize,
  geometryTextureLimits,
  geometryTextureMediaType,
  type GeometryNormalConvention,
  type GeometryTextureRole,
} from '@editor-platform/geometry-core';

/** One file of a texture set as read, with the map it is for and why it cannot be used. */
export interface ViewTextureFile {
  /** The file's name (inside the zip, its path there). */
  name: string;
  bytes: Uint8Array;
  /** `image/png` or `image/jpeg`; undefined for a file that is not an image. */
  mediaType?: string;
  /** The map, read from the name; the user may choose another. */
  role?: GeometryTextureRole;
  /** A normal map's convention, when the name says it. */
  normal?: GeometryNormalConvention;
  /** Why the file is not used by default: not an image, a map the views do not draw… */
  ignored?: string;
  /** Why the file cannot be used at all: too large, too many pixels, not readable. */
  problem?: 'too-large' | 'too-many-pixels' | 'unreadable';
  width?: number;
  height?: number;
}
/** What the user chose to read, as read: the files and the set's name. */
export interface ViewTextureRead {
  name: string;
  files: ViewTextureFile[];
}

/** Reads an image's size; the browser's decoder by default. */
export type ViewImageMeasure = (
  bytes: Uint8Array,
  mediaType: string,
) => Promise<{ width: number; height: number }>;
const browserMeasure: ViewImageMeasure = async (bytes, mediaType) => {
  const image = await createImageBitmap(new Blob([bytes as BlobPart], { type: mediaType }));
  const size = { width: image.width, height: image.height };
  image.close();
  return size;
};

/** Bytes of a zip's entries together (a texture zip is a few images). */
const zipBytes = 64 * 1024 * 1024;

/**
 * Reads the chosen files: each zip is opened (folders and macOS metadata skipped), each image
 * checked against the limits and given its map from its name. When the names give one map
 * twice, the first is kept (an OpenGL normal map before a DirectX one) and the others ignored.
 */
export async function readTextureFiles(
  chosen: readonly { name: string; bytes: Uint8Array }[],
  measure: ViewImageMeasure = browserMeasure,
): Promise<ViewTextureRead> {
  const entries: { name: string; bytes: Uint8Array }[] = [];
  for (const file of chosen) {
    if (!/\.zip$/i.test(file.name)) {
      entries.push(file);
      continue;
    }
    let total = 0;
    const unzipped = unzipSync(file.bytes, {
      filter: (f) => {
        total += f.originalSize;
        if (total > zipBytes) throw new Error('texture-zip-too-large');
        return !f.name.endsWith('/') && !/(^|\/)(__MACOSX\/|\.)/.test(f.name);
      },
    });
    for (const [name, bytes] of Object.entries(unzipped)) entries.push({ name, bytes });
  }
  const files: ViewTextureFile[] = [];
  for (const { name, bytes } of entries) {
    const mediaType = geometryTextureMediaType(name);
    if (!mediaType) {
      files.push({ name, bytes, ignored: 'not-image' });
      continue;
    }
    const read = geometryTextureFileRole(name);
    const file: ViewTextureFile = {
      name,
      bytes,
      mediaType,
      ...(read && 'role' in read
        ? { role: read.role, ...(read.normal ? { normal: read.normal } : {}) }
        : {}),
      ...(read && 'ignored' in read ? { ignored: read.ignored } : {}),
    };
    // The header's size first: a small file can hold an image too large to decode safely.
    const head = geometryTextureImageSize(bytes);
    if (bytes.byteLength > geometryTextureLimits.imageBytes) file.problem = 'too-large';
    else if (!head) file.problem = 'unreadable';
    else if (Math.max(...head) > geometryTextureLimits.imagePixels) {
      Object.assign(file, { width: head[0], height: head[1] });
      file.problem = 'too-many-pixels';
    } else
      try {
        const { width, height } = await measure(bytes, mediaType);
        Object.assign(file, { width, height });
        if (Math.max(width, height) > geometryTextureLimits.imagePixels)
          file.problem = 'too-many-pixels';
      } catch {
        file.problem = 'unreadable';
      }
    files.push(file);
  }
  // One file per map: an OpenGL normal map first, then the order of the names.
  const order = (f: ViewTextureFile) => (f.normal === 'dx' ? 1 : 0);
  const sorted = [...files].sort((a, b) => order(a) - order(b) || (a.name < b.name ? -1 : 1));
  const taken = new Set<GeometryTextureRole>();
  for (const f of sorted)
    if (f.role && !f.problem) {
      if (taken.has(f.role)) {
        f.ignored = 'duplicate';
        delete f.role;
        delete f.normal;
      } else taken.add(f.role);
    }
  const first = chosen[0]?.name ?? '';
  // ambientCG's `Bricks076C_1K-JPG.zip`, Poly Haven's `red_brick_1k.zip`.
  const name = (first.split(/[\\/]/).pop() ?? '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_\-. ](\d+k)([_\-. ]?(jpg|jpeg|png))?$/i, '')
    .slice(0, 256);
  return { name: chosen.length === 1 && /\.zip$/i.test(first) ? name : name || 'Texture', files };
}
