import { femLimits, nodesPerElement, type FemMesh } from './fem';

/** A field on nodes or on elements: `components` values per entry (1 scalar, 3 vector, 6 tensor). */
export interface VtuField {
  name: string;
  components: 1 | 3 | 6 | 9;
  values: Float64Array;
}
/** R3i-4: a shell's midsurface triangles (three nodes each), written as VTK triangles. */
export interface VtuTriangles {
  type: 'tri3';
  nodes: Float64Array;
  elements: Uint32Array;
}
export interface VtuInput {
  mesh: FemMesh | VtuTriangles;
  pointData?: VtuField[];
  cellData?: VtuField[];
}

/** VTK cell types (VTK file formats, "Linear and non-linear cell types"). */
const vtkType = { tet4: 10, tet10: 24, tri3: 5 } as const;

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Standard base64 with padding, without platform helpers (runs in Workers and Node alike). */
export function base64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      alphabet[n >> 18]! + alphabet[(n >> 12) & 63]! + alphabet[(n >> 6) & 63]! + alphabet[n & 63]!;
  }
  if (i < bytes.length) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += alphabet[n >> 18]! + alphabet[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? alphabet[(n >> 6) & 63]! + '=' : '==';
  }
  return out;
}
/** A VTK "binary" inline array: base64 of a UInt32 byte count followed by the data. */
function block(data: Uint8Array): string {
  const out = new Uint8Array(4 + data.length);
  new DataView(out.buffer).setUint32(0, data.length, true);
  out.set(data, 4);
  return base64(out);
}
function le(values: ArrayLike<number>, kind: 'f64' | 'i32' | 'u8'): Uint8Array {
  const size = kind === 'f64' ? 8 : kind === 'i32' ? 4 : 1;
  const out = new Uint8Array(values.length * size);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) {
    if (kind === 'f64') view.setFloat64(i * 8, values[i]!, true);
    else if (kind === 'i32') view.setInt32(i * 4, values[i]!, true);
    else view.setUint8(i, values[i]!);
  }
  return out;
}
const attr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fieldName = (s: string) => {
  if (!/^[\p{L}\p{N}_ .\-()]{1,64}$/u.test(s)) throw new RangeError(`vtu-field-name: ${s}`);
  return attr(s);
};

/**
 * An XML VTU (UnstructuredGrid, version 1.0, little-endian, inline base64) of a mesh and its
 * fields, readable by ParaView. Field lengths must match the node or element count. The shape
 * face of each boundary face is not written; `ShapeFace` per element is not meaningful.
 */
export function writeVtu(input: VtuInput): string {
  const { mesh } = input;
  const npe = mesh.type === 'tri3' ? 3 : nodesPerElement(mesh.type);
  const n = mesh.nodes.length / 3;
  const m = mesh.elements.length / npe;
  const offsets = new Int32Array(m);
  for (let e = 0; e < m; e++) offsets[e] = (e + 1) * npe;
  const types = new Uint8Array(m).fill(vtkType[mesh.type]);
  const names = new Set<string>();
  const array = (f: VtuField, count: number) => {
    if (names.has(f.name)) throw new RangeError(`vtu-field-repeated: ${f.name}`);
    names.add(f.name);
    if (f.values.length !== count * f.components)
      throw new RangeError(`vtu-field-length: ${f.name}`);
    for (const v of f.values)
      if (!Number.isFinite(v)) throw new RangeError(`vtu-field-value: ${f.name}`);
    return `<DataArray type="Float64" Name="${fieldName(f.name)}" NumberOfComponents="${f.components}" format="binary">${block(le(f.values, 'f64'))}</DataArray>`;
  };
  const lines = [
    '<?xml version="1.0"?>',
    '<VTKFile type="UnstructuredGrid" version="1.0" byte_order="LittleEndian" header_type="UInt32">',
    '<UnstructuredGrid>',
    `<Piece NumberOfPoints="${n}" NumberOfCells="${m}">`,
    '<PointData>',
    ...(input.pointData ?? []).map((f) => array(f, n)),
    '</PointData>',
    '<CellData>',
    ...(input.cellData ?? []).map((f) => array(f, m)),
    '</CellData>',
    '<Points>',
    `<DataArray type="Float64" NumberOfComponents="3" format="binary">${block(le(mesh.nodes, 'f64'))}</DataArray>`,
    '</Points>',
    '<Cells>',
    `<DataArray type="Int32" Name="connectivity" format="binary">${block(le(mesh.elements, 'i32'))}</DataArray>`,
    `<DataArray type="Int32" Name="offsets" format="binary">${block(le(offsets, 'i32'))}</DataArray>`,
    `<DataArray type="UInt8" Name="types" format="binary">${block(le(types, 'u8'))}</DataArray>`,
    '</Cells>',
    '</Piece>',
    '</UnstructuredGrid>',
    '</VTKFile>',
    '',
  ];
  return lines.join('\n');
}

