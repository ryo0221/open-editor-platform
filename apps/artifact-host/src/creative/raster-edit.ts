import { canonicalJson, clone, type Artifact } from '@editor-platform/artifact-core';
import type { EditorCommand } from '@editor-platform/editor-core';
import {
  deriveDesignRasterProvenance,
  updateElement,
  type DesignContent,
} from '@editor-platform/design/model';

const pixelSource = 'Creative Host / native pixel edit';
/** Host attribution for owned pixel edits. Ordinary src replacement still invalidates provenance. */
export function attributedCreativeRasterEdit(
  edit: EditorCommand<DesignContent>,
  artifact: Artifact<DesignContent>,
): EditorCommand<DesignContent> {
  if (edit.type !== 'design.raster.edit') return edit;
  const version = artifact.versions.find((v) => v.versionId === artifact.draft.baseVersionId);
  return {
    ...edit,
    apply(content) {
      let next = edit.apply(content);
      for (const before of content.elements) {
        const after = next.elements.find((e) => e.id === before.id);
        if (
          before.type !== 'image' ||
          !before.provenance ||
          !after?.src ||
          after.src === before.src ||
          after.provenance
        )
          continue;
        const old = before.provenance,
          saved = version?.content.elements.find((e) => e.id === before.id);
        // Brush history already belongs to EditorSession: keep the retained originals,
        // rather than appending one duplicate ancestor for every stroke.
        const derived =
          old.source === pixelSource && old.lineage?.length
            ? { ...clone(old), src: after.src }
            : deriveDesignRasterProvenance(old, after.src, {
                artifactId: artifact.id,
                elementId: before.id,
                ...(saved?.provenance &&
                saved.src === before.src &&
                canonicalJson(saved.provenance) === canonicalJson(old)
                  ? { versionId: version!.versionId }
                  : {}),
              });
        const { version: _version, ...provenance } = derived;
        next = updateElement(before.id, {
          provenance: { ...provenance, source: pixelSource },
        }).apply(next);
      }
      return next;
    },
  };
}
