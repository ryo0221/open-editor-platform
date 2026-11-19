import {
  ExplicitError,
  ExplicitSolver,
  type ExplicitModel,
  type ExplicitResult,
  type ExplicitSettings,
} from './explicit';

/**
 * VS8a (docs/cad/vehicle-simulation.md, VS8・VS-U4): a crash run on a compute Host. The browser
 * sends the explicit model and settings as JSON numbers (`crashJobOf`); the Host checks the job
 * again (`checkCrashJob`: known keys only, finite numbers, whole indices, sizes within
 * `crashJobLimits`), runs the same solver in Node (`runCrashJob`) and sends the result back as
 * JSON (`crashResultJson`), which the browser reads into typed arrays (`readCrashResult`). The
 * solver checks the model itself (indices, materials, …) and fails a job it refuses.
 */
export interface CrashJob {
  kind: 'crash';
  model: Record<string, unknown>;
  settings: ExplicitSettings;
}

/** The Host's share (VS-U10: 4 cores, 15 GB, one job at a time). */
export const crashJobLimits = Object.freeze({
  nodes: 400_000,
  shells: 400_000,
  beams: 50_000,
  welds: 20_000,
  /** VS8c: node ties (a bond's seams). */
  ties: 200_000,
  rigidBodies: 2_000,
  masses: 100_000,
  materials: 256,
  /** s */
  endTime: 0.3,
  frames: 300,
  historyNodes: 64,
  /** A run longer than this is stopped (ms). */
  timeoutMs: 60 * 60_000,
});

export class CrashJobError extends Error {
  constructor(message: string) {
    super(`crash-job-invalid: ${message}`);
    this.name = 'CrashJobError';
  }
}

const typed = [
  'nodes',
  'shells',
  'thickness',
  'shellMaterial',
  'fixed',
  'velocity',
  'rotation',
  'beams',
  'beamSection',
  'beamMaterial',
  'beamOrientation',
  'shellPart',
  'ties',
] as const;
const plain = [
  'materials',
  'masses',
  'forces',
  'gravity',
  'sections',
  'rigidBodies',
  'welds',
  'contact',
  'walls',
  'poles',
] as const;

