import { canonicalJson, clone } from '@editor-platform/artifact-core';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import {
  applyAssemblyOperation,
  componentsReading,
  patternsReading,
  settleAssembly,
  type CadAssemblyOperation,
} from './assembly-operations';
import type { CadSolvedPose } from './assembly';
import type { CadExpression } from './expression';
import {
  dependentParameters,
  downstreamFeatures,
  parameterClosure,
  featureKind,
  featureReads,
  isLiteralPosition,
  parameterValues,
  profileParameters,
  sketchAttachment,
  featureReferenceSources,
  sketchParameters,
  upstreamFeatures,
} from './graph';
import {
  cadLimits,
  cadToleranceSetOf,
  cadToleranceSets,
  identityQuaternion,
  position,
  type CadAppearance,
  type CadAssetRef,
  type CadBody,
  type CadDocument,
  type CadFeature,
  type CadNamedView,
  type CadParameter,
  type CadCurveLayout,
  type CadPatternLayout,
  type CadProfile,
  type CadToleranceSet,
  type Position3,
  type Quaternion,
} from './model';
import { CadSketchError, solveSketch, type CadSketch } from './sketch';
import {
  applyJointOperation,
  fixAtStoredPose,
  jointsReading,
  writeSolvedPoses,
  type CadJointOperation,
} from './joints-operations';
import { jointRefPath } from './joints';
import { remapTopoName, type CadTopologyRef } from './topology';
import { assertCad, cadId, record } from './validation';

/** Same digest as artifact-core `contentHash`, computed synchronously for command base checks. */
export const cadContentHash = (doc: CadDocument) =>
  bytesToHex(sha256(new TextEncoder().encode(canonicalJson(doc))));

/** A new body. The trusted layer assigns `placementFeatureId` together with all other IDs. */
export interface CadNewBody {
  id: string;
  name: string;
  sourceFeatureId: string;
  placementFeatureId: string;
  appearance: CadAppearance;
}
/** Serializable operation data shared by UI gestures, headless callers and proposals. */
export type CadOperation =
  | {
      type: 'insertFeatures';
      parameters?: CadParameter[];
      profiles?: CadProfile[];
      /** Solved on insert from their `solved`, which seeds the solver. */
      sketches?: CadSketch[];
      features: CadFeature[];
      bodies?: CadNewBody[];
    }
  /** A literal `value`, or an `expression` over other parameters. */
  | ({ type: 'setParameter'; parameterId: string } & (
      | { value: number }
      | { expression: CadExpression }
    ))
  | { type: 'updateFeature'; featureId: string; args: CadFeature['args'] }
  | {
      type: 'updateProfile';
      profileId: string;
      plane: CadProfile['plane'];
      shape: CadProfile['shape'];
    }
  /**
   * A sketch's plane, elements and constraints replaced; `solved` seeds the solver (the last
   * solution, with positions for new points) and the result is what is stored.
   */
  | {
      type: 'updateSketch';
      sketchId: string;
      plane: CadSketch['plane'];
      entities: CadSketch['entities'];
      constraints: CadSketch['constraints'];
      solved: CadSketch['solved'];
    }
  | {
      type: 'transformBody';
      bodyId: string;
      translation: Position3;
      rotation: Quaternion;
      unbind?: true;
    }
  /** `toolId` (D1), or 1–256 `toolIds` applied by one Boolean (R1). */
  | ({
      type: 'booleanBodies';
      targetId: string;
      mode: 'union' | 'cut' | 'common';
      booleanFeatureId: string;
      placementFeatureId: string;
    } & ({ toolId: string; toolIds?: never } | { toolIds: string[]; toolId?: never }))
  /**
   * The tools of Boolean `featureId` in a new order, or with some taken out: `toolIds` is a
   * non-empty subset of the bodies it consumes. A body taken out is active again.
   */
  | { type: 'setBooleanTools'; featureId: string; toolIds: string[] }
  /** `count` copies of the tool body Booleaned into the target at once; the tool is consumed. */
  | {
      type: 'patternBodies';
      targetId: string;
      toolId: string;
      mode: 'union' | 'cut';
      layout: CadPatternLayout | CadCurveLayout;
      patternFeatureId: string;
      placementFeatureId: string;
    }
  /**
   * R2a-3: 2–64 sheet bodies sewn by one feature: the target's body carries the result, the
   * others are consumed (as a Boolean's tools).
   */
  | {
      type: 'sewBodies';
      targetId: string;
      toolIds: string[];
      toleranceMm: number;
      solid: boolean;
      sewFeatureId: string;
      placementFeatureId: string;
    }
  /**
   * A detail feature (fillet, chamfer, shell, draft, mirror; R2a-3's trim and thicken) on an
   * active body: `feature` reads the body's current result, and a new placement after it becomes
   * the body's result, of the kind the feature gives.
   */
  | {
      type: 'detailBody';
      bodyId: string;
      feature: Extract<CadFeature, { type: CadDetailType }>;
      placementFeatureId: string;
    }
  /**
   * Stored references chosen again (docs/cad/r1-modeling.md, 分かれた要素の選び直し), with the
   * upstream `edit` that broke them when there is one: both are one transaction and one Undo.
   */
  | {
      type: 'rebindReferences';
      edit?: Exclude<CadOperation, { type: 'rebindReferences' | 'withSolvedPoses' }>;
      bindings: CadReferenceBinding[];
    }
  | { type: 'deleteClosure'; ids: string[]; cascade: boolean }
  | { type: 'duplicateClosure'; bodyIds: string[]; idMap: Record<string, string> }
  | { type: 'rename'; targetId: string; name: string }
  | { type: 'saveNamedView'; view: CadNamedView }
  | { type: 'reorderFeatures'; featureIds: string[] }
  /** Explicit kernel migration: the next draft names another exact build (docs/cad/model.md). */
  | { type: 'setKernelBuild'; kernelId: string; buildHash: string }
  /** K2 (docs/cad/complex-models.md): the document's named tolerance set. */
  | { type: 'setToleranceSet'; set: CadToleranceSet }
  /**
   * D2 STEP adoption: the Host already holds the assets' bytes. Adds the refs (or reuses equal
   * ones), the imported feature, its placement and an active body in one edit.
   */
  | {
      type: 'insertImportedBody';
      assets: CadAssetRef[];
      feature: Extract<CadFeature, { type: 'imported' }>;
      body: CadNewBody;
    }
  | CadAssemblyOperation
  | CadJointOperation
  /**
   * An edit with its joint children's poses solved from the candidate's part evaluations
   * (R2b-U5). Only the coordinator writes it, after evaluating `edit`; it is still one edit.
   */
  | {
      type: 'withSolvedPoses';
      edit: Exclude<CadOperation, { type: 'withSolvedPoses' }>;
      poses: Record<string, CadSolvedPose>;
    };
