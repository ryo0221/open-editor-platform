import {
  MemoryStorage,
  createArtifact,
  commitVersion,
  canonicalJson,
  type Artifact,
} from '@editor-platform/artifact-core';
import { mountStoryBoard } from '../../../apps/artifact-host/src/creative/story-board/browser';
import { createStoryBoardSample } from '../../../apps/artifact-host/src/creative/story-board/sample';
import {
  readBoardSettings,
  createBoardSettingsData,
} from '../../../apps/artifact-host/src/creative/story-board/settings';

async function start() {
  const storage = new MemoryStorage<Artifact<unknown>>();
  const sample = await createStoryBoardSample(storage);
  const settings = structuredClone(
    readBoardSettings((await storage.get(sample.settingsId))!.draft.content),
  );
  if (new URL(location.href).searchParams.get('board') === 'other') {
    const original = (await storage.get(settings.boardArtifactId))!;
    const board = await commitVersion(
      {
        ...createArtifact('whiteboard', 'もう一枚の物語ボード', original.draft.content),
        id: 'camera-board-2',
      },
      null,
      null,
    );
    await storage.put(board);
    settings.boardArtifactId = board.id;
  }
  const config = await commitVersion(
    {
      ...createArtifact('data', 'もう一つの表示設定', createBoardSettingsData(settings)),
      id: 'camera-settings-2',
    },
    null,
    null,
  );
  await storage.put(config);
  localStorage.setItem('camera:links', JSON.stringify(sample.links));
  const output = document.getElementById('camera-native')!;
  output.textContent = canonicalJson(await storage.list());
  document.getElementById('camera-inspect')!.onclick = async () => {
    output.textContent = canonicalJson(await storage.list());
  };
  mountStoryBoard({
    artifacts: storage,
    settingsId: sample.settingsId,
    linksKey: 'camera:links',
    namespace: 'camera-fixture',
  });
}
void start();
