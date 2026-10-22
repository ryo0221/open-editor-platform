/** Explicit v1 -> v2 new-Artifact preparation; the Host owns retention and durable creation. */
import {
  canonicalJson,
  contentHash,
  createArtifact,
  deepFreeze,
  type Artifact,
} from '@editor-platform/artifact-core';
import {
  adoptVideoContentV2,
  assertVideoContentV1,
  type VideoContentV1,
  type VideoContentV2,
} from '@editor-platform/video-core';

export interface VideoMigrationHost {
  read(): { artifact: Artifact<VideoContentV1>; revision: string; canEdit: boolean };
  /** Verify and retain immutable source bytes/interpretations through apply settlement. */
  validateSources(content: VideoContentV1, signal: AbortSignal): Promise<void>;
}
export interface VideoMigrationPreview {
  readonly converter: 'video-v1-to-v2-1';
  readonly sourceArtifactId: string;
  readonly sourceBaseVersionId: string | null;
  readonly sourceContentHash: string;
  readonly targetContentHash: string;
  readonly content: VideoContentV2;
  readonly losses: readonly string[];
}
const tokens = new WeakMap<
  VideoMigrationPreview,
  { host: VideoMigrationHost; source: string; revision: string }
>();
function capture(host: VideoMigrationHost) {
  const live = host.read();
  if (!live.canEdit) throw Error('Migration permission denied');
  if (!live.revision || !live.artifact.id) throw Error('Migration source identity');
  const artifact = structuredClone(live.artifact);
  assertVideoContentV1(artifact.draft.content);
  return { artifact, revision: live.revision, source: canonicalJson(artifact) };
}
function unchanged(host: VideoMigrationHost, source: string, revision: string) {
  const live = capture(host);
  if (live.source !== source || live.revision !== revision) throw Error('Migration source changed');
}
export async function previewVideoMigration(host: VideoMigrationHost, signal: AbortSignal) {
  signal.throwIfAborted();
  const original = capture(host);
  const content = adoptVideoContentV2(original.artifact.draft.content);
  await host.validateSources(structuredClone(original.artifact.draft.content), signal);
  const preview: VideoMigrationPreview = deepFreeze({
    converter: 'video-v1-to-v2-1',
    sourceArtifactId: original.artifact.id,
    sourceBaseVersionId: original.artifact.draft.baseVersionId,
    sourceContentHash: await contentHash(original.artifact.draft.content),
    targetContentHash: await contentHash(content),
    content,
    losses: [],
  });
  signal.throwIfAborted();
  unchanged(host, original.source, original.revision);
  tokens.set(preview, { host, source: original.source, revision: original.revision });
  return preview;
}
/** Returns a new unsaved document. It never replaces the source or commits storage. */
export async function applyVideoMigration(preview: VideoMigrationPreview, signal: AbortSignal) {
  const state = tokens.get(preview);
  if (!state) throw Error('Unknown or consumed migration preview');
  // One-shot even on failure: permission/retention failures require a fresh preview.
  tokens.delete(preview);
  signal.throwIfAborted();
  unchanged(state.host, state.source, state.revision);
  const original = capture(state.host).artifact;
  await state.host.validateSources(structuredClone(original.draft.content), signal);
  if ((await contentHash(preview.content)) !== preview.targetContentHash)
    throw Error('Migration candidate changed');
  signal.throwIfAborted();
  unchanged(state.host, state.source, state.revision);
  return createArtifact(original.kind, `${original.name} (v2)`, structuredClone(preview.content), {
    source: 'imported',
    migration: {
      converter: preview.converter,
      sourceArtifactId: preview.sourceArtifactId,
      sourceBaseVersionId: preview.sourceBaseVersionId,
      sourceContentHash: preview.sourceContentHash,
      targetContentHash: preview.targetContentHash,
      sourceSchema: 'video-core-prototype-v1',
      targetSchema: 'video-core-prototype-v2',
    },
  });
}
