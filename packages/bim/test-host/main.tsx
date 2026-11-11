import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  bimStarter,
  f31BoxBuilding,
  f33Types,
  f37Office,
  f39Roofs,
  type BimDocument,
} from '@editor-platform/bim-core';
import { EditorInputs, EditorSession } from '@editor-platform/editor-core';
import { EditorInputsContext } from '@editor-platform/editor-ui';
import '@editor-platform/editor-ui/styles.css';
import kernelBuild from 'virtual:cad-kernel-build';
import { BimController, BimSurface, WorkerBimKernel, type BimAssetStore } from '../src';
import KernelWorker from '../src/worker?worker';

// Standalone host: ?fixture=starter|box|types|office|gable|hip, ?readonly=1, ?kernel=missing,
// ?assets=1 (the Host keeps texture images in memory for the page's life, #662).
const params = new URLSearchParams(location.search);
const fixtures: Record<string, () => BimDocument> = {
  starter: bimStarter,
  box: f31BoxBuilding,
  types: f33Types,
  office: f37Office,
  gable: () => f39Roofs('gable'),
  hip: () => f39Roofs('hip'),
};
const session = new EditorSession<BimDocument>(
  (fixtures[params.get('fixture') ?? 'box'] ?? f31BoxBuilding)(),
);
const kernel = new WorkerBimKernel({
  spawn: () => new KernelWorker() as never,
  build: params.get('kernel') === 'missing' ? undefined : (kernelBuild ?? undefined),
});
const readOnly = params.get('readonly') === '1';
const kept = new Map<string, Uint8Array>();
const textures: BimAssetStore | undefined =
  params.get('assets') === '1'
    ? {
        get: (sha256) => kept.get(sha256),
        stage: async (list) => {
          for (const { ref, bytes } of list) kept.set(ref.sha256, bytes);
        },
      }
    : undefined;
const controller = new BimController({
  session,
  kernel,
  ...(textures ? { textures } : {}),
  canEdit: () => !readOnly,
  onApplied: (content) => Object.assign(window, { bimApplied: content }),
});
// For the browser tests.
Object.assign(window, { bimController: controller, bimSession: session });

function App() {
  const [, render] = useState(0);
  const history = (direction: 'undo' | 'redo') => {
    if (direction === 'undo' ? !session.canUndo : !session.canRedo) return;
    if (direction === 'undo') session.undo();
    else session.redo();
    controller.sync();
    render((n) => n + 1);
  };
  return (
    <BimSurface
      controller={controller}
      name="Building"
      {...(params.get('ifc') === '1'
        ? { ifc: () => ({ artifactId: 'test-host', timeStamp: '2026-11-03T00:00:00Z' }) }
        : {})}
      onUndo={() => history('undo')}
      onRedo={() => history('redo')}
      {...(params.has('compact')
        ? { layout: { compactBreakpoint: Number(params.get('compact')) } }
        : {})}
    />
  );
}
const inputs = new EditorInputs();
createRoot(document.getElementById('root')!).render(
  <EditorInputsContext.Provider value={inputs}>
    <App />
  </EditorInputsContext.Provider>,
);
