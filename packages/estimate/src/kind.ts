import { defineKind } from '@editor-platform/artifact-kinds';
import { createEstimate, isEstimate, type EstimateDocument } from '@editor-platform/estimate-core';

/** The 見積・積算 kind (docs/kind-registry-design.md). */
export const estimateKind = defineKind<EstimateDocument>({
  kind: 'estimate',
  area: 'office',
  label: '見積・積算',
  icon: '¥',
  description: '数量・単価・配賦と条件別見積',
  creatable: true,
  create: (count) => ({ name: `見積・積算 ${count}`, content: createEstimate() }),
  validate: isEstimate,
});
