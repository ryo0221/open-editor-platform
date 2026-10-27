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
import { BimController, BimSurface, WorkerBimKernel } from '../src';
import KernelWorker from '../src/worker?worker';

// Standalone host: ?fixture=starter|box|types|office|gable|hip, ?readonly=1, ?kernel=missing.
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
const controller = new BimController({
  session,
  kernel,
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
      onUndo={() => history('undo')}
      onRedo={() => history('redo')}
    />
  );
}
const inputs = new EditorInputs();
createRoot(document.getElementById('root')!).render(
  <EditorInputsContext.Provider value={inputs}>
    <App />
  </EditorInputsContext.Provider>,
);
