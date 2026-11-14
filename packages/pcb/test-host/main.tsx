import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { f75Pi5Board, pcbStarter, type PcbDocument } from '@editor-platform/pcb-core';
import { EditorInputs, EditorSession } from '@editor-platform/editor-core';
import { EditorInputsContext } from '@editor-platform/editor-ui';
import '@editor-platform/editor-ui/styles.css';
import { PcbController, PcbSurface } from '../src';
import '../src/style.css';

// Standalone host: ?fixture=starter|f75, ?readonly=1.
const params = new URLSearchParams(location.search);
const fixtures: Record<string, () => PcbDocument> = { starter: pcbStarter, f75: f75Pi5Board };
const session = new EditorSession<PcbDocument>(
  (fixtures[params.get('fixture') ?? 'starter'] ?? pcbStarter)(),
);
const readOnly = params.get('readonly') === '1';
const controller = new PcbController({
  session,
  canEdit: () => !readOnly,
  onApplied: (content) => Object.assign(window, { pcbApplied: content }),
});
// For the browser tests.
Object.assign(window, { pcbController: controller, pcbSession: session });

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
    <PcbSurface
      controller={controller}
      name="Board"
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
