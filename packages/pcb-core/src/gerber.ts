import { zipSync, strToU8 } from 'fflate';
import { arcOf, loopBounds } from './geometry';
import {
  pcbCopperLayerNames,
  type PcbComponent,
  type PcbDocument,
  type PcbLoop,
  type PcbSilk,
  type Vec2,
} from './model';
import { componentPads, componentTransform, type PcbPlacedPad } from './placement';
import { pcbZoneFills, type PcbZoneFill } from './zones';

/**
 * Fabrication data (PB6, docs/cad/pcb-design.md): Gerber X2 (RS-274X with attributes) per
 * layer, Excellon drill files (plated and unplated), a bill of materials and a placement CSV.
 * Gerber coordinates are mm in format 4.6; arcs are written as arcs (G75 with G02/G03), so pads,
 * the board edge and silk circles keep their exact shape. Zone copper is the fill shared with
 * the screen and DRC (`pcbZoneFills`), one region per trapezoid. The same document gives the
 * same bytes.
 */

export interface PcbFabFile {
  /** File name in the archive, `<base>-<layer>.<ext>`. */
  name: string;
  /** What the file holds, e.g. `Copper,L1,Top` or `drill:plated`. */
  role: string;
  text: string;
}

/** Writes a number in Gerber's 4.6 format (mm, leading zeros omitted, micro-millimetre steps). */
const coord = (v: number) => String(Math.round(v * 1e6) + 0);
const mm = (v: number) => (Math.round(v * 1e6) / 1e6).toFixed(6);
const xy = (p: Vec2) => `X${coord(p[0])}Y${coord(p[1])}`;

/** `%FSLAX46Y46*%`: four integer digits, so offsets and coordinates stay below this, mm. */
const gerberMaxMm = 1e4;
/** Half the format's resolution (1 nm): lines this close to an arc write the same file. */
const flatTolerance = 0.5e-6;

/**
 * The inner points of lines that follow `arc` (from `p`) within `flatTolerance`. Placed from
 * `p`, not from the far-off centre, so a nearly straight arc keeps the digits that matter.
 */
function flatArc(p: Vec2, arc: ReturnType<typeof arcOf>): Vec2[] {
  if (!Number.isFinite(arc.radius)) return [];
  const step = 4 * Math.asin(Math.sqrt(Math.min(1, flatTolerance / (2 * arc.radius))));
  const k = Math.max(1, Math.ceil(Math.abs(arc.sweep) / step));
  if (!Number.isFinite(k)) return [];
  const a0 = arc.startAngle;
  const out: Vec2[] = [];
  for (let j = 1; j < k; j++) {
    const a = a0 + (arc.sweep * j) / k;
    const half = Math.sin((a - a0) / 2);
    const mid = (a + a0) / 2;
    out.push([
      p[0] - 2 * arc.radius * Math.sin(mid) * half,
      p[1] + 2 * arc.radius * Math.cos(mid) * half,
    ]);
  }
  return out;
}

/** An attribute value: `,`, `*`, `%` and `\` are not allowed in a field; they become `\uXXXX`. */
export function gerberField(text: string): string {
  let out = '';
  for (const c of text) {
    const code = c.charCodeAt(0);
    out +=
      code < 0x20 || ',*%\\'.includes(c)
        ? `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`
        : c;
  }
  return out;
}

type Template = { kind: 'C'; d: number } | { kind: 'R' | 'O'; w: number; h: number };

/** Object attributes of the next objects (`.TO`): net, pin, component. */
interface ObjectAttributes {
  N?: string;
  P?: [string, string];
  C?: string;
}

class GerberWriter {
  private apertures = new Map<string, number>();
  private defs: string[] = [];
  private body: string[] = [];
  private object = '';
  private objectKeys: string[] = [];
  private regionFunction: string | undefined;

  constructor(
    private header: string[],
    private withFunctions: boolean,
  ) {}

  aperture(t: Template, fn?: string): number {
    const def = t.kind === 'C' ? `C,${mm(t.d)}` : `${t.kind},${mm(t.w)}X${mm(t.h)}`;
    const f = this.withFunctions ? fn : undefined;
    const key = `${def}|${f ?? ''}`;
    let code = this.apertures.get(key);
    if (code === undefined) {
      code = 10 + this.apertures.size;
      this.apertures.set(key, code);
      if (f) this.defs.push(`%TA.AperFunction,${f}*%`);
      this.defs.push(`%ADD${code}${def}*%`);
      if (f) this.defs.push('%TD*%');
    }
    return code;
  }

