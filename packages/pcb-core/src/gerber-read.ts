import type { Vec2 } from './model';

/**
 * A Gerber and Excellon reader for tests (PB6): it reads what `pcbFabricationFiles` writes
 * (format 4.6 mm, C/R/O apertures, lines, G75 arcs, regions, X2 attributes), so a written file
 * can be turned back into shapes and compared with the board. It is not a general reader:
 * anything else is refused with an error naming the command.
 */

export interface GerberAperture {
  template: 'C' | 'R' | 'O';
  params: number[];
  function?: string;
}
/** A side of a region or a draw: a line, or an arc about `center` (`ccw` its turn). */
export interface GerberSegment {
  from: Vec2;
  to: Vec2;
  center?: Vec2;
  ccw?: boolean;
}
export type GerberObject =
  | { kind: 'flash'; aperture: GerberAperture; at: Vec2; attrs: Record<string, string[]> }
  | {
      kind: 'draw';
      aperture: GerberAperture;
      segment: GerberSegment;
      attrs: Record<string, string[]>;
    }
  | {
      kind: 'region';
      contour: GerberSegment[];
      function?: string;
      attrs: Record<string, string[]>;
    };

export interface GerberImage {
  fileAttrs: Record<string, string[]>;
  objects: GerberObject[];
}

const unescape = (s: string) =>
  s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
function attribute(text: string): [string, string[]] {
  const [name, ...values] = text.split(',');
  return [name, values.map(unescape)];
}

export function readGerber(text: string): GerberImage {
  const fileAttrs: Record<string, string[]> = {};
  const apertureDict: Record<string, string[]> = {};
  const objectDict: Record<string, string[]> = {};
  const apertures = new Map<number, GerberAperture>();
  const objects: GerberObject[] = [];
  let fs = false;
  let current: GerberAperture | undefined;
  let mode: 'G01' | 'G02' | 'G03' = 'G01';
  let multi = false;
  let pos: Vec2 = [0, 0];
  let region: GerberSegment[] | undefined;
  let ended = false;
  const num = (s: string) => {
    if (!fs) throw new Error('gerber:no-format');
    return Number(s) / 1e6;
  };
  const extended = (cmd: string) => {
    if (cmd.startsWith('FS')) {
      if (cmd !== 'FSLAX46Y46') throw new Error(`gerber:format:${cmd}`);
      fs = true;
    } else if (cmd.startsWith('MO')) {
      if (cmd !== 'MOMM') throw new Error(`gerber:units:${cmd}`);
    } else if (cmd === 'LPD') {
      /* dark polarity, the only one written */
    } else if (cmd.startsWith('TF')) {
      const [k, v] = attribute(cmd.slice(2));
      fileAttrs[k] = v;
    } else if (cmd.startsWith('TA')) {
      const [k, v] = attribute(cmd.slice(2));
      apertureDict[k] = v;
    } else if (cmd.startsWith('TO')) {
      const [k, v] = attribute(cmd.slice(2));
      objectDict[k] = v;
    } else if (cmd.startsWith('TD')) {
      const k = cmd.slice(2);
      for (const d of [apertureDict, objectDict])
        for (const key of Object.keys(d)) if (!k || key === k) delete d[key];
    } else if (cmd.startsWith('AD')) {
      const m = /^ADD(\d+)([CRO]),([\d.]+)(?:X([\d.]+))?$/.exec(cmd);
      if (!m) throw new Error(`gerber:aperture:${cmd}`);
      const params = [Number(m[3]), ...(m[4] ? [Number(m[4])] : [])];
      const fn = apertureDict['.AperFunction'];
      apertures.set(Number(m[1]), {
        template: m[2] as 'C' | 'R' | 'O',
        params,
        ...(fn ? { function: fn.join(',') } : {}),
      });
    } else throw new Error(`gerber:extended:${cmd}`);
  };
  const attrs = () => Object.fromEntries(Object.entries(objectDict).map(([k, v]) => [k, [...v]]));
  const word = (raw: string) => {
    let cmd = raw;
    if (cmd === 'M02') {
      ended = true;
      return;
    }
    const g = /^G(\d+)/.exec(cmd);
    if (g) {
      cmd = cmd.slice(g[0].length);
      const code = Number(g[1]);
      if (code === 1 || code === 2 || code === 3) mode = `G0${code}` as typeof mode;
      else if (code === 75) multi = true;
      else if (code === 36) region = [];
      else if (code === 37) {
        if (!region) throw new Error('gerber:region-end');
        const fn = apertureDict['.AperFunction'];
        objects.push({
          kind: 'region',
          contour: region,
          ...(fn ? { function: fn.join(',') } : {}),
          attrs: attrs(),
        });
        region = undefined;
      } else throw new Error(`gerber:g:${code}`);
      if (!cmd) return;
    }
    const sel = /^D(\d+)$/.exec(cmd);
    if (sel && Number(sel[1]) >= 10) {
      current = apertures.get(Number(sel[1]));
      if (!current) throw new Error(`gerber:aperture-missing:${sel[1]}`);
      return;
    }
    const m = /^(?:X(-?\d+))?(?:Y(-?\d+))?(?:I(-?\d+))?(?:J(-?\d+))?D0([123])$/.exec(cmd);
    if (!m) throw new Error(`gerber:word:${raw}`);
    const to: Vec2 = [
      m[1] !== undefined ? num(m[1]) : pos[0],
      m[2] !== undefined ? num(m[2]) : pos[1],
    ];
    const op = Number(m[5]);
    if (op === 2) {
      pos = to;
      return;
    }
    if (op === 3) {
      if (!current || region) throw new Error('gerber:flash');
      objects.push({ kind: 'flash', aperture: current, at: to, attrs: attrs() });
      pos = to;
      return;
    }
    let segment: GerberSegment = { from: pos, to };
    if (mode !== 'G01') {
      if (!multi) throw new Error('gerber:single-quadrant');
      const i = m[3] !== undefined ? num(m[3]) : 0;
      const j = m[4] !== undefined ? num(m[4]) : 0;
      segment = { from: pos, to, center: [pos[0] + i, pos[1] + j], ccw: mode === 'G03' };
    }
    if (region) region.push(segment);
    else {
      if (!current) throw new Error('gerber:draw');
      objects.push({ kind: 'draw', aperture: current, segment, attrs: attrs() });
    }
    pos = to;
  };
  let i = 0;
  const src = text.replace(/\r/g, '');
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n' || ch === ' ') {
      i++;
      continue;
    }
    if (ch === '%') {
      const end = src.indexOf('%', i + 1);
      if (end < 0) throw new Error('gerber:unterminated');
      for (const c of src.slice(i + 1, end).split('*')) if (c.trim()) extended(c.trim());
      i = end + 1;
      continue;
    }
    const end = src.indexOf('*', i);
    if (end < 0) throw new Error('gerber:unterminated');
    word(src.slice(i, end).trim());
    i = end + 1;
  }
  if (!ended) throw new Error('gerber:no-end');
  return { fileAttrs, objects };
}

