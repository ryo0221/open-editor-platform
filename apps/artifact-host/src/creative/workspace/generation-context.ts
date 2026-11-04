import { validDesignRasterProvenance } from '@editor-platform/design/model';
import { emptyCreativeLayerPng } from '../generation';
import { canonicalJson, clone, contentHash } from '@editor-platform/artifact-core';
import {
  readPreparedCreativeLayerInput,
  type CreativeLayerPreparation,
  type CreativeLayerRequest,
} from '../generation';
import type { CreativeWorkspace } from './model';
import {
  readWorldContexts,
  type WorldReference,
  type WorldSamplePermission,
} from './world-context';

/** Host execution input, never an Artifact, native provenance, or a v1 request field. */
export interface CreativeWorldContextSnapshot {
  schemaVersion: 1;
  resolutionVersion: 1;
  namespace: string;
  scope: {
    mode: 'character' | 'setting';
    itemId: string;
    candidateContextId: string;
    sceneId?: string;
  };
  adoptions: { id: string; revision: number }[];
  references: {
    contextId: string;
    reference: WorldReference;
    projection: {
      kind: 'text' | 'svg';
      value: string;
      rasterSources?: CreativeLayerRequest['rough']['rasterSources'];
    };
    projectionHash: string;
  }[];
  fingerprint: string;
}
export interface CreativeWorldInput {
  editorRequest: CreativeLayerRequest;
  context: CreativeWorldContextSnapshot;
}
export interface CreativeWorldInputOptions {
  mode: 'character' | 'setting';
  itemId: string;
  sceneId?: string;
  /** Host activity/authority epoch: must also reject a switched workspace or Scene. */
  assertActive(): void;
  /** Separate from reading. Includes source, rough/current images and their terms. */
  maySendEditorRequest(request: Readonly<CreativeLayerRequest>): boolean;
  /** Permission to send/export this exact reference, separate from mayRead. */
  maySendReference(reference: Readonly<WorldReference>): boolean;
  /** Each effective sample raster needs its own source/license send decision. */
  maySendSampleImage?: WorldSamplePermission;
}
export const creativeWorldInputLimits = Object.freeze({
  references: 64,
  textBytes: 64 * 1024,
  samples: 8,
  envelopeBytes: 12 * 1024 * 1024,
} as const);
const object = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v)) &&
  Object.keys(v).every((key) => keys.includes(key));
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 4096;
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const bytes = (text: string) => new TextEncoder().encode(text).length;
const invalid = () => Error('制作前提snapshotの構造・投影・hashが不正です。');
/** Pure byte-budget calculation; this does not establish input authority. */
export function serializeCreativeWorldInput(input: CreativeWorldInput) {
  const json = canonicalJson(input);
  if (bytes(json) > creativeWorldInputLimits.envelopeBytes)
    throw Error('生成入力全体は12MiBまでです。資料を切り捨てずに再準備してください。');
  return json;
}
function fingerprintInput(c: CreativeWorldContextSnapshot) {
  return {
    schemaVersion: c.schemaVersion,
    resolutionVersion: c.resolutionVersion,
    namespace: c.namespace,
    scope: c.scope,
    references: c.references.map(({ contextId, reference, projectionHash }) => ({
      contextId,
      reference,
      projectionHash,
    })),
  };
}
/** Closed snapshot validator. It verifies integrity, never current permission or retention. */
export async function readCreativeWorldContext(
  raw: unknown,
): Promise<CreativeWorldContextSnapshot> {
  // Clone before any await: a caller cannot replace a validated field while hashing.
  const c = clone(raw) as CreativeWorldContextSnapshot;
  if (
    !object(c, [
      'schemaVersion',
      'resolutionVersion',
      'namespace',
      'scope',
      'adoptions',
      'references',
      'fingerprint',
    ]) ||
    c.schemaVersion !== 1 ||
    c.resolutionVersion !== 1 ||
    !id(c.namespace) ||
    !object(c.scope, ['mode', 'itemId', 'candidateContextId', 'sceneId']) ||
    !['character', 'setting'].includes(c.scope.mode) ||
    !id(c.scope.itemId) ||
    !id(c.scope.candidateContextId) ||
    (c.scope.sceneId !== undefined && !id(c.scope.sceneId)) ||
    !Array.isArray(c.adoptions) ||
    !Array.isArray(c.references) ||
    c.references.length > creativeWorldInputLimits.references ||
    !digest(c.fingerprint)
  )
    throw invalid();
  const ids = ['work', ...(c.scope.sceneId ? [c.scope.sceneId] : []), c.scope.candidateContextId];
  if (
    new Set(ids).size !== ids.length ||
    c.adoptions.length !== ids.length ||
    c.adoptions.some((a, i) => !object(a, ['id', 'revision']) || a.id !== ids[i])
  )
    throw invalid();
  if (bytes(canonicalJson(c)) > creativeWorldInputLimits.envelopeBytes)
    throw Error('制作前提snapshotが12MiBを超えています。');
  let textBytes = 0,
    samples = 0;
  for (const r of c.references) {
    if (
      !object(r, ['contextId', 'reference', 'projection', 'projectionHash']) ||
      !ids.includes(r.contextId) ||
      !digest(r.projectionHash) ||
      !object(r.projection, ['kind', 'value', 'rasterSources']) ||
      typeof r.projection.value !== 'string' ||
      !object(r.reference, [
        'id',
        'role',
        'namespace',
        'artifactId',
        'versionId',
        'contentHash',
        'selector',
        'required',
      ]) ||
      (r.reference.role === 'sample' ? r.projection.kind !== 'svg' : r.projection.kind !== 'text')
    )
      throw invalid();
    const sources = r.projection.rasterSources;
    if (
      sources !== undefined &&
      (r.projection.kind !== 'svg' ||
        !Array.isArray(sources) ||
        sources.some((source) => {
          if (
            !object(source, ['elementId', 'source', 'license', 'lineage']) ||
            !id(source.elementId) ||
            (source.lineage !== undefined &&
              (!Array.isArray(source.lineage) ||
                source.lineage.some(
                  (ancestor) =>
                    !object(ancestor, [
                      'source',
                      'license',
                      'name',
                      'version',
                      'elementId',
                      'artifactId',
                      'versionId',
                    ]),
                )))
          )
            return true;
          const { elementId: _elementId, lineage, ...terms } = source;
          return !validDesignRasterProvenance({
            ...terms,
            src: emptyCreativeLayerPng,
            ...(lineage
              ? {
                  lineage: lineage.map((ancestor) => ({ ...ancestor, src: emptyCreativeLayerPng })),
                }
              : {}),
          });
        }))
    )
      throw invalid();
    if (r.projection.kind === 'text') textBytes += bytes(r.projection.value);
    else samples++;
  }
  if (textBytes > creativeWorldInputLimits.textBytes || samples > creativeWorldInputLimits.samples)
    throw Error('制作前提は本文64KiB・見本8件までです。切り捨てずに再選択してください。');
  readWorldContexts({
    namespace: c.namespace,
    contexts: c.adoptions.map((a) => ({
      ...a,
      references: c.references.filter((r) => r.contextId === a.id).map((r) => r.reference),
    })),
  });
  for (const r of c.references)
    if ((await contentHash(r.projection)) !== r.projectionHash) throw invalid();
  if ((await contentHash(fingerprintInput(c))) !== c.fingerprint) throw invalid();
  return c;
}