  private attrs(a: ObjectAttributes) {
    const lines: string[] = [];
    if (a.N !== undefined) lines.push(`%TO.N,${gerberField(a.N)}*%`);
    if (a.P) lines.push(`%TO.P,${gerberField(a.P[0])},${gerberField(a.P[1])}*%`);
    if (a.C !== undefined) lines.push(`%TO.C,${gerberField(a.C)}*%`);
    const text = lines.join('\n');
    if (text === this.object) return;
    // Clear by name: a bare %TD*% would also clear a region's aperture function.
    for (const k of this.objectKeys) this.body.push(`%TD.${k}*%`);
    if (text) this.body.push(text);
    this.object = text;
    this.objectKeys = (['N', 'P', 'C'] as const).filter((k) => a[k] !== undefined);
  }

  private use = -1;
  private select(code: number) {
    if (code !== this.use) this.body.push(`D${code}*`);
    this.use = code;
  }

  flash(code: number, at: Vec2, a: ObjectAttributes = {}) {
    this.attrs(a);
    this.select(code);
    this.body.push(`${xy(at)}D03*`);
  }

  draw(code: number, from: Vec2, to: Vec2, a: ObjectAttributes = {}) {
    this.attrs(a);
    this.select(code);
    this.body.push(`${xy(from)}D02*`, `G01*`, `${xy(to)}D01*`);
  }

  /** A full circle drawn with a round aperture (a silk ring). */
  circle(code: number, center: Vec2, r: number, a: ObjectAttributes = {}) {
    this.attrs(a);
    this.select(code);
    const start: Vec2 = [center[0] + r, center[1]];
    this.body.push(`${xy(start)}D02*`, `G03*`, `${xy(start)}I${coord(-r)}J0D01*`, 'G01*');
  }

  /** The sides of a closed loop, lines and arcs, drawn with the current aperture. */
  private loopSides(loop: PcbLoop) {
    this.body.push(`${xy([loop[0][0], loop[0][1]])}D02*`);
    let mode = '';
    for (let i = 0; i < loop.length; i++) {
      const v = loop[i];
      const w = loop[(i + 1) % loop.length];
      const p: Vec2 = [v[0], v[1]];
      const q: Vec2 = [w[0], w[1]];
      const bulge = v[2] ?? 0;
      if (!bulge) {
        if (mode !== 'G01') this.body.push('G01*');
        mode = 'G01';
        this.body.push(`${xy(q)}D01*`);
        continue;
      }
      const arc = arcOf(p, q, bulge);
      const off: Vec2 = [arc.center[0] - p[0], arc.center[1] - p[1]];
      if (!(Math.abs(off[0]) < gerberMaxMm && Math.abs(off[1]) < gerberMaxMm)) {
        // A nearly straight arc: its centre offset does not fit the coordinate format, so it is
        // written as lines within the format's resolution of the arc.
        if (mode !== 'G01') this.body.push('G01*');
        mode = 'G01';
        for (const r of flatArc(p, arc)) this.body.push(`${xy(r)}D01*`);
        this.body.push(`${xy(q)}D01*`);
        continue;
      }
      const m = bulge > 0 ? 'G03' : 'G02';
      if (mode !== m) this.body.push(`${m}*`);
      mode = m;
      this.body.push(`${xy(q)}I${coord(off[0])}J${coord(off[1])}D01*`);
    }
    if (mode !== 'G01') this.body.push('G01*');
  }

  /** A loop drawn as a line (the board profile). */
  outline(code: number, loop: PcbLoop) {
    this.attrs({});
    this.select(code);
    this.loopSides(loop);
  }

  /** A filled region; `fn` is its aperture function (regions take it from the dictionary). */
  region(loop: PcbLoop, a: ObjectAttributes = {}, fn?: string) {
    this.attrs(a);
    const f = this.withFunctions ? fn : undefined;
    if (f !== this.regionFunction) {
      this.body.push(f ? `%TA.AperFunction,${f}*%` : '%TD.AperFunction*%');
      this.regionFunction = f;
    }
    this.body.push('G36*');
    this.loopSides(loop);
    this.body.push('G37*');
  }

  text(): string {
    return [
      ...this.header,
      '%FSLAX46Y46*%',
      '%MOMM*%',
      '%LPD*%',
      'G75*',
      'G01*',
      ...this.defs,
      ...this.body,
      ...(this.object || this.regionFunction ? ['%TD*%'] : []),
      'M02*',
      '',
    ].join('\n');
  }
}

