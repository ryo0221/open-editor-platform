import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  cosimLedSchematic,
  cosimSelfHoldBindings,
  cosimStarter,
  type CosimDocument,
  type CosimSourceRef,
} from '@editor-platform/cosim-core';
import { EditorInputs, EditorSession } from '@editor-platform/editor-core';
import { EditorInputsContext } from '@editor-platform/editor-ui';
import '@editor-platform/editor-ui/styles.css';
import {
  ladderBlinkExample,
  ladderSelfHoldExample,
  type LadderDocument,
} from '@editor-platform/ladder-core';
import '@editor-platform/ladder/style.css';
import '@editor-platform/schematic/style.css';
import type { SchematicDocument } from '@editor-platform/schematic-core';
import { CosimController, CosimSurface, type CosimSource } from '../src';
import '../src/style.css';

// Standalone host: ?fixture=hold|empty, ?readonly=1. Saved versions live in memory.
const params = new URLSearchParams(location.search);
function source<T>(
  artifactId: string,
  name: string,
  versions: [string, T][],
): CosimSource<T> & { versions: [string, T][] } {
  return {
    versions,
    async list() {
      return [
        {
          artifactId,
          name,
          versions: [...versions].reverse().map(([label], i) => ({
            versionId: `v${versions.length - i}`,
            label,
            contentHash: `h${versions.length - i}`,
          })),
        },
      ];
    },
    async document(ref: CosimSourceRef) {
      const n = Number(ref.versionId.slice(1));
      if (ref.artifactId !== artifactId || ref.contentHash !== `h${n}` || !versions[n - 1])
        throw new Error('source-missing');
      return structuredClone(versions[n - 1][1]);
    },
  };
}
const schematics = source<SchematicDocument>('sch', 'LED and button', [
  ['v1 — 330 Ω', cosimLedSchematic(330)],
  ['v2 — 1 kΩ', cosimLedSchematic(1000)],
]);
const ladders = source<LadderDocument>('lad', 'Programs', [
  ['v1 — self-hold', ladderSelfHoldExample()],
  ['v2 — blink', ladderBlinkExample()],
  [
    'v3 — STOP held',
    (() => {
      const doc = ladderSelfHoldExample();
      doc.variables = doc.variables.map((v) => (v.name === 'STOP' ? { ...v, initial: true } : v));
      return doc;
    })(),
  ],
]);
const fixtures: Record<string, () => CosimDocument> = {
  hold: () => ({
    ...cosimStarter(),
    name: 'Self-hold LED',
    schematic: { artifactId: 'sch', versionId: 'v1', contentHash: 'h1' },
    ladder: { artifactId: 'lad', versionId: 'v1', contentHash: 'h1' },
    bindings: cosimSelfHoldBindings(),
  }),
  empty: cosimStarter,
};
const session = new EditorSession<CosimDocument>(
  (fixtures[params.get('fixture') ?? 'hold'] ?? fixtures.hold)(),
);
const readOnly = params.get('readonly') === '1';
const controller = new CosimController({
  session,
  canEdit: () => !readOnly,
  onApplied: (content) => Object.assign(window, { cosimApplied: content }),
  sources: { schematics, ladders },
});
// For the browser tests.
Object.assign(window, { cosimController: controller, cosimSession: session });

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
    <CosimSurface
      controller={controller}
      name="Co-simulation"
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
