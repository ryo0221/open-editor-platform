import type {
  CadAppearance,
  CadBodyKind,
  CadStepPlan,
  CadToleranceSet,
} from '@editor-platform/cad-core';
import { geometryDefaultFinish, geometryLightLimits } from '@editor-platform/geometry-core';
import type { CadMesh } from './protocol';
import type { CadStepPmiWritten } from './step-pmi-write';

/** An image to embed in a file, as the document stores it. */
export interface CadExportImage {
  bytes: Uint8Array;
  mediaType: 'image/png' | 'image/jpeg';
}
/**
 * #663: a body's texture set as glTF takes it. `metallicRoughness` is one image holding
 * roughness in green and metalness in blue (glTF's packing, as the view reads its maps); a
 * normal map is OpenGL (y up). The images are written once each, by identity.
 */
export interface CadExportTextures {
  color?: CadExportImage;
  normal?: CadExportImage;
  metallicRoughness?: CadExportImage;
  occlusion?: CadExportImage;
  /** The size one image covers on a face (mm): width, height. */
  sizeMm: [number, number];
  /** Turn of the image on the face, counter-clockwise (degrees). */
  rotationDeg: number;
}

/** One active body to export: its evaluated mesh and how it is shown. */
export interface CadExportBody {
  name: string;
  /** A sheet's triangles need not enclose a volume (docs/cad/r2a-freeform.md). */
  kind: CadBodyKind;
  appearance: CadAppearance;
  mesh: CadMesh;
  /** #663: GLB only; drawn when the mesh has texture coordinates. */
  textures?: CadExportTextures;
}
/** Preflight report: what the file is made from and what it does not keep (docs/cad/integration.md). */
export interface CadExportReport {
  format: 'stl' | 'glb' | 'step';
  sourceContentHash: string;
  buildHash: string;
  /** Units of the coordinates written to the file. */
  units: 'mm' | 'm';
  bodies: number;
  /** R2b-5: an assembly's products (each shape once) and instances (STEP AP242 only). */
  products?: number;
  instances?: number;
  /** Mesh formats only. */
  triangles?: number;
  /** Absolute linear deflection (mm) of the triangulation; mesh formats only. */
  deflectionMm?: number;
  /** Applied once at the file boundary. */
  transforms: string[];
  /** Information the file does not carry. */
  losses: string[];
  /** K2: the document's tolerance set and the largest tolerance in the written shapes (STEP). */
  toleranceSet?: CadToleranceSet;
  maxToleranceMm?: number;
}
export class CadExportError extends Error {
  constructor(
    readonly code:
      | 'mesh-empty'
      | 'mesh-open'
      | 'mesh-degenerate'
      | 'mesh-precision'
      | 'sheet-not-solid'
      | 'step-invalid',
    readonly bodyName?: string,
  ) {
    super(bodyName ? `${code}@${bodyName}` : code);
  }
}

const triangleCount = (bodies: readonly CadExportBody[]) =>
  bodies.reduce((n, b) => n + b.mesh.indices.length / 3, 0);

/**
 * Checks that every solid's triangles enclose a volume: welded by exact vertex position, each edge
 * is used by exactly two triangles in opposite directions, and no triangle has zero area. A sheet
 * may have open edges (used once) but is still consistently oriented and without overlaps: no
 * edge is used by more than two triangles, and a shared edge is traversed in opposite directions.
 */
