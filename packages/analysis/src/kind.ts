import { defineKind } from '@editor-platform/artifact-kinds';
import { createAnalysis, isAnalysis, type AnalysisDocument } from '@editor-platform/analysis-core';

/** The 計算・分析ノート kind (docs/kind-registry-design.md). */
export const analysisKind = defineKind<AnalysisDocument>({
  kind: 'analysis',
  area: 'office',
  label: '計算・分析ノート',
  icon: '∑',
  description: '保存Dataの計算・条件別比較',
  creatable: true,
  create: (count) => ({ name: `計算・分析ノート ${count}`, content: createAnalysis() }),
  validate: isAnalysis,
});
