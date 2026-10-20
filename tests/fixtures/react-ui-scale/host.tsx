import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorSession, type EditorCommand } from '@editor-platform/editor-core';
import { createArtifact, IndexedDBStorage, type Artifact } from '@editor-platform/artifact-core';
import { loadReactUiDocument, type ReactUiDocument } from '@editor-platform/react-ui-core';
import { ReactUiSurface } from '@editor-platform/react-ui';
import { createScaleDocument } from './catalog';
import { scaleRuntime } from './runtime';

const storage = new IndexedDBStorage<Artifact<ReactUiDocument>>('issue24-scale');
const saved = await storage.get('scale-artifact');
const initial = saved ? loadReactUiDocument(saved.draft.content) : createScaleDocument();
const session = new EditorSession(initial);
let snapshot = initial;
Object.assign(window, { scaleBenchmark: { snapshot: () => session.content } });
function Host() {
  const [content, setContent] = useState(initial);
  const [selected, select] = useState('leaf-000');
  const [status, setStatus] = useState(saved ? 'Saved' : 'Unsaved');
  const [savedSequence, setSavedSequence] = useState(0);
  function adopt(value: ReactUiDocument) {
    snapshot = value;
    setContent(value);
    setStatus('Unsaved');
  }
  function execute(command: EditorCommand<ReactUiDocument>) {
    adopt(session.executeView(command));
  }
  async function save() {
    setStatus('Saving');
    const record = createArtifact('react-ui', 'Fixed scale fixture', snapshot);
    await storage.put({ ...record, id: 'scale-artifact' });
    setSavedSequence((value) => value + 1);
    setStatus('Saved');
  }
  return (
    <>
      <header>
        <button onClick={() => adopt(session.undoView())}>Host Undo</button>
        <button onClick={() => void save()}>Host Save</button>
        <output aria-label="Host save state" data-saved-sequence={savedSequence}>
          {status}
        </output>
        <output aria-label="Node count">{content.nodes.length}</output>
      </header>
      <ReactUiSurface
        content={content}
        readOnly={false}
        execute={execute}
        selectedId={selected}
        select={select}
        runtime={scaleRuntime}
      />
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Host />);