export function checkClosedMesh(bodies: readonly CadExportBody[]): void {
  if (!bodies.length || !triangleCount(bodies)) throw new CadExportError('mesh-empty');
  for (const { name, kind, mesh } of bodies) {
    const { positions: p, indices } = mesh;
    // Faces carry their own vertices; the shared edge polygon gives them identical coordinates.
    const weld = new Map<string, number>();
    const id = (v: number) => {
      const key = `${p[v * 3]},${p[v * 3 + 1]},${p[v * 3 + 2]}`;
      let n = weld.get(key);
      if (n === undefined) weld.set(key, (n = weld.size));
      return n;
    };
    // Per undirected edge: how many triangles use it, and +1/−1 for each direction.
    const edges = new Map<string, { uses: number; direction: number }>();
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
      const u = [0, 1, 2].map((k) => p[b * 3 + k] - p[a * 3 + k]);
      const v = [0, 1, 2].map((k) => p[c * 3 + k] - p[a * 3 + k]);
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      if (!Math.hypot(...n)) throw new CadExportError('mesh-degenerate', name);
      const w = [id(a), id(b), id(c)];
      for (let k = 0; k < 3; k++) {
        const [from, to] = [w[k], w[(k + 1) % 3]];
        const key = from < to ? `${from}:${to}` : `${to}:${from}`;
        const edge = edges.get(key) ?? { uses: 0, direction: 0 };
        edge.uses++;
        edge.direction += from < to ? 1 : -1;
        edges.set(key, edge);
      }
    }
    // Closed and consistently oriented: two triangles per edge, traversing it in opposite directions.
    for (const edge of edges.values()) {
      if (kind === 'sheet' && edge.uses === 1) continue;
      if (edge.uses !== 2 || edge.direction !== 0) throw new CadExportError('mesh-open', name);
    }
  }
}

/**
 * Drops triangles with two corners at one point: the triangulator leaves them where a face
 * closes to a point (a lamp's or a nose's tip). They have no area and no edge of their own, so
 * the mesh stays closed without them; a sliver with three distinct corners is kept (and refused
 * by `checkClosedMesh`), since dropping it would open the mesh. A body left without triangles
 * is refused (`mesh-empty`).
 */
export function dropCollapsed(bodies: readonly CadExportBody[]): {
  bodies: CadExportBody[];
  dropped: number;
} {
  let dropped = 0;
  const kept = bodies.map((body) => {
    const { positions: p, indices } = body.mesh;
    const same = (a: number, b: number) =>
      p[a * 3] === p[b * 3] && p[a * 3 + 1] === p[b * 3 + 1] && p[a * 3 + 2] === p[b * 3 + 2];
    const keep: number[] = [];
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
      if (same(a, b) || same(b, c) || same(c, a)) dropped++;
      else keep.push(a, b, c);
    }
    // A body with nothing left would be written without triangles (or left out of STL).
    if (!keep.length) throw new CadExportError('mesh-empty', body.name);
    return keep.length === indices.length
      ? body
      : { ...body, mesh: { ...body.mesh, indices: Uint32Array.from(keep) } };
  });
  return { bodies: kept, dropped };
}
const droppedNote = (n: number) =>
  n ? [`Dropped ${n} triangle${n === 1 ? '' : 's'} without area (two corners at one point)`] : [];

/** Binary STL in millimetres: one facet per triangle, facet normal from the winding. */
export function writeStl(
  given: readonly CadExportBody[],
  report: Omit<
    CadExportReport,
    'format' | 'units' | 'bodies' | 'triangles' | 'transforms' | 'losses'
  >,
): { bytes: Uint8Array; report: CadExportReport } {
  // STL describes a closed volume for manufacturing; a sheet has none.
  const sheet = given.find((b) => b.kind === 'sheet');
  if (sheet) throw new CadExportError('sheet-not-solid', sheet.name);
  const { bodies, dropped } = dropCollapsed(given);
  checkClosedMesh(bodies);
  // The same check on the float32 world coordinates the file will hold.
  try {
    checkClosedMesh(
      bodies.map((b) => ({
        ...b,
        mesh: {
          ...b.mesh,
          positions: Float32Array.from(b.mesh.positions, (v, i) => v + b.mesh.origin[i % 3]),
        },
      })),
    );
  } catch (error) {
    if (error instanceof CadExportError) throw new CadExportError('mesh-precision', error.bodyName);
    throw error;
  }
  const triangles = triangleCount(bodies);
  const bytes = new Uint8Array(84 + triangles * 50);
  const view = new DataView(bytes.buffer);
  // The header must not start with "solid", or readers take the file for ASCII STL.
  const header = `EditorPlatform CAD binary STL, units mm, ${report.sourceContentHash}`;
  bytes.set(new TextEncoder().encode(header).subarray(0, 80));
  view.setUint32(80, triangles, true);
  let at = 84;
  for (const { name, mesh } of bodies) {
    const { positions: p, indices, origin } = mesh;
    // World coordinates as the file stores them: float32. A small body far from the origin can
    // lose its shape here even though its origin-relative mesh is closed and non-degenerate.
    const vertex = (i: number) => [0, 1, 2].map((k) => Math.fround(p[i * 3 + k] + origin[k]));
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]].map(vertex);
      const u = [0, 1, 2].map((k) => b[k] - a[k]);
      const v = [0, 1, 2].map((k) => c[k] - a[k]);
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const l = Math.hypot(...n);
      if (!l) throw new CadExportError('mesh-precision', name);
      for (const x of [...n.map((x) => x / l), ...a, ...b, ...c]) {
        view.setFloat32(at, x, true);
        at += 4;
      }
      at += 2; // attribute byte count 0
    }
  }
  return {
    bytes,
    report: {
      ...report,
      format: 'stl',
      units: 'mm',
      bodies: bodies.length,
      triangles,
      transforms: droppedNote(dropped),
      losses: [
        'STL has no unit field: the reader must be told the coordinates are millimetres.',
        'Curved faces are approximated by triangles; exact surfaces, feature history, parameters, body names and colours are not kept.',
      ],
    },
  };
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rgb = (hex: string) =>
  [1, 3, 5].map((i) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255));

