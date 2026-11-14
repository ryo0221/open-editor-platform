import { canonicalJson } from '@editor-platform/artifact-core';
import { cadTopologyLimits, faceNameFits, faceNameKey } from '@editor-platform/cad-core';
import {
  simulationLimits as L,
  simulationMetrics,
  studyMetrics,
  thermalConstraintKinds,
  thermalLoadKinds,
  type SimulationDiagnostic,
  type SimulationStudyKind,
  type SimulationDocument,
} from './model';

type Rec = Record<string, unknown>;
const reservedKeys = ['__proto__', 'constructor', 'prototype', 'toJSON'];
/** Owners of setting targets in `overrides`; reserved in the element ID namespace. */
export const settingOwners: readonly string[] = Object.freeze(['preparation', 'mesh']);
// Override choices index the analysis shape: at most femLimits.shapeFaces / shapeEdges.
const record = (v: unknown): v is Rec =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const codePoints = (s: string) => [...s].length;
/** Artifact-scoped stable ID: 1–128 code points, no controls, whitespace edges or reserved keys. */
export const simulationId = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  codePoints(v) <= L.idCodePoints &&
  v.trim() === v &&
  !/\p{Cc}/u.test(v) &&
  !reservedKeys.includes(v);
const text = (v: unknown): v is string =>
  typeof v === 'string' && codePoints(v) <= L.nameCodePoints && !/\p{Cc}/u.test(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const tuple = (v: unknown, n: number): v is number[] =>
  Array.isArray(v) && v.length === n && v.every(finite);
const within = (v: unknown, max: number): v is number => finite(v) && Math.abs(v) <= max;

/** Plain JSON data only, depth-limited before any domain traversal. */
function jsonShape(value: unknown): { code: string; path: string } | undefined {
  const seen = new Set<object>();
  function visit(v: unknown, depth: number, path: string): { code: string; path: string } | void {
    if (depth > L.jsonDepth) return { code: 'json-depth', path };
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number') return Number.isFinite(v) ? undefined : { code: 'number', path };
    if (typeof v !== 'object' || seen.has(v)) return { code: 'json-value', path };
    const isArray = Array.isArray(v);
    if (Object.getPrototypeOf(v) !== (isArray ? Array.prototype : Object.prototype))
      return { code: 'json-value', path };
    seen.add(v);
    // A hole in an array is skipped by every/forEach and becomes null in JSON: refuse it.
    if (isArray)
      for (let i = 0; i < v.length; i++)
        if (!Object.prototype.hasOwnProperty.call(v, i))
          return { code: 'json-value', path: `${path}.${i}` };
    for (const key of Reflect.ownKeys(v)) {
      if (isArray && key === 'length') continue;
      if (typeof key !== 'string' || reservedKeys.includes(key)) return { code: 'json-key', path };
      if (isArray && !/^(0|[1-9][0-9]*)$/.test(key)) return { code: 'json-key', path };
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      if (!('value' in d)) return { code: 'json-value', path: `${path}.${key}` };
      const r = visit(d.value, depth + 1, `${path}.${key}`);
      if (r) return r;
    }
    seen.delete(v);
  }
  return visit(value, 0, '$') ?? undefined;
}

const faceName = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every((s) => typeof s === 'string' && s.length > 0 && !/\p{Cc}/u.test(s)) &&
  faceNameFits(v);
/** One face name for a face, two (sorted) for an edge: cad-core's form of a name. */
const topoName = (v: unknown, kind: 'face' | 'edge') => {
  if (!Array.isArray(v) || !v.every(faceName) || v.length !== (kind === 'face' ? 1 : 2))
    return false;
  const keys = v.map(faceNameKey);
  return keys.every((k, i) => i === 0 || keys[i - 1]! <= k);
};

/**
 * Checks the shape and values of a document; returns every problem found (empty = valid). Whether
 * targets resolve on the source version is decided by evaluation (`checkSimulationSource` for
 * what the source document alone tells), never here.
 */
export function validateSimulation(value: unknown): SimulationDiagnostic[] {
  const out: SimulationDiagnostic[] = [];
  const add = (code: string, path: string, message = code) => out.push({ code, path, message });
  const shape = jsonShape(value);
  if (shape) {
    add(shape.code, shape.path, 'not plain JSON data');
    return out;
  }
  if (!record(value)) {
    add('simulation-document', '$');
    return out;
  }
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) {
    add('unsupported-schema', '$.schemaVersion', 'only schemas 1 and 2 are read');
    return out;
  }
  // R3j-2: schema 2 adds the other bodies and a target's body; schema 1 has neither.
  const schema2 = value.schemaVersion === 2;
  if (new TextEncoder().encode(canonicalJson(value)).length > L.contentBytes)
    add('content-too-large', '$');
  const keys = (v: Rec, path: string, names: string[], optional: string[] = []) => {
    let ok = true;
    for (const k of names)
      if (!Object.hasOwn(v, k)) {
        add('missing-key', `${path}.${k}`);
        ok = false;
      }
    for (const k of Object.keys(v))
      if (!names.includes(k) && !optional.includes(k)) {
        add('unknown-key', `${path}.${k}`);
        ok = false;
      }
    return ok;
  };
  if (
    !keys(
      value,
      '$',
      [
        'schemaVersion',
        'units',
        'name',
        'source',
        'materials',
        'materialId',
        'preparation',
        'mesh',
        'loads',
        'constraints',
        'studies',
      ],
      [
        'retiredIds',
        'overrides',
        'runs',
        ...(schema2 ? ['bodies', 'bonds', 'masses', 'spotWelds', 'sheets'] : []),
      ],
    )
  )
    return out;
  if (value.units !== 'mm-N-MPa-t-s') add('units', '$.units');
  if (!text(value.name)) add('name', '$.name');

  const ids = new Map<string, string>();
  const id = (v: unknown, path: string) => {
    if (!simulationId(v)) return add('id', path);
    // `preparation` and `mesh` name the settings that own targets (overrides), never an element.
    if (settingOwners.includes(v)) return add('reserved-id', path);
    const first = ids.get(v);
    if (first !== undefined) add('duplicate-id', path, `also at ${first}`);
    else ids.set(v, path);
  };
  const list = (v: unknown, path: string, max: number): unknown[] => {
    if (!Array.isArray(v)) {
      add('array', path);
      return [];
    }
    if (v.length > max) add('limit-exceeded', path);
    return v;
  };

  const src = value.source;
  if (!record(src) || !keys(src, '$.source', ['artifactId', 'versionId', 'contentHash', 'bodyId']))
    add('source', '$.source');
  else
    for (const k of ['artifactId', 'versionId', 'contentHash', 'bodyId'])
      if (!simulationId(src[k])) add('source', `$.source.${k}`);

  // R3j-2: the bodies a target may name (the source body is named by leaving `body` out).
  const bodyIds = new Set<string>();
  if (Object.hasOwn(value, 'bodies')) {
    const bodies = list(value.bodies, '$.bodies', L.bodies);
    if (!bodies.length) add('bodies-empty', '$.bodies', 'leave bodies out when there are none');
    bodies.forEach((b, i) => {
      const p = `$.bodies[${i}]`;
      if (!record(b) || !keys(b, p, ['bodyId', 'materialId'], ['idealisation']))
        return add('body', p);
      if (!simulationId(b.bodyId)) return add('body', `${p}.bodyId`);
      if (record(src) && b.bodyId === src.bodyId)
        add('body-is-source', `${p}.bodyId`, 'the source body is not listed again');
      else if (bodyIds.has(b.bodyId)) add('duplicate-body', `${p}.bodyId`);
      bodyIds.add(b.bodyId);
      if (b.materialId !== null && !simulationId(b.materialId)) add('value', `${p}.materialId`);
      if (b.idealisation !== undefined && b.idealisation !== 'solid' && b.idealisation !== 'shell')
        add('value', `${p}.idealisation`);
    });
  }
  const target = (v: unknown, path: string, kinds: ('face' | 'edge')[]) => {
    if (!record(v) || !keys(v, path, ['kind', 'ref'], schema2 ? ['body'] : []))
      return add('target', path);
    if (Object.hasOwn(v, 'body') && !bodyIds.has(v.body as string))
      add('target-body', `${path}.body`, 'not one of the analysed bodies');
    if (!kinds.includes(v.kind as 'face')) return add('target-kind', `${path}.kind`);
    const ref = v.ref;
    const rp = `${path}.ref`;
    if (!record(ref) || !keys(ref, rp, ['kind', 'featureId', 'name', 'hint'], ['select']))
      return add('reference', rp);
    const kind = v.kind as 'face' | 'edge';
    if (ref.kind !== kind) add('reference-kind', `${rp}.kind`);
    if (!simulationId(ref.featureId)) add('reference-feature', `${rp}.featureId`);
    if (!topoName(ref.name, kind)) add('reference-name', `${rp}.name`);
    if (Object.hasOwn(ref, 'select')) {
      const sel = ref.select;
      if (
        !record(sel) ||
        Object.keys(sel).join() !== 'adjacent' ||
        !Array.isArray(sel.adjacent) ||
        !sel.adjacent.length ||
        sel.adjacent.length > cadTopologyLimits.refsPerFeature ||
        !sel.adjacent.every((n) => topoName(n, kind)) ||
        new Set(sel.adjacent.map((n) => JSON.stringify(n))).size !== sel.adjacent.length
      )
        add('reference-select', `${rp}.select`);
    }
    const h = ref.hint;
    const hp = `${rp}.hint`;
    if (!record(h) || !keys(h, hp, ['centroid', 'size'], ['normal']))
      return add('reference-hint', hp);
    if (!tuple(h.centroid, 3) || !h.centroid.every((c) => within(c, L.lengthMm)))
      add('reference-hint', `${hp}.centroid`);
    if (
      Object.hasOwn(h, 'normal') &&
      (!tuple(h.normal, 3) || Math.abs(Math.hypot(...h.normal) - 1) > 1e-6)
    )
      add('reference-hint', `${hp}.normal`);
    if (!finite(h.size) || h.size < 0) add('reference-hint', `${hp}.size`);
  };
  const targets = (v: unknown, path: string, kinds: ('face' | 'edge')[], min = 1) => {
    const a = list(v, path, L.targetsPerItem);
    if (a.length < min) add('targets-empty', path);
    a.forEach((t, i) => target(t, `${path}[${i}]`, kinds));
    const forms = a.map((t) => canonicalJson(t));
    if (new Set(forms).size !== forms.length) add('duplicate-target', path);
  };
  const positive = (v: unknown, path: string, max: number) => {
    if (!finite(v) || v <= 0 || v > max) add('value', path);
  };

  list(value.materials, '$.materials', L.materials).forEach((m, i) => {
    const p = `$.materials[${i}]`;
    if (!record(m)) return add('material', p);
    if (
      !keys(
        m,
        p,
        ['id', 'name', 'model', 'youngsModulus', 'poissonsRatio', 'density'],
        ['conductivity'],
      )
    )
      return;
    id(m.id, `${p}.id`);
    if (!text(m.name)) add('name', `${p}.name`);
    if (m.model !== 'linear-elastic-isotropic') add('unsupported-material', `${p}.model`);
    positive(m.youngsModulus, `${p}.youngsModulus`, L.modulusMPa);
    // −1 < ν < 0.5 for a positive-definite isotropic material; 0.5 (incompressible) is refused.
    if (!finite(m.poissonsRatio) || m.poissonsRatio <= -1 || m.poissonsRatio >= 0.5)
      add('value', `${p}.poissonsRatio`);
    positive(m.density, `${p}.density`, L.densityMax);
    if (Object.hasOwn(m, 'conductivity'))
      positive(m.conductivity, `${p}.conductivity`, L.conductivity);
  });
  const materialIds = new Set(
    Array.isArray(value.materials) ? value.materials.filter(record).map((m) => m.id as string) : [],
  );
  if (value.materialId !== null && !materialIds.has(value.materialId as string))
    add('material-missing', '$.materialId');
  if (Array.isArray(value.bodies))
    value.bodies.forEach((b, i) => {
      if (record(b) && typeof b.materialId === 'string' && !materialIds.has(b.materialId))
        add('material-missing', `$.bodies[${i}].materialId`);
    });

  const prep = value.preparation;
  if (
    record(prep) &&
    keys(prep, '$.preparation', ['removeHolesBelow', 'removeFilletsBelow', 'removeFaces'])
  ) {
    for (const k of ['removeHolesBelow', 'removeFilletsBelow'])
      if (prep[k] !== null) positive(prep[k], `$.preparation.${k}`, L.lengthMm);
    const a = list(prep.removeFaces, '$.preparation.removeFaces', L.removeFaces);
    a.forEach((t, i) => target(t, `$.preparation.removeFaces[${i}]`, ['face']));
  } else if (!record(prep)) add('preparation', '$.preparation');

  const mesh = value.mesh;
  if (record(mesh) && keys(mesh, '$.mesh', ['order', 'size', 'minSize', 'grading', 'local'])) {
    if (mesh.order !== 2) add('unsupported-mesh-order', '$.mesh.order');
    positive(mesh.size, '$.mesh.size', L.lengthMm);
    positive(mesh.minSize, '$.mesh.minSize', L.lengthMm);
    if (finite(mesh.size) && finite(mesh.minSize) && mesh.minSize > mesh.size)
      add('mesh-size-order', '$.mesh.minSize');
    if (!finite(mesh.grading) || mesh.grading < 1 || mesh.grading > 10)
      add('value', '$.mesh.grading');
    list(mesh.local, '$.mesh.local', L.localSizes).forEach((l, i) => {
      const p = `$.mesh.local[${i}]`;
      if (!record(l)) return add('local-size', p);
      if (!keys(l, p, ['target', 'size'])) return;
      target(l.target, `${p}.target`, ['face', 'edge']);
      positive(l.size, `${p}.size`, L.lengthMm);
      if (finite(l.size) && finite(mesh.minSize) && l.size < mesh.minSize)
        add('mesh-size-order', `${p}.size`);
    });
  } else if (!record(mesh)) add('mesh', '$.mesh');

  const vec = (v: unknown, path: string, max: number, nonzero: boolean) => {
    if (!tuple(v, 3) || !v.every((c) => within(c, max))) return add('value', path);
    if (nonzero && Math.hypot(...v) === 0) add('value-zero', path);
  };
  const loadIds = new Set<string>();
  const loadKinds = new Map<string, unknown>();
  const constraintKinds = new Map<string, unknown>();
  list(value.loads, '$.loads', L.loads).forEach((l, i) => {
    const p = `$.loads[${i}]`;
    if (!record(l)) return add('load', p);
    if (l.kind === 'force') {
      if (!keys(l, p, ['id', 'name', 'kind', 'targets', 'force'])) return;
      targets(l.targets, `${p}.targets`, ['face', 'edge']);
      vec(l.force, `${p}.force`, L.forceN, true);
    } else if (l.kind === 'pressure') {
      if (!keys(l, p, ['id', 'name', 'kind', 'targets', 'pressure'])) return;
      targets(l.targets, `${p}.targets`, ['face']);
      if (!within(l.pressure, L.pressureMPa) || l.pressure === 0) add('value', `${p}.pressure`);
    } else if (l.kind === 'gravity') {
      if (!keys(l, p, ['id', 'name', 'kind', 'acceleration'])) return;
      vec(l.acceleration, `${p}.acceleration`, L.accelerationMmS2, true);
    } else if (l.kind === 'heat-flux') {
      if (!keys(l, p, ['id', 'name', 'kind', 'targets', 'flux'])) return;
      targets(l.targets, `${p}.targets`, ['face']);
      if (!within(l.flux, L.heatFlux) || l.flux === 0) add('value', `${p}.flux`);
    } else if (l.kind === 'convection') {
      if (!keys(l, p, ['id', 'name', 'kind', 'targets', 'coefficient', 'ambient'])) return;
      targets(l.targets, `${p}.targets`, ['face']);
      positive(l.coefficient, `${p}.coefficient`, L.filmCoefficient);
      if (!finite(l.ambient) || l.ambient < 0 || l.ambient > L.temperatureK)
        add('value', `${p}.ambient`);
    } else return add('unsupported-load', `${p}.kind`);
    loadKinds.set(l.id as string, l.kind);
    id(l.id, `${p}.id`);
    if (!text(l.name)) add('name', `${p}.name`);
    loadIds.add(l.id as string);
  });

  // R3j-4: each side of a bond is on one body.
  if (Object.hasOwn(value, 'bonds')) {
    const bonds = list(value.bonds, '$.bonds', L.bonds);
    if (!bonds.length) add('bonds-empty', '$.bonds', 'leave bonds out when there are none');
    bonds.forEach((b, i) => {
      const p = `$.bonds[${i}]`;
      if (!record(b)) return add('bond', p);
      if (!keys(b, p, ['id', 'name', 'follower', 'on', 'tolerance'], ['contact'])) return;
      if (Object.hasOwn(b, 'contact') && b.contact !== true) add('value', `${p}.contact`);
      id(b.id, `${p}.id`);
      if (!text(b.name)) add('name', `${p}.name`);
      for (const side of ['follower', 'on'] as const) {
        targets(b[side], `${p}.${side}`, ['face', 'edge']);
        if (Array.isArray(b[side])) {
          const on = new Set(
            (b[side] as unknown[]).map((t) => (record(t) ? (t.body ?? null) : null)),
          );
          if (on.size > 1) add('bond-side-body', `${p}.${side}`, 'each side is on one body');
        }
      }
      positive(b.tolerance, `${p}.tolerance`, L.lengthMm);
    });
  }

  // CR5a: masses on faces.
  if (Object.hasOwn(value, 'masses')) {
    const masses = list(value.masses, '$.masses', L.masses);
    if (!masses.length) add('masses-empty', '$.masses', 'leave masses out when there are none');
    masses.forEach((m, i) => {
      const p = `$.masses[${i}]`;
      if (!record(m)) return add('mass', p);
      if (!keys(m, p, ['id', 'name', 'targets', 'mass'])) return;
      id(m.id, `${p}.id`);
      if (!text(m.name)) add('name', `${p}.name`);
      targets(m.targets, `${p}.targets`, ['face']);
      positive(m.mass, `${p}.mass`, L.massT);
    });
  }

  // CR5b: spot weld rows, each flange one face of one body.
  if (Object.hasOwn(value, 'spotWelds')) {
    const welds = list(value.spotWelds, '$.spotWelds', L.spotWelds);
    if (!welds.length)
      add('spot-welds-empty', '$.spotWelds', 'leave spotWelds out when there are none');
    const rows = new Set<string>();
    welds.forEach((w, i) => {
      const p = `$.spotWelds[${i}]`;
      if (!record(w)) return add('spot-weld', p);
      if (!keys(w, p, ['id', 'name', 'weldId', 'follower', 'on', 'radiusMm', 'tolerance'])) return;
      id(w.id, `${p}.id`);
      if (!text(w.name)) add('name', `${p}.name`);
      if (!text(w.weldId) || !w.weldId) add('spot-weld-row', `${p}.weldId`);
      else if (rows.has(w.weldId as string))
        add('spot-weld-row', `${p}.weldId`, 'a CAD row is taken once');
      else rows.add(w.weldId as string);
      for (const side of ['follower', 'on'] as const) {
        targets(w[side], `${p}.${side}`, ['face']);
        if (!Array.isArray(w[side]) || (w[side] as unknown[]).length !== 1)
          add('spot-weld-flange', `${p}.${side}`, 'each flange is one face');
      }
      positive(w.radiusMm, `${p}.radiusMm`, L.weldRadiusMm);
      positive(w.tolerance, `${p}.tolerance`, L.lengthMm);
    });
  }

  // CR5e: sheet thicknesses, one per body.
  if (Object.hasOwn(value, 'sheets')) {
    const sheets = list(value.sheets, '$.sheets', L.sheets);
    if (!sheets.length) add('sheets-empty', '$.sheets', 'leave sheets out when there are none');
    const seen = new Set<string>();
    sheets.forEach((t, i) => {
      const p = `$.sheets[${i}]`;
      if (!record(t)) return add('sheet', p);
      if (!keys(t, p, ['bodyId', 'thicknessMm'])) return;
      if (!text(t.bodyId) || !t.bodyId) add('sheet', `${p}.bodyId`);
      else if (seen.has(t.bodyId)) add('sheet', `${p}.bodyId`, 'one thickness per body');
      else seen.add(t.bodyId);
      positive(t.thicknessMm, `${p}.thicknessMm`, L.sheetThicknessMm);
    });
  }

  const constraintIds = new Set<string>();
  list(value.constraints, '$.constraints', L.constraints).forEach((c, i) => {
    const p = `$.constraints[${i}]`;
    if (!record(c)) return add('constraint', p);
    if (c.kind === 'fixed') {
      if (!keys(c, p, ['id', 'name', 'kind', 'targets'])) return;
      targets(c.targets, `${p}.targets`, ['face', 'edge']);
    } else if (c.kind === 'roller') {
      if (!keys(c, p, ['id', 'name', 'kind', 'targets'])) return;
      targets(c.targets, `${p}.targets`, ['face']);
    } else if (c.kind === 'pinned') {
      if (!keys(c, p, ['id', 'name', 'kind', 'targets'])) return;
      targets(c.targets, `${p}.targets`, ['face', 'edge']);
    } else if (c.kind === 'displacement') {
      if (!keys(c, p, ['id', 'name', 'kind', 'targets', 'displacement'])) return;
      targets(c.targets, `${p}.targets`, ['face', 'edge']);
      const d = c.displacement;
      if (
        !Array.isArray(d) ||
        d.length !== 3 ||
        !d.every((x) => x === null || within(x, L.lengthMm)) ||
        d.every((x) => x === null)
      )
        add('value', `${p}.displacement`);
    } else if (c.kind === 'temperature') {
      if (!keys(c, p, ['id', 'name', 'kind', 'targets', 'temperature'])) return;
      targets(c.targets, `${p}.targets`, ['face', 'edge']);
      if (!finite(c.temperature) || c.temperature < 0 || c.temperature > L.temperatureK)
        add('value', `${p}.temperature`);
    } else return add('unsupported-constraint', `${p}.kind`);
    constraintKinds.set(c.id as string, c.kind);
    id(c.id, `${p}.id`);
    if (!text(c.name)) add('name', `${p}.name`);
    constraintIds.add(c.id as string);
  });

  list(value.studies, '$.studies', L.studies).forEach((s, i) => {
    const p = `$.studies[${i}]`;
    if (!record(s)) return add('study', p);
    const base = ['id', 'name', 'kind', 'loadIds', 'constraintIds', 'solver', 'convergence'];
    if (
      s.kind !== 'linear-static' &&
      s.kind !== 'modal' &&
      s.kind !== 'thermal' &&
      s.kind !== 'aero'
    )
      return add('unsupported-analysis', `${p}.kind`);
    // R3i-4: a structural study may say how it models the body; a thermal one is solid only.
    const optional =
      s.kind === 'thermal' || s.kind === 'aero'
        ? []
        : s.kind === 'modal'
          ? ['idealisation']
          : ['idealisation', 'test'];
    const required =
      s.kind === 'modal' ? [...base, 'modes'] : s.kind === 'aero' ? [...base, 'aero'] : base;
    if (!keys(s, p, required, optional)) return;
    // VS4a: a wind tunnel's air, browser cell and Host mesh; no loads or constraints.
    const aero = s.kind === 'aero';
    if (aero) {
      const a = s.aero;
      const q = `${p}.aero`;
      if (!record(a)) add('value', q);
      else if (
        keys(a, q, ['speed', 'yawDeg', 'ground', 'browserCellMm', 'host', 'referenceAreaMm2'])
      ) {
        if (!finite(a.speed) || a.speed < 1 || a.speed > L.aeroSpeed) add('value', `${q}.speed`);
        if (!within(a.yawDeg, L.aeroYawDeg)) add('value', `${q}.yawDeg`);
        if (a.ground !== 'moving' && a.ground !== 'fixed' && a.ground !== 'slip')
          add('value', `${q}.ground`);
        if (!finite(a.browserCellMm) || a.browserCellMm <= 0 || a.browserCellMm > L.aeroCellMm)
          add('value', `${q}.browserCellMm`);
        if (
          a.referenceAreaMm2 !== null &&
          (!finite(a.referenceAreaMm2) ||
            a.referenceAreaMm2 <= 0 ||
            a.referenceAreaMm2 > L.aeroReferenceAreaMm2)
        )
          add('value', `${q}.referenceAreaMm2`);
        const h = a.host;
        if (!record(h)) add('value', `${q}.host`);
        else if (keys(h, `${q}.host`, ['baseMm', 'level', 'iterations'])) {
          if (!finite(h.baseMm) || h.baseMm < L.aeroHostBaseMmMin || h.baseMm > L.aeroHostBaseMmMax)
            add('value', `${q}.host.baseMm`);
          if (
            !Number.isSafeInteger(h.level) ||
            (h.level as number) < 0 ||
            (h.level as number) > L.aeroHostLevel
          )
            add('value', `${q}.host.level`);
          if (
            !Number.isSafeInteger(h.iterations) ||
            (h.iterations as number) < 10 ||
            (h.iterations as number) > L.aeroHostIterations
          )
            add('value', `${q}.host.iterations`);
        }
      }
    }
    if (s.idealisation !== undefined && s.idealisation !== 'solid' && s.idealisation !== 'shell')
      add('value', `${p}.idealisation`);
    id(s.id, `${p}.id`);
    if (!text(s.name)) add('name', `${p}.name`);
    if (
      s.kind === 'modal' &&
      (!Number.isSafeInteger(s.modes) || (s.modes as number) < 1 || (s.modes as number) > L.modes)
    )
      add('value', `${p}.modes`);
    const refs = (v: unknown, path: string, known: Set<string>, max: number) => {
      const a = list(v, path, max);
      a.forEach((x, k) => {
        if (!known.has(x as string)) add('reference-missing', `${path}[${k}]`);
      });
      if (new Set(a).size !== a.length) add('duplicate-reference', path);
      return a;
    };
    const ls = refs(s.loadIds, `${p}.loadIds`, loadIds, L.loads);
    if (aero && ls.length) add('value', `${p}.loadIds`, 'a wind-tunnel study has no loads');
    // Natural modes have no loads.
    if (s.kind === 'modal' && ls.length) add('value', `${p}.loadIds`, 'a modal study has no loads');
    const cs = refs(s.constraintIds, `${p}.constraintIds`, constraintIds, L.constraints);
    if (aero && cs.length)
      add('value', `${p}.constraintIds`, 'a wind-tunnel study has no constraints');
    // R3h: a thermal study takes the thermal items only, the others none of them.
    const thermal = s.kind === 'thermal';
    ls.forEach((x, k) => {
      const kind = loadKinds.get(x as string);
      if (kind !== undefined && thermalLoadKinds.includes(kind as never) !== thermal)
        add('study-kind', `${p}.loadIds[${k}]`, `not a load of a ${String(s.kind)} study`);
    });
    cs.forEach((x, k) => {
      const kind = constraintKinds.get(x as string);
      if (kind !== undefined && thermalConstraintKinds.includes(kind as never) !== thermal)
        add(
          'study-kind',
          `${p}.constraintIds[${k}]`,
          `not a constraint of a ${String(s.kind)} study`,
        );
    });
    // A thermal study is held by a temperature or a convection; the others by a constraint.
    if (
      !aero &&
      !cs.length &&
      !(thermal && ls.some((x) => loadKinds.get(x as string) === 'convection'))
    )
      add('constraints-empty', `${p}.constraintIds`);
    // CR5c: a stiffness test names a pair of the study's displacements (torsion) or one of its
    // forces (bending).
    if (Object.hasOwn(s, 'test')) {
      const t = s.test;
      const tp = `${p}.test`;
      if (!record(t) || (t.kind !== 'torsion' && t.kind !== 'bending')) add('stiffness-test', tp);
      else if (keys(t, tp, t.kind === 'torsion' ? ['kind', 'left', 'right'] : ['kind', 'load'])) {
        const own = (
          x: unknown,
          path: string,
          ids: unknown[],
          kinds: Map<string, unknown>,
          k: string,
        ) => {
          if (typeof x !== 'string' || !ids.includes(x))
            add(
              'stiffness-test',
              path,
              `not one of the study's ${k === 'force' ? 'loads' : 'constraints'}`,
            );
          else if (kinds.get(x) !== k) add('stiffness-test', path, `not a ${k}`);
        };
        if (t.kind === 'torsion') {
          own(t.left, `${tp}.left`, cs, constraintKinds, 'displacement');
          own(t.right, `${tp}.right`, cs, constraintKinds, 'displacement');
          if (t.left === t.right) add('stiffness-test', `${tp}.right`, 'the same as left');
        } else own(t.load, `${tp}.load`, ls, loadKinds, 'force');
      }
    }
    const sv = s.solver;
    if (record(sv) && keys(sv, `${p}.solver`, ['tolerance', 'maxIterations'])) {
      if (!finite(sv.tolerance) || sv.tolerance <= 0 || sv.tolerance > 1e-3)
        add('value', `${p}.solver.tolerance`);
      if (
        !Number.isSafeInteger(sv.maxIterations) ||
        (sv.maxIterations as number) < 1 ||
        (sv.maxIterations as number) > L.maxIterations
      )
        add('value', `${p}.solver.maxIterations`);
    } else if (!record(sv)) add('solver', `${p}.solver`);
    const cv = s.convergence;
    if (record(cv) && keys(cv, `${p}.convergence`, ['levels', 'metrics', 'tolerance'])) {
      if (
        !Number.isSafeInteger(cv.levels) ||
        (cv.levels as number) < 1 ||
        (cv.levels as number) > L.convergenceLevels
      )
        add('value', `${p}.convergence.levels`);
      const ms = list(cv.metrics, `${p}.convergence.metrics`, simulationMetrics.length);
      // CR5c: a stiffness test also measures its stiffness.
      const allowed: readonly string[] = [
        ...studyMetrics[s.kind as SimulationStudyKind],
        ...(s.kind === 'linear-static' && Object.hasOwn(s, 'test') ? ['stiffness'] : []),
      ];
      ms.forEach((m, k) => {
        if (!allowed.includes(m as never)) add('value', `${p}.convergence.metrics[${k}]`);
      });
      if (new Set(ms).size !== ms.length) add('duplicate-reference', `${p}.convergence.metrics`);
      if (cv.levels !== 1 && !ms.length) add('value', `${p}.convergence.metrics`);
      if (!finite(cv.tolerance) || cv.tolerance <= 0 || cv.tolerance > 0.5)
        add('value', `${p}.convergence.tolerance`);
    } else if (!record(cv)) add('convergence', `${p}.convergence`);
  });

  if (Object.hasOwn(value, 'overrides')) {
    // Targets each owner holds, by canonical form.
    const owned = new Map<string, Set<string>>();
    const own = (owner: string, ts: unknown) => {
      const set = owned.get(owner) ?? new Set<string>();
      if (Array.isArray(ts)) for (const t of ts) set.add(canonicalJson(t));
      owned.set(owner, set);
    };
    for (const x of [
      ...(Array.isArray(value.loads) ? value.loads : []),
      ...(Array.isArray(value.constraints) ? value.constraints : []),
    ])
      if (record(x) && typeof x.id === 'string') own(x.id, x.targets);
    if (Array.isArray(value.masses))
      for (const m of value.masses) if (record(m) && typeof m.id === 'string') own(m.id, m.targets);
    if (Array.isArray(value.spotWelds))
      for (const w of value.spotWelds)
        if (record(w) && typeof w.id === 'string') {
          own(w.id, w.follower);
          own(w.id, w.on);
        }
    if (Array.isArray(value.bonds))
      for (const b of value.bonds)
        if (record(b) && typeof b.id === 'string') {
          own(b.id, b.follower);
          own(b.id, b.on);
        }
    if (record(prep)) own('preparation', prep.removeFaces);
    if (record(mesh) && Array.isArray(mesh.local))
      own(
        'mesh',
        mesh.local.map((l) => (record(l) ? l.target : null)),
      );
    const seen = new Set<string>();
    list(value.overrides, '$.overrides', L.overrides).forEach((o, i) => {
      const p = `$.overrides[${i}]`;
      if (!record(o)) return add('override', p);
      if (!keys(o, p, ['owner', 'target', 'versionId', 'preparationHash', 'kernelBuild', 'chosen']))
        return;
      for (const k of ['versionId', 'preparationHash', 'kernelBuild'])
        if (!simulationId(o[k])) add('override', `${p}.${k}`);
      const form = canonicalJson(o.target);
      if (typeof o.owner !== 'string' || !owned.get(o.owner)?.has(form))
        add('override-target', `${p}.target`, 'not a target of its owner');
      const c = list(o.chosen, `${p}.chosen`, L.overrideChoices);
      if (
        !c.length ||
        !c.every(
          (x) =>
            Number.isSafeInteger(x) &&
            (x as number) >= 0 &&
            (x as number) < (record(o.target) && o.target.kind === 'edge' ? 262_144 : 65_536),
        ) ||
        new Set(c).size !== c.length
      )
        add('override', `${p}.chosen`);
      const key = canonicalJson([o.owner, o.target, o.versionId, o.preparationHash, o.kernelBuild]);
      if (seen.has(key)) add('duplicate-override', p);
      seen.add(key);
    });
  }
  if (Object.hasOwn(value, 'runs')) {
    const studyKinds = new Map<string, SimulationStudyKind>(
      Array.isArray(value.studies)
        ? value.studies
            .filter(record)
            .map((x): [string, SimulationStudyKind] => [
              x.id as string,
              x.kind === 'modal' || x.kind === 'thermal' || x.kind === 'aero'
                ? x.kind
                : 'linear-static',
            ])
        : [],
    );
    const studyIds = new Set(studyKinds.keys());
    // CR5c: the studies with a stiffness test, whose levels may record the stiffness.
    const tests = new Set(
      Array.isArray(value.studies)
        ? value.studies
            .filter((x) => record(x) && x.kind === 'linear-static' && Object.hasOwn(x, 'test'))
            .map((x) => (x as Rec).id)
        : [],
    );
    const runText = (v: unknown): v is string =>
      typeof v === 'string' && codePoints(v) <= L.runTextCodePoints && !/\p{Cc}/u.test(v);
    const checksOf = (kind: SimulationStudyKind | undefined) =>
      kind === 'modal'
        ? ['mapping', 'mass', 'quality', 'solver', 'orthogonality']
        : kind === 'aero'
          ? ['surface', 'solver']
          : ['mapping', 'load', 'quality', 'solver', 'equilibrium'];
    const studied = new Set<string>();
    const runs = list(value.runs, '$.runs', L.studies);
    if (!runs.length) add('runs', '$.runs', 'absent when there are none');
    runs.forEach((r, i) => {
      const p = `$.runs[${i}]`;
      if (!record(r)) return add('run', p);
      if (!keys(r, p, ['id', 'studyId', 'inputs', 'levels', 'checks', 'status', 'reasons'])) return;
      id(r.id, `${p}.id`);
      if (typeof r.studyId !== 'string' || !studyIds.has(r.studyId))
        add('reference-missing', `${p}.studyId`);
      else if (studied.has(r.studyId)) add('duplicate-run', `${p}.studyId`);
      else studied.add(r.studyId);
      const kind = typeof r.studyId === 'string' ? studyKinds.get(r.studyId) : undefined;
      const checkNames = checksOf(kind);
      const metricNames = studyMetrics[kind ?? 'linear-static'];
      const inputs = r.inputs;
      const inputKeys = [
        'simulationHash',
        'cadContentHash',
        'kernelBuild',
        'mesherBuild',
        'solverBuild',
      ];
      if (!record(inputs)) add('run', `${p}.inputs`);
      else if (keys(inputs, `${p}.inputs`, inputKeys))
        for (const k of inputKeys) if (!simulationId(inputs[k])) add('run', `${p}.inputs.${k}`);
      const levels = list(r.levels, `${p}.levels`, L.convergenceLevels);
      if (!levels.length) add('run', `${p}.levels`);
      levels.forEach((l, k) => {
        const q = `${p}.levels[${k}]`;
        if (!record(l)) return add('run', q);
        if (!keys(l, q, ['size', 'nodes', 'elements', 'metrics'])) return;
        if (!within(l.size, L.lengthMm) || l.size <= 0) add('value', `${q}.size`);
        for (const n of ['nodes', 'elements'] as const)
          if (!Number.isSafeInteger(l[n]) || (l[n] as number) <= 0) add('value', `${q}.${n}`);
        const m = l.metrics;
        if (!record(m)) return add('run', `${q}.metrics`);
        // Exactly the metrics of its study's kind (and a test's stiffness).
        const tested = tests.has(r.studyId);
        if (keys(m, `${q}.metrics`, [...metricNames], tested ? ['stiffness'] : [])) {
          for (const name of metricNames)
            if (!finite(m[name])) add('value', `${q}.metrics.${name}`);
          if (Object.hasOwn(m, 'stiffness') && !finite(m.stiffness))
            add('value', `${q}.metrics.stiffness`);
        }
      });
      const checks = list(r.checks, `${p}.checks`, L.runChecks);
      const named = new Set<string>();
      checks.forEach((c, k) => {
        const q = `${p}.checks[${k}]`;
        if (!record(c)) return add('run', q);
        if (!keys(c, q, ['name', 'pass', 'detail'])) return;
        if (typeof c.name !== 'string' || !checkNames.includes(c.name) || named.has(c.name))
          add('run', `${q}.name`);
        else named.add(c.name);
        if (typeof c.pass !== 'boolean') add('run', `${q}.pass`);
        if (!runText(c.detail)) add('run', `${q}.detail`);
      });
      // A failed run leaves no result to record.
      if (r.status !== 'verified' && r.status !== 'reference') add('run', `${p}.status`);
      const reasons = list(r.reasons, `${p}.reasons`, L.runReasons);
      reasons.forEach((x, k) => {
        if (!runText(x)) add('run', `${p}.reasons[${k}]`);
      });
      // VS4a: a wind tunnel's result is for reference in V1.
      if (kind === 'aero' && r.status === 'verified')
        add('run', `${p}.status`, 'a wind-tunnel run is for reference');
      if (r.status === 'verified' && reasons.length)
        add('run', `${p}.reasons`, 'a verified run has none');
      // Verified needs every check passed over at least two levels (状態の決め方).
      if (
        r.status === 'verified' &&
        (levels.length < 2 ||
          !checkNames.every((n) =>
            checks.some((c) => record(c) && c.name === n && c.pass === true),
          ))
      )
        add('run', `${p}.status`, 'verified needs every check passed over two levels or more');
    });
  }
  if (Object.hasOwn(value, 'retiredIds')) {
    const r = list(value.retiredIds, '$.retiredIds', L.retiredIds);
    r.forEach((x, i) => {
      if (!simulationId(x)) add('id', `$.retiredIds[${i}]`);
      else if (ids.has(x)) add('retired-id-in-use', `$.retiredIds[${i}]`);
    });
    if (new Set(r).size !== r.length) add('duplicate-id', '$.retiredIds');
  }
  return out;
}

export function isSimulationDocument(value: unknown): value is SimulationDocument {
  return validateSimulation(value).length === 0;
}
