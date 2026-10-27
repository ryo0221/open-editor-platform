import type {
  CadAppearance,
  CadBodyKind,
  CadStepPlan,
  CadToleranceSet,
} from '@editor-platform/cad-core';
import type { CadMesh } from './protocol';

/** One active body to export: its evaluated mesh and how it is shown. */
export interface CadExportBody {
  name: string;
  /** A sheet's triangles need not enclose a volume (docs/cad/r2a-freeform.md). */
  kind: CadBodyKind;
  appearance: CadAppearance;
  mesh: CadMesh;
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
 * glTF 2.0 binary for display: one node per body with its colour. Converted once at this
 * boundary from millimetres and Z-up to glTF's metres and Y-up: (x, y, z) → (x, z, −y) / 1000.
 */
export function writeGlb(
  given: readonly CadExportBody[],
  report: Omit<
    CadExportReport,
    'format' | 'units' | 'bodies' | 'triangles' | 'transforms' | 'losses'
  >,
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
  const add = (data: ArrayBufferView, target: number) => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.byteLength, target });
    chunks.push(bytes);
    length += bytes.byteLength; // every array here is a multiple of 4 bytes
    return bufferViews.length - 1;
  };
  const nodes: object[] = [];
  const meshes: object[] = [];
  const materials: object[] = [];
  for (const [i, { name, kind, appearance, mesh }] of bodies.entries()) {
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
    accessors.push(
      { bufferView: add(positions, 34962), componentType: 5126, count, type: 'VEC3', min, max },
      { bufferView: add(normals, 34962), componentType: 5126, count, type: 'VEC3' },
      {
        bufferView: add(new Uint32Array(mesh.indices), 34963),
        componentType: 5125,
        count: mesh.indices.length,
        type: 'SCALAR',
      },
    );
    const opaque = appearance.opacity >= 1;
    materials.push({
      name,
      pbrMetallicRoughness: {
        baseColorFactor: [...rgb(appearance.color), appearance.opacity],
        metallicFactor: 0,
        roughnessFactor: 0.6,
      },
      ...(opaque ? {} : { alphaMode: 'BLEND' }),
      // A sheet has no inside: both sides are visible.
      ...(kind === 'sheet' ? { doubleSided: true } : {}),
    });
    meshes.push({
      name,
      primitives: [
        {
          attributes: { POSITION: i * 3, NORMAL: i * 3 + 1 },
          indices: i * 3 + 2,
          material: i,
        },
      ],
    });
    // Positions stay relative to the body's box centre (float32 precision); the node places them.
    nodes.push({ name, mesh: i, translation: toGltf(...mesh.origin, 1 / 1000) });
  }
  const json = {
    asset: { version: '2.0', generator: 'EditorPlatform CAD' },
    extras: { sourceContentHash: report.sourceContentHash, buildHash: report.buildHash },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials,
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
): CadExportReport {
  const head = new TextDecoder().decode(bytes.subarray(0, 64));
  if (!head.startsWith('ISO-10303-21;')) throw new CadExportError('step-invalid');
  const note = readToleranceNote(bytes);
  return {
    ...meta,
    format: 'step',
    units: 'mm',
    bodies,
    transforms: [],
    losses: [
      bodies > 1
        ? `Feature history, parameters, body names, colours and named views are not written: each of the ${bodies} bodies is its solids, or one surface (shell), with exact surfaces (AP214), side by side without an assembly structure.`
        : 'Feature history, parameters, the body name, colour and named views are not written: the body is its solids, or one surface (shell), with exact surfaces (AP214).',
      ...(note
        ? [
            `The tolerance set (${note.toleranceSet}) is written only as a note in the file header; the largest tolerance in the shapes is ${note.maxToleranceMm} mm.`,
          ]
        : []),
    ],
    ...note,
  };
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