/**
 * Texture coordinates as glTF reads them from the mesh's real-size ones (mm): divided by the size
 * one image covers and turned as the view does (three.js `Texture.repeat` and `rotation` about the
 * origin), then with v flipped, as glTF's images start at their top row and the view's at the
 * bottom. The image repeats, so the flip needs no offset.
 */
export function glbTextureCoordinates(uvs: Float32Array, set: CadExportTextures): Float32Array {
  const r = (set.rotationDeg * Math.PI) / 180;
  const [c, s] = [Math.cos(r), Math.sin(r)];
  const [w, h] = set.sizeMm;
  const out = new Float32Array(uvs.length);
  for (let i = 0; i < uvs.length; i += 2) {
    const [u, v] = [uvs[i], uvs[i + 1]];
    out[i] = (c * u + s * v) / w;
    out[i + 1] = -(-s * u + c * v) / h;
  }
  return out;
}

/**
 * glTF 2.0 binary for display: one node per body with its look (colour, opacity, roughness and
 * metalness) and, #663, its texture maps with their images embedded. Converted once at this
 * boundary from millimetres and Z-up to glTF's metres and Y-up: (x, y, z) → (x, z, −y) / 1000.
 */
export function writeGlb(
  given: readonly CadExportBody[],
  report: Omit<
    CadExportReport,
    'format' | 'units' | 'bodies' | 'triangles' | 'transforms' | 'losses'
  >,
  extraLosses: readonly string[] = [],
): { bytes: Uint8Array; report: CadExportReport } {
  const { bodies, dropped } = dropCollapsed(given);
  checkClosedMesh(bodies);
  const toGltf = (x: number, y: number, z: number, scale: number) => [
    x * scale,
    z * scale,
    -y * scale,
  ];
  const chunks: Uint8Array[] = [];
  let length = 0;
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  const add = (data: ArrayBufferView, target?: number) => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    bufferViews.push({
      buffer: 0,
      byteOffset: length,
      byteLength: bytes.byteLength,
      ...(target ? { target } : {}),
    });
    chunks.push(bytes);
    length += bytes.byteLength;
    // An image may end anywhere: the next view starts on a multiple of 4 bytes.
    const gap = (4 - (length % 4)) % 4;
    if (gap) {
      chunks.push(new Uint8Array(gap));
      length += gap;
    }
    return bufferViews.length - 1;
  };
  const accessor = (a: object) => accessors.push(a) - 1;
  const images: object[] = [];
  const textures: object[] = [];
  const imageIndex = new Map<Uint8Array, number>();
  const texture = (image: CadExportImage) => {
    let index = imageIndex.get(image.bytes);
    if (index === undefined) {
      index = images.push({ bufferView: add(image.bytes), mimeType: image.mediaType }) - 1;
      textures.push({ sampler: 0, source: index });
      imageIndex.set(image.bytes, index);
    }
    return { index };
  };
  const losses: string[] = [];
  const nodes: object[] = [];
  const meshes: object[] = [];
  const materials: object[] = [];
  for (const [i, { name, kind, appearance, mesh, textures: set }] of bodies.entries()) {
    const count = mesh.positions.length / 3;
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < count; v++) {
      const [x, y, z] = [0, 1, 2].map((k) => mesh.positions[v * 3 + k]);
      const q = toGltf(x, y, z, 1 / 1000);
      positions.set(q, v * 3);
      // Min/max of the stored float32 values, as glTF validators compare them exactly.
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], positions[v * 3 + k]);
        max[k] = Math.max(max[k], positions[v * 3 + k]);
      }
      const [nx, ny, nz] = [0, 1, 2].map((k) => mesh.normals[v * 3 + k]);
      normals.set(toGltf(nx, ny, nz, 1), v * 3);
    }
    const attributes: Record<string, number> = {
      POSITION: accessor({
        bufferView: add(positions, 34962),
        componentType: 5126,
        count,
        type: 'VEC3',
        min,
        max,
      }),
      NORMAL: accessor({
        bufferView: add(normals, 34962),
        componentType: 5126,
        count,
        type: 'VEC3',
      }),
    };
    const maps =
      set && (['color', 'normal', 'metallicRoughness', 'occlusion'] as const).filter((r) => set[r]);
    const textured = !!set && !!maps?.length && mesh.uvs?.length === count * 2;
    if (set && maps?.length && !textured)
      losses.push(
        `${name}: the texture maps are not written, as its mesh has no texture coordinates.`,
      );
    if (textured)
      attributes.TEXCOORD_0 = accessor({
        bufferView: add(glbTextureCoordinates(mesh.uvs!, set), 34962),
        componentType: 5126,
        count,
        type: 'VEC2',
      });
    const indices = accessor({
      bufferView: add(new Uint32Array(mesh.indices), 34963),
      componentType: 5125,
      count: mesh.indices.length,
      type: 'SCALAR',
    });
    const opaque = appearance.opacity >= 1;
    const lit =
      appearance.emission && appearance.emission.strength > 0 ? appearance.emission : undefined;
    const extensions: Record<string, object> = {};
    if (lit && lit.strength !== 1)
      extensions.KHR_materials_emissive_strength = { emissiveStrength: lit.strength };
    if (appearance.transmission) {
      extensions.KHR_materials_transmission = { transmissionFactor: appearance.transmission };
      extensions.KHR_materials_ior = { ior: appearance.ior ?? geometryLightLimits.defaultIor };
    }
    materials.push({
      name,
      pbrMetallicRoughness: {
        baseColorFactor: [...rgb(appearance.color), appearance.opacity],
        metallicFactor: appearance.metalness ?? geometryDefaultFinish.metalness,
        roughnessFactor: appearance.roughness ?? geometryDefaultFinish.roughness,
        ...(textured && set.color ? { baseColorTexture: texture(set.color) } : {}),
        ...(textured && set.metallicRoughness
          ? { metallicRoughnessTexture: texture(set.metallicRoughness) }
          : {}),
      },
      ...(textured && set.normal ? { normalTexture: texture(set.normal) } : {}),
      ...(textured && set.occlusion ? { occlusionTexture: texture(set.occlusion) } : {}),
      ...(opaque ? {} : { alphaMode: 'BLEND' }),
      // CR6a: a lamp's light (strengths other than 1 in KHR_materials_emissive_strength) and a
      // lens's transmission (KHR_materials_transmission, KHR_materials_ior).
      ...(lit ? { emissiveFactor: rgb(lit.color) } : {}),
      ...(Object.keys(extensions).length ? { extensions } : {}),
      // A sheet has no inside: both sides are visible.
      ...(kind === 'sheet' ? { doubleSided: true } : {}),
    });
    meshes.push({ name, primitives: [{ attributes, indices, material: i }] });
    // Positions stay relative to the body's box centre (float32 precision); the node places them.
    nodes.push({ name, mesh: i, translation: toGltf(...mesh.origin, 1 / 1000) });
  }
  const extensionsUsed = [
    ...new Set(
      materials.flatMap((m) => Object.keys((m as { extensions?: object }).extensions ?? {})),
    ),
  ].sort();
  const json = {
    asset: { version: '2.0', generator: 'EditorPlatform CAD' },
    ...(extensionsUsed.length ? { extensionsUsed } : {}),
    extras: { sourceContentHash: report.sourceContentHash, buildHash: report.buildHash },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials,
    ...(images.length
      ? {
          // Repeating, with mipmaps, as the view draws them.
          samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
          images,
          textures,
        }
      : {}),
    accessors,
    bufferViews,
    buffers: [{ byteLength: length }],
  };
  const pad = (n: number) => (4 - (n % 4)) % 4;
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = jsonBytes.byteLength + pad(jsonBytes.byteLength);
  const binLength = length + pad(length);
  const bytes = new Uint8Array(12 + 8 + jsonLength + 8 + binLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  bytes.set(jsonBytes, 20);
  bytes.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonLength);
  const bin = 20 + jsonLength;
  view.setUint32(bin, binLength, true);
  view.setUint32(bin + 4, 0x004e4942, true); // "BIN\0"
  let at = bin + 8;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return {
    bytes,
    report: {
      ...report,
      format: 'glb',
      units: 'm',
      bodies: bodies.length,
      triangles: triangleCount(bodies),
      transforms: [
        'mm → m (× 0.001)',
        'Z-up → Y-up: (x, y, z) → (x, z, −y)',
        ...droppedNote(dropped),
      ],
      losses: [
        'A display mesh: exact surfaces, feature history, parameters and named views are not kept.',
        ...extraLosses,
        ...losses,
      ],
    },
  };
}