/** What a VTU was refused for; nothing is repaired. */
export type VtuProblem =
  | 'too-large'
  | 'syntax'
  | 'format'
  | 'structure'
  | 'array'
  | 'length'
  | 'not-finite'
  | 'index'
  | 'cell'
  | 'field';
/** Every refusal of a VTU read (`result-invalid`, docs/cad/r3-analysis.md 安全性). */
export class VtuError extends Error {
  readonly code = 'result-invalid';
  constructor(
    readonly problem: VtuProblem,
    readonly detail: string,
  ) {
    super(`result-invalid: ${problem}: ${detail}`);
    this.name = 'VtuError';
  }
}
const refuse = (problem: VtuProblem, detail: string): never => {
  throw new VtuError(problem, detail);
};

/** A VTU read for display: a mesh without shape faces, and its fields. */
export interface VtuResult {
  /** R3i-5: `tri3` for a shell's midsurface, as `writeVtu` writes it. */
  type: FemMesh['type'] | 'tri3';
  nodes: Float64Array;
  elements: Uint32Array;
  pointData: VtuField[];
  cellData: VtuField[];
}
export interface VtuReadLimits {
  /** Characters of the whole text. */
  bytes: number;
  nodes: number;
  elements: number;
  /** Fields in each of PointData and CellData. */
  fields: number;
}
export const vtuReadLimits: Readonly<VtuReadLimits> = Object.freeze({
  bytes: femLimits.bytes,
  nodes: femLimits.nodes,
  elements: femLimits.elements,
  fields: 32,
});

const decodeTable = new Int16Array(128).fill(-1);
for (let i = 0; i < alphabet.length; i++) decodeTable[alphabet.charCodeAt(i)] = i;
/** Strict base64 (padding required, nothing else but ASCII whitespace around it). */
export function unbase64(text: string): Uint8Array {
  const s = text.trim();
  if (s.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(s) || /=[^=]|={3}/.test(s))
    return refuse('array', 'base64');
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const v = [0, 1, 2, 3].map((k) => (s[i + k] === '=' ? 0 : decodeTable[s.charCodeAt(i + k)]!));
    const n = (v[0]! << 18) | (v[1]! << 12) | (v[2]! << 6) | v[3]!;
    for (const b of [n >> 16, (n >> 8) & 255, n & 255]) if (o < out.length) out[o++] = b & 255;
  }
  return out;
}

interface Tag {
  name: string;
  attrs: Map<string, string>;
  children: Tag[];
  text: string;
}
const unattr = (s: string) =>
  s.replace(/&(amp|quot|lt|gt|apos);/g, (_, e: string) =>
    e === 'amp' ? '&' : e === 'quot' ? '"' : e === 'lt' ? '<' : e === 'gt' ? '>' : "'",
  );
