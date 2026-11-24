import { canonical, copy, fail, type Domain } from '@editor-platform/collaboration-core';
import { assertGraph, isGraphDocument, relationProfile, type GraphDocument } from '@editor-platform/structured-graph/model';
import { isAnalysis, type AnalysisDocument } from '@editor-platform/analysis-core';
import { isEstimate, type EstimateDocument } from '@editor-platform/estimate-core';
import { validateFictionMap, type FictionMapContent } from '@editor-platform/fiction-map/model';
import { geoKind } from '@editor-platform/geo-inspector/kind';
import { isLadderDocument, type LadderDocument } from '@editor-platform/ladder-core';
import { isSchematicDocument, type SchematicDocument } from '@editor-platform/schematic-core';
import { isDrawingDocument, type DrawingDocument } from '@editor-platform/drawing-core';
import { isPcbDocument, type PcbDocument } from '@editor-platform/pcb-core';
import { isConstructionDocument, type ConstructionDocument } from '@editor-platform/construction-core';
import { isFactoryDocument, type FactoryDocument } from '@editor-platform/factory-core';
import { isCosimDocument, type CosimDocument } from '@editor-platform/cosim-core';
import { containsSharedReference } from './reference-guard';
import { collection, type Schema } from './editor-transactions';

function records<T extends object>(
  domain: Domain,
  isNative: (value: unknown) => value is T,
  root: readonly (keyof T & string)[],
  fields: Partial<Record<keyof T & string, readonly string[]>>,
  refusal: (content: T) => string | undefined = () => undefined,
  fixedSources: readonly (keyof T & string)[] = [],
): Schema<T> {
  const unsupported = (value: T) =>
    refusal(value) ??
    (containsSharedReference(value) ? '成果物への参照を含む内容は共同編集できません。' : undefined);
  const validate = (value: unknown): value is T => isNative(value) && !unsupported(value);
  const collections = Object.keys(fields) as (keyof T & string)[];
  return {
    root,
    recordRoots: collections,
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
        if (fixedSources.some((key) => canonical(content[key]) !== canonical(next[key])))
          fail('invalid-operation', '参照元が異なる保存版は共同編集中に復元できません。');
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

function graphRefusal(graph: GraphDocument): string | undefined {
  if (graph.profile.id !== relationProfile.id || graph.profile.version !== relationProfile.version)
    return 'このグラフのプロファイルは共同編集に対応していません。';
  try {
    assertGraph(graph, relationProfile);
  } catch {
    return 'グラフの関係や属性がプロファイルに合っていません。';
  }
}

const nativeRecordSchemas = {
  'structured-graph': records('structured-graph', isGraphDocument, ['attributes', 'presentation'], {
    nodes: ['type', 'attributes', 'sectionId'],
    edges: ['type', 'from', 'to', 'attributes'],
    sections: ['type', 'attributes', 'parentId'],
  }, graphRefusal),
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
  ladder: records<LadderDocument>('ladder', isLadderDocument, ['name', 'scanMs', 'variables'], {
    rungs: ['comment', 'network', 'coils'],
  }),
  schematic: records<SchematicDocument>('schematic', isSchematicDocument, ['sheet'], {
    symbols: ['name', 'prefix', 'pins', 'graphics', 'generator'],
    parts: ['ref', 'value', 'symbol', 'at', 'rotationDeg', 'mirror', 'footprint', 'pinMap', 'model', 'noConnect'],
    wires: ['points'],
    junctions: ['at'],
    labels: ['name', 'at', 'rotationDeg'],
    powers: ['name', 'at', 'rotationDeg', 'style'],
  }),
  drawing: records<DrawingDocument>(
    'drawing', isDrawingDocument, ['name', 'projection'],
    {
      sheets: ['name', 'size', 'orientation', 'filing', 'title', 'revisions'],
      annotations: [
        'sheetId', 'kind', 'at', 'text', 'heightMm', 'viewId', 'type', 'refs', 'tolerance',
        'ref', 'target', 'symbol',
      ],
    },
    (doc) => doc.sources.length || doc.views.length
      ? 'CAD・BIM の投影図を含む図面は共同編集できません。'
      : undefined,
  ),
  pcb: records<PcbDocument>(
    'pcb', isPcbDocument, ['board'],
    {
      holes: ['name', 'at', 'drillMm', 'plated', 'keepoutMm'],
      footprints: ['name', 'pads', 'silk', 'courtyard', 'heightMm', 'generator'],
      components: ['ref', 'value', 'footprint', 'at', 'rotationDeg', 'side', 'locked'],
      netClasses: ['name', 'trackWidthMm', 'clearanceMm', 'viaDiameterMm', 'viaDrillMm'],
      nets: ['name', 'class', 'pins'],
      tracks: ['net', 'layer', 'widthMm', 'from', 'to'],
      vias: ['net', 'at', 'diameterMm', 'drillMm'],
      zones: [
        'net', 'layer', 'outline', 'priority', 'clearanceMm', 'padConnection', 'thermalGapMm',
        'spokeWidthMm',
      ],
    },
    (doc) => doc.stack.length ? '別の基板を重ねた基板は共同編集できません。' : undefined,
  ),
  construction: records<ConstructionDocument>(
    'construction', isConstructionDocument, ['name', 'startDate', 'calendar', 'retiredIds', 'site'],
    { tasks: ['name', 'durationDays', 'predecessors', 'action', 'elementIds', 'actual', 'raiseMm'] },
    undefined,
    ['source'],
  ),
  factory: records<FactoryDocument>(
    'factory', isFactoryDocument,
    ['name', 'calendars', 'workerPools', 'paths', 'fleets', 'control', 'run', 'experiment'],
    {
      products: ['name'],
      objects: [
        'name', 'kind', 'calendarId', 'pathNodeId', 'exit', 'at', 'size', 'failures', 'setup',
        'workers', 'interval', 'mix', 'limit', 'startMs', 'processTime', 'productTimes', 'count',
        'mainProductId', 'components', 'outputProductId', 'capacity', 'order', 'lengthMm',
        'speedMmS', 'partLengthMm', 'accumulating',
      ],
      links: ['from', 'to', 'productIds', 'transport'],
    },
    (doc) => doc.building || doc.objects.some((object) => object.look)
      ? 'CAD・BIM を参照する工場は共同編集できません。'
      : undefined,
  ),
  cosim: records<CosimDocument>(
    'cosim', isCosimDocument, ['name', 'bindings'], {},
    undefined,
    ['schematic', 'ladder'],
  ),
};

export { nativeRecordSchemas };
