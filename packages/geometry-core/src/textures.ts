/**
 * Image textures shared by the CAD and bim views (issue #662, texture stage 2): the maps of a
 * texture set, which map a file is for (read from its name, as the free texture sites name them),
 * the limits on an image, and the real-size texture coordinates of a planar face. Pure data and
 * arithmetic: no Three.js, no image decoding.
 */

/** The maps of a texture set (glTF metal/roughness). */
export type GeometryTextureRole = 'color' | 'normal' | 'roughness' | 'metalness' | 'occlusion';
export const geometryTextureRoles: readonly GeometryTextureRole[] = Object.freeze([
  'color',
  'normal',
  'roughness',
  'metalness',
  'occlusion',
]);
/**
 * How a normal map's green channel points: OpenGL (y up, as glTF and the views) or DirectX
 * (y down). A DirectX map is drawn with its green flipped.
 */
export type GeometryNormalConvention = 'gl' | 'dx';

/** What a file of a downloaded texture set holds, read from its name. */
export type GeometryTextureFileRole =
  | { role: GeometryTextureRole; normal?: GeometryNormalConvention }
  /** A map the views do not draw (height, displacement, opacity…), or a preview. */
  | { ignored: string }
  | undefined;

/** Name suffixes as ambientCG, Poly Haven and other free sites write them, most specific first. */
const suffixes: readonly [RegExp, Exclude<GeometryTextureFileRole, undefined>][] = [
  [/(^|[_\-. ])(normal|nor|nrm|nrml)[_\-. ]?gl$/, { role: 'normal', normal: 'gl' }],
  [/(^|[_\-. ])(normal|nor|nrm|nrml)[_\-. ]?dx$/, { role: 'normal', normal: 'dx' }],
  [/(^|[_\-. ])(normal|nor|nrm|nrml|norm|normalmap)$/, { role: 'normal' }],
  [
    /(^|[_\-. ])(color|colour|basecolor|base[_\-. ]?color|albedo|diffuse|diff|col|dif)$/,
    {
      role: 'color',
    },
  ],
  [/(^|[_\-. ])(roughness|rough|rgh)$/, { role: 'roughness' }],
  [/(^|[_\-. ])(metalness|metallic|metal|met|mtl)$/, { role: 'metalness' }],
  [
    /(^|[_\-. ])(ambientocclusion|ambient[_\-. ]?occlusion|ao|occlusion|occ)$/,
    {
      role: 'occlusion',
    },
  ],
  [/(^|[_\-. ])(displacement|disp|height|bump)$/, { ignored: 'displacement' }],
  [/(^|[_\-. ])(opacity|alpha|mask)$/, { ignored: 'opacity' }],
  [
    /(^|[_\-. ])(specular|spec|gloss|glossiness|emission|emissive|arm|orm)$/,
    {
      ignored: 'other',
    },
  ],
  [/(^|[_\-. ])(preview|thumb|thumbnail|sphere)$/, { ignored: 'preview' }],
];
/** The image types a texture is read from. */
export const geometryTextureMediaTypes: readonly string[] = Object.freeze([
  'image/png',
  'image/jpeg',
]);

/** The media type of an image file by its name, or undefined when it is not one. */
export function geometryTextureMediaType(fileName: string): string | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  return ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : undefined;
}

/**
 * Which map a file of a texture set holds, from its name: the last word before the extension,
 * after a resolution or format tag (`Bricks076C_1K-JPG_NormalGL.jpg`,
 * `red_brick_diff_1k.jpg`). Undefined when the name says nothing; the user then chooses.
 */
export function geometryTextureFileRole(fileName: string): GeometryTextureFileRole {
  const base = (fileName.split(/[\\/]/).pop() ?? '').replace(/\.[a-z0-9]+$/i, '').toLowerCase();
  // Poly Haven ends with the resolution (`_1k`, `_2k`): drop it, and ambientCG's `_1K-JPG`.
  const name = base.replace(/[_\-. ](\d+k)([_\-. ]?(jpg|jpeg|png))?$/, '');
  for (const [pattern, role] of suffixes) if (pattern.test(name)) return role;
  return undefined;
}

/** Limits on one image of a texture set (#662): larger images are refused, not scaled. */
export const geometryTextureLimits = Object.freeze({
  /** Bytes of one image file. */
  imageBytes: 4 * 1024 * 1024,
  /** Pixels on the longer side (a 2K map). */
  imagePixels: 2048,
  /** Real size of the image on a face, in mm. */
  minSizeMm: 1,
  maxSizeMm: 100_000,
});

/**
 * Width and height of a PNG or JPEG from its header, without decoding it; undefined when the
 * header is not one of those (or is cut short). Lets a viewer refuse an image over the limits
 * before it allocates the decoded pixels (a small file can hold a very large image).
 */