/** The element tree of the text: tags, attributes and text only (no comments, CDATA, DTD). */
function parseXml(text: string): Tag {
  let i = 0;
  const decl = /^\s*<\?xml[^?]*\?>/.exec(text);
  if (decl) i = decl[0].length;
  const root: Tag = { name: '', attrs: new Map(), children: [], text: '' };
  const stack = [root];
  const tag =
    /<(\/?)([A-Za-z][A-Za-z0-9]*)((?:\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*"[^"<]*")*)\s*(\/?)>/y;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    const chunk = text.slice(i, lt < 0 ? text.length : lt);
    if (chunk.trim()) {
      if (stack.length < 2) refuse('syntax', 'text outside the root');
      stack[stack.length - 1]!.text += chunk;
    }
    if (lt < 0) break;
    tag.lastIndex = lt;
    const m = tag.exec(text);
    if (!m) return refuse('syntax', `at ${lt}`);
    i = tag.lastIndex;
    const [, close, name, attrText, selfClose] = m;
    if (close) {
      if (attrText || selfClose || stack.length < 2 || stack[stack.length - 1]!.name !== name)
        refuse('syntax', `</${name}>`);
      stack.pop();
      continue;
    }
    const attrs = new Map<string, string>();
    for (const a of attrText!.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/g)) {
      if (attrs.has(a[1]!)) refuse('syntax', `repeated ${a[1]}`);
      attrs.set(a[1]!, unattr(a[2]!));
    }
    const node: Tag = { name: name!, attrs, children: [], text: '' };
    const parent = stack[stack.length - 1]!;
    if (parent === root && root.children.length) refuse('syntax', 'second root');
    parent.children.push(node);
    if (!selfClose) stack.push(node);
    if (stack.length > 8) refuse('syntax', 'too deep');
  }
  if (stack.length !== 1 || root.children.length !== 1) refuse('syntax', 'unclosed');
  return root.children[0]!;
}

/**
 * Reads, for display only, the VTU this module writes: XML UnstructuredGrid version 1.0 (or 0.1),
 * little-endian, UInt32 headers, inline base64 arrays, one piece of tet4 or tet10 cells only,
 * Float64 points and fields (1, 3, 6 or 9 components), Int32 or Int64 connectivity and offsets,
 * UInt8 types. Everything is checked (lengths, finite values, index range, one cell type, offsets)
 * against `limits`; anything else (appended or ASCII data, compression, other cell types or
 * number types, several pieces) is refused with `VtuError` (`result-invalid`).
 */
