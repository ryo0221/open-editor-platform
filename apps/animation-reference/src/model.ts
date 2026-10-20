import {
  createPlayableAnimationEmbed,
  readAnimationHostContent,
  type AnimationHostContent,
} from '@editor-platform/animation-core/v2';
import { contentHash, type Artifact } from '@editor-platform/artifact-core';
import { loadHostArtifact, type EditorHostAdapter } from '@editor-platform/editor-host';

const animationAdapter: EditorHostAdapter<AnimationHostContent> = {
  kind: 'animation',
  validate(value): value is AnimationHostContent {
    try {
      readAnimationHostContent(value);
      return true;
    } catch {
      return false;
    }
  },
  capabilities: { undo: true, nativeJson: true, formats: [], preview: 'none', shared: false },
};

export function savedAnimationEmbed(artifact: Artifact<AnimationHostContent>) {
  const version = artifact.versions.at(-1);
  return version
    ? createPlayableAnimationEmbed(
        {
          artifactId: artifact.id,
          versionId: version.versionId,
          contentHash: version.contentHash,
          compositionId: version.content.rootCompositionId,
        },
        version.content,
        artifact.name,
      )
    : undefined;
}

/** Validate before the Host installs content that its saved Player must render. */
export async function readAnimationHostArtifact(
  text: string,
): Promise<Artifact<AnimationHostContent>> {
  const owned = await loadHostArtifact(text, animationAdapter);
  if (!savedAnimationEmbed(owned))
    // An unsaved import must also be able to produce its first saved Player.
    createPlayableAnimationEmbed(
      {
        artifactId: owned.id,
        versionId: 'prospective-saved-version',
        contentHash: await contentHash(owned.draft.content),
        compositionId: owned.draft.content.rootCompositionId,
      },
      owned.draft.content,
      owned.name,
    );
  return owned;
}
