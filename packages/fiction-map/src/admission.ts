import { canonicalJson, deepFreeze } from '@editor-platform/artifact-core';
import { copyData } from './input';
import { readJson } from './json';
import { checkReferences, pointsOf, readContent } from './schema';
import { checkGeometry, markGeometry } from './geometry-validation';
import {
  checkWork,
  fictionMapLimits as limits,
  type WorkPlan,
  type WorkLedger,
  chargeWork,
} from './limits';
import { attempt, fail } from './result';
import type { FictionMapContent, FictionMapDiagnostic, FictionMapResult } from './types';

const owned = new WeakSet<object>();
export const isOwnedContent = (value: unknown): value is FictionMapContent =>
  !!value && typeof value === 'object' && owned.has(value);
export function planContent(c: FictionMapContent): WorkPlan {
  const plan: WorkPlan = {
    features: c.features.length,
    vertices: 0,
    rawPoints: 0,
    edges: 0,
    vertexPairs: 0,
    edgePairs: 0,
  };
  for (const f of c.features) {
    const raw = pointsOf(f.geometry).length,
      n = f.geometry.type === 'polygon' ? Math.max(0, raw - 1) : raw;
    plan.vertices += n;
    plan.rawPoints += raw;
    plan.edges +=
      f.geometry.type === 'point' ? 0 : f.geometry.type === 'polygon' ? n : Math.max(0, n - 1);
    if (f.geometry.type === 'polygon') {
      plan.vertexPairs += (n * (n - 1)) / 2;
      plan.edgePairs += (n * (n - 1)) / 2;
    }
  }
  return plan;
}
export function checkCapacity(c: FictionMapContent): WorkPlan {
  for (const [key, max, code] of [
    ['layers', limits.layers, 'layer-limit'],
    ['features', limits.features, 'feature-limit'],
    ['namedViews', limits.namedViews, 'view-limit'],
  ] as const)
    if (c[key].length > max) fail(code, '/' + key, { limit: max, actual: c[key].length });
  for (let i = 0; i < c.features.length; i++) {
    const g = c.features[i].geometry,
      raw = pointsOf(g).length,
      max = g.type === 'polygon' ? 65 : g.type === 'polyline' ? 64 : 1;
    if (raw > max)
      fail('geometry-vertex-limit', `/features/${i}/geometry`, { limit: max, actual: raw });
  }
  const plan = planContent(c);
  if (plan.vertices > limits.vertices)
    fail('map-vertex-limit', '/features', { limit: limits.vertices, actual: plan.vertices });
  const bytes = new TextEncoder().encode(canonicalJson(c)).length;
  if (bytes > limits.nativeBytes)
    fail('native-byte-limit', '', { limit: limits.nativeBytes, actual: bytes });
  return plan;
}
/** Internal admission; reuse only a model-owned immutable base, never a public certificate. */
export function admit(
  input: unknown,
  reuse?: FictionMapContent,
  ledger?: WorkLedger,
): FictionMapContent {
  const c = readContent(copyData(input));
  const plan = checkCapacity(c);
  checkReferences(c);
  checkWork(plan);
  if (ledger) chargeWork(plan, ledger);
  const samePolicy =
    reuse &&
    isOwnedContent(reuse) &&
    canonicalJson(reuse.precision) === canonicalJson(c.precision) &&
    canonicalJson(reuse.coordinateSpace.bounds) === canonicalJson(c.coordinateSpace.bounds) &&
    reuse.coordinateSpace.yAxis === c.coordinateSpace.yAxis;
  const base = new Map(samePolicy ? reuse.features.map((f) => [f.id, f.geometry]) : []);
  c.features.forEach((f, i) => {
    const g = base.get(f.id);
    if (g && canonicalJson(g) === canonicalJson(f.geometry)) return;
    checkGeometry(f.geometry, c.precision, `/features/${i}/geometry`);
  });
  deepFreeze(c);
  c.features.forEach((f) => markGeometry(f.geometry));
  owned.add(c);
  return c;
}
export function validateFictionMap(input: unknown): FictionMapResult<FictionMapContent> {
  return attempt('input', () => admit(input));
}
export function createFictionMap(): FictionMapContent {
  return admit({
    kind: 'fiction-map',
    schemaVersion: 1,
    coordinateSpace: {
      kind: 'local-plane',
      bounds: { minX: 0, minY: 0, maxX: 1024, maxY: 1024 },
      unit: { name: 'map-unit' },
      yAxis: 'down',
    },
    precision: { minEdgeLength: 0, minPolygonArea: 0 },
    layers: [],
    features: [],
    namedViews: [],
  });
}
export function parseFictionMap(input: string | Uint8Array): FictionMapResult<FictionMapContent> {
  return attempt('input', () => admit(readJson(input)));
}
export function serializeFictionMap(input: unknown): FictionMapResult<string> {
  return attempt('input', () => canonicalJson(isOwnedContent(input) ? input : admit(input)));
}
export function admitAt(
  input: unknown,
  source: FictionMapDiagnostic['source'],
  reuse?: FictionMapContent,
  ledger?: WorkLedger,
) {
  return attempt(source, () => admit(input, reuse, ledger));
}
