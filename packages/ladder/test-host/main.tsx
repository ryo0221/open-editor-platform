import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ladderBlinkExample,
  ladderCounterExample,
  ladderSelfHoldExample,
  type LadderDocument,
} from '@editor-platform/ladder-core';
import { EditorInputs, EditorSession } from '@editor-platform/editor-core';
import { EditorInputsContext } from '@editor-platform/editor-ui';
import '@editor-platform/editor-ui/styles.css';
import { LadderController, LadderSurface } from '../src';
import '../src/style.css';

// Standalone host: ?fixture=hold|blink|counter|empty, ?readonly=1.
const params = new URLSearchParams(location.search);
const fixtures: Record<string, () => LadderDocument> = {
  hold: ladderSelfHoldExample,
  blink: ladderBlinkExample,
  counter: ladderCounterExample,
  empty: () => ({
    schemaVersion: 1,
    name: 'Empty',
    scanMs: 10,
    variables: [],
    rungs: [],
  }),
};
const session = new EditorSession<LadderDocument>(
  (fixtures[params.get('fixture') ?? 'hold'] ?? ladderSelfHoldExample)(),
);
const readOnly = params.get('readonly') === '1';
const controller = new LadderController({
  session,
  canEdit: () => !readOnly,
  onApplied: (content) => Object.assign(window, { ladderApplied: content }),
});
// For the browser tests.
Object.assign(window, { ladderController: controller, ladderSession: session });

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
    <LadderSurface
      controller={controller}
      name="Ladder"
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
