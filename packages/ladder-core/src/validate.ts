import {
  ladderCoilKinds,
  ladderCompareOps,
  ladderContactKinds,
  ladderCounterTypes,
  ladderLimits,
  ladderRoles,
  ladderTimerTypes,
  ladderTypes,
  type LadderDocument,
  type LadderVariable,
} from './model';

/**
 * Strict validation of a ladder program (docs/cad/circuit-simulation.md, SL6). Errors make the
 * program unusable; warnings (`coil-duplicate`) are shown but allowed.
 */
export interface LadderDiagnostic {
  severity: 'error' | 'warning';
  code: string;
  path: string;
  /** The rung, node, coil or variable it is about. */
  id?: string;
}

/** IEC 61131-3 identifiers: a letter or `_` then letters, digits and single underscores. */
const identifier = /^(?:[A-Za-z]|_[A-Za-z0-9])(?:_?[A-Za-z0-9])*$/;
/** Keywords that cannot name a variable (the ones a ladder program might collide with). */
const keywords = new Set(
  (
    'TRUE FALSE AND OR XOR NOT MOD BOOL INT DINT REAL TIME STRING TON TOF TP CTU CTD CTUD R_TRIG ' +
    'F_TRIG VAR END_VAR VAR_INPUT VAR_OUTPUT PROGRAM END_PROGRAM FUNCTION FUNCTION_BLOCK IF THEN ' +
    'ELSE END_IF FOR WHILE CASE OF RETURN EN ENO'
  ).split(' '),
);
export function ladderIdentifierOk(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length <= ladderLimits.nameLength &&
    identifier.test(name) &&
    !keywords.has(name.toUpperCase())
  );
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, lo: number, hi: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** The declared variable a reference names (IEC names compare without case). */
export function ladderVariableMap(doc: Pick<LadderDocument, 'variables'>) {
  const map = new Map<string, LadderVariable>();
  for (const v of doc.variables)
    if (isRecord(v) && typeof v.name === 'string') map.set(v.name.toUpperCase(), v);
  return {
    get: (name: string) => (typeof name === 'string' ? map.get(name.toUpperCase()) : undefined),
  };
}