export function readVtu(text: string, limits: Readonly<VtuReadLimits> = vtuReadLimits): VtuResult {
  if (text.length > limits.bytes) refuse('too-large', `${text.length} characters`);
  const file = parseXml(text);
  const a = (t: Tag, k: string) => t.attrs.get(k);
  if (file.name !== 'VTKFile' || a(file, 'type') !== 'UnstructuredGrid')
    refuse('format', 'not an UnstructuredGrid VTKFile');
  if (!['1.0', '0.1'].includes(a(file, 'version') ?? '')) refuse('format', 'version');
  if (a(file, 'byte_order') !== 'LittleEndian') refuse('format', 'byte_order');
  if ((a(file, 'header_type') ?? 'UInt32') !== 'UInt32') refuse('format', 'header_type');
  if (a(file, 'compressor') !== undefined) refuse('format', 'compressed');
  const only = (t: Tag, name: string) => {
    if (t.children.length !== 1 || t.children[0]!.name !== name || t.text.trim())
      refuse('structure', `${t.name} must hold one ${name}`);
    return t.children[0]!;
  };
  const grid = only(file, 'UnstructuredGrid');
  const piece = only(grid, 'Piece');
  const count = (k: string, max: number) => {
    const s = a(piece, k) ?? '';
    if (!/^\d{1,9}$/.test(s)) return refuse('structure', k);
    const n = Number(s);
    if (n > max) refuse('too-large', `${n} ${k}`);
    return n;
  };
  const n = count('NumberOfPoints', limits.nodes);
  const m = count('NumberOfCells', limits.elements);
  const sections = new Map<string, Tag>();
  for (const c of piece.children) {
    if (!['PointData', 'CellData', 'Points', 'Cells'].includes(c.name) || sections.has(c.name))
      refuse('structure', `Piece holds ${c.name}`);
    sections.set(c.name, c);
  }
  if (piece.text.trim()) refuse('structure', 'text in Piece');
  const points = sections.get('Points');
  const cells = sections.get('Cells');
  if (!points || !cells) return refuse('structure', 'Points and Cells are required');
  /** One inline array: its declared type, and its values (length checked against the header). */
  const read = (t: Tag, types: string[]) => {
    if (t.name !== 'DataArray' || t.children.length) refuse('structure', `${t.name} in a section`);
    const type = a(t, 'type') ?? '';
    if (!types.includes(type)) refuse('array', `type ${type}`);
    if (a(t, 'format') !== 'binary') refuse('format', `format ${a(t, 'format') ?? 'none'}`);
    const raw = unbase64(t.text);
    if (raw.length < 4) refuse('array', 'header');
    const size = new DataView(raw.buffer, raw.byteOffset).getUint32(0, true);
    if (size !== raw.length - 4) refuse('length', `block of ${size} bytes in ${raw.length - 4}`);
    const width = type.endsWith('64') ? 8 : type.endsWith('32') ? 4 : 1;
    if (size % width) refuse('length', 'partial value');
    const view = new DataView(raw.buffer, raw.byteOffset + 4, size);
    const values = new Float64Array(size / width);
    for (let i = 0; i < values.length; i++)
      values[i] =
        type === 'Float64'
          ? view.getFloat64(i * 8, true)
          : type === 'Int64'
            ? Number(view.getBigInt64(i * 8, true))
            : type === 'Int32'
              ? view.getInt32(i * 4, true)
              : view.getUint8(i);
    return values;
  };
  const components = (t: Tag) => {
    const c = Number(a(t, 'NumberOfComponents') ?? '1');
    if (![1, 3, 6, 9].includes(c)) refuse('field', `${c} components`);
    return c as VtuField['components'];
  };
  if (points.children.length !== 1) refuse('structure', 'Points holds one DataArray');
  const p = points.children[0]!;
  if (components(p) !== 3) refuse('array', 'points need 3 components');
  const nodes = read(p, ['Float64']);
  if (nodes.length !== n * 3) refuse('length', `${nodes.length / 3} points for ${n}`);
  for (const v of nodes)
    if (!Number.isFinite(v)) refuse('not-finite', 'point');
    else if (Math.abs(v) > femLimits.coordinateMm) refuse('too-large', 'coordinate');
  const byName = new Map<string, Tag>();
  for (const c of cells.children) {
    const name = a(c, 'Name') ?? '';
    if (!['connectivity', 'offsets', 'types'].includes(name) || byName.has(name))
      refuse('structure', `Cells holds ${name || 'an unnamed array'}`);
    byName.set(name, c);
  }
  if (byName.size !== 3) refuse('structure', 'Cells needs connectivity, offsets and types');
  const types = read(byName.get('types')!, ['UInt8']);
  if (types.length !== m) refuse('length', 'types');
  const kind =
    types[0] === vtkType.tet4
      ? 'tet4'
      : types[0] === vtkType.tet10
        ? 'tet10'
        : types[0] === vtkType.tri3
          ? 'tri3'
          : null;
  if (m === 0 || kind === null) return refuse('cell', `cell type ${types[0] ?? 'none'}`);
  for (const t of types) if (t !== types[0]) refuse('cell', 'mixed cell types');
  const npe = kind === 'tri3' ? 3 : nodesPerElement(kind);
  const offsets = read(byName.get('offsets')!, ['Int32', 'Int64']);
  if (offsets.length !== m) refuse('length', 'offsets');
  for (let e = 0; e < m; e++) if (offsets[e] !== (e + 1) * npe) refuse('cell', `offset ${e}`);
  const connectivity = read(byName.get('connectivity')!, ['Int32', 'Int64']);
  if (connectivity.length !== m * npe) refuse('length', 'connectivity');
  const elements = new Uint32Array(m * npe);
  for (let i = 0; i < elements.length; i++) {
    const v = connectivity[i]!;
    if (!Number.isInteger(v) || v < 0 || v >= n)
      refuse('index', `node ${v} of element ${Math.floor(i / npe)}`);
    elements[i] = v;
  }
  const fields = (section: string, entries: number) => {
    const t = sections.get(section);
    if (!t) return [];
    if (t.text.trim()) refuse('structure', `text in ${section}`);
    if (t.children.length > limits.fields) refuse('too-large', `${t.children.length} fields`);
    const names = new Set<string>();
    return t.children.map((f): VtuField => {
      const name = a(f, 'Name') ?? '';
      if (!/^[\p{L}\p{N}_ .\-()]{1,64}$/u.test(name)) refuse('field', `name ${name}`);
      if (names.has(name)) refuse('field', `repeated ${name}`);
      names.add(name);
      const c = components(f);
      const values = read(f, ['Float64']);
      if (values.length !== entries * c) refuse('length', name);
      for (const v of values) if (!Number.isFinite(v)) refuse('not-finite', name);
      return { name, components: c, values };
    });
  };
  return {
    type: kind,
    nodes,
    elements,
    pointData: fields('PointData', n),
    cellData: fields('CellData', m),
  };
}
