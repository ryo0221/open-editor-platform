/** Animation 1 -> 2 Host preparation; no generic pair inference or package loading. */
import {
  canonicalJson,
  contentHash,
  createArtifact,
  deepFreeze,
  type Artifact,
} from '@editor-platform/artifact-core';
import { readAnimationV1, type AnimationContentV1 } from '@editor-platform/animation-core';
import { upgradeAnimation2, type AnimationContent2 } from '@editor-platform/animation-core/v2';

export interface AnimationMigrationHost {
  read(): {
    artifact: Artifact<AnimationContentV1>;
    revision: string;
    canEdit: boolean;
    pins: { sourceReader: string; targetReader: string; converter: string };
  };
  /** Verify and retain immutable source bytes/interpretations through apply settlement. */
  validateSources(content: AnimationContentV1, signal: AbortSignal): Promise<void>;
}
export interface AnimationMigrationPreview {
  readonly converter: 'animation-1-to-2-1';
  readonly sourceArtifactId: string;
  readonly sourceBaseVersionId: string | null;
  readonly sourceContentHash: string;
  readonly targetContentHash: string;
  readonly content: AnimationContent2;
  readonly losses: readonly string[];
}
const tokens = new WeakMap<
  AnimationMigrationPreview,
  { host: AnimationMigrationHost; source: string; revision: string }
>();
function capture(host: AnimationMigrationHost) {
  const live = host.read();
  if (!live.canEdit) throw Error('Migration permission denied');
  if (!live.revision || !live.artifact.id) throw Error('Migration source identity');
  const artifact = structuredClone(live.artifact);
  const pins = structuredClone(live.pins);
  if (
    Object.keys(pins).sort().join() !== 'converter,sourceReader,targetReader' ||
    !Object.values(pins).every((pin) => /^sha256:[a-f0-9]{64}$/.test(pin))
  )
    throw Error('Migration reader/converter pins');
  readAnimationV1(artifact.draft.content);
  return { artifact, revision: live.revision, source: canonicalJson({ artifact, pins }), pins };
}
function unchanged(host: AnimationMigrationHost, source: string, revision: string) {
  const live = capture(host);
  if (live.source !== source || live.revision !== revision) throw Error('Migration source changed');
}
export async function previewAnimationMigration(host: AnimationMigrationHost, signal: AbortSignal) {
  signal.throwIfAborted();
  const original = capture(host);
  const content = upgradeAnimation2(original.artifact.draft.content);
  await host.validateSources(structuredClone(original.artifact.draft.content), signal);
  const preview: AnimationMigrationPreview = deepFreeze({
    converter: 'animation-1-to-2-1',
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
export async function applyAnimationMigration(
  preview: AnimationMigrationPreview,
  signal: AbortSignal,
) {
  const state = tokens.get(preview);
  if (!state) throw Error('Unknown or consumed migration preview');
  // One-shot even on failure: permission/retention failures require a fresh preview.
  tokens.delete(preview);
  signal.throwIfAborted();
  unchanged(state.host, state.source, state.revision);
  const current = capture(state.host);
  const original = current.artifact;
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
      sourceSchema: 'animation-schema-1',
      targetSchema: 'animation-schema-2',
      sourceReaderPin: current.pins.sourceReader,
      targetReaderPin: current.pins.targetReader,
      converterPin: current.pins.converter,
    },
  });
}
