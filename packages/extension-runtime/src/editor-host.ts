/**
 * Binds a registered Extension to one existing editor-host `ArtifactEditor`.
 *
 * Single Session owner: the ArtifactEditor owns the EditorSession, native history, persistence
 * and final edit permission. The Extension never creates a second Session or history stack; every
 * read/edit/Undo/save reaches the ArtifactEditor through the registry's scoped API. Without a
 * Surface (`mount`), the same handle API serves headless/non-UI use of the same verified package.
 */
import type { HostAdapter, Permission } from '@editor-platform/extension-contract';
import type { ArtifactEditor } from '@editor-platform/editor-host';

export interface ArtifactEditorBinding {
  /** Native schema version the Host read the artifact as; must equal the manifest's. */
  schemaVersion: number;
  /** Current Host grant per permission, rechecked at every call. Mutations also need edit rights. */
  allowed(permission: Permission): boolean;
  /** Options for each Extension-requested save, e.g. an author. Default: draft save only. */
  save?: { commitVersion?: boolean; author?: string };
}

export function artifactEditorHost<T>(
  editor: ArtifactEditor<T>,
  binding: ArtifactEditorBinding,
): HostAdapter<T> {
  const artifactKind = editor.snapshot.kind;
  const host: HostAdapter<T> = {
    artifactKind,
    schemaVersion: binding.schemaVersion,
    allowed: (permission: Permission) => binding.allowed(permission),
    readOnly: () => editor.readOnly,
    read: () => editor.content,
    execute: (command) => {
      editor.execute(command);
    },
    undo: () => {
      editor.undo();
    },
    redo: () => {
      editor.redo();
    },
    save: async () => {
      await editor.save({ ...binding.save });
    },
    select: (ids) => {
      editor.select({ addresses: ids.map((elementId) => ({ artifactId: editor.id, elementId })) });
    },
  };
  return Object.freeze(host);
}