/** The job of a model and its settings, as JSON numbers. */
export function crashJobOf(model: ExplicitModel, settings: ExplicitSettings): CrashJob {
  const out: Record<string, unknown> = {};
  for (const k of typed) {
    const v = model[k];
    if (v !== undefined) out[k] = Array.from(v);
  }
  for (const k of plain) {
    const v = model[k];
    if (v !== undefined) out[k] = v;
  }
  return { kind: 'crash', model: out, settings: { ...settings } };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The model and settings of a job, checked: only the model's and the settings' own keys, numbers
 * that are finite (whole where they are indices or counts), sizes within `limits`. What the
 * solver checks itself (indices in range, a material per shell, …) is left to it.
 */
export function checkCrashJob(
  value: unknown,
  limits: typeof crashJobLimits = crashJobLimits,
): { model: ExplicitModel; settings: ExplicitSettings } {
  const bad = (m: string): never => {
    throw new CrashJobError(m);
  };
  if (!isRecord(value) || value.kind !== 'crash') bad('not a crash job');
  const v = value as Record<string, unknown>;
  for (const k of Object.keys(v))
    if (!['kind', 'model', 'settings'].includes(k)) bad(`unknown key ${k}`);
  if (!isRecord(v.model)) bad('no model');
  const m = v.model as Record<string, unknown>;
  for (const k of Object.keys(m))
    if (!(typed as readonly string[]).includes(k) && !(plain as readonly string[]).includes(k))
      bad(`unknown model key ${k}`);
  // `below`: whole numbers from 0 under it (indices, and what the typed array holds), so none
  // wraps when it is converted.
  const numbers = (k: string, max: number, below?: number): number[] => {
    const a = m[k];
    if (!Array.isArray(a)) return bad(`${k} is not a list`);
    if (a.length > max) bad(`${k} has more than ${max} values`);
    for (const x of a)
      if (!finite(x) || (below !== undefined && (!Number.isInteger(x) || x < 0 || x >= below)))
        bad(`${k} holds a bad number`);
    return a as number[];
  };
  const u16 = 65_536;
  const L = limits;
  const nodes = numbers('nodes', 3 * L.nodes);
  if (nodes.length % 3) bad('nodes are not x, y, z');
  const nn = nodes.length / 3;
  const shells = numbers('shells', 4 * L.shells, nn);
  if (shells.length % 4) bad('shells are not four nodes each');
  const ns = shells.length / 4;
  const model: ExplicitModel = {
    nodes: Float64Array.from(nodes),
    shells: Uint32Array.from(shells),
    thickness: Float64Array.from(numbers('thickness', ns)),
    shellMaterial: Uint16Array.from(numbers('shellMaterial', ns, u16)),
    materials: [],
  };
  const opt = <T>(k: string, read: () => T) => (m[k] === undefined ? undefined : read());
  const fixed = opt('fixed', () => Uint8Array.from(numbers('fixed', nn, 64)));
  if (fixed) model.fixed = fixed;
  const velocity = opt('velocity', () => Float64Array.from(numbers('velocity', 3 * nn)));
  if (velocity) model.velocity = velocity;
  const rotation = opt('rotation', () => Float64Array.from(numbers('rotation', 3 * nn)));
  if (rotation) model.rotation = rotation;
  const beams = opt('beams', () => Uint32Array.from(numbers('beams', 2 * L.beams, nn)));
  if (beams) {
    model.beams = beams;
    const nb = beams.length / 2;
    model.beamSection = Uint16Array.from(numbers('beamSection', nb, u16));
    model.beamMaterial = Uint16Array.from(numbers('beamMaterial', nb, u16));
    const o = opt('beamOrientation', () => Float64Array.from(numbers('beamOrientation', 3 * nb)));
    if (o) model.beamOrientation = o;
  }
  const part = opt('shellPart', () => Uint16Array.from(numbers('shellPart', ns, u16)));
  if (part) model.shellPart = part;
  const ties = opt('ties', () => Uint32Array.from(numbers('ties', 2 * L.ties, nn)));
  if (ties) {
    if (ties.length % 2) bad('ties are not node pairs');
    model.ties = ties;
  }
  // The plain parts: JSON of numbers (and flags) only, within their sizes; their shapes are the
  // solver's.
  const sized: Record<string, number> = {
    materials: L.materials,
    masses: L.masses,
    forces: L.masses,
    sections: L.materials,
    rigidBodies: L.rigidBodies,
    welds: L.welds,
    walls: 64,
    poles: 64,
  };
  const onlyNumbers = (x: unknown, depth: number): boolean =>
    depth > 6
      ? false
      : finite(x) ||
        typeof x === 'boolean' ||
        (Array.isArray(x) &&
          x.length <= 3 * L.nodes &&
          x.every((y) => onlyNumbers(y, depth + 1))) ||
        (isRecord(x) &&
          Object.keys(x).every((k) => /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(k)) &&
          Object.values(x).every((y) => onlyNumbers(y, depth + 1)));
  for (const k of plain) {
    if (m[k] === undefined) continue;
    const x = m[k];
    if (!onlyNumbers(x, 0)) bad(`${k} holds something else than numbers and flags`);
    if (k in sized) {
      if (!Array.isArray(x)) bad(`${k} is not a list`);
      if ((x as unknown[]).length > sized[k]!) bad(`${k} has more than ${sized[k]}`);
    }
    (model as unknown as Record<string, unknown>)[k] = x;
  }
  if (!Array.isArray(model.materials) || !model.materials.length) bad('no materials');
  if (!isRecord(v.settings)) bad('no settings');
  const s = v.settings as Record<string, unknown>;
  const keys = [
    'endTime',
    'stepScale',
    'hourglass',
    'thicknessPoints',
    'frameEvery',
    'minStep',
    'massScalingShare',
    'historyNodes',
    'historyEvery',
  ];
  for (const k of Object.keys(s)) if (!keys.includes(k)) bad(`unknown setting ${k}`);
  for (const k of ['endTime', 'stepScale', 'hourglass', 'thicknessPoints', 'frameEvery'])
    if (!finite(s[k])) bad(`${k} is not a number`);
  for (const k of ['minStep', 'massScalingShare', 'historyEvery'])
    if (s[k] !== undefined && !finite(s[k])) bad(`${k} is not a number`);
  const endTime = s.endTime as number;
  if (!(endTime > 0) || endTime > L.endTime) bad(`the end time is not in (0, ${L.endTime}] s`);
  if (!((s.frameEvery as number) > 0) || endTime / (s.frameEvery as number) > L.frames)
    bad(`more than ${L.frames} frames`);
  const history = s.historyNodes;
  if (
    history !== undefined &&
    (!Array.isArray(history) ||
      history.length > L.historyNodes ||
      !history.every((x) => finite(x) && Number.isInteger(x) && x >= 0 && x < nn))
  )
    bad('bad history nodes');
  return { model, settings: s as unknown as ExplicitSettings };
}

/**
 * Runs a checked job to its end time, reporting the solved time every `chunk` steps; `stop`
 * (checked between chunks) cancels it. The solver's refusals come back as `ExplicitError`.
 */
export function runCrashJob(
  job: { model: ExplicitModel; settings: ExplicitSettings },
  progress?: (time: number, endTime: number) => void,
  stop?: () => boolean,
  chunk = 2_000,
): ExplicitResult {
  const solver = new ExplicitSolver(job.model, job.settings);
  while (!solver.done) {
    if (stop?.()) throw new ExplicitError('cancelled', 'the run was cancelled');
    solver.advance(chunk);
    progress?.(solver.time, job.settings.endTime);
  }
  return solver.result();
}

/** A result as JSON (typed arrays as lists). */
export function crashResultJson(r: ExplicitResult): string {
  return JSON.stringify(r, (_k, v: unknown) =>
    ArrayBuffer.isView(v) && !(v instanceof DataView) ? Array.from(v as Float64Array) : v,
  );
}

/** A result read back from the Host's JSON into typed arrays, its shape checked. */
export function readCrashResult(text: string): ExplicitResult {
  const bad = (m: string): never => {
    throw new RangeError(`the crash result has ${m}`);
  };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return bad('no JSON');
  }
  if (!isRecord(v)) return bad('no object');
  const list = (x: unknown, what: string): number[] => {
    if (!Array.isArray(x) || !x.every(finite)) bad(`a bad ${what}`);
    return x as number[];
  };
  for (const k of ['step', 'steps', 'addedMass', 'addedMassShare'])
    if (!finite(v[k])) bad(`no ${k}`);
  if (!Array.isArray(v.frames) || !Array.isArray(v.energies) || !Array.isArray(v.history))
    bad('no frames, energies or history');
  if (!Array.isArray(v.barriers) || !Array.isArray(v.checks)) bad('no barriers or checks');
  const frames = (v.frames as unknown[]).map((f) => {
    if (!isRecord(f) || !finite(f.time)) return bad('a bad frame');
    return {
      time: f.time,
      displacement: Float32Array.from(list(f.displacement, 'frame displacement')),
      plasticStrain: Float32Array.from(list(f.plasticStrain, 'frame plastic strain')),
      erased: Uint8Array.from(list(f.erased, 'frame erasure')),
    };
  });
  const history = (v.history as unknown[]).map((h) => {
    if (!isRecord(h) || !finite(h.node)) return bad('a bad history');
    return {
      node: h.node,
      time: Float64Array.from(list(h.time, 'history time')),
      displacement: Float64Array.from(list(h.displacement, 'history displacement')),
      velocity: Float64Array.from(list(h.velocity, 'history velocity')),
    };
  });
  const barriers = (v.barriers as unknown[]).map((b) => {
    if (!isRecord(b) || (b.kind !== 'wall' && b.kind !== 'pole') || !finite(b.index))
      return bad('a bad barrier');
    return {
      kind: b.kind as 'wall' | 'pole',
      index: b.index,
      time: Float64Array.from(list(b.time, 'barrier time')),
      force: Float64Array.from(list(b.force, 'barrier force')),
    };
  });
  for (const e of v.energies as unknown[])
    if (
      !isRecord(e) ||
      !['time', 'kinetic', 'internal', 'hourglass', 'external', 'contact'].every((k) =>
        finite(e[k]),
      )
    )
      bad('a bad energy');
  const names = ['energy-balance', 'hourglass-energy', 'mass-scaling'];
  for (const c of v.checks as unknown[])
    if (!isRecord(c) || !names.includes(c.name as string) || typeof c.pass !== 'boolean')
      bad('a bad check');
  return {
    step: v.step as number,
    steps: v.steps as number,
    frames,
    addedMass: v.addedMass as number,
    addedMassShare: v.addedMassShare as number,
    energies: v.energies as ExplicitResult['energies'],
    history,
    barriers,
    checks: (v.checks as ExplicitResult['checks']).map((c) => ({
      name: c.name,
      pass: c.pass,
      detail: String(c.detail ?? '').slice(0, 500),
    })),
  };
}
