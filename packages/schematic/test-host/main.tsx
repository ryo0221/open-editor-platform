import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  schematicLedExample,
  schematicStarter,
  type SchematicDocument,
} from '@editor-platform/schematic-core';
import { EditorInputs, EditorSession } from '@editor-platform/editor-core';
import { EditorInputsContext } from '@editor-platform/editor-ui';
import '@editor-platform/editor-ui/styles.css';
import { SchematicController, SchematicSurface } from '../src';
import '../src/style.css';

// Standalone host: ?fixture=starter|led|led-sim, ?readonly=1.
const params = new URLSearchParams(location.search);
/** The LED example with circuit models on R1 (330 Ω), D1 (green LED) and SW1 (SL5b tests). */
function ledWithModels(): SchematicDocument {
  const doc = schematicLedExample();
  const models: Record<string, NonNullable<SchematicDocument['parts'][number]['model']>> = {
    r1: { kind: 'resistor', terminals: { a: '1', b: '2' }, params: { ohms: 330 } },
    d1: { kind: 'led', terminals: { anode: '2', cathode: '1' }, params: { color: 'green' } },
    sw1: {
      kind: 'switch',
      terminals: { a: '1', b: '2' },
      params: { closedOhms: 0.05, openOhms: 1e9 },
    },
  };
  for (const p of doc.parts) p.model = models[p.id];
  return doc;
}
const fixtures: Record<string, () => SchematicDocument> = {
  starter: schematicStarter,
  led: schematicLedExample,
  'led-sim': ledWithModels,
};
const session = new EditorSession<SchematicDocument>(
  (fixtures[params.get('fixture') ?? 'starter'] ?? schematicStarter)(),
);
const readOnly = params.get('readonly') === '1';
const controller = new SchematicController({
  session,
  canEdit: () => !readOnly,
  onApplied: (content) => Object.assign(window, { schematicApplied: content }),
});
// For the browser tests.
Object.assign(window, { schematicController: controller, schematicSession: session });

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
    <SchematicSurface
      controller={controller}
      name="Schematic"
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
