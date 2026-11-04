import { createRoot } from 'react-dom/client';
import { useState, useSyncExternalStore } from 'react';
import { MemoryStorage, type Artifact } from '@editor-platform/artifact-core';
import { StoryBoardController } from '../../../apps/artifact-host/src/creative/story-board/controller';
import { createStoryBoardSample } from '../../../apps/artifact-host/src/creative/story-board/sample';
import { StoryBoardHost } from '../../../apps/artifact-host/src/creative/story-board/host';

async function start() {
  const storage = new MemoryStorage<Artifact<unknown>>();
  const sample = await createStoryBoardSample(storage);
  const hidden = new Set<string>();
  const controller = await StoryBoardController.open(storage, sample.settingsId, sample.links, {
    namespace: 'browser-negative',
    mayRead: (id) => !hidden.has(id),
    mayEdit: (id) => !hidden.has(id),
  });
  const put = storage.put.bind(storage);
  let hold = false,
    fail = false,
    release: (() => void) | undefined;
  let attempts = 0;
  let notify = () => {};
  storage.put = async (artifact) => {
    if (artifact.id === sample.settingsId) {
      attempts++;
      notify();
      if (fail) throw Error('fixture quota');
      if (hold)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    }
    return put(artifact);
  };
  function Fixture() {
    useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    const [message, setMessage] = useState('');
    const [, refresh] = useState(0);
    notify = () => refresh((n) => n + 1);
    return (
      <>
        <nav aria-label="Fixture controls">
          <button
            onClick={() => {
              hold = true;
            }}
          >
            Hold settings
          </button>
          <button
            onClick={() => {
              fail = true;
            }}
          >
            Fail settings
          </button>
          <button
            onClick={() => {
              hold = false;
              fail = false;
              release?.();
            }}
          >
            Release settings
          </button>
          <button
            onClick={() => {
              hidden.add('sb660-story-ledger-A');
              controller.invalidate();
            }}
          >
            Revoke source
          </button>
          <button
            onClick={() => {
              hidden.clear();
              controller.invalidate();
            }}
          >
            Restore access
          </button>
          <button
            onClick={() => {
              try {
                controller.guard();
                setMessage('allowed');
              } catch {
                setMessage('blocked');
              }
            }}
          >
            Probe guard
          </button>
          <output data-testid="guard">{message}</output>
          <output data-testid="attempts">{attempts}</output>
          <output hidden data-testid="native">
            {JSON.stringify({
              board: controller.boardSnapshot.content,
              settings: controller.settingsSnapshot.content,
            })}
          </output>
        </nav>
        <StoryBoardHost controller={controller} changeBoard={() => setMessage('closed')} />
      </>
    );
  }
  createRoot(document.getElementById('root')!).render(<Fixture />);
}
void start();