/** The copper layer's X2 file function: `Copper,L<n>,Top|Inr|Bot`. */
function copperFunction(names: string[], layer: string): string {
  const i = names.indexOf(layer);
  const pos = i === 0 ? 'Top' : i === names.length - 1 ? 'Bot' : 'Inr';
  return `Copper,L${i + 1},${pos}`;
}

const layerFile = (layer: string) => layer.replace('.', '_');

/** Whether a placed pad can be a flash of a standard aperture, and which one. */
function padTemplate(p: PcbPlacedPad, c: PcbComponent): Template | undefined {
  const { shape, size } = p.pad;
  if (shape === 'circle') return { kind: 'C', d: size[0] };
  if (shape === 'roundrect') return undefined;
  const turns = c.rotationDeg / 90;
  if (Math.abs(turns - Math.round(turns)) > 1e-9) return undefined;
  const quarter = (((Math.round(p.pad.rotationDeg / 90) + Math.round(turns)) % 2) + 2) % 2 === 1;
  const [w, h] = quarter ? [size[1], size[0]] : size;
  if (shape === 'oval' && Math.abs(w - h) <= 1e-9) return { kind: 'C', d: w };
  return { kind: shape === 'rect' ? 'R' : 'O', w, h };
}

interface Context {
  doc: PcbDocument;
  header: (fn: string, polarity: 'Positive' | 'Negative') => string[];
  pads: { p: PcbPlacedPad; c: PcbComponent; net?: string }[];
  netName: Map<string, string>;
}

function padShape(
  g: GerberWriter,
  { p, c, net }: Context['pads'][number],
  fn: string | undefined,
  withAttrs: boolean,
) {
  const t = padTemplate(p, c);
  const a: ObjectAttributes = withAttrs ? { N: net, P: [c.ref, p.pad.number], C: c.ref } : {};
  if (t) g.flash(g.aperture(t, fn), p.at, a);
  else g.region(p.loop, a, fn);
}

function copperLayer(ctx: Context, layer: string, fills: PcbZoneFill[]): string {
  const { doc } = ctx;
  const names = pcbCopperLayerNames(doc.board.copperLayers);
  const g = new GerberWriter(ctx.header(copperFunction(names, layer), 'Positive'), true);
  // Zones first (as on the screen): pads, tracks and vias are drawn over their reliefs.
  for (const f of fills) {
    if (f.layer !== layer) continue;
    const N = ctx.netName.get(f.net) ?? f.net;
    for (const t of f.trapezoids) {
      const pts: Vec2[] = [
        [t.xl0, t.y0],
        [t.xr0, t.y0],
        [t.xr1, t.y1],
        [t.xl1, t.y1],
      ];
      const loop = pts.filter(
        (v, i) =>
          Math.abs(v[0] - pts[(i + 1) % 4][0]) > 5e-7 ||
          Math.abs(v[1] - pts[(i + 1) % 4][1]) > 5e-7,
      );
      if (loop.length >= 3) g.region(loop, { N }, 'Conductor');
    }
  }
  for (const pad of ctx.pads)
    if (pad.p.layers.includes(layer))
      padShape(g, pad, pad.p.pad.type === 'smd' ? 'SMDPad,CuDef' : 'ComponentPad', true);
  for (const t of doc.tracks)
    if (t.layer === layer)
      g.draw(g.aperture({ kind: 'C', d: t.widthMm }, 'Conductor'), t.from, t.to, {
        N: ctx.netName.get(t.net) ?? t.net,
      });
  for (const v of doc.vias)
    g.flash(g.aperture({ kind: 'C', d: v.diameterMm }, 'ViaPad'), v.at, {
      N: ctx.netName.get(v.net) ?? v.net,
    });
  return g.text();
}

/** Solder mask openings (negative: drawn where there is no mask). Vias are tented. */
function maskLayer(ctx: Context, side: 'top' | 'bottom'): string {
  const g = new GerberWriter(
    ctx.header(`Soldermask,${side === 'top' ? 'Top' : 'Bot'}`, 'Negative'),
    false,
  );
  for (const pad of ctx.pads)
    if (pad.p.pad.type !== 'smd' || pad.c.side === side) padShape(g, pad, undefined, false);
  for (const h of ctx.doc.holes) g.flash(g.aperture({ kind: 'C', d: h.drillMm }), h.at);
  return g.text();
}

function pasteLayer(ctx: Context, side: 'top' | 'bottom'): string {
  const g = new GerberWriter(
    ctx.header(`Paste,${side === 'top' ? 'Top' : 'Bot'}`, 'Positive'),
    false,
  );
  for (const pad of ctx.pads)
    if (pad.p.pad.type === 'smd' && pad.c.side === side) padShape(g, pad, undefined, false);
  return g.text();
}

