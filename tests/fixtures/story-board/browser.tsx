import { MemoryStorage, type Artifact } from '@editor-platform/artifact-core';
import { mountStoryBoard } from '../../../apps/artifact-host/src/creative/story-board/browser';
import { createStoryBoardSample } from '../../../apps/artifact-host/src/creative/story-board/sample';

async function start() {
  const mode = new URL(location.href).searchParams.get('mode');
  const storage = new MemoryStorage<Artifact<unknown>>();
  const status = document.getElementById('fixture-status')!;
  const writes = document.getElementById('fixture-writes')!;
  let edit = mode !== 'readonly',
    read = true,
    count = 0;
  let settingsId: string | undefined;
  const readable = new Set<string>();
  let finalOwner = '';
  if (['sources', 'permissions', 'config-revoked', 'typing'].includes(mode ?? '')) {
    const sample = await createStoryBoardSample(storage);
    localStorage.setItem('entry:links', JSON.stringify(sample.links));
    if (mode === 'typing') {
      localStorage.removeItem('story-board:settings-id');
      for (const artifact of await storage.list()) readable.add(artifact.id);
    } else {
      settingsId = sample.settingsId;
      finalOwner = sample.links.story.worldSettings;
    }
  }
  const get = storage.get.bind(storage),
    put = storage.putIfAbsent.bind(storage);
  storage.get = async (id) => {
    const reads = document.getElementById('fixture-reads')!;
    reads.textContent = String(Number(reads.textContent) + 1);
    const result = await get(id);
    if (id === finalOwner) {
      finalOwner = '';
      if (mode === 'config-revoked') read = false;
      if (mode === 'sources') api.sourcesChanged();
      else api.permissionsChanged();
      status.textContent = 'notified before final open read returned';
    }
    return result;
  };
  storage.putIfAbsent = async (artifact) => {
    count++;
    writes.textContent = String(count);
    const result = await put(artifact);
    if (mode === 'revoking' && count === 1) {
      edit = false;
      api.permissionsChanged();
      status.textContent = 'revoked after accepted first write';
    }
    return result;
  };
  const api = mountStoryBoard({
    artifacts: storage,
    settingsId,
    linksKey: 'entry:links',
    mayEdit: () => edit,
    mayRead: (id) => (mode === 'typing' ? readable.has(id) : read || id !== settingsId),
  });
  document.getElementById('fixture-revoke')!.onclick = () => {
    readable.delete('sb660-settings');
    api.permissionsChanged();
  };
  document.getElementById('fixture-inspect')!.onclick = async () => {
    status.textContent = `persisted:${(await storage.list()).length}`;
  };
}
void start();