export type CadOperationType = CadOperation['type'];
/** Feature types `detailBody` adds. */
export type CadDetailType =
  | 'fillet'
  | 'chamfer'
  | 'shell'
  | 'draft'
  | 'mirror'
  | 'trim'
  | 'thicken';
export const cadDetailTypes: readonly CadDetailType[] = [
  'fillet',
  'chamfer',
  'shell',
  'draft',
  'mirror',
  'trim',
  'thicken',
];
/** One stored reference replaced: its feature, its path in that feature's args, the new ref. */
export interface CadReferenceBinding {
  /** The feature, or the sketch whose attachment (`['plane', 'face']`) is chosen again. */
  featureId: string;
  path: (string | number)[];
  ref: CadTopologyRef;
}

const fail = (code: string): never => {
  throw new Error(code);
};
const find = <T extends { id: string }>(items: T[], id: string, code: string) =>
  items.find((x) => x.id === id) ?? fail(code);
export const placementFeature = (id: string, inputId: string, name = 'Placement'): CadFeature => ({
  id,
  name,
  type: 'transform',
  inputFeatureIds: [inputId],
  args: { translation: position(0, 0, 0), rotation: identityQuaternion() },
});
const dropViewsFor = (doc: CadDocument, removed: Set<string>) => {
  doc.namedViews = doc.namedViews
    .map((v) => ({ ...v, bodyIds: v.bodyIds.filter((id) => !removed.has(id)) }))
    .filter((v) => v.bodyIds.length);
};

/**
 * Solves sketches again from their stored coordinates against `doc`'s parameters (docs: 解くのは
 * 編集のときだけ). The first that cannot be solved refuses the whole edit.
 */