/**
 * Report for a STEP file the kernel wrote from the exact shapes (AP214, millimetres). Refuses
 * bytes that are not an ISO 10303-21 exchange file.
 */
/** K2: the note on the tolerances a STEP file's header carries (`FILE_DESCRIPTION`). */
const toleranceNote = /'CAD tolerance set (standard|large); largest tolerance ([0-9.eE+-]+) mm'/;
/**
 * Writes the document's tolerance set and the largest tolerance of the written shapes into the
 * STEP header, as a second description beside OCCT's own (K2, docs/cad/complex-models.md).
 */
export function withToleranceNote(
  bytes: Uint8Array,
  set: CadToleranceSet,
  maxToleranceMm: number,
): Uint8Array {
  const text = new TextDecoder('latin1').decode(bytes);
  const at = text.indexOf('FILE_DESCRIPTION((');
  if (at < 0 || at > text.indexOf('ENDSEC;')) return bytes;
  const cut = at + 'FILE_DESCRIPTION(('.length;
  const note = `'CAD tolerance set ${set}; largest tolerance ${maxToleranceMm.toPrecision(3)} mm',`;
  const out = new Uint8Array(bytes.length + note.length);
  out.set(bytes.subarray(0, cut));
  for (let i = 0; i < note.length; i++) out[cut + i] = note.charCodeAt(i);
  out.set(bytes.subarray(cut), cut + note.length);
  return out;
}
/** The note `withToleranceNote` wrote, read back from the header. */
function readToleranceNote(bytes: Uint8Array) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  const found = toleranceNote.exec(head.slice(0, head.indexOf('ENDSEC;') + 1 || undefined));
  return found
    ? { toleranceSet: found[1] as CadToleranceSet, maxToleranceMm: Number(found[2]) }
    : undefined;
}

