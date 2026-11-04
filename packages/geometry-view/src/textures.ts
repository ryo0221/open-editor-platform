/**
 * Image textures on the CAD and bim views' solids (issue #662, texture stage 2). A mesh carries
 * real-size texture coordinates in mm (`uvs`); a texture set names its decoded images by map and
 * the size one image covers on a face, so the same image keeps its real scale on every solid.
 * Display only.
 */
import {
  type MeshStandardMaterial,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
} from 'three';
import {
  geometryTextureImageSize,
  geometryTextureLimits,
  type GeometryNormalConvention,
  type GeometryTextureRole,
  type GeometryTextureSet,
} from '@editor-platform/geometry-core';

/** A texture set ready to draw. */
export interface ViewTextureSet {
  /** Decoded images by map; a map still decoding (or unreadable) is left out. */
  maps: Partial<Record<GeometryTextureRole, Texture>>;
  /** The size one image covers on a face (mm): width, height. */
  sizeMm: [number, number];
  /** Turn of the image on the face, counter-clockwise (radians). */
  rotationRad?: number;
  /** The normal map's convention: a DirectX map is drawn with its green flipped. */
  normal?: GeometryNormalConvention;
}

const slots = {
  color: 'map',
  normal: 'normalMap',
  roughness: 'roughnessMap',
  metalness: 'metalnessMap',
  occlusion: 'aoMap',
} as const satisfies Record<GeometryTextureRole, keyof MeshStandardMaterial>;

/**
 * Puts a texture set's maps on a solid's material, or takes them off (`undefined`). Each map is
 * a copy of the decoded image's texture (the GPU keeps one upload per image) repeated every
 * `sizeMm`. As in glTF, the material's colour, roughness and metalness multiply the maps.
 */
export function setViewTextures(material: MeshStandardMaterial, set: ViewTextureSet | undefined) {
  for (const role of Object.keys(slots) as GeometryTextureRole[]) {
    const slot = slots[role];
    const old = material[slot] as Texture | null;
    if (old?.userData.viewTexture) old.dispose();
    const image = set?.maps[role];
    if (!image || !set) {
      (material[slot] as Texture | null) = null;
      continue;
    }
    const map = image.clone();
    map.userData.viewTexture = true;
    map.wrapS = map.wrapT = RepeatWrapping;
    map.repeat.set(1 / set.sizeMm[0], 1 / set.sizeMm[1]);
    map.rotation = set.rotationRad ?? 0;
    map.colorSpace = role === 'color' ? SRGBColorSpace : NoColorSpace;
    map.needsUpdate = true;
    (material[slot] as Texture | null) = map;
  }
  if (set?.maps.normal) material.normalScale.set(1, set.normal === 'dx' ? -1 : 1);
  material.needsUpdate = true;
  return material;
}

/** Disposes the map copies `setViewTextures` put on a material (not the decoded images). */
export function disposeViewTextures(material: unknown) {
  const m = material as Partial<Record<(typeof slots)[GeometryTextureRole], Texture | null>>;
  for (const slot of Object.values(slots)) {
    const map = m[slot];
    if (map?.userData.viewTexture) map.dispose();
  }
}

/** GPU bytes of a material's image maps (RGBA with mipmaps), each image counted once. */
export function viewTextureBytes(material: unknown, seen: Set<unknown>): number {
  const m = material as Partial<Record<(typeof slots)[GeometryTextureRole], Texture | null>>;
  let bytes = 0;
  for (const slot of Object.values(slots)) {
    const map = m[slot];
    const image = map?.source?.data as { width?: number; height?: number } | undefined;
    if (!map || !image || seen.has(map.source)) continue;
    seen.add(map.source);
    bytes += Math.ceil(((image.width ?? 0) * (image.height ?? 0) * 4 * 4) / 3);
  }
  return bytes;
}

/** Decodes an image file into something a texture can upload; the browser's by default. */
export type ViewImageDecoder = (bytes: Uint8Array, mediaType: string) => Promise<unknown>;
const browserDecoder: ViewImageDecoder = async (bytes, mediaType) =>
  createImageBitmap(new Blob([bytes as BlobPart], { type: mediaType }), {
    // WebGL does not flip an ImageBitmap on upload: flip it here, as images are drawn y up.
    imageOrientation: 'flipY',
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });

