import { canonical, copy, fail, type Domain } from '@editor-platform/collaboration-core';
import { assertGraph, isGraphDocument, relationProfile, type GraphProfile, type GraphDocument } from '@editor-platform/structured-graph/model';
import { isAnalysis, type AnalysisDocument } from '@editor-platform/analysis-core';
import { isEstimate, type EstimateDocument } from '@editor-platform/estimate-core';
import { validateFictionMap, type FictionMapContent } from '@editor-platform/fiction-map/model';
import { geoKind } from '@editor-platform/geo-inspector/kind';
import { containsSharedReference } from './reference-guard';
import { collection, type Schema } from './record-schema';

export function records<T extends object>(
  domain: Domain,
  isNative: (value: unknown) => value is T,
  root: readonly (keyof T & string)[],
  fields: Partial<Record<keyof T & string, readonly string[]>>,
  refusal: (content: T) => string | undefined = () => undefined,
  fixedSources: readonly (keyof T & string)[] = [],
  options?: {
    atomicRoots?: readonly (keyof T & string)[];
    optionalCollections?: readonly (keyof T & string)[];
    taggedCollections?: readonly (keyof T & string)[];
    fixedProjection?(content: T): unknown;
  },
): Schema<T> {
  const unsupported = (value: T) =>
    refusal(value) ??
    (containsSharedReference(value) ? '成果物への参照を含む内容は共同編集できません。' : undefined);
  const validate = (value: unknown): value is T => isNative(value) && !unsupported(value);
  const collections = Object.keys(fields) as (keyof T & string)[];
  function validateTransition(before: T, after: T) {
    if (fixedSources.some((key) =>
      before[key] !== after[key] && canonical(before[key]) !== canonical(after[key])))
      fail('invalid-operation', '共同編集中は固定した参照元や素材を変更できません。');
    if (options?.fixedProjection &&
        canonical(options.fixedProjection(before)) !== canonical(options.fixedProjection(after)))
      fail('invalid-operation', '共同編集中は固定したメッシュやリグの構造を変更できません。');
  }
  return {
    root,
    recordRoots: collections,
    taggedCollections: options?.taggedCollections,
    optionalCollections: options?.optionalCollections,
    atomicRoots: options?.atomicRoots,
    validateTransition,
    collections: (content) =>
      collections.map((key) => collection(content, key, fields[key]!)),
    base: {
      domain,
      validate,
      unsupportedContentReason: (value) => isNative(value) ? unsupported(value) : undefined,
      resource: () => undefined,
      validateAnchor: () => false,
      apply(content, action) {
        const next = action.payload.content;
        if (action.type !== 'domain.restore' || !validate(next))
          fail('invalid-operation', 'この保存版を共同編集中に復元できません。');
        validateTransition(content, next);
        return {
          content: copy(next),
          required: ['*'],
          touched: ['*'],
          targets: ['*'],
          inverse: [{ type: 'domain.restore', target: '*', payload: { content } }],
        };
      },
    },
  };
}

export function structuredGraphSchema(profiles: readonly GraphProfile[]) {
  return records<GraphDocument>('structured-graph', isGraphDocument, ['attributes', 'presentation'], {
    nodes: ['type', 'attributes', 'sectionId'],
    edges: ['type', 'from', 'to', 'attributes'],
    sections: ['type', 'attributes', 'parentId'],
  }, (graph) => {
    const profile = profiles.find((p) => p.id === graph.profile.id && p.version === graph.profile.version);
    if (!profile) return 'このグラフのプロファイルは共同編集に対応していません。';
    try {
      assertGraph(graph, profile);
    } catch {
      return 'グラフの関係や属性がプロファイルに合っていません。';
    }
  }, ['profile', 'id', 'schemaVersion']);
}

export const nativeRecordSchemas = {
  'structured-graph': structuredGraphSchema([relationProfile]),
  analysis: records<AnalysisDocument>('analysis', isAnalysis, ['title'], {
    blocks: ['kind', 'text', 'targetId'],
    parameters: ['label', 'type', 'value'],
    steps: ['op', 'input', 'columns', 'expression', 'field', 'right', 'leftKey', 'rightKey', 'mode', 'cardinality', 'groupBy', 'metrics', 'keys'],
    scenarios: ['name', 'parameterValues'],
    outputs: ['stepId', 'columns', 'presentation'],
  }, (value) => value.retainedSources.length || value.runs.length || value.inputs.length
    ? '参照元や保存済みの計算結果を持つ分析は共同編集できません。' : undefined),
  estimate: records<EstimateDocument>('estimate', isEstimate, ['title', 'description', 'currency', 'rounding', 'workRules', 'workPlan'], {
    quantities: ['name', 'unit', 'value', 'quality', 'evidence', 'override', 'inclusion', 'exclusionReason'],
    rates: ['name', 'unitPrice', 'perUnit', 'currency', 'evidence', 'override'],
    lines: ['name', 'category', 'note', 'bindings', 'rateId', 'wasteRatio', 'purchaseRounding', 'inclusion', 'exclusionReason'],
    adjustments: ['name', 'kind', 'value', 'basisLineIds', 'reason'],
    scenarios: ['name', 'quantities', 'rates', 'waste', 'workRules'],
  }, (value) =>
    value.retainedSources.length || value.calculations.length ||
    value.quantities.some((q) => q.quality !== 'manual' || q.source) ||
    value.rates.some((r) => r.source)
      ? '外部参照や保存済みの計算結果を持つ見積は共同編集できません。' : undefined),
  'fiction-map': records<FictionMapContent>('fiction-map',
    (value): value is FictionMapContent => validateFictionMap(value).ok,
    ['coordinateSpace', 'precision'], {
      layers: ['name', 'purpose', 'visibleByDefault'],
      features: ['layerId', 'featureKind', 'geometry', 'name', 'description', 'category', 'style', 'worldEntityRef'],
      namedViews: ['name', 'extent', 'visibleLayerIds'],
    }, (value) => value.features.some((f) => f.artifactRefs?.length)
      ? '成果物への参照を含む地図は共同編集できません。' : undefined),
  geo: records('geo', geoKind.validate, ['workspace'], {
    layers: ['name', 'crs', 'axis', 'fields', 'features'],
  }, (value) => value.sources.length || value.workspace?.assets.length ||
    value.workspace?.joins.length || value.workspace?.comparisons.length
    ? '外部データを参照している地図は共同編集できません。' : undefined),
};