function resolveSketches(doc: CadDocument, ids: Set<string>) {
  if (!ids.size) return;
  const params = parameterValues(doc);
  for (const s of doc.sketches) {
    if (!ids.has(s.id)) continue;
    try {
      s.solved = solveSketch(s, params).solved;
    } catch (e) {
      // A malformed sketch is left as given: validation names what is wrong with it.
      if (e instanceof CadSketchError && solverCodes.has(e.code)) throw e;
    }
  }
}
const solverCodes = new Set([
  'sketch-redundant-constraint',
  'sketch-conflicting-constraint',
  'sketch-not-converged',
  'sketch-degenerate',
  'coordinate-range',
]);

function addBody(doc: CadDocument, b: CadNewBody) {
  doc.features.push(
    placementFeature(
      b.placementFeatureId,
      b.sourceFeatureId,
      generatedName('', b.name, ' placement'),
    ),
  );
  doc.bodies.push({
    id: b.id,
    name: b.name,
    kind: featureKind(doc, b.placementFeatureId) ?? 'solid',
    resultFeatureId: b.placementFeatureId,
    state: 'active',
    appearance: b.appearance,
  });
}
/** Asset refs no imported feature reads any more leave the content (the Host keeps the bytes). */
function pruneAssets(doc: CadDocument) {
  const used = new Set(
    doc.features.flatMap((f) =>
      f.type === 'imported' ? [f.args.sourceAssetId, f.args.brepAssetId] : [],
    ),
  );
  doc.assets = doc.assets.filter((a) => used.has(a.id));
}

/** Every dependent of the given IDs: features reading them, bodies on removed results, consumed tools of removed Booleans. */
export function dependencyClosure(doc: CadDocument, ids: Iterable<string>) {
  const roots = new Set(ids);
  // Parameters whose expressions read a removed parameter go with it.
  const parameters = new Set(
    [...dependentParameters(doc.parameters, roots)].filter((id) =>
      doc.parameters.some((p) => p.id === id),
    ),
  );
  const profiles = new Set(
    doc.profiles
      .filter((p) => roots.has(p.id) || profileParameters(p).some((x) => parameters.has(x)))
      .map((p) => p.id),
  );
  // Features and sketches depend on each other (a sketch on the face it is attached to, a
  // feature on the sketch it sweeps): grow both until nothing more joins.
  const features = new Set<string>();
  const sketches = new Set<string>();
  for (const b of doc.bodies) if (roots.has(b.id)) features.add(b.resultFeatureId);
  for (let size = -1; size !== features.size + sketches.size; ) {
    size = features.size + sketches.size;
    for (const s of doc.sketches) {
      const face = sketchAttachment(s);
      if (
        roots.has(s.id) ||
        sketchParameters(s).some((p) => parameters.has(p)) ||
        (face !== undefined && features.has(face))
      )
        sketches.add(s.id);
    }
    for (const f of doc.features) {
      const reads = featureReads(f);
      if (
        roots.has(f.id) ||
        reads.parameters.some((p) => parameters.has(p)) ||
        reads.profiles.some((p) => profiles.has(p)) ||
        reads.sketches.some((p) => sketches.has(p)) ||
        featureReferenceSources(f).some((x) => features.has(x))
      )
        features.add(f.id);
    }
    for (const id of downstreamFeatures(doc.features, features)) features.add(id);
  }
  const bodies = new Set(
    doc.bodies
      .filter(
        (b) =>
          roots.has(b.id) ||
          features.has(b.resultFeatureId) ||
          (b.state === 'consumed' && features.has(b.consumedByFeatureId)),
      )
      .map((b) => b.id),
  );
  // A fixed component whose placement reads a removed parameter (R2b).
  const components = new Set([
    ...doc.components.filter((c) => roots.has(c.id)).map((c) => c.id),
    ...componentsReading(doc, parameters),
  ]);
  // Patterns of a removed seed or laid out by a removed parameter (R2b-3).
  const patterns = new Set(patternsReading(doc, roots, { parameters, components }));
  // Joints that read any of these; their children stay, fixed where they stand (R2b-2).
  const joints = new Set(jointsReading(doc, roots, { parameters, features, components, patterns }));
  const known = new Set([
    ...parameters,
    ...profiles,
    ...sketches,
    ...features,
    ...bodies,
    ...components,
    ...patterns,
    ...joints,
  ]);
  for (const id of roots) if (!known.has(id)) fail('target-missing');
  return { parameters, profiles, sketches, features, bodies, components, patterns, joints };
}