export function stepReport(
  bytes: Uint8Array,
  bodies: number,
  meta: { sourceContentHash: string; buildHash: string },
  /** PMI-4b/4c: what the file carries of the bodies' PMI (the evaluation's count). */
  pmi?: CadStepPmiWritten,
): CadExportReport {
  const head = new TextDecoder().decode(bytes.subarray(0, 64));
  if (!head.startsWith('ISO-10303-21;')) throw new CadExportError('step-invalid');
  const note = readToleranceNote(bytes);
  const w = pmi?.written;
  const written = w ? w.dimension + w['geometric-tolerance'] + w.datum + w['datum-target'] : 0;
  return {
    ...meta,
    format: 'step',
    units: 'mm',
    bodies,
    transforms: [],
    losses: [
      written
        ? bodies > 1
          ? `Feature history, parameters, body names, colours, materials and textures are not written: each of the ${bodies} bodies is its solids, or one surface (shell), with exact surfaces (AP242), side by side without an assembly structure.`
          : 'Feature history, parameters, the body name, colour, material and textures are not written: the body is its solids, or one surface (shell), with exact surfaces (AP242).'
        : bodies > 1
          ? `Feature history, parameters, body names, colours, materials, textures, named views and PMI (dimensions, tolerances, datums; also when the bodies were imported with it) are not written: each of the ${bodies} bodies is its solids, or one surface (shell), with exact surfaces (AP214), side by side without an assembly structure.`
          : 'Feature history, parameters, the body name, colour, material, textures, named views and PMI (dimensions, tolerances, datums; also when the body was imported with it) are not written: the body is its solids, or one surface (shell), with exact surfaces (AP214).',
      ...(pmi ? stepPmiLines(pmi, written) : []),
      ...(note
        ? [
            `The tolerance set (${note.toleranceSet}) is written only as a note in the file header; the largest tolerance in the shapes is ${note.maxToleranceMm} mm.`,
          ]
        : []),
    ],
    ...note,
  };
}