function silkLayer(ctx: Context, side: 'top' | 'bottom'): string {
  const g = new GerberWriter(
    ctx.header(`Legend,${side === 'top' ? 'Top' : 'Bot'}`, 'Positive'),
    false,
  );
  for (const c of ctx.doc.components) {
    if (c.side !== side) continue;
    const fp = ctx.doc.footprints.find((f) => f.id === c.footprint);
    if (!fp) continue;
    const f = componentTransform(c);
    for (const s of fp.silk as PcbSilk[]) {
      if (s.kind === 'line') {
        g.draw(g.aperture({ kind: 'C', d: s.widthMm }), f(s.from), f(s.to));
      } else if (s.filled) {
        g.flash(g.aperture({ kind: 'C', d: 2 * s.radiusMm + s.widthMm }), f(s.center));
      } else g.circle(g.aperture({ kind: 'C', d: s.widthMm }), f(s.center), s.radiusMm);
    }
  }
  return g.text();
}

/** The board's edge and cut-outs, drawn with a 0.1 mm line. */
function profileLayer(ctx: Context): string {
  const g = new GerberWriter(ctx.header('Profile,NP', 'Positive'), true);
  const code = g.aperture({ kind: 'C', d: 0.1 }, 'Profile');
  g.outline(code, ctx.doc.board.outline);
  for (const k of ctx.doc.board.cutouts) g.outline(code, k);
  return g.text();
}

export interface PcbDrillHit {
  at: Vec2;
  drillMm: number;
}

/** Plated (vias, through pads, plated mounting holes) and unplated holes. */
export function pcbDrillHits(doc: PcbDocument): { plated: PcbDrillHit[]; unplated: PcbDrillHit[] } {
  const plated: PcbDrillHit[] = [];
  const unplated: PcbDrillHit[] = [];
  for (const v of doc.vias) plated.push({ at: v.at, drillMm: v.drillMm });
  for (const c of doc.components)
    for (const p of componentPads(doc, c)) {
      if (p.pad.type === 'smd' || p.pad.drillMm === undefined) continue;
      (p.pad.type === 'thru' ? plated : unplated).push({ at: p.at, drillMm: p.pad.drillMm });
    }
  for (const h of doc.holes) (h.plated ? plated : unplated).push({ at: h.at, drillMm: h.drillMm });
  return { plated, unplated };
}

/** An Excellon drill file in mm (tools by diameter, smallest first). */
function excellon(hits: PcbDrillHit[], plated: boolean, layers: number): string {
  const sizes = [...new Set(hits.map((h) => Math.round(h.drillMm * 1000)))].sort((a, b) => a - b);
  const f = (v: number) => (Math.round(v * 1000) / 1000).toFixed(3);
  const lines = [
    'M48',
    `; DRILL file, ${plated ? 'plated' : 'unplated'} holes, editor-platform pcb`,
    `; #@! TF.FileFunction,${plated ? 'Plated' : 'NonPlated'},1,${layers},${plated ? 'PTH' : 'NPTH'}`,
    'FMAT,2',
    'METRIC',
    ...sizes.map((s, i) => `T${i + 1}C${f(s / 1000)}`),
    '%',
    'G90',
    'G05',
  ];
  sizes.forEach((s, i) => {
    lines.push(`T${i + 1}`);
    for (const h of hits)
      if (Math.round(h.drillMm * 1000) === s) lines.push(`X${f(h.at[0])}Y${f(h.at[1])}`);
  });
  lines.push('M30', '');
  return lines.join('\n');
}

const csvField = (v: string | number) => {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows: (string | number)[][]) =>
  rows.map((r) => r.map(csvField).join(',')).join('\n') + '\n';
/** "R2" < "R10": refs by their letters, then by their number. */
const refOrder = (a: string, b: string) =>
  a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * Bill of materials: one line per value and footprint (by the footprint's ID, so two
 * footprints that share a name stay apart), with the refs and the count.
 */
export function pcbBomCsv(doc: PcbDocument): string {
  const groups = new Map<
    string,
    { value: string; footprint: string; id: string; refs: string[] }
  >();
  for (const c of doc.components) {
    const footprint = doc.footprints.find((f) => f.id === c.footprint)?.name ?? c.footprint;
    const key = `${c.value}\u0000${c.footprint}`;
    const g = groups.get(key) ?? { value: c.value, footprint, id: c.footprint, refs: [] };
    g.refs.push(c.ref);
    groups.set(key, g);
  }
  const rows = [...groups.values()].map((g) => ({ ...g, refs: g.refs.sort(refOrder) }));
  rows.sort((a, b) => refOrder(a.refs[0], b.refs[0]));
  return csv([
    ['Designator', 'Value', 'Footprint', 'Footprint ID', 'Quantity'],
    ...rows.map((g) => [g.refs.join(' '), g.value, g.footprint, g.id, g.refs.length]),
  ]);
}