function apply(
  doc: CadDocument,
  input: Exclude<CadOperation, { type: 'withSolvedPoses' }>,
): CadDocument {
  // Own the payload too: the result is frozen by EditorSession and must not alias caller data.
  const op = clone(input);
  const next = clone(doc);
  switch (op.type) {
    case 'insertFeatures': {
      next.parameters.push(...(op.parameters ?? []));
      next.profiles.push(...(op.profiles ?? []));
      next.sketches.push(...(op.sketches ?? []));
      next.features.push(...op.features);
      for (const b of op.bodies ?? []) addBody(next, b);
      resolveSketches(next, new Set((op.sketches ?? []).map((s) => s.id)));
      return next;
    }
    case 'insertImportedBody': {
      if (op.feature.type !== 'imported' || op.body.sourceFeatureId !== op.feature.id)
        fail('imported-feature');
      for (const a of op.assets) {
        const same = next.assets.find((x) => x.id === a.id);
        if (!same) next.assets.push(a);
        else if (canonicalJson(same) !== canonicalJson(a)) fail('asset-conflict');
      }
      next.features.push(op.feature);
      addBody(next, op.body);
      return next;
    }
    case 'setParameter': {
      const i = next.parameters.findIndex((p) => p.id === op.parameterId);
      if (i < 0) fail('target-missing');
      const { id, name, type } = next.parameters[i];
      next.parameters[i] =
        'expression' in op
          ? { id, name, type, expression: op.expression }
          : { id, name, type, value: op.value };
      const changed = dependentParameters(next.parameters, [id]);
      resolveSketches(
        next,
        new Set(
          next.sketches
            .filter((s) => sketchParameters(s).some((p) => changed.has(p)))
            .map((s) => s.id),
        ),
      );
      return next;
    }
    case 'updateSketch': {
      const s = find(next.sketches, op.sketchId, 'target-missing');
      s.plane = op.plane;
      s.entities = op.entities;
      s.constraints = op.constraints;
      s.solved = op.solved;
      resolveSketches(next, new Set([s.id]));
      return next;
    }
    case 'updateFeature': {
      const f = find(next.features, op.featureId, 'target-missing');
      (f as { args: unknown }).args = clone(op.args);
      // Arguments can change what a result is (a sew's `solid`): each body follows its result.
      for (const body of next.bodies)
        body.kind = featureKind(next, body.resultFeatureId) ?? body.kind;
      return next;
    }
    case 'updateProfile': {
      const p = find(next.profiles, op.profileId, 'target-missing');
      p.plane = clone(op.plane);
      p.shape = clone(op.shape);
      return next;
    }
    case 'transformBody': {
      const body = find(next.bodies, op.bodyId, 'target-missing');
      if (body.state !== 'active') fail('body-consumed');
      const t = find(next.features, body.resultFeatureId, 'target-missing');
      if (t.type !== 'transform') return fail('body-result-not-placement');
      if (!op.unbind && !isLiteralPosition(t.args.translation)) fail('placement-bound');
      if (next.features.some((f) => (f.inputFeatureIds as string[]).includes(t.id)))
        fail('placement-has-dependents');
      t.args = { translation: clone(op.translation), rotation: [...op.rotation] };
      return next;
    }
    case 'booleanBodies': {
      const toolIds = op.toolIds ?? [op.toolId!];
      if (!toolIds.length || new Set(toolIds).size !== toolIds.length) fail('boolean-tools');
      if (toolIds.includes(op.targetId)) fail('boolean-same-body');
      const target = find(next.bodies, op.targetId, 'target-missing');
      const tools = toolIds.map((id) => find(next.bodies, id, 'target-missing'));
      if (target.state !== 'active' || tools.some((t) => t.state !== 'active'))
        fail('body-consumed');
      next.features.push(
        {
          id: op.booleanFeatureId,
          name: generatedName(
            `${op.mode} `,
            tools.length === 1 ? tools[0]!.name : `${tools.length} bodies`,
            '',
          ),
          type: 'boolean',
          inputFeatureIds: [target.resultFeatureId, ...tools.map((t) => t.resultFeatureId)],
          args: { mode: op.mode },
        },
        placementFeature(
          op.placementFeatureId,
          op.booleanFeatureId,
          generatedName('', target.name, ' placement'),
        ),
      );
      target.resultFeatureId = op.placementFeatureId;
      for (const tool of tools) {
        const consumed: CadBody = {
          id: tool.id,
          name: tool.name,
          kind: tool.kind,
          resultFeatureId: tool.resultFeatureId,
          appearance: tool.appearance,
          state: 'consumed',
          consumedByFeatureId: op.booleanFeatureId,
        };
        next.bodies[next.bodies.indexOf(tool)] = consumed;
      }
      dropViewsFor(next, new Set(toolIds));
      return next;
    }
    case 'setBooleanTools': {
      const f = find(next.features, op.featureId, 'target-missing');
      if (f.type !== 'boolean') fail('boolean-feature');
      const current = next.bodies.filter(
        (b) => b.state === 'consumed' && b.consumedByFeatureId === f.id,
      );
      if (
        !op.toolIds.length ||
        new Set(op.toolIds).size !== op.toolIds.length ||
        op.toolIds.some((id) => !current.some((b) => b.id === id))
      )
        fail('boolean-tools');
      const byId = new Map(current.map((b) => [b.id, b]));
      f.inputFeatureIds = [
        f.inputFeatureIds[0]!,
        ...op.toolIds.map((id) => byId.get(id)!.resultFeatureId),
      ];
      for (const body of current)
        if (!op.toolIds.includes(body.id))
          next.bodies[next.bodies.indexOf(body)] = {
            id: body.id,
            name: body.name,
            kind: body.kind,
            resultFeatureId: body.resultFeatureId,
            appearance: body.appearance,
            state: 'active',
          };
      return next;
    }
    case 'patternBodies': {
      if (op.targetId === op.toolId) fail('boolean-same-body');
      const target = find(next.bodies, op.targetId, 'target-missing');
      const tool = find(next.bodies, op.toolId, 'target-missing');
      if (target.state !== 'active' || tool.state !== 'active') fail('body-consumed');
      next.features.push(
        {
          id: op.patternFeatureId,
          name: generatedName('pattern ', tool.name, ''),
          type: 'pattern',
          inputFeatureIds: [target.resultFeatureId, tool.resultFeatureId],
          args: { mode: op.mode, layout: clone(op.layout) },
        },
        placementFeature(
          op.placementFeatureId,
          op.patternFeatureId,
          generatedName('', target.name, ' placement'),
        ),
      );
      target.resultFeatureId = op.placementFeatureId;
      next.bodies[next.bodies.indexOf(tool)] = {
        id: tool.id,
        name: tool.name,
        kind: tool.kind,
        resultFeatureId: tool.resultFeatureId,
        appearance: tool.appearance,
        state: 'consumed',
        consumedByFeatureId: op.patternFeatureId,
      };
      dropViewsFor(next, new Set([tool.id]));
      return next;
    }
    case 'detailBody': {
      const body = find(next.bodies, op.bodyId, 'target-missing');
      if (body.state !== 'active') fail('body-consumed');
      const f = op.feature;
      if (!record(f) || !cadDetailTypes.includes(f.type)) fail('detail-type');
      if (
        !Array.isArray(f.inputFeatureIds) ||
        f.inputFeatureIds.length !== 1 ||
        f.inputFeatureIds[0] !== body.resultFeatureId
      )
        fail('detail-input');
      next.features.push(
        f,
        placementFeature(op.placementFeatureId, f.id, generatedName('', body.name, ' placement')),
      );
      body.resultFeatureId = op.placementFeatureId;
      // A thicken makes a solid of a sheet (R2a-3); the validation checks the kind it gives.
      body.kind = featureKind(next, f.id) ?? body.kind;
      return next;
    }
    case 'sewBodies': {
      if (!op.toolIds.length || new Set(op.toolIds).size !== op.toolIds.length) fail('sew-inputs');
      if (op.toolIds.includes(op.targetId)) fail('sew-same-body');
      const target = find(next.bodies, op.targetId, 'target-missing');
      const tools = op.toolIds.map((id) => find(next.bodies, id, 'target-missing'));
      if (target.state !== 'active' || tools.some((t) => t.state !== 'active'))
        fail('body-consumed');
      next.features.push(
        {
          id: op.sewFeatureId,
          name: generatedName('sew ', target.name, ''),
          type: 'sew',
          inputFeatureIds: [target.resultFeatureId, ...tools.map((t) => t.resultFeatureId)] as [
            string,
            string,
            ...string[],
          ],
          args: { toleranceMm: op.toleranceMm, solid: op.solid },
        },
        placementFeature(
          op.placementFeatureId,
          op.sewFeatureId,
          generatedName('', target.name, ' placement'),
        ),
      );
      target.resultFeatureId = op.placementFeatureId;
      target.kind = op.solid ? 'solid' : 'sheet';
      for (const tool of tools)
        next.bodies[next.bodies.indexOf(tool)] = {
          id: tool.id,
          name: tool.name,
          kind: tool.kind,
          resultFeatureId: tool.resultFeatureId,
          appearance: tool.appearance,
          state: 'consumed',
          consumedByFeatureId: op.sewFeatureId,
        };
      dropViewsFor(next, new Set(op.toolIds));
      return next;
    }
    case 'rebindReferences': {
      if (!Array.isArray(op.bindings) || !op.bindings.length) fail('rebind-empty');
      const edited = op.edit
        ? op.edit.type === ('rebindReferences' as string) ||
          op.edit.type === ('withSolvedPoses' as string)
          ? fail('rebind-nested')
          : apply(next, op.edit)
        : next;
      const seen = new Set<string>();
      for (const b of op.bindings) {
        const key = JSON.stringify([b.featureId, b.path]);
        if (seen.has(key)) fail('rebind-duplicate');
        seen.add(key);
        // A feature's path is in its args; a sketch's is in the sketch (its plane's face); a
        // joint's is in the joint (a connector's face or edge, R2b-2b).
        const f = edited.features.find((x) => x.id === b.featureId);
        const sketch = f ? undefined : edited.sketches.find((x) => x.id === b.featureId);
        const joint = f || sketch ? undefined : edited.joints.find((x) => x.id === b.featureId);
        if (!f && !sketch && !joint) fail('target-missing');
        if (!Array.isArray(b.path) || !b.path.length) return fail('rebind-path');
        if (
          joint &&
          !(['parent', 'child'] as const).some(
            (side) => JSON.stringify(jointRefPath(side)) === JSON.stringify(b.path),
          )
        )
          fail('rebind-path');
        let holder: unknown = f ? f.args : (sketch ?? joint);
        for (const k of b.path.slice(0, -1))
          holder =
            holder && typeof holder === 'object' && Object.hasOwn(holder, k)
              ? (holder as Record<string | number, unknown>)[k]
              : fail('rebind-path');
        const last = b.path[b.path.length - 1]!;
        const old =
          holder && typeof holder === 'object' && Object.hasOwn(holder, last)
            ? (holder as Record<string | number, unknown>)[last]
            : undefined;
        // Only a stored reference is replaced, by one of the same kind.
        if (!record(old) || !Object.hasOwn(old, 'name') || old.kind !== b.ref?.kind)
          fail('rebind-path');
        (holder as Record<string | number, unknown>)[last] = clone(b.ref);
      }
      return edited;
    }
    case 'deleteClosure': {
      const closure = dependencyClosure(next, op.ids);
      const roots = new Set(op.ids);
      const extra = [
        ...closure.parameters,
        ...closure.profiles,
        ...closure.sketches,
        ...closure.features,
        ...closure.bodies,
        ...closure.components,
        ...closure.patterns,
        ...closure.joints,
      ].filter((id) => !roots.has(id));
      // A body's own placement transform is part of deleting that body, not a dependent.
      const owned = new Set(
        next.bodies.filter((b) => roots.has(b.id)).map((b) => b.resultFeatureId),
      );
      if (!op.cascade && extra.some((id) => !owned.has(id))) fail('delete-has-dependents');
      next.parameters = next.parameters.filter((p) => !closure.parameters.has(p.id));
      next.profiles = next.profiles.filter((p) => !closure.profiles.has(p.id));
      next.sketches = next.sketches.filter((s) => !closure.sketches.has(s.id));
      next.features = next.features.filter((f) => !closure.features.has(f.id));
      next.bodies = next.bodies.filter((b) => !closure.bodies.has(b.id));
      for (const j of next.joints)
        if (closure.joints.has(j.id)) fixAtStoredPose(next, j.child.componentId);
      next.joints = next.joints.filter((j) => !closure.joints.has(j.id));
      next.components = next.components.filter((c) => !closure.components.has(c.id));
      next.componentPatterns = next.componentPatterns.filter((p) => !closure.patterns.has(p.id));
      dropViewsFor(next, closure.bodies);
      return next;
    }
    case 'duplicateClosure':
      return duplicate(next, op.bodyIds, op.idMap);
    case 'rename': {
      const targets = [
        ...next.parameters,
        ...next.profiles,
        ...next.sketches,
        ...next.features,
        ...next.bodies,
        ...next.namedViews,
        ...next.parts,
        ...next.components,
        ...next.componentPatterns,
        ...next.joints,
      ];
      find(targets, op.targetId, 'target-missing').name = op.name;
      return next;
    }
    case 'saveNamedView': {
      const i = next.namedViews.findIndex((v) => v.id === op.view.id);
      if (i < 0) next.namedViews.push(clone(op.view));
      else next.namedViews[i] = clone(op.view);
      return next;
    }
    case 'setKernelBuild': {
      if (op.buildHash === next.kernelProfile.buildHash) fail('kernel-build-unchanged');
      next.kernelProfile = { ...next.kernelProfile, id: op.kernelId, buildHash: op.buildHash };
      return next;
    }
    case 'setToleranceSet': {
      if (!Object.hasOwn(cadToleranceSets, op.set)) fail('tolerance-set-unknown');
      if (cadToleranceSetOf(next.kernelProfile) === op.set) fail('tolerance-set-unchanged');
      next.kernelProfile = { ...next.kernelProfile, ...cadToleranceSets[op.set] };
      return next;
    }
    case 'reorderFeatures': {
      if (
        op.featureIds.length !== next.features.length ||
        new Set(op.featureIds).size !== op.featureIds.length
      )
        fail('reorder-permutation');
      const byId = new Map(next.features.map((f) => [f.id, f]));
      next.features = op.featureIds.map((id) => byId.get(id) ?? fail('reorder-permutation'));
      return next;
    }
    case 'insertComponents':
    case 'setComponentPlacement':
    case 'setPartProperties':
    case 'setComponentBom':
    case 'insertComponentPattern':
    case 'updateComponentPattern':
    case 'replacePartSources':
      return applyAssemblyOperation(next, op);
    case 'insertJoint':
    case 'updateJoint':
    case 'setJointValues':
    case 'solveAssemblyPoses':
      return applyJointOperation(next, op);
  }
}

