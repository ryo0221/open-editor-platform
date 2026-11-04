import { canonicalJson, clone, contentHash } from '@editor-platform/artifact-core';
import type { LocalDraftRevision } from '@editor-platform/editor-core';
import {
  appearance,
  applyDesignOverride,
  validDesignRasterProvenance,
  type DesignContent,
} from '@editor-platform/design/model';
import {
  creativeDesignFocus,
  creativeDesignAddressKey,
  type CreativeDesignAddress,
} from '@editor-platform/design/creative-proposal-diff';
import { readWorldContexts, type WorldReference } from './world-context';

export interface CreativeWorldIdentity {
  schemaVersion: 1;
  operationId: string;
  requestId: string;
  payloadHash: string;
  fingerprint: string;
}
export interface CreativeWorldResultManifest {
  identity: CreativeWorldIdentity;
  srcHash: string;
  source: string;
  license: string;
  name?: string;
}
export interface CreativeWorldExecutionRecord {
  schemaVersion: 1;
  operationId: string;
  revision: number;
  namespace: string;
  requestId: string;
  scope: {
    mode: 'character' | 'setting';
    itemId: string;
    candidateContextId: string;
    sceneId?: string;
    artifactId: string;
    frameId: string;
    address: CreativeDesignAddress;
  };
  context: {
    fingerprint: string;
    payloadHash: string;
    adoptions: { id: string; revision: number }[];
    references: { contextId: string; reference: WorldReference; projectionHash: string }[];
  };
  state:
    | 'prepared'
    | 'preview'
    | 'applying'
    | 'applied'
    | 'rejected'
    | 'cancelled'
    | 'stale'
    | 'uncertain';
  result?: { srcHash: string; source: string; license: string };
  proposalId?: string;
  applied?: {
    transactionId: string;
    beforeRevision: LocalDraftRevision;
    revision: LocalDraftRevision;
    imageHash: string;
    targetHash: string;
    srcHash: string;
    source: string;
    license: string;
  };
  usages: {
    artifactId: string;
    versionId: string;
    contentHash: string;
    targetHash: string;
    derived: boolean;
  }[];
}
/** Trusted Host storage: authorize and compare/write atomically at the real storage boundary. */
export interface CreativeWorldRecordStorage {
  list(namespace: string, artifactId: string): Promise<unknown>;
  write(
    record: Readonly<CreativeWorldExecutionRecord>,
    expectedRevision: number | null,
  ): Promise<void>;
}
const object = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v)) &&
  Object.keys(v).every((k) => keys.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 4096;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const revision = (v: unknown) =>
  object(v, ['kind', 'sessionId', 'sequence']) &&
  v.kind === 'local-draft' &&
  id(v.sessionId) &&
  Number.isSafeInteger(v.sequence) &&
  Number(v.sequence) >= 0;
const terms = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 1024;
const invalid = () => Error('World実行記録の形式・対象・版・hashが不正です。');
export function readCreativeWorldIdentity(raw: unknown): CreativeWorldIdentity {
  const v = clone(raw) as CreativeWorldIdentity;
  if (
    !object(v, ['schemaVersion', 'operationId', 'requestId', 'payloadHash', 'fingerprint']) ||
    v.schemaVersion !== 1 ||
    !id(v.operationId) ||
    !id(v.requestId) ||
    !hash(v.payloadHash) ||
    !hash(v.fingerprint)
  )
    throw invalid();
  return v;
}
export function readCreativeWorldResultManifest(raw: unknown): CreativeWorldResultManifest {
  const v = clone(raw) as CreativeWorldResultManifest;
  if (
    !object(v, ['identity', 'srcHash', 'source', 'license', 'name']) ||
    !hash(v.srcHash) ||
    !terms(v.source) ||
    !terms(v.license) ||
    (v.name !== undefined && (typeof v.name !== 'string' || v.name.length > 160))
  )
    throw invalid();
  readCreativeWorldIdentity(v.identity);
  return v;
}
/** Closed structural validator; this is neither authority nor evidence of native apply. No body/PNG is stored. */
export function readCreativeWorldExecutionRecord(raw: unknown): CreativeWorldExecutionRecord {
  const v = clone(raw) as CreativeWorldExecutionRecord;
  if (
    !object(v, [
      'schemaVersion',
      'operationId',
      'revision',
      'namespace',
      'requestId',
      'scope',
      'context',
      'state',
      'result',
      'proposalId',
      'applied',
      'usages',
    ]) ||
    v.schemaVersion !== 1 ||
    !id(v.operationId) ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 1 ||
    !id(v.namespace) ||
    !id(v.requestId) ||
    !object(v.scope, [
      'mode',
      'itemId',
      'candidateContextId',
      'sceneId',
      'artifactId',
      'frameId',
      'address',
    ]) ||
    !['character', 'setting'].includes(v.scope.mode) ||
    ![v.scope.itemId, v.scope.candidateContextId, v.scope.artifactId, v.scope.frameId].every(id) ||
    (v.scope.sceneId !== undefined && !id(v.scope.sceneId)) ||
    !object(v.context, ['fingerprint', 'payloadHash', 'adoptions', 'references']) ||
    !hash(v.context.fingerprint) ||
    !hash(v.context.payloadHash) ||
    !Array.isArray(v.context.adoptions) ||
    !Array.isArray(v.context.references) ||
    v.context.references.length > 64 ||
    ![
      'prepared',
      'preview',
      'applying',
      'applied',
      'rejected',
      'cancelled',
      'stale',
      'uncertain',
    ].includes(v.state) ||
    (v.proposalId !== undefined && !id(v.proposalId)) ||
    !Array.isArray(v.usages) ||
    v.usages.length > 256 ||
    new TextEncoder().encode(canonicalJson(v)).length > 512 * 1024
  )
    throw invalid();
  creativeDesignAddressKey(v.scope.address);
  const ids = ['work', ...(v.scope.sceneId ? [v.scope.sceneId] : []), v.scope.candidateContextId];
  if (
    v.context.adoptions.length !== ids.length ||
    v.context.adoptions.some((a, i) => !object(a, ['id', 'revision']) || a.id !== ids[i])
  )
    throw invalid();
  if (
    v.context.references.some(
      (r) =>
        !object(r, ['contextId', 'reference', 'projectionHash']) ||
        !ids.includes(r.contextId) ||
        !hash(r.projectionHash),
    )
  )
    throw invalid();
  readWorldContexts({
    namespace: v.namespace,
    contexts: v.context.adoptions.map((a) => ({
      ...a,
      references: v.context.references.filter((r) => r.contextId === a.id).map((r) => r.reference),
    })),
  });
  if (
    v.result !== undefined &&
    (!object(v.result, ['srcHash', 'source', 'license']) ||
      !hash(v.result.srcHash) ||
      !terms(v.result.source) ||
      !terms(v.result.license))
  )
    throw invalid();
  if (
    v.applied !== undefined &&
    (!object(v.applied, [
      'transactionId',
      'beforeRevision',
      'revision',
      'imageHash',
      'targetHash',
      'srcHash',
      'source',
      'license',
    ]) ||
      !id(v.applied.transactionId) ||
      !revision(v.applied.beforeRevision) ||
      !revision(v.applied.revision) ||
      v.applied.beforeRevision.sessionId !== v.applied.revision.sessionId ||
      v.applied.revision.sequence !== v.applied.beforeRevision.sequence + 1 ||
      ![v.applied.imageHash, v.applied.targetHash, v.applied.srcHash].every(hash) ||
      !terms(v.applied.source) ||
      !terms(v.applied.license) ||
      !v.result ||
      v.applied.srcHash !== v.result.srcHash)
  )
    throw invalid();
  if (v.state === 'applied' && !v.applied) throw invalid();
  const versions = new Set<string>();
  for (const u of v.usages) {
    if (
      !object(u, ['artifactId', 'versionId', 'contentHash', 'targetHash', 'derived']) ||
      u.artifactId !== v.scope.artifactId ||
      !id(u.versionId) ||
      !hash(u.contentHash) ||
      !hash(u.targetHash) ||
      typeof u.derived !== 'boolean' ||
      !v.applied ||
      versions.has(u.versionId)
    )
      throw invalid();
    versions.add(u.versionId);
  }
  return v;
}
/** Public qualified address rules, same effective Instance override as native projection. */
export function worldGenerationTarget(
  content: DesignContent,
  address: CreativeDesignAddress,
  frameId?: string,
) {
  creativeDesignFocus(content, address);
  if (frameId) {
    if (!content.elements.some((e) => e.id === frameId && e.type === 'frame' && !e.parentId))
      throw Error('採用先のFrameがありません。');
    const owners = address.componentId
      ? content.elements.filter(
          (e) =>
            e.type === 'instance' &&
            e.componentId === address.componentId &&
            e.parentId === frameId &&
            (!address.instanceId || e.id === address.instanceId),
        )
      : content.elements.filter((e) => e.id === address.elementId && e.parentId === frameId);
    if (owners.length !== 1)
      throw Error('採用先のFrame・qualified addressの対応が欠落・曖昧です。');
  }
  let element = address.componentId
    ? content.components
        .find((c) => c.id === address.componentId)!
        .elements!.find((e) => e.id === address.elementId)!
    : content.elements.find((e) => e.id === address.elementId)!;
  if (address.instanceId) {
    const override = content.elements.find((e) => e.id === address.instanceId)!.overrides?.[
      element.id
    ];
    element = applyDesignOverride(
      appearance(content, {
        ...element,
        ...(override?.styleId ? { styleId: override.styleId } : {}),
      }),
      override,
    );
  } else element = appearance(content, element);
  if (
    element.type !== 'image' ||
    !element.src ||
    !validDesignRasterProvenance(element.provenance) ||
    element.provenance.src !== element.src
  )
    throw Error('適用画像とnative来歴の対応が不正です。');
  return clone(element);
}
export async function worldGenerationEvidence(
  content: DesignContent,
  address: CreativeDesignAddress,
  frameId?: string,
) {
  const target = worldGenerationTarget(content, address, frameId),
    provenance = target.provenance!;
  return {
    imageHash: await contentHash({ src: target.src, provenance }),
    targetHash: await contentHash(target),
    srcHash: await contentHash(target.src),
    source: provenance.source,
    license: provenance.license,
  };
}
/** Actual operation ancestry or an already confirmed base usage must be supplied by the caller. */
export async function matchWorldSavedTarget(
  record: CreativeWorldExecutionRecord,
  content: DesignContent,
) {
  if (!record.applied) return undefined;
  const target = worldGenerationTarget(content, record.scope.address, record.scope.frameId);
  const proof = await worldGenerationEvidence(content, record.scope.address, record.scope.frameId);
  if (proof.imageHash === record.applied.imageHash)
    return {
      targetHash: proof.targetHash,
      derived: proof.targetHash !== record.applied.targetHash,
    };
  for (const ancestor of target.provenance!.lineage ?? [])
    if (
      ancestor.source === record.applied.source &&
      ancestor.license === record.applied.license &&
      (await contentHash(ancestor.src)) === record.applied.srcHash
    )
      return { targetHash: proof.targetHash, derived: true };
  return undefined;
}