export function validateLadder(input: unknown): LadderDiagnostic[] {
  const out: LadderDiagnostic[] = [];
  const err = (code: string, path: string, id?: string) =>
    out.push({ severity: 'error', code, path, ...(id ? { id } : {}) });
  const keys = (
    o: Record<string, unknown>,
    path: string,
    required: string[],
    optional: string[] = [],
  ) => {
    for (const k of required) if (!Object.hasOwn(o, k)) err('shape', `${path}.${k}`);
    for (const k of Object.keys(o))
      if (!required.includes(k) && !optional.includes(k)) err('shape', `${path}.${k}`);
  };
  if (!isRecord(input)) {
    err('shape', '$');
    return out;
  }
  keys(input, '$', ['schemaVersion', 'name', 'scanMs', 'variables', 'rungs']);
  if (input.schemaVersion !== 1) err('schema-version', '$.schemaVersion');
  if (typeof input.name !== 'string' || input.name.length > 200) err('shape', '$.name');
  if (!isInt(input.scanMs, 1, 10_000)) err('scan-ms', '$.scanMs');
  if (!Array.isArray(input.variables) || !Array.isArray(input.rungs)) {
    err('shape', '$');
    return out;
  }
  if (input.variables.length > ladderLimits.variables) err('limit-variables', '$.variables');
  if (input.rungs.length > ladderLimits.rungs) err('limit-rungs', '$.rungs');
  if (out.length) return out;

  // Variables.
  const seen = new Set<string>();
  input.variables.forEach((v: unknown, i) => {
    const p = `$.variables[${i}]`;
    if (!isRecord(v)) return err('shape', p);
    keys(v, p, ['name', 'type', 'role'], ['initial', 'comment']);
    const name = v.name as string;
    if (!ladderIdentifierOk(name)) err('name-invalid', `${p}.name`, String(name));
    else if (seen.has(name.toUpperCase())) err('name-duplicate', `${p}.name`, name);
    else seen.add(name.toUpperCase());
    if (!ladderTypes.includes(v.type as never)) err('variable-type', `${p}.type`, name);
    if (!ladderRoles.includes(v.role as never)) err('variable-role', `${p}.role`, name);
    const block = [...ladderTimerTypes, ...ladderCounterTypes].includes(v.type as never);
    if (block && v.role !== 'internal') err('variable-role', `${p}.role`, name);
    if (
      v.comment !== undefined &&
      (typeof v.comment !== 'string' || v.comment.length > ladderLimits.commentLength)
    )
      err('shape', `${p}.comment`);
    if (v.initial !== undefined) {
      const ok =
        v.type === 'BOOL'
          ? typeof v.initial === 'boolean'
          : v.type === 'INT'
            ? isInt(v.initial, -32768, 32767)
            : v.type === 'TIME'
              ? isInt(v.initial, 0, 2 ** 31 - 1)
              : false;
      if (!ok) err('initial', `${p}.initial`, name);
    }
  });
  const vars = ladderVariableMap(input as unknown as LadderDocument);
  const typeOf = (name: unknown) => (typeof name === 'string' ? vars.get(name)?.type : undefined);

  // Rungs.
  const ids = new Set<string>();
  const id = (v: unknown, path: string) => {
    if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) return err('id', path);
    if (ids.has(v)) err('id-duplicate', path, v);
    ids.add(v);
  };
  const instances = new Map<string, string>();
  const written = new Map<string, string>();
  const ref = (name: unknown, path: string, want: readonly string[], nodeId: string) => {
    const t = typeOf(name);
    if (!t) return (err('variable-missing', path, nodeId), false);
    if (!want.includes(t)) return (err('variable-type', path, nodeId), false);
    return true;
  };
  const operand = (o: unknown, path: string, nodeId: string) => {
    if (!isRecord(o)) return err('shape', path);
    if (Object.hasOwn(o, 'value')) {
      keys(o, path, ['value']);
      if (!isInt(o.value, -(2 ** 31), 2 ** 31 - 1)) err('operand', `${path}.value`, nodeId);
      return;
    }
    keys(o, path, ['variable'], ['member']);
    const t = typeOf(o.variable);
    if (!t) return err('variable-missing', `${path}.variable`, nodeId);
    const ok =
      o.member === undefined
        ? t === 'INT' || t === 'TIME'
        : o.member === 'CV'
          ? (ladderCounterTypes as readonly string[]).includes(t)
          : o.member === 'ET'
            ? (ladderTimerTypes as readonly string[]).includes(t)
            : false;
    if (!ok) err('variable-type', `${path}.variable`, nodeId);
  };
  input.rungs.forEach((r: unknown, i) => {
    const p = `$.rungs[${i}]`;
    if (!isRecord(r)) return err('shape', p);
    keys(r, p, ['id', 'network', 'coils'], ['comment']);
    id(r.id, `${p}.id`);
    const rid = String(r.id);
    if (
      r.comment !== undefined &&
      (typeof r.comment !== 'string' || r.comment.length > ladderLimits.commentLength)
    )
      err('shape', `${p}.comment`);
    let count = 0;
    const node = (n: unknown, path: string, depth: number) => {
      if (++count > ladderLimits.nodesPerRung)
        return count === ladderLimits.nodesPerRung + 1 && err('limit-nodes', path, rid);
      if (depth > ladderLimits.depth) return err('limit-depth', path, rid);
      if (!isRecord(n)) return err('shape', path);
      id(n.id, `${path}.id`);
      const nid = String(n.id);
      switch (n.kind) {
        case 'contact':
          keys(n, path, ['id', 'kind', 'variable', 'contact']);
          ref(n.variable, `${path}.variable`, ['BOOL'], nid);
          if (!ladderContactKinds.includes(n.contact as never))
            err('shape', `${path}.contact`, nid);
          break;
        case 'series':
          keys(n, path, ['id', 'kind', 'items']);
          if (!Array.isArray(n.items)) return err('shape', `${path}.items`);
          n.items.forEach((c: unknown, k) => node(c, `${path}.items[${k}]`, depth + 1));
          break;
        case 'parallel':
          keys(n, path, ['id', 'kind', 'branches']);
          if (!Array.isArray(n.branches)) return err('shape', `${path}.branches`);
          if (n.branches.length < 2) err('branch-count', `${path}.branches`, nid);
          n.branches.forEach((c: unknown, k) => node(c, `${path}.branches[${k}]`, depth + 1));
          break;
        case 'timer':
        case 'counter': {
          const timer = n.kind === 'timer';
          keys(
            n,
            path,
            ['id', 'kind', 'instance', timer ? 'presetMs' : 'preset'],
            timer ? [] : ['reset'],
          );
          if (
            ref(n.instance, `${path}.instance`, timer ? ladderTimerTypes : ladderCounterTypes, nid)
          ) {
            const key = String(n.instance).toUpperCase();
            if (instances.has(key)) err('instance-duplicate', `${path}.instance`, nid);
            instances.set(key, nid);
          }
          if (timer ? !isInt(n.presetMs, 0, 2 ** 31 - 1) : !isInt(n.preset, -32768, 32767))
            err('preset', `${path}.${timer ? 'presetMs' : 'preset'}`, nid);
          if (!timer && n.reset !== undefined) ref(n.reset, `${path}.reset`, ['BOOL'], nid);
          break;
        }
        case 'compare':
          keys(n, path, ['id', 'kind', 'op', 'a', 'b']);
          if (!ladderCompareOps.includes(n.op as never)) err('shape', `${path}.op`, nid);
          operand(n.a, `${path}.a`, nid);
          operand(n.b, `${path}.b`, nid);
          break;
        default:
          err('shape', `${path}.kind`, nid);
      }
    };
    node(r.network, `${p}.network`, 1);
    if (!Array.isArray(r.coils)) return err('shape', `${p}.coils`);
    if (r.coils.length === 0) err('rung-no-coil', `${p}.coils`, rid);
    r.coils.forEach((c: unknown, k) => {
      const q = `${p}.coils[${k}]`;
      if (!isRecord(c)) return err('shape', q);
      keys(c, q, ['id', 'variable', 'coil']);
      id(c.id, `${q}.id`);
      const cid = String(c.id);
      if (!ladderCoilKinds.includes(c.coil as never)) err('shape', `${q}.coil`, cid);
      if (!ref(c.variable, `${q}.variable`, ['BOOL'], cid)) return;
      const v = vars.get(c.variable as string)!;
      if (v.role === 'input') err('coil-input', `${q}.variable`, cid);
      // A variable driven by two plain coils: the later rung wins each scan.
      if (c.coil === 'normal' || c.coil === 'negated') {
        const key = v.name.toUpperCase();
        if (written.has(key))
          out.push({ severity: 'warning', code: 'coil-duplicate', path: `${q}.variable`, id: cid });
        written.set(key, cid);
      }
    });
  });
  return out;
}

/** True when the program has no errors (warnings allowed). */
export function isLadderDocument(input: unknown): input is LadderDocument {
  return validateLadder(input).every((d) => d.severity !== 'error');
}
