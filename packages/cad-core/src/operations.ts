import { canonicalJson, clone } from '@editor-platform/artifact-core';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import {
  downstreamFeatures,
  featureReads,
  isLiteralPosition,
  profileParameters,
  upstreamFeatures,
} from './graph';
import {
  cadLimits,
  identityQuaternion,
  position,
  type CadAppearance,
  type CadBody,
  type CadDocument,
  type CadFeature,
  type CadNamedView,
  type CadParameter,
  type CadProfile,
  type Position3,
  type Quaternion,
} from './model';
import { assertCad, cadId } from './validation';

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
      features: CadFeature[];
      bodies?: CadNewBody[];
    }
  | { type: 'setParameter'; parameterId: string; value: number }
  | { type: 'updateFeature'; featureId: string; args: CadFeature['args'] }
  | {
      type: 'updateProfile';
      profileId: string;
      plane: CadProfile['plane'];
      shape: CadProfile['shape'];
    }
  | {
      type: 'transformBody';
      bodyId: string;
      translation: Position3;
      rotation: Quaternion;
      unbind?: true;
    }
  | {
      type: 'booleanBodies';
      targetId: string;
      toolId: string;
      mode: 'union' | 'cut' | 'common';
      booleanFeatureId: string;
      placementFeatureId: string;
    }
  | { type: 'deleteClosure'; ids: string[]; cascade: boolean }
  | { type: 'duplicateClosure'; bodyIds: string[]; idMap: Record<string, string> }
  | { type: 'rename'; targetId: string; name: string }
  | { type: 'saveNamedView'; view: CadNamedView }
  | { type: 'reorderFeatures'; featureIds: string[] };
export type CadOperationType = CadOperation['type'];

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

/** Every dependent of the given IDs: features reading them, bodies on removed results, consumed tools of removed Booleans. */
export function dependencyClosure(doc: CadDocument, ids: Iterable<string>) {
  const roots = new Set(ids);
  const features = new Set<string>();
  for (const f of doc.features) {
    const reads = featureReads(f);
    if (
      roots.has(f.id) ||
      reads.parameters.some((p) => roots.has(p)) ||
      reads.profiles.some((p) => roots.has(p))
    )
      features.add(f.id);
  }
  const profiles = new Set(
    doc.profiles
      .filter((p) => roots.has(p.id) || profileParameters(p).some((x) => roots.has(x)))
      .map((p) => p.id),
  );
  for (const f of doc.features)
    if (featureReads(f).profiles.some((p) => profiles.has(p))) features.add(f.id);
  for (const b of doc.bodies) if (roots.has(b.id)) features.add(b.resultFeatureId);
  for (const id of downstreamFeatures(doc.features, features)) features.add(id);
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
  const parameters = new Set(doc.parameters.filter((p) => roots.has(p.id)).map((p) => p.id));
  const known = new Set([...parameters, ...profiles, ...features, ...bodies]);
  for (const id of roots) if (!known.has(id)) fail('target-missing');
  return { parameters, profiles, features, bodies };
}

