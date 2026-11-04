import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IndexedDBStorage, type Artifact } from '@editor-platform/artifact-core';
import { ArtifactEditor, loadHostArtifact } from '@editor-platform/editor-host';
import { WhiteboardSurface } from '@editor-platform/whiteboard';
import { isWhiteboard, type WhiteboardContent } from '@editor-platform/whiteboard/model';

const storage = new IndexedDBStorage<Artifact<WhiteboardContent>>('native-capacity-fixture');
const adapter = {
  kind: 'whiteboard',
  validate: isWhiteboard,
  capabilities: { undo: true, nativeJson: true, formats: [], preview: 'none', shared: false },
} as const;

function Host() {
  const [editor, setEditor] = useState<ArtifactEditor<WhiteboardContent>>();
  const [status, setStatus] = useState('Ready');
  const [, refresh] = useState(0);
  async function open(json: string) {
    setEditor(new ArtifactEditor(await loadHostArtifact(json, adapter), adapter, storage));
  }
  useEffect(() => {
    void storage.get('native-capacity-fixture').then((artifact) => {
      if (artifact) void open(JSON.stringify(artifact));
    });
  }, []);
  useEffect(() => editor?.attach(() => refresh((n) => n + 1)), [editor]);
  async function run(action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      setStatus(String(error));
    }
  }
  return (
    <main>
      <h1>Native capacity / IndexedDB Host</h1>
      <label>
        Import native
        <input
          type="file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void run(async () => open(await file.text()));
          }}
        />
      </label>
      <button
        disabled={!editor}
        onClick={() =>
          void run(async () => {
            await editor!.save({ commitVersion: true });
            setStatus('Saved');
          })
        }
      >
        Save version
      </button>
      <button
        disabled={!editor}
        onClick={() =>
          void run(async () => {
            const json = (await editor!.export('native-json')) as string;
            const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = 'capacity.json';
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          })
        }
      >
        Export native
      </button>
      <p role="status" aria-label="Storage status">
        {status}
      </p>
      <output aria-label="Native versions">{editor?.artifact.versions.length ?? 0}</output>
      {editor && (
        <WhiteboardSurface
          content={editor.content}
          execute={(command) => {
            editor.execute(command);
          }}
          select={(ids) =>
            editor.select({
              addresses: ids.map((elementId) => ({ artifactId: editor.id, elementId })),
            })
          }
        />
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Host />);
