import type { GeometryQuantitySources } from '@editor-platform/calculation-core';
import type { EstimateBimEvaluator } from './bim-source';

export type { EstimateBimEvaluator, BimQuantityEvaluation } from './bim-source';

const cad = () => import('./cad-source');
const bim = () => import('./bim-source');

/**
 * CAD/BIM quantity sources for a calculation such as Estimate. The CAD and BIM code loads on
 * first use. `evaluateBim` is the Host-owned BIM kernel evaluation; without it, kernel
 * quantities are refused (`bim-kernel-verifier-required`).
 */
export function geometryQuantitySources(
  evaluateBim?: EstimateBimEvaluator,
): GeometryQuantitySources {
  return {
    verification: {
      async verifySource(source, sources) {
        return (await bim()).bimQuantityVerification(evaluateBim).verifySource(source, sources);
      },
      async verifyQuantities(quantities, sources) {
        return (await bim())
          .bimQuantityVerification(evaluateBim)
          .verifyQuantities(quantities, sources);
      },
    },
    retainCad: async (input) => (await cad()).retainCadInput(input),
    cadRows: async (root, sources) => (await cad()).cadSourceProjection(root, sources).rows,
    measureCad: async (root, sources, identity) =>
      (await cad()).cadMeasurement(root, sources, identity),
    bimElements: async (content) => (await bim()).bimElements(content),
    retainBim: async (input) => (await bim()).retainBimInput(input),
    measureBim: async (root, elementId, metric, signal) =>
      (await bim()).bimMeasurement(root, elementId, metric, evaluateBim, signal),
  };
}
