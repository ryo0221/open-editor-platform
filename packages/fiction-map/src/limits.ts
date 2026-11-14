import { fail } from './result';

export const fictionMapLimits = Object.freeze({
  policy: 'fiction-map-v1',
  coordinate: 2 ** 20,
  ringVertices: 64,
  polylineVertices: 64,
  layers: 10,
  features: 200,
  namedViews: 10,
  vertices: 1000,
  rawPoints: 1200,
  nativeBytes: 65536,
  inputBytes: 65536,
  depth: 6,
  values: 20000,
  requestBytes: 262144,
  requestDepth: 8,
  requestValues: 40000,
  affectedIds: 400,
  edits: 400,
  vertexPairs: 31020,
  edgePairs: 31020,
  passPairs: 62040,
  appendPairs: 124080,
  edges: 1000,
  artifactRefsPerFeature: 8,
} as const);
export type FictionMapLimits = typeof fictionMapLimits;
export interface WorkPlan {
  features: number;
  vertices: number;
  rawPoints: number;
  edges: number;
  vertexPairs: number;
  edgePairs: number;
}
/** Internal defensive boundary; public admission applies document limits first. */
export function checkWork(plan: WorkPlan): void {
  const l = fictionMapLimits;
  if (plan.features > l.features)
    fail('operation-feature-limit', '', { limit: l.features, actual: plan.features });
  if (plan.vertices > l.vertices || plan.rawPoints > l.rawPoints || plan.edges > l.edges)
    fail('operation-vertex-limit', '', { limit: l.vertices, actual: plan.vertices });
  if (
    plan.vertexPairs > l.vertexPairs ||
    plan.edgePairs > l.edgePairs ||
    plan.vertexPairs + plan.edgePairs > l.passPairs
  )
    fail('operation-pair-limit', '', {
      limit: l.passPairs,
      actual: plan.vertexPairs + plan.edgePairs,
    });
}

export function checkAffectedIds(count: number): void {
  if (count > fictionMapLimits.affectedIds)
    fail('operation-feature-limit', '', { limit: fictionMapLimits.affectedIds, actual: count });
}
export interface WorkLedger {
  pairs: number;
  passes: number;
  readonly maxPairs: number;
  readonly maxPasses: number;
}
export function chargeWork(plan: WorkPlan, ledger: WorkLedger): void {
  const pairs = plan.vertexPairs + plan.edgePairs;
  if (ledger.pairs + pairs > ledger.maxPairs || ledger.passes + 1 > ledger.maxPasses)
    fail('operation-pair-limit', '', { limit: ledger.maxPairs, actual: ledger.pairs + pairs });
  ledger.pairs += pairs;
  ledger.passes++;
}