function apply(doc: CadDocument, input: CadOperation): CadDocument {
  // Own the payload too: the result is frozen by EditorSession and must not alias caller data.
  const op = clone(input);
  const next = clone(doc);
  switch (op.type) {
    case 'insertFeatures': {
      next.parameters.push(...(op.parameters ?? []));
      next.profiles.push(...(op.profiles ?? []));
      next.features.push(...op.features);
      for (const b of op.bodies ?? []) {
        next.features.push(
          placementFeature(
            b.placementFeatureId,
            b.sourceFeatureId,
            generatedName('', b.name, ' placement'),
          ),
        );
        next.bodies.push({
          id: b.id,
          name: b.name,
          resultFeatureId: b.placementFeatureId,
          state: 'active',
          appearance: b.appearance,
        });
      }
      return next;
    }
    case 'setParameter':
      find(next.parameters, op.parameterId, 'target-missing').value = op.value;
      return next;
    case 'updateFeature': {
      const f = find(next.features, op.featureId, 'target-missing');
      (f as { args: unknown }).args = clone(op.args);
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
      if (op.targetId === op.toolId) fail('boolean-same-body');
      const target = find(next.bodies, op.targetId, 'target-missing');
      const tool = find(next.bodies, op.toolId, 'target-missing');
      if (target.state !== 'active' || tool.state !== 'active') fail('body-consumed');
      next.features.push(
        {
          id: op.booleanFeatureId,
          name: generatedName(`${op.mode} `, tool.name, ''),
          type: 'boolean',
          inputFeatureIds: [target.resultFeatureId, tool.resultFeatureId],
          args: { mode: op.mode },
        },
        placementFeature(
          op.placementFeatureId,
          op.booleanFeatureId,
          generatedName('', target.name, ' placement'),
        ),
      );
      target.resultFeatureId = op.placementFeatureId;
      const consumed: CadBody = {
        id: tool.id,
        name: tool.name,
        resultFeatureId: tool.resultFeatureId,
        appearance: tool.appearance,
        state: 'consumed',
        consumedByFeatureId: op.booleanFeatureId,
      };
      next.bodies[next.bodies.indexOf(tool)] = consumed;
      dropViewsFor(next, new Set([tool.id]));
      return next;
    }
    case 'deleteClosure': {
      const closure = dependencyClosure(next, op.ids);
      const roots = new Set(op.ids);
      const extra = [
        ...closure.parameters,
        ...closure.profiles,
        ...closure.features,
        ...closure.bodies,
      ].filter((id) => !roots.has(id));
      // A body's own placement transform is part of deleting that body, not a dependent.
      const owned = new Set(
        next.bodies.filter((b) => roots.has(b.id)).map((b) => b.resultFeatureId),
      );
      if (!op.cascade && extra.some((id) => !owned.has(id))) fail('delete-has-dependents');
      next.parameters = next.parameters.filter((p) => !closure.parameters.has(p.id));
      next.profiles = next.profiles.filter((p) => !closure.profiles.has(p.id));
      next.features = next.features.filter((f) => !closure.features.has(f.id));
      next.bodies = next.bodies.filter((b) => !closure.bodies.has(b.id));
      dropViewsFor(next, closure.bodies);
      return next;
    }
    case 'duplicateClosure':
      return duplicate(next, op.bodyIds, op.idMap);
    case 'rename': {
      const targets = [
        ...next.parameters,
        ...next.profiles,
        ...next.features,
        ...next.bodies,
        ...next.namedViews,
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
  }
}

/** Copies the selected active bodies with their complete upstream closure; `idMap` must name every copied ID. */
function duplicate(
  doc: CadDocument,
  bodyIds: string[],
  idMap: Record<string, string>,
): CadDocument {
  const bodies = bodyIds.map((id) => find(doc.bodies, id, 'target-missing'));
  if (bodies.some((b) => b.state !== 'active')) fail('body-consumed');
  const features = upstreamFeatures(
    doc.features,
    bodies.map((b) => b.resultFeatureId),
  );
  const reads = doc.features.filter((f) => features.has(f.id)).map(featureReads);
  const profiles = new Set(reads.flatMap((r) => r.profiles));
  const parameters = new Set([
    ...reads.flatMap((r) => r.parameters),
    ...doc.profiles.filter((p) => profiles.has(p.id)).flatMap(profileParameters),
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
  const sources = [
    ...parameters,
    ...profiles,
    ...features,
    ...copiedBodies.map((b) => b.id),
    ...vertexIds,
  ];
  if (
    Object.keys(idMap).length !== sources.length ||
    sources.some((id) => !cadId(idMap[id] as unknown))
  )
    fail('duplicate-id-map');
  const remap = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(remap);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          typeof v === 'string' &&
          ['id', 'parameterId', 'profileId', 'resultFeatureId', 'consumedByFeatureId'].includes(
            k,
          ) &&
          Object.hasOwn(idMap, v)
            ? idMap[v]
            : k === 'inputFeatureIds'
              ? (v as string[]).map((i) => idMap[i] ?? fail('duplicate-closure'))
              : remap(v),
        ]),
      );
    return value;
  };
  const copy = <T>(items: T[], keep: (x: T) => boolean) =>
    items.filter(keep).map((x) => remap(x) as T);
  doc.parameters.push(...copy(doc.parameters, (p) => parameters.has(p.id)));
  doc.profiles.push(...copy(doc.profiles, (p) => profiles.has(p.id)));
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
  const next = apply(doc, op);
  assertCad(next);
  return next;
}
