import {
  clone,
  canonicalJson,
  contentHash,
  serializeArtifact,
} from '@editor-platform/artifact-core';
import { loadHostArtifact } from '@editor-platform/editor-host';
import { isDocument } from '@editor-platform/document/model';
import { documentText } from '@editor-platform/document/text';
import { isDesignWithPaths, exportDesignSvg } from '@editor-platform/design/model';
import {
  creativeWorldSampleImages,
  projectCreativeLayerReference,
  type CreativeLayerRequest,
} from '../generation';
import type { CreativeWorkspaceStorage } from './model';
import { workspaceDocumentAdapter, workspaceComicAdapter } from './model';

export const worldRoles = [
  'facts',
  'identity',
  'style',
  'sample',
  'scene-state',
  'instructions',
  'exception',
] as const;
export type WorldRole = (typeof worldRoles)[number];
/** CW1 subset: explicit root blocks, or a root Frame. No name/JSONPath/latest resolver. */
export type WorldSelector =
  | { type: 'document-blocks'; blockIds: string[] }
  | { type: 'design-frame'; frameId: string };
export interface WorldReference {
  id: string;
  role: WorldRole;
  namespace: string;
  artifactId: string;
  versionId: string;
  contentHash: string;
  selector: WorldSelector;
  required: boolean;
}
export interface WorldContext {
  id: string;
  revision: number;
  references: WorldReference[];
}
/** Owned only by CreativeWorkspaceLinks. All values are references, never native bodies. */
export interface WorldContexts {
  namespace: string;
  contexts: WorldContext[];
}
const object = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).every((k) => keys.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 4096;
export function readWorldContexts(raw: unknown): WorldContexts {
  if (
    !object(raw, ['namespace', 'contexts']) ||
    !id(raw.namespace) ||
    !Array.isArray(raw.contexts) ||
    raw.contexts.length > 64
  )
    throw Error('作品設定の構造が不正です。');
  let count = 0;
  const contextIds = new Set();
  for (const c of raw.contexts) {
    if (
      !object(c, ['id', 'revision', 'references']) ||
      !id(c.id) ||
      contextIds.has(c.id) ||
      !Number.isSafeInteger(c.revision) ||
      (c.revision as number) < 0 ||
      !Array.isArray(c.references)
    )
      throw Error('採用前提の構造が不正です。');
    contextIds.add(c.id);
    count += c.references.length;
    const ids = new Set(),
      targets = new Set();
    for (const r of c.references) {
      if (
        !object(r, [
          'id',
          'role',
          'namespace',
          'artifactId',
          'versionId',
          'contentHash',
          'selector',
          'required',
        ]) ||
        !id(r.id) ||
        ids.has(r.id) ||
        !worldRoles.includes(r.role as WorldRole) ||
        r.namespace !== raw.namespace ||
        !id(r.artifactId) ||
        !id(r.versionId) ||
        typeof r.contentHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(r.contentHash) ||
        typeof r.required !== 'boolean'
      )
        throw Error('資料参照が不正・重複、またはnamespaceが異なります。');
      ids.add(r.id);
      const s = r.selector;
      const document =
        object(s, ['type', 'blockIds']) &&
        s.type === 'document-blocks' &&
        Array.isArray(s.blockIds) &&
        s.blockIds.length > 0 &&
        s.blockIds.length <= 256 &&
        s.blockIds.every(id) &&
        new Set(s.blockIds).size === s.blockIds.length;
      const design = object(s, ['type', 'frameId']) && s.type === 'design-frame' && id(s.frameId);
      if ((!document && !design) || (r.role === 'sample' ? !design : !document))
        throw Error('未知selectorまたはrole/domain不一致です。');
      const key = canonicalJson([r.role, r.artifactId, r.selector]);
      if (targets.has(key)) throw Error('同じ資料の参照が重複しています。');
      targets.add(key);
    }
  }
  if (count > 64) throw Error('作品設定の参照上限は64件です。変更しません。');
  return clone(raw) as unknown as WorldContexts;
}
export interface WorldReferenceView {
  reference: WorldReference;
  state: 'current' | 'stale' | 'missing' | 'invalid' | 'forbidden';
  reason?: string;
  text?: string;
  svg?: string;
  latest?: { versionId: string; contentHash: string };
  rasterSources?: CreativeLayerRequest['rough']['rasterSources'];
}
export type WorldSampleImage = ReturnType<typeof creativeWorldSampleImages>[number];
export type WorldSamplePermission = (
  reference: Readonly<WorldReference>,
  image: Readonly<WorldSampleImage>,
) => boolean;
export function projectWorldReference(
  reference: WorldReference,
  content: unknown,
  purpose: 'view' | 'generation' = 'view',
  maySendImage?: WorldSamplePermission,
): { text?: string; svg?: string; rasterSources?: CreativeLayerRequest['rough']['rasterSources'] } {
  const s = reference.selector;
  if (s.type === 'document-blocks') {
    if (!isDocument(content)) throw Error('資料のdomainがDocumentではありません。');
    const native = documentText(content);
    const blocks = s.blockIds.map((id) => {
      const matches = content.blocks.filter((b) => b.id === id);
      if (matches.length !== 1)
        throw Error('指定blockが欠落または曖昧です。元資料を復元してください。');
      const block = matches[0];
      if (!('text' in block) || typeof block.text !== 'string')
        throw Error('CW1では本文blockのみ参照できます。');
      const segments = native.segments.filter((segment) => segment.blockId === block.id);
      if (!segments.length) throw Error('CW1では本文blockのみ参照できます。');
      return segments.map((segment) => native.text.slice(segment.start, segment.end)).join('\n');
    });
    return { text: blocks.join('\n') };
  }
  if (!isDesignWithPaths(content)) throw Error('資料のdomainがDesignではありません。');
  const frames = content.elements.filter(
    (e) => e.id === s.frameId && e.type === 'frame' && !e.parentId,
  );
  if (frames.length !== 1) throw Error('指定Frameが欠落または曖昧です。元資料を復元してください。');
  if (purpose === 'generation')
    for (const image of creativeWorldSampleImages(content, s.frameId))
      if (maySendImage?.(clone(reference), clone(image)) !== true)
        throw Error(
          '画像入り見本の送信許可がありません。画像ごとの出典・licenseを確認してください。',
        );
  return {
    svg: exportDesignSvg(content, [s.frameId]),
    ...(purpose === 'generation'
      ? { rasterSources: projectCreativeLayerReference(content, s.frameId).rasterSources }
      : {}),
  };
}
/** Host reads retained versions. Permission checked after every await and before exposing projection. */
export async function readWorldReference(
  io: CreativeWorkspaceStorage,
  reference: WorldReference,
  mayRead: (id: string) => boolean,
  purpose: 'view' | 'generation' = 'view',
  maySendImage?: WorldSamplePermission,
): Promise<WorldReferenceView> {
  const check = () => {
    if (!mayRead(reference.artifactId))
      throw Error('forbidden: 資料の閲覧権限がありません。権限を確認してください。');
  };
  try {
    check();
    const a = await io.artifacts.get(reference.artifactId);
    check();
    if (!a || a.id !== reference.artifactId)
      throw Error('missing: 資料Artifactがありません。元資料を復元してください。');
    const v = a.versions.find((v) => v.versionId === reference.versionId);
    if (!v) throw Error('missing: exact保存版がありません。版を復元してください。');
    if (reference.selector.type === 'document-blocks')
      await loadHostArtifact(serializeArtifact(a), workspaceDocumentAdapter);
    else await loadHostArtifact(serializeArtifact(a), workspaceComicAdapter);
    check();
    if (
      v.contentHash !== reference.contentHash ||
      (await contentHash(v.content)) !== reference.contentHash
    )
      throw Error('invalid: 保存版のhashが一致しません。元資料を確認してください。');
    check();
    const projection = projectWorldReference(reference, v.content, purpose, maySendImage);
    const latest = a.versions.find((v) => v.versionId === a.draft.baseVersionId);
    return {
      reference: clone(reference),
      state: latest && latest.versionId !== v.versionId ? 'stale' : 'current',
      ...projection,
      ...(latest
        ? { latest: { versionId: latest.versionId, contentHash: latest.contentHash } }
        : {}),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      reference: clone(reference),
      state:
        !mayRead(reference.artifactId) || reason.startsWith('forbidden:')
          ? 'forbidden'
          : reason.startsWith('missing:')
            ? 'missing'
            : 'invalid',
      reason,
    };
  }
}
/** Legacy entrypoint refuses World execution without the explicit supported connection. */
export { assertWorldGenerationAvailable } from '../generation';