/**
 * What `duplicateClosure` copies for these active bodies: their upstream features, the profiles
 * and parameters those read, the bodies in the closure, and polyline vertex IDs. `idMap` names
 * every one of `ids`.
 */
export function duplicateClosureOf(doc: CadDocument, bodyIds: readonly string[]) {
  const bodies = bodyIds.map((id) => find(doc.bodies, id, 'target-missing'));
  if (bodies.some((b) => b.state !== 'active')) fail('body-consumed');
  // The upstream features, and through each sketch they sweep the features it is attached to,
  // until nothing is added: the copy refers to nothing outside it.
  const byId = new Map(doc.sketches.map((s) => [s.id, s]));
  const roots = new Set(bodies.map((b) => b.resultFeatureId));
  let features: Set<string>;
  let reads: ReturnType<typeof featureReads>[];
  for (;;) {
    features = upstreamFeatures(doc.features, roots);
    reads = doc.features.filter((f) => features.has(f.id)).map(featureReads);
    const size = roots.size;
    for (const id of reads.flatMap((r) => r.sketches)) {
      const face = byId.get(id) && sketchAttachment(byId.get(id)!);
      if (face !== undefined) roots.add(face);
    }
    // Edges a surface feature reads are copied with it, as a sketch's face is.
    for (const f of doc.features)
      if (features.has(f.id)) for (const x of featureReferenceSources(f)) roots.add(x);
    if (roots.size === size) break;
  }
  const profiles = new Set(reads.flatMap((r) => r.profiles));
  const sketches = new Set(reads.flatMap((r) => r.sketches));
  const parameters = parameterClosure(doc.parameters, [
    ...reads.flatMap((r) => r.parameters),
    ...doc.profiles.filter((p) => profiles.has(p.id)).flatMap(profileParameters),
    ...doc.sketches.filter((s) => sketches.has(s.id)).flatMap(sketchParameters),
  ]);
  const copiedBodies = doc.bodies.filter(
    (b) =>
      bodyIds.includes(b.id) ||
      (b.state === 'consumed' &&
        features.has(b.consumedByFeatureId) &&
        features.has(b.resultFeatureId)),
  );
  const vertexIds = doc.profiles
    .filter((p) => profiles.has(p.id) && p.shape.type === 'polyline')
    .flatMap((p) => (p.shape.type === 'polyline' ? p.shape.vertices.map((v) => v.id) : []));
  const ids = [
    ...parameters,
    ...profiles,
    ...sketches,
    ...features,
    ...copiedBodies.map((b) => b.id),
    ...vertexIds,
  ];
  return { ids, parameters, profiles, sketches, features, copiedBodies };
}
/** Copies the selected active bodies with their complete upstream closure; `idMap` must name every copied ID. */
function duplicate(
  doc: CadDocument,
  bodyIds: string[],
  idMap: Record<string, string>,
): CadDocument {
  const {
    ids: sources,
    parameters,
    profiles,
    sketches,
    features,
    copiedBodies,
  } = duplicateClosureOf(doc, bodyIds);
  if (
    Object.keys(idMap).length !== sources.length ||
    sources.some((id) => !cadId(idMap[id] as unknown))
  )
    fail('duplicate-id-map');
  const remap = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(remap);
    if (value && typeof value === 'object') {
      // A stored reference names faces by IDs too (`tool:<id>/…`, `side:v:<vertex ID>`): the
      // copy's names.
      const ref = record(value) && Object.hasOwn(value, 'hint') && Object.hasOwn(value, 'name');
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          typeof v === 'string' &&
          [
            'id',
            'parameterId',
            'profileId',
            'sketchId',
            'resultFeatureId',
            'consumedByFeatureId',
            'featureId',
          ].includes(k) &&
          Object.hasOwn(idMap, v)
            ? idMap[v]
            : k === 'inputFeatureIds'
              ? (v as string[]).map((i) => idMap[i] ?? fail('duplicate-closure'))
              : ref && k === 'name'
                ? remapTopoName(v as CadTopologyRef['name'], idMap)
                : ref && k === 'select'
                  ? {
                      adjacent: (v as { adjacent: CadTopologyRef['name'][] }).adjacent.map((n) =>
                        remapTopoName(n, idMap),
                      ),
                    }
                  : remap(v),
        ]),
      );
    }
    return value;
  };
  const copy = <T>(items: T[], keep: (x: T) => boolean) =>
    items.filter(keep).map((x) => remap(x) as T);
  doc.parameters.push(...copy(doc.parameters, (p) => parameters.has(p.id)));
  doc.profiles.push(...copy(doc.profiles, (p) => profiles.has(p.id)));
  // Element and constraint IDs are local to a sketch: only its own ID, plane and dimension
  // parameters follow the map.
  doc.sketches.push(
    ...doc.sketches
      .filter((s) => sketches.has(s.id))
      .map((s) => ({
        ...s,
        id: idMap[s.id],
        plane: remap(s.plane) as CadSketch['plane'],
        constraints: s.constraints.map((k) => ({ ...(remap(k) as typeof k), id: k.id })),
      })),
  );
  doc.features.push(...copy(doc.features, (f) => features.has(f.id)));
  doc.bodies.push(...copy(doc.bodies, (b) => copiedBodies.includes(b)));
  return doc;
}

/** Pure, atomic: returns a validated new document or throws without touching `doc`. */
/** A derived name that stays within `cadLimits.nameCodePoints` by shortening the body name. */
function generatedName(prefix: string, name: string, suffix: string) {
  const room = cadLimits.nameCodePoints - [...prefix].length - [...suffix].length;
  return `${prefix}${[...name].slice(0, room).join('')}${suffix}`;
}
export function applyCadOperation(doc: CadDocument, op: CadOperation): CadDocument {
  const solved = op.type === 'withSolvedPoses' ? op : undefined;
  const next = apply(
    doc,
    solved ? solved.edit : (op as Exclude<CadOperation, { type: 'withSolvedPoses' }>),
  );
  pruneAssets(next);
  settleAssembly(next);
  if (solved) writeSolvedPoses(next, solved.poses);
  assertCad(next);
  return next;
}
