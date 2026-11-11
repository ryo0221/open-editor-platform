import { clone, contentHash, serializeArtifact } from '@editor-platform/artifact-core';
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
import { workspaceDocumentAdapter, workspaceComicAdapter } from './native-adapters';

export * from './world-links';
import { type WorldReference } from './world-links';

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