/**
 * CW2a preparation only. No provider dispatch, import, apply, receipt or UI enablement.
 * Every getter/preflight guards live authority. Previously handed out copies cannot be recalled.
 */
export async function prepareCreativeWorldInput(
  workspace: CreativeWorkspace,
  preparation: CreativeLayerPreparation,
  options: CreativeWorldInputOptions,
) {
  const {
    mode,
    itemId,
    sceneId,
    assertActive,
    maySendEditorRequest,
    maySendReference,
    maySendSampleImage,
  } = options;
  const {
    request,
    sourceContentHash,
    assertReadable: assertNativeReadable,
  } = readPreparedCreativeLayerInput(preparation);
  const select = () => {
    const mapping = workspace.mapping,
      p = workspace.project(mode);
    const card = p.cards.find((c) => c.id === itemId),
      binding = card && p.binding(card);
    const candidateContextId = workspace.itemContextId(mode, itemId);
    if (
      !card ||
      !binding ||
      !candidateContextId ||
      canonicalJson(request.source) !==
        canonicalJson({ ...p.mapping.source, itemId, elementId: card.elementId }) ||
      request.frameId !== binding.chosenFrameId ||
      request.currentReference.artifactId !== binding.design.artifactId ||
      request.currentReference.versionId !== binding.design.versionId ||
      request.currentReference.frameId !== request.frameId
    )
      throw Error('生成対象と作品・選択候補の対応が変わりました。再準備してください。');
    const scene = sceneId ? workspace.scene(sceneId) : undefined;
    const item = scene?.items.find((i) => i.mode === mode && i.itemId === itemId);
    if (scene && !item) throw Error('このSceneには生成対象の人物・場所が接続されていません。');
    if (
      item &&
      (canonicalJson(item.source) !==
        canonicalJson({
          artifactId: request.source.artifactId,
          versionId: request.source.versionId,
          elementId: request.source.elementId,
        }) ||
        canonicalJson(item.artwork) !==
          canonicalJson({
            artifactId: request.currentReference.artifactId,
            versionId: request.currentReference.versionId,
            elementId: request.frameId,
          }))
    )
      throw Error('Sceneの採用参照が生成対象と異なります。Scene参照を明示更新してください。');
    if (!mapping.world) throw Error('作品設定を接続してください。');
    readWorldContexts(mapping.world);
    const scope = { mode, itemId, candidateContextId, ...(sceneId ? { sceneId } : {}) };
    const contexts = ['work', ...(sceneId ? [sceneId] : []), candidateContextId].map((id) =>
      workspace.worldContext(id),
    );
    return {
      namespace: mapping.world.namespace,
      scope,
      contexts,
      ...(scene
        ? {
            scene: {
              id: scene.id,
              kind: scene.kind,
              origin: scene.origin,
              members: scene.members,
              item,
            },
          }
        : {}),
    };
  };
  const adopted = select(),
    identity = canonicalJson(adopted);
  if (
    adopted.contexts.flatMap((c) => c.references).filter((r) => r.role === 'sample').length >
    creativeWorldInputLimits.samples
  )
    throw Error('制作前提の見本は8件までです。切り捨てずに再選択してください。');
  const sampleKeys = new Set<string>();
  const sampleChecks: (() => void)[] = [];
  // Capture original IDs, especially Scene origin; never resolve a replacement when reading a cached input.
  const readArtifactIds = [
    request.source.artifactId,
    request.rough.artifactId,
    request.currentReference.artifactId,
    ...(adopted.scene ? [adopted.scene.origin.artifactId] : []),
    ...adopted.contexts.flatMap((context) =>
      context.references.map((reference) => reference.artifactId),
    ),
  ];
  const assertReadable = () => {
    const asserted: unknown = assertActive();
    if (asserted !== undefined) {
      if (asserted && typeof (asserted as PromiseLike<unknown>).then === 'function')
        void Promise.resolve(asserted).catch(() => {});
      throw Error('Hostの活動・認可検査は同期のvoid assertionにしてください。');
    }
    assertNativeReadable();
    if (!readArtifactIds.every((id) => workspace.canReadWorld(id) === true))
      throw Error('設定・ラフ・現在画像・Scene・資料の閲覧権限がありません。');
  };
  const assertCurrent = () => {
    assertReadable();
    for (const check of sampleChecks) check();
    readPreparedCreativeLayerInput(preparation);
    if (sceneId) workspace.assertGenerationSceneCurrent(sceneId);
    if (workspace.canPrepareWorldInput !== true)
      throw Error('制作前提を使う生成の編集権限がありません。');
    if (canonicalJson(select()) !== identity)
      throw Error('採用前提が変更されました。生成入力を再準備してください。');
    if (maySendEditorRequest(clone(request)) !== true)
      throw Error('設定・ラフ・現在画像の外部送信が許可されていません。');
    for (const c of adopted.contexts)
      for (const r of c.references) {
        if (workspace.canReadWorld(r.artifactId) !== true || maySendReference(clone(r)) !== true)
          throw Error('資料の閲覧または外部送信が許可されていません。');
      }
  };
  const resolve = async () => {
    assertCurrent();
    await workspace.preflightGenerationSources(mode, request, {
      sourceContentHash,
      sceneId,
      assertCurrent,
    });
    assertCurrent();
    const references: CreativeWorldContextSnapshot['references'] = [];
    let textBytes = 0;
    for (const c of adopted.contexts) {
      const views = await workspace.readWorld(c.id, 'generation', (reference, image) => {
        const check = () => {
          if (maySendSampleImage?.(clone(reference), clone(image)) !== true)
            throw Error('画像入り見本の送信許可が失効しました。');
        };
        check();
        if (!sampleChecks.length || !sampleKeys.has(canonicalJson([reference, image]))) {
          sampleKeys.add(canonicalJson([reference, image]));
          sampleChecks.push(check);
        }
        return true;
      });
      assertCurrent();
      for (const view of views) {
        // Even optional references are not silently dropped. The author must select again.
        if (!['current', 'stale'].includes(view.state))
          throw Error(
            view.reason?.includes('画像入り見本')
              ? view.reason
              : '採用資料が欠落・不正・権限不足です。復旧または明示的な再選択が必要です。',
          );
        const projection =
          view.reference.role === 'sample'
            ? {
                kind: 'svg' as const,
                value: view.svg!,
                rasterSources: clone(view.rasterSources ?? []),
              }
            : { kind: 'text' as const, value: view.text! };
        if (projection.kind === 'text') textBytes += bytes(projection.value);
        if (textBytes > creativeWorldInputLimits.textBytes)
          throw Error('制作前提の本文は64KiBまでです。切り捨てずに再選択してください。');
        references.push({
          contextId: c.id,
          reference: clone(view.reference),
          projection,
          projectionHash: await contentHash(projection),
        });
        assertCurrent();
      }
    }
    const context: CreativeWorldContextSnapshot = {
      schemaVersion: 1,
      resolutionVersion: 1,
      namespace: adopted.namespace,
      scope: adopted.scope,
      adoptions: adopted.contexts.map(({ id, revision }) => ({ id, revision })),
      references,
      fingerprint: '',
    };
    context.fingerprint = await contentHash(fingerprintInput(context));
    const validated = await readCreativeWorldContext(context);
    assertCurrent();
    return { editorRequest: clone(request), context: validated };
  };
  const input = await resolve(),
    json = serializeCreativeWorldInput(input);
  const payloadHash = await contentHash(input);
  assertCurrent();
  return {
    get snapshot(): CreativeWorldInput {
      assertCurrent();
      return clone(input);
    },
    /** Canonical wire bytes; the payloadHash describes exactly this serialization. */
    serialize() {
      assertCurrent();
      return json;
    },
    get payloadHash() {
      assertCurrent();
      return payloadHash;
    },
    /** Read-only authorization for re-exposing an owned snapshot, including after native apply. */
    assertReadable,
    assertCurrent,
    /** Re-read retained native versions and permissions; local guard also runs after every await. */
    async preflight() {
      const current = await resolve();
      assertCurrent();
      if (canonicalJson(current) !== json)
        throw Error('制作前提の投影が変わりました。再準備してください。');
      return clone(input);
    },
  };
}
export type CreativeWorldInputPreparation = Awaited<ReturnType<typeof prepareCreativeWorldInput>>;
