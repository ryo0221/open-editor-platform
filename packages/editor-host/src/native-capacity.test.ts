import { expect, it } from 'vitest';
import { MemoryStorage, serializeArtifact, type Artifact } from '@editor-platform/artifact-core';
import { createArtifact } from '@editor-platform/artifact-core';
import { command } from '@editor-platform/editor-core';
import { ArtifactEditor, loadHostArtifact, type EditorHostAdapter } from './index';

type Content = { text: string };
const adapter: EditorHostAdapter<Content> = {
  kind: 'capacity-fixture',
  validate: (value: unknown): value is Content =>
    !!value && typeof value === 'object' && 'text' in value && typeof value.text === 'string',
  capabilities: { undo: true, nativeJson: true, formats: [], preview: 'none', shared: false },
};

it('continues the same owner beyond the former 16 MiB boundary without dropping versions', async () => {
  const storage = new MemoryStorage<Artifact<Content>>();
  const owner = createArtifact('capacity-fixture', 'Layered artwork size fixture', { text: '' });
  const editor = new ArtifactEditor(owner, adapter, storage);
  const text = 'x'.repeat(9 * 1024 * 1024);
  editor.execute(command('first', 'First image-sized content', () => ({ text })));
  const first = await editor.save({ commitVersion: true });
  expect(new TextEncoder().encode(serializeArtifact(first.artifact)).length).toBeGreaterThan(
    16 * 1024 * 1024,
  );
  editor.execute(command('second', 'Change only artwork visibility', () => ({ text: text + '2' })));
  const second = await editor.save({ commitVersion: true });
  expect(second.artifact.id).toBe(owner.id);
  expect(second.artifact.versions.slice(0, -1)).toEqual(first.artifact.versions);
  expect(editor.canUndo).toBe(true);
  const json = await editor.export('native-json');
  const loaded = await loadHostArtifact(json as string, adapter);
  expect(loaded.id).toBe(owner.id);
  expect(loaded.draft.content).toEqual(second.artifact.draft.content);
  expect(loaded.draft.baseVersionId).toBe(second.artifact.draft.baseVersionId);
  expect(loaded.versions).toEqual(second.artifact.versions);
  expect(await storage.get(owner.id)).toEqual(second.artifact);
  expect(loaded.versions).toHaveLength(2);
});
