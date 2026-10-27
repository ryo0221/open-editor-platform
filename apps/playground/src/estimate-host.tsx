import { useEffect, useReducer, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArtifactEditor, loadHostArtifact } from '@editor-platform/editor-host';
import {
  canonicalJson,
  commitVersion,
  createArtifact,
  MemoryStorage,
  type Artifact,
} from '@editor-platform/artifact-core';
import {
  EstimateSurface,
  estimateHostAdapter,
  estimateSources,
  type EstimatePort,
} from '@editor-platform/estimate';
import { createEstimate, type EstimateDocument } from '@editor-platform/estimate-core';
import '@editor-platform/estimate/styles.css';
const storage = new MemoryStorage<Artifact<EstimateDocument>>();
async function main() {
  const saved = localStorage.getItem('estimate-independent');
  const artifact = saved
    ? await loadHostArtifact(saved, estimateHostAdapter)
    : createArtifact('estimate', '見積・積算', createEstimate());
  const host = new ArtifactEditor(artifact, estimateHostAdapter, storage, () => true);
  const native = {
    schemaVersion: 2,
    columns: [
      { id: 'qty', name: 'Quantity', type: 'number' },
      { id: 'price', name: 'Price', type: 'number' },
    ],
    rows: [
      { id: 'a', values: { qty: 2, price: 10 } },
      { id: 'b', values: { qty: 3, price: 20 } },
    ],
  };
  const source = await commitVersion(
    createArtifact('data', '売上サンプル', native),
    'local',
    'Fixture',
  );
  function App() {
    const [, refresh] = useReducer((n) => n + 1, 0),
      [error, setError] = useState('');
    useEffect(() => host.attach(refresh), []);
    const port: EstimatePort = {
      read: () => host.content,
      revision: () => canonicalJson(host.revision),
      generation: () => 0,
      canEdit: () => true,
      canRead: () => true,
      canExport: () => true,
      inputsReady: () => true,
      execute: (c) => {
        host.execute(c);
      },
      flush: () => host.flushInputs(),
    };
    return (
      <>
        <button
          onClick={() =>
            void host
              .export('native-json')
              .then((text) => {
                const url = URL.createObjectURL(new Blob([String(text)]));
                const a = document.createElement('a');
                a.href = url;
                a.download = 'estimate.json';
                a.click();
                URL.revokeObjectURL(url);
              })
              .catch((e) => setError(String(e)))
          }
        >
          Native JSON出力（入力・過去結果を含む）
        </button>
        <label>
          Native JSON読込
          <input
            type="file"
            accept=".json"
            onChange={(e) => {
              const file = e.target.files?.[0];
              const revision = canonicalJson(host.revision);
              if (file)
                void file
                  .text()
                  .then((text) => loadHostArtifact(text, estimateHostAdapter))
                  .then((a) => {
                    host.flushInputs();
                    if (canonicalJson(host.revision) !== revision)
                      throw Error('読込中に編集されました。');
                    localStorage.setItem('estimate-independent', JSON.stringify(a));
                    window.location.reload();
                  })
                  .catch((e) => setError(String(e)));
            }}
          />
        </label>
        <p role="alert">{error}</p>
        <EstimateSurface
          port={port}
          sources={estimateSources([source])}
          save={async () => {
            const result = await host.save({ commitVersion: true });
            localStorage.setItem('estimate-independent', JSON.stringify(result.artifact));
          }}
          history={(d) => (d === 'undo' ? host.undo() : host.redo())}
          registerInput={(b) =>
            host.registerInputBoundary(() => {
              if (b.read().composing) throw Error('IME変換を確定してください。');
              b.prepare()();
            })
          }
        />
      </>
    );
  }
  createRoot(document.getElementById('root')!).render(<App />);
}
void main().catch((e) => {
  document.getElementById('root')!.textContent = String(e);
});
