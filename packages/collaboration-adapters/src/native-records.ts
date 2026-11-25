import { canonical, copy, fail, type Domain } from '@editor-platform/collaboration-core';
import { assertGraph, isGraphDocument, relationProfile, type GraphProfile, type GraphDocument } from '@editor-platform/structured-graph/model';
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
import { isCadDocument, type CadDocument } from '@editor-platform/cad-core';
import { isBimDocument, type BimDocument } from '@editor-platform/bim-core';
import { isCharacterDocument, type CharacterDocument } from '@editor-platform/character-core';
import { isSimulationDocument, type SimulationDocument } from '@editor-platform/simulation-core';
import { containsSharedReference } from './reference-guard';
import { collection, type Schema } from './editor-transactions';

function records<T extends object>(
  domain: Domain,
  isNative: (value: unknown) => value is T,
  root: readonly (keyof T & string)[],
  fields: Partial<Record<keyof T & string, readonly string[]>>,
  refusal: (content: T) => string | undefined = () => undefined,
  fixedSources: readonly (keyof T & string)[] = [],
  options?: {
    atomicRoots?: readonly (keyof T & string)[];
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

const cadModelFields = [
  'parameters', 'profiles', 'sketches', 'features', 'bodies', 'spotWelds', 'proportions',
] as const;

// Mesh bytes encode part/skin/morph relationships. Keep that topology fixed for this session.
function characterMeshTopology(doc: CharacterDocument) {
  return {
    parts: Object.fromEntries(doc.parts.map((part) => [part.id, {
      mesh: part.mesh, multires: part.multires, slots: part.materials.length,
    }])),
    skeletons: Object.fromEntries(doc.skeletons.map((rig) => [rig.id,
      Object.fromEntries(rig.bones.map((bone) => [bone.id, bone.parentId])),
    ])),
    skins: doc.skins,
    morphs: Object.fromEntries(doc.morphs.map((morph) => [morph.id, morph.partId])),
  };
}

const nativeRecordSchemas = {
  cad: records<CadDocument>(
    'cad', isCadDocument,
    [...cadModelFields, 'partProperties', 'designTargets', 'sightChecks', 'toleranceStacks', 'motions'],
    { namedViews: ['name', 'bodyIds', 'camera', 'projection'] },
    (doc) => doc.assets.length || doc.parts.length || doc.components.length || doc.underlays?.length
      ? '取り込んだ形状・部品・素材を含む CAD は共同編集できません。'
      : undefined,
    ['kernelProfile', 'schemaVersion'],
    { atomicRoots: cadModelFields },
  ),
  bim: records<BimDocument>(
    'bim', isBimDocument, ['project', 'inhabitantHeightMm'],
    {
      levels: ['name', 'elevationMm'],
      grids: ['label', 'start', 'end', 'bubbles'],
      materials: ['name', 'category', 'appearance', 'densityKgM3', 'youngsModulusMPa', 'poissonsRatio'],
      types: ['name', 'description', 'ifcGlobalId', 'properties', 'common', 'layers', 'profile', 'materialId', 'widthMm', 'heightMm'],
      elements: [
        'name', 'description', 'ifcGlobalId', 'properties', 'common', 'typeId', 'start', 'end', 'bulge',
        'location', 'base', 'top', 'clipBy', 'lean', 'boundary', 'holes', 'slope', 'at', 'rotationRad',
        'topAt', 'topScale', 'endTop', 'hostId', 'wall', 'slab', 'alongMm', 'flipFacing', 'flipHand',
        'sillMm', 'shape', 'number', 'center', 'innerRadiusMm', 'outerRadiusMm', 'startAngleRad',
        'sweepRad', 'side', 'heightMm', 'directionRad', 'widthMm', 'risers', 'treadMm',
      ],
      joins: ['walls', 'kind', 'through'],
      views: ['name', 'level', 'cutHeightMm', 'scale', 'depthMm', 'line', 'direction'],
      propertySets: ['name', 'properties'],
      cameras: ['name', 'position', 'target', 'up', 'fovDeg'],
    },
    (doc) => doc.assets?.length || doc.types.some((type) => type.kind === 'part')
      ? '外部部品や画像素材を含む BIM は共同編集できません。'
      : undefined,
    [], { taggedCollections: ['types', 'elements', 'views'] },
  ),
  character: records<CharacterDocument>(
    'character', isCharacterDocument, ['name', 'retiredIds'],
    {
      materials: ['name', 'color', 'opacity', 'roughness', 'metalness', 'maps', 'doubleSided'],
      parts: ['name', 'parentId', 'transform', 'materials', 'visible', 'subdivision'],
      skeletons: ['name', 'parentPartId', 'bones', 'ik'],
      morphs: ['name', 'weight'],
      actions: ['name', 'duration', 'frameRate', 'tracks'],
    },
    (doc) => doc.props.length ? '外部の小道具を含む Character は共同編集できません。' : undefined,
    ['assets', 'schemaVersion'],
    { fixedProjection: characterMeshTopology },
  ),
  simulation: records<SimulationDocument>(
    'simulation', isSimulationDocument,
    ['name', 'materialId', 'bodies', 'preparation', 'mesh', 'overrides', 'sheets', 'retiredIds'],
    {
      materials: ['name', 'model', 'youngsModulus', 'poissonsRatio', 'density', 'conductivity', 'plasticity', 'specificHeat', 'expansion'],
      loads: ['name', 'targets', 'force', 'pressure', 'acceleration', 'flux', 'amplitude', 'coefficient', 'ambient', 'emissivity'],
      constraints: ['name', 'targets', 'displacement', 'temperature', 'amplitude'],
      studies: ['name', 'loadIds', 'constraintIds', 'solver', 'convergence', 'idealisation', 'fatigue', 'test', 'modal', 'thermal', 'transient', 'aero', 'crash', 'seal', 'shower'],
      bonds: ['name', 'follower', 'on', 'tolerance', 'contact'],
      masses: ['name', 'targets', 'mass'],
      spotWelds: ['name', 'weldId', 'follower', 'on', 'radiusMm', 'tolerance'],
      seals: ['name', 'line', 'base', 'mating', 'insetMm', 'section', 'hinge'],
    },
    (doc) => doc.runs?.length ? '保存済みの解析結果を含む成果物は共同編集できません。' : undefined,
    ['source', 'schemaVersion'],
    { taggedCollections: ['loads', 'constraints', 'studies'] },
  ),
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