interface CacheEntry {
  texture?: Texture;
  failed?: boolean;
  pending?: Promise<void>;
  /** Asked for since the last sweep. */
  used: boolean;
  /** Swept while decoding: the image is closed when it arrives. */
  dropped?: boolean;
}
const closeImage = (image: unknown) => (image as { close?(): void } | undefined)?.close?.();

/**
 * The decoded images of one view, by content hash. `get` gives the texture once decoded and
 * starts decoding the first time (undefined until then, or when the image cannot be read);
 * `onLoad` is called after each image is decoded, so the view draws it. An image larger than
 * the import limit (2048 px) is refused from its header before it is decoded, as one opened from
 * a file did not pass the import's check. The view calls `sweep` after each full build, which
 * frees the images that build no longer asked for (a replaced or removed texture).
 */
export class ViewTextureCache {
  private readonly entries = new Map<string, CacheEntry>();
  private disposed = false;

  constructor(
    private readonly onLoad: () => void,
    private readonly decode: ViewImageDecoder = browserDecoder,
  ) {}

  get(
    sha256: string,
    read: () => { bytes: Uint8Array; mediaType: string } | undefined,
  ): Texture | undefined {
    const entry = this.entries.get(sha256);
    if (entry) {
      entry.used = true;
      return entry.texture;
    }
    const next: CacheEntry = { used: true };
    this.entries.set(sha256, next);
    const file = read();
    const size = file && geometryTextureImageSize(file.bytes);
    const limit = geometryTextureLimits.imagePixels;
    if (!file || !size || Math.max(...size) > limit || Math.min(...size) < 1) {
      next.failed = true;
      return undefined;
    }
    next.pending = this.decode(file.bytes, file.mediaType).then(
      (image) => {
        const { width = 0, height = 0 } = image as { width?: number; height?: number };
        if (this.disposed || next.dropped || Math.max(width, height) > limit) {
          closeImage(image);
          if (!this.disposed && !next.dropped) next.failed = true;
          return;
        }
        const texture = new Texture(image as HTMLImageElement);
        // Flipped by the decoder.
        texture.flipY = false;
        texture.anisotropy = 4;
        texture.needsUpdate = true;
        next.texture = texture;
        this.onLoad();
      },
      () => {
        next.failed = true;
      },
    );
    return undefined;
  }

  /**
   * Frees every image not asked for since the last sweep (its decoded pixels and GPU copy):
   * called by the view after it has asked for every image it draws.
   */
  sweep() {
    for (const [sha, e] of this.entries) {
      if (e.used) {
        e.used = false;
        continue;
      }
      e.dropped = true;
      e.texture?.dispose();
      closeImage(e.texture?.image);
      this.entries.delete(sha);
    }
  }

  /** How many images are kept (decoding, decoded or failed). */
  get size() {
    return this.entries.size;
  }

  /** Whether an image could not be read (missing bytes or not an image). */
  failed(sha256: string): boolean {
    return !!this.entries.get(sha256)?.failed;
  }

  /** Settles when every image asked for so far is decoded or failed (tests, captures). */
  async settled(): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => e.pending));
  }

  dispose() {
    this.disposed = true;
    for (const e of this.entries.values()) {
      e.texture?.dispose();
      closeImage(e.texture?.image);
    }
    this.entries.clear();
  }
}

/**
 * A stored texture set as the view draws it: each map's decoded image from the cache, which
 * reads the bytes by the asset's hash. Undefined without a set; a map still decoding (or
 * missing) is left out until it is ready.
 */
export function viewTexturesOf(
  set: GeometryTextureSet | undefined,
  assets: readonly { id: string; sha256: string; mediaType: string }[],
  cache: ViewTextureCache | undefined,
  read: (sha256: string) => Uint8Array | undefined,
): ViewTextureSet | undefined {
  if (!set || !cache) return undefined;
  const maps: ViewTextureSet['maps'] = {};
  for (const [role, id] of Object.entries(set.maps) as [GeometryTextureRole, string][]) {
    const ref = assets.find((a) => a.id === id);
    if (!ref) continue;
    const texture = cache.get(ref.sha256, () => {
      const bytes = read(ref.sha256);
      return bytes ? { bytes, mediaType: ref.mediaType } : undefined;
    });
    if (texture) maps[role] = texture;
  }
  return {
    maps,
    sizeMm: set.sizeMm,
    rotationRad: (set.rotationDeg * Math.PI) / 180,
    normal: set.normal,
  };
}