/** PMI-4b/4c: the report's lines on the PMI a part's STEP file carries and what it leaves out. */
function stepPmiLines(pmi: CadStepPmiWritten, written: number): string[] {
  const n = (count: number, one: string, many = `${one}s`) =>
    `${count} ${count === 1 ? one : many}`;
  const w = pmi.written;
  return [
    ...(written
      ? [
          `PMI is written as semantic GD&T (AP242) on the faces, edges and vertices it was imported on: ${n(w.dimension, 'dimension')}, ${n(w['geometric-tolerance'], 'geometric tolerance')}, ${n(w.datum, 'datum')}${pmi.presented ? `; ${pmi.presented} of them with their presentation lines` : ''}.`,
        ]
      : []),
    ...(pmi.stale
      ? [
          `${n(pmi.stale, 'PMI item is', 'PMI items are')} not written: stale on the shape as it is now (a change of a face, edge or datum it depends on, or several imports with PMI in one body).`,
        ]
      : []),
    ...(pmi.unwritable
      ? [
          `${n(pmi.unwritable, 'current PMI item is', 'current PMI items are')} not written: datum targets (their target geometry is not kept), datums that stand only on them, datums whose name another body in the file already uses, dimensions along a path, tolerances that reference a datum not written, or values and modifiers the writer has no form for.`,
        ]
      : []),
    ...(pmi.presentationLost
      ? [
          `The presentation lines of ${n(pmi.presentationLost, 'written PMI item are', 'written PMI items are')} not written: the body is not placed along one path from its import (a pattern's copy), or a line has no length.`,
        ]
      : []),
    ...(pmi.views
      ? [
          `${n(pmi.views, 'saved view of the PMI is', 'saved views of the PMI are')} not written (the writer writes no views).`,
        ]
      : []),
    ...(pmi.unsupportedBuild
      ? [
          `${n(pmi.unsupportedBuild, 'PMI item is', 'PMI items are')} not written: the build this document is evaluated with has no PMI writer.`,
        ]
      : []),
  ];
}

/**
 * Report for an assembly the kernel wrote as STEP AP242 (R2b-5): its products and instances, in
 * millimetres. Refuses bytes that are not an ISO 10303-21 exchange file.
 */
export function assemblyStepReport(
  bytes: Uint8Array,
  plan: CadStepPlan,
  meta: { sourceContentHash: string; buildHash: string },
): CadExportReport {
  const head = new TextDecoder().decode(bytes.subarray(0, 64));
  if (!head.startsWith('ISO-10303-21;')) throw new CadExportError('step-invalid');
  return {
    ...meta,
    format: 'step',
    units: 'mm',
    bodies: plan.products.reduce((n, p) => n + (p.shape?.bodies.length ?? 0), 0),
    products: plan.products.length,
    instances: plan.instances,
    transforms: [],
    losses: [
      'Feature history, parameters, joints, patterns as patterns (their copies are written as instances), named views, PMI and materials are not written. Each part is one product with exact surfaces (AP242).',
    ],
  };
}