/** Signed sweep of an arc segment, full circle when its ends meet. */
function sweepOf(s: GerberSegment): number {
  const c = s.center!;
  const a0 = Math.atan2(s.from[1] - c[1], s.from[0] - c[0]);
  const a1 = Math.atan2(s.to[1] - c[1], s.to[0] - c[0]);
  let d = a1 - a0;
  if (s.ccw) {
    while (d <= 1e-12) d += 2 * Math.PI;
  } else while (d >= -1e-12) d -= 2 * Math.PI;
  return d;
}

/** Signed area of a closed contour, exact along its arcs (counter-clockwise positive). */
export function gerberContourArea(contour: GerberSegment[]): number {
  let a = 0;
  for (const s of contour) {
    a += (s.from[0] * s.to[1] - s.to[0] * s.from[1]) / 2;
    if (s.center) {
      const r = Math.hypot(s.from[0] - s.center[0], s.from[1] - s.center[1]);
      const t = sweepOf(s);
      a += (r * r * (t - Math.sin(t))) / 2;
    }
  }
  return a;
}

/** Area of a flashed aperture. */
export function gerberApertureArea(ap: GerberAperture): number {
  const [w, h = w] = ap.params;
  if (ap.template === 'C') return (Math.PI * w * w) / 4;
  if (ap.template === 'R') return w * h;
  const r = Math.min(w, h) / 2;
  return w * h - (4 - Math.PI) * r * r;
}

export interface ExcellonImage {
  plated?: boolean;
  tools: Map<number, number>;
  hits: { tool: number; drillMm: number; at: Vec2 }[];
}

/** Reads an Excellon file as written by `pcbFabricationFiles` (mm, decimal coordinates). */
export function readExcellon(text: string): ExcellonImage {
  const tools = new Map<number, number>();
  const hits: ExcellonImage['hits'] = [];
  let header = true;
  let metric = false;
  let tool = 0;
  let plated: boolean | undefined;
  let ended = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(';')) {
      const m = /TF\.FileFunction,(Plated|NonPlated)/.exec(line);
      if (m) plated = m[1] === 'Plated';
      continue;
    }
    if (header) {
      if (line === 'M48' || line === 'FMAT,2') continue;
      if (line === 'METRIC') metric = true;
      else if (line === '%') header = false;
      else {
        const t = /^T(\d+)C([\d.]+)$/.exec(line);
        if (!t) throw new Error(`excellon:header:${line}`);
        tools.set(Number(t[1]), Number(t[2]));
      }
      continue;
    }
    if (line === 'G90' || line === 'G05') continue;
    if (line === 'M30') {
      ended = true;
      continue;
    }
    const t = /^T(\d+)$/.exec(line);
    if (t) {
      tool = Number(t[1]);
      if (!tools.has(tool)) throw new Error(`excellon:tool:${tool}`);
      continue;
    }
    const h = /^X(-?[\d.]+)Y(-?[\d.]+)$/.exec(line);
    if (!h || !tool) throw new Error(`excellon:line:${line}`);
    hits.push({ tool, drillMm: tools.get(tool)!, at: [Number(h[1]), Number(h[2])] });
  }
  if (!metric) throw new Error('excellon:units');
  if (!ended) throw new Error('excellon:no-end');
  return { ...(plated !== undefined ? { plated } : {}), tools, hits };
}