/**
 * Placement (pick and place): every part's centre (the middle of its courtyard's bounds, not
 * the footprint origin, which is pin 1 for a header), rotation and side, mm, seen from the top.
 */
export function pcbPlacementCsv(doc: PcbDocument): string {
  const parts = [...doc.components].sort((a, b) => refOrder(a.ref, b.ref));
  const f = (v: number) => (Math.round(v * 1e4) / 1e4).toFixed(4);
  return csv([
    ['Designator', 'Value', 'Footprint', 'Mid X', 'Mid Y', 'Rotation', 'Layer'],
    ...parts.map((c) => {
      const fp = doc.footprints.find((x) => x.id === c.footprint);
      let mid = c.at;
      if (fp) {
        const [x0, y0, x1, y1] = loopBounds(fp.courtyard);
        mid = componentTransform(c)([(x0 + x1) / 2, (y0 + y1) / 2]);
      }
      return [
        c.ref,
        c.value,
        fp?.name ?? c.footprint,
        f(mid[0]),
        f(mid[1]),
        f(c.rotationDeg),
        c.side,
      ];
    }),
  ]);
}

/**
 * Every fabrication file of the board. `fills` are the zone fills when the caller already has
 * them (the screen); otherwise they are computed.
 */
export function pcbFabricationFiles(
  doc: PcbDocument,
  base = 'board',
  fills: PcbZoneFill[] = pcbZoneFills(doc),
): PcbFabFile[] {
  const netName = new Map(doc.nets.map((n) => [n.id, n.name]));
  const padNet = new Map<string, string>();
  for (const n of doc.nets) for (const [c, p] of n.pins) padNet.set(`${c}\u0000${p}`, n.name);
  const pads: Context['pads'] = [];
  for (const c of doc.components)
    for (const p of componentPads(doc, c))
      pads.push({ p, c, net: padNet.get(`${c.id}\u0000${p.pad.number}`) });
  const ctx: Context = {
    doc,
    pads,
    netName,
    header: (fn, polarity) => [
      '%TF.GenerationSoftware,editor-platform,pcb,1*%',
      '%TF.SameCoordinates,Original*%',
      `%TF.FileFunction,${fn}*%`,
      `%TF.FilePolarity,${polarity}*%`,
    ],
  };
  const copper = pcbCopperLayerNames(doc.board.copperLayers);
  const gbr = (layer: string, role: string, text: string): PcbFabFile => ({
    name: `${base}-${layerFile(layer)}.gbr`,
    role,
    text,
  });
  const drills = pcbDrillHits(doc);
  return [
    ...copper.map((l) => gbr(l, copperFunction(copper, l), copperLayer(ctx, l, fills))),
    gbr('F.Mask', 'Soldermask,Top', maskLayer(ctx, 'top')),
    gbr('B.Mask', 'Soldermask,Bot', maskLayer(ctx, 'bottom')),
    gbr('F.Paste', 'Paste,Top', pasteLayer(ctx, 'top')),
    gbr('B.Paste', 'Paste,Bot', pasteLayer(ctx, 'bottom')),
    gbr('F.SilkS', 'Legend,Top', silkLayer(ctx, 'top')),
    gbr('B.SilkS', 'Legend,Bot', silkLayer(ctx, 'bottom')),
    gbr('Edge.Cuts', 'Profile,NP', profileLayer(ctx)),
    {
      name: `${base}-PTH.drl`,
      role: 'drill:plated',
      text: excellon(drills.plated, true, copper.length),
    },
    {
      name: `${base}-NPTH.drl`,
      role: 'drill:unplated',
      text: excellon(drills.unplated, false, copper.length),
    },
    { name: `${base}-bom.csv`, role: 'bom', text: pcbBomCsv(doc) },
    { name: `${base}-pos.csv`, role: 'placement', text: pcbPlacementCsv(doc) },
  ];
}

/** The files as one zip; entries carry a fixed time so the same board gives the same bytes. */
export function pcbFabricationZip(files: PcbFabFile[]): Uint8Array {
  const entries: Record<string, [Uint8Array, { mtime: Date }]> = {};
  const mtime = new Date(2000, 0, 1);
  for (const f of files) entries[f.name] = [strToU8(f.text), { mtime }];
  return zipSync(entries, { level: 6 });
}
