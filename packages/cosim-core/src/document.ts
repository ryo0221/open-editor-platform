import { cosimLimits, type CosimBinding } from './cosim';

/**
 * The co-simulation document (docs/cad/circuit-simulation.md, SL8, SL-U3): which saved version
 * of a schematic and of a ladder program run together, and how the ladder's variables are bound
 * to the schematic's GPIO nets. The documents themselves stay in their own Artifacts; an exact
 * version is named by its content hash. Schema 1 is the only schema.
 */
export interface CosimSourceRef {
  artifactId: string;
  versionId: string;
  contentHash: string;
}

export interface CosimDocument {
  schemaVersion: 1;
  name: string;
  schematic?: CosimSourceRef;
  ladder?: CosimSourceRef;
  bindings: CosimBinding[];
}

export interface CosimDiagnostic {
  code: string;
  path: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max;

/** Strict plain-JSON validation: exact keys, references, bindings (each net and variable once). */
export function validateCosim(input: unknown): CosimDiagnostic[] {
  const out: CosimDiagnostic[] = [];
  const err = (code: string, path: string) => out.push({ code, path });
  const keys = (
    o: Record<string, unknown>,
    path: string,
    required: string[],
    optional: string[],
  ) => {
    for (const k of required) if (!Object.hasOwn(o, k)) err('shape', `${path}.${k}`);
    for (const k of Object.keys(o))
      if (!required.includes(k) && !optional.includes(k)) err('shape', `${path}.${k}`);
  };
  if (!isRecord(input)) return [{ code: 'shape', path: '$' }];
  keys(input, '$', ['schemaVersion', 'name', 'bindings'], ['schematic', 'ladder']);
  if (input.schemaVersion !== 1) err('schema-version', '$.schemaVersion');
  if (typeof input.name !== 'string' || input.name.length > 200) err('shape', '$.name');
  for (const k of ['schematic', 'ladder'] as const) {
    const r = input[k];
    if (r === undefined) continue;
    if (!isRecord(r)) {
      err('shape', `$.${k}`);
      continue;
    }
    keys(r, `$.${k}`, ['artifactId', 'versionId', 'contentHash'], []);
    if (!text(r.artifactId) || !text(r.versionId) || !text(r.contentHash)) err('source', `$.${k}`);
  }
  if (!Array.isArray(input.bindings)) {
    err('shape', '$.bindings');
    return out;
  }
  if (input.bindings.length > cosimLimits.bindings) err('limit-bindings', '$.bindings');
  const vars = new Set<string>();
  const nets = new Set<string>();
  input.bindings.forEach((b: unknown, i) => {
    const p = `$.bindings[${i}]`;
    if (!isRecord(b)) return err('shape', p);
    keys(b, p, ['variable', 'net', 'kind'], ['pull', 'activeLow']);
    if (!text(b.variable, 64)) err('binding-variable', `${p}.variable`);
    else if (vars.has(String(b.variable).toUpperCase())) err('binding-duplicate', `${p}.variable`);
    else vars.add(String(b.variable).toUpperCase());
    if (!text(b.net, 200)) err('binding-net', `${p}.net`);
    else if (nets.has(String(b.net))) err('binding-duplicate', `${p}.net`);
    else nets.add(String(b.net));
    if (b.kind !== 'input' && b.kind !== 'output') err('shape', `${p}.kind`);
    if (
      b.pull !== undefined &&
      (b.kind !== 'input' || !['up', 'down', 'none'].includes(b.pull as string))
    )
      err('shape', `${p}.pull`);
    if (b.activeLow !== undefined && typeof b.activeLow !== 'boolean')
      err('shape', `${p}.activeLow`);
  });
  return out;
}

export const isCosimDocument = (input: unknown): input is CosimDocument =>
  validateCosim(input).length === 0;

/** A new co-simulation: no sources chosen, no bindings (the Playground's starter). */
export function cosimStarter(): CosimDocument {
  return { schemaVersion: 1, name: 'Co-simulation', bindings: [] };
}