export function geometryTextureImageSize(bytes: Uint8Array): [number, number] | undefined {
  const at = (i: number) => bytes[i] ?? 0;
  const u16 = (i: number) => (at(i) << 8) | at(i + 1);
  const u32 = (i: number) =>
    ((at(i) << 24) >>> 0) + (at(i + 1) << 16) + (at(i + 2) << 8) + at(i + 3);
  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length >= 24 && png.every((b, i) => bytes[i] === b)) {
    // The first chunk is IHDR: width and height, big-endian.
    if (String.fromCharCode(at(12), at(13), at(14), at(15)) !== 'IHDR') return undefined;
    return [u32(16), u32(20)];
  }
  if (at(0) !== 0xff || at(1) !== 0xd8) return undefined;
  // JPEG: walk the markers to the first start of frame (SOF0–SOF15 but DHT, JPG, DAC).
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (at(i) !== 0xff) return undefined;
    const marker = at(i + 1);
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = u16(i + 2);
    if (length < 2) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > bytes.length) return undefined;
      return [u16(i + 7), u16(i + 5)];
    }
    if (marker === 0xda || marker === 0xd9) return undefined;
    i += 2 + length;
  }
  return undefined;
}

type Vec3 = readonly [number, number, number];
/**
 * Real-size texture coordinates (mm) of a point on a planar face with outward unit normal `n`,
 * anchored to the model's axes so neighbouring faces line up: on a wall the texture's up is the
 * model's z, on a floor or a roof (normal within about 25° of z) its up is y. Seen from outside, u runs right and v up, so an
 * image is never mirrored.
 */
export function geometryPlanarTextureUv(p: Vec3, n: Vec3): [number, number] {
  // Up is the model's z made perpendicular to the face, or its y on a floor, a roof or a soffit
  // (z would be nearly along the normal); right is up × n. Both are unit vectors on the face, so
  // a sloped roof keeps its real size too.
  const axis = Math.abs(n[2]) >= 0.9 ? 1 : 2;
  const k = n[axis]!;
  const up: Vec3 = [-k * n[0], (axis === 1 ? 1 : 0) - k * n[1], (axis === 2 ? 1 : 0) - k * n[2]];
  const l = Math.hypot(up[0], up[1], up[2]);
  const u: Vec3 = [up[0] / l, up[1] / l, up[2] / l];
  const right: Vec3 = [
    u[1] * n[2] - u[2] * n[1],
    u[2] * n[0] - u[0] * n[2],
    u[0] * n[1] - u[1] * n[0],
  ];
  return [
    p[0] * right[0] + p[1] * right[1] + p[2] * right[2],
    p[0] * u[0] + p[1] * u[1] + p[2] * u[2],
  ];
}

/**
 * A texture set on a look (#662), as CAD and the building domain store it: the asset ID of each
 * map's image (an asset of the document), the size one image covers on a face, its turn, the
 * normal map's convention, and where it came from as the user gave it.
 */
export interface GeometryTextureSet {
  /** Asset IDs by map; at least one. */
  maps: Partial<Record<GeometryTextureRole, string>>;
  /** The size one image covers on a face (mm): width, height. */
  sizeMm: [number, number];
  /** Turn of the image on the face, counter-clockwise (degrees, −360 to 360). */
  rotationDeg: number;
  normal: GeometryNormalConvention;
  /** The set's name (e.g. the downloaded file's), up to 256 code points. */
  name: string;
  /** Where it was downloaded from (`http(s)://`, up to 2048 characters) and its licence (64). */
  source?: string;
  license?: string;
}
const textureSetKeys = ['maps', 'sizeMm', 'rotationDeg', 'normal', 'name', 'source', 'license'];
/**
 * What is wrong with a stored texture set's shape, as `[code, key]` pairs (`key` is the field;
 * empty for the set itself). `isId` checks each map's asset ID; whether the asset exists is the
 * document's check.
 */
export function geometryTextureSetProblems(
  t: unknown,
  isId: (v: unknown) => boolean,
): [string, string][] {
  if (typeof t !== 'object' || t === null || Array.isArray(t)) return [['texture', '']];
  const s = t as Record<string, unknown>;
  const out: [string, string][] = [];
  for (const k of Object.keys(s)) if (!textureSetKeys.includes(k)) out.push(['unknown-field', k]);
  for (const k of ['maps', 'sizeMm', 'rotationDeg', 'normal', 'name'])
    if (!Object.hasOwn(s, k)) out.push(['missing-field', k]);
  const maps = s.maps;
  if (
    typeof maps !== 'object' ||
    maps === null ||
    Array.isArray(maps) ||
    !Object.keys(maps).length ||
    Object.entries(maps).some(
      ([role, id]) => !(geometryTextureRoles as readonly string[]).includes(role) || !isId(id),
    )
  )
    out.push(['texture-maps', 'maps']);
  const { minSizeMm, maxSizeMm } = geometryTextureLimits;
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (
    !Array.isArray(s.sizeMm) ||
    s.sizeMm.length !== 2 ||
    !s.sizeMm.every((v) => finite(v) && v >= minSizeMm && v <= maxSizeMm)
  )
    out.push(['texture-size', 'sizeMm']);
  if (!finite(s.rotationDeg) || Math.abs(s.rotationDeg) > 360)
    out.push(['texture-rotation', 'rotationDeg']);
  if (s.normal !== 'gl' && s.normal !== 'dx') out.push(['texture-normal', 'normal']);
  const text = (v: unknown, max: number) => typeof v === 'string' && [...v].length <= max;
  if (!text(s.name, 256)) out.push(['texture-name', 'name']);
  if (
    Object.hasOwn(s, 'source') &&
    (!text(s.source, 2048) || !/^https?:\/\/\S+$/.test(s.source as string))
  )
    out.push(['texture-source', 'source']);
  if (Object.hasOwn(s, 'license') && !text(s.license, 64)) out.push(['texture-license', 'license']);
  return out;
}
