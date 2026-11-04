import { createRoot } from 'react-dom/client';
import { WorkspaceReference } from './workspace-reference';
import { useEffect, useState } from 'react';
import { ArtifactEditor } from '@editor-platform/editor-host';
import {
  createArtifact,
  canonicalJson,
  MemoryStorage,
  type Artifact,
} from '@editor-platform/artifact-core';
import { FictionMapArtifactSurface } from '@editor-platform/fiction-map/artifact-surface';
import {
  FictionMapWorldPanel,
  type FictionMapWorldHost,
  type FictionMapWorldResult,
} from '@editor-platform/fiction-map/world-panel';
import { fictionMapHostAdapter, adoptFictionMapBase } from '@editor-platform/fiction-map/host';
import {
  commitFictionMapChange,
  prepareFictionMapChange,
  updateFeatureMetadata,
  type FictionMapContent,
} from '@editor-platform/fiction-map/model';
import {
  ReferenceResolver,
  ReferenceError,
  type EmbeddedReference,
  type ReferenceHost,
} from '@editor-platform/artifact-references';
import { ReferenceImage } from '@editor-platform/artifact-references/react';
import { fictionMapReferenceAdapter } from '@editor-platform/reference-adapters';
import { mapFixture } from '../../fiction-map-d3/native-fixture';
import '@editor-platform/fiction-map/styles.css';
const storage = new MemoryStorage<Artifact<FictionMapContent>>();
let referenceFault: 'missing-source' | 'missing-target' | 'stale' | undefined;
let renames = 0;
let slowWorld = false,
  releaseWorld = () => {};
let mayEdit = true,
  fail = false,
  slow = false,
  release = () => {},
  access: 'ready' | 'forbidden' | 'offline' = 'ready',
  world: 'ready' | 'forbidden' | 'offline' | 'missing-source' = 'ready';
const listeners = new Set<() => void>(),
  notify = () => listeners.forEach((f) => f());
const host = new ArtifactEditor(
  createArtifact('fiction-map', 'Independent Map', mapFixture()),
  fictionMapHostAdapter,
  {
    put: async (a) => {
      if (fail) {
        fail = false;
        throw Error('Injected storage failure');
      }
      if (slow) {
        slow = false;
        await new Promise<void>((r) => (release = r));
      }
      await storage.put(a);
    },
  },
  () => mayEdit,
);
const initialized = host.save({ commitVersion: true });
let delayReference = false,
  releaseReference = () => {};
declare global {
  interface Window {
    fictionMapReferencePending: boolean;
  }
}
window.fictionMapReferencePending = false;
const referenceHost: ReferenceHost = {
  list: async () => [],
  async checkSnapshot(source, snapshot) {
    if (delayReference) {
      delayReference = false;
      window.fictionMapReferencePending = true;
      await new Promise<void>((resolve) => {
        releaseReference = resolve;
      });
      window.fictionMapReferencePending = false;
    }
    if (referenceFault)
      throw new ReferenceError(
        referenceFault,
        referenceFault === 'missing-target' ? 'Saved version is missing' : referenceFault,
      );
    const a = await storage.get(source.artifactId),
      v = a?.versions.find((v) => v.versionId === snapshot.versionId);
    if (!a) throw new ReferenceError('missing-source', 'Map missing');
    if (!v) throw new ReferenceError('missing-target', 'Version missing');
    if (
      v.contentHash !== snapshot.contentHash ||
      canonicalJson(v.content) !== canonicalJson(snapshot.content)
    )
      throw new ReferenceError('stale', 'Snapshot contradicts saved version');
  },
  checkAccess() {
    if (access !== 'ready') throw new ReferenceError(access, access);
  },
  read: async (source) => {
    const a = (await storage.get(host.id))!,
      v = a.versions.at(-1)!;
    return {
      artifactId: a.id,
      domain: source.domain,
      versionId: v.versionId,
      revision: a.versions.length,
      contentHash: v.contentHash,
      content: v.content,
      dependencies: [],
    };
  },
  subscribe: (fn) => {
    const wrapped = () => fn(host.id);
    listeners.add(wrapped);
    return () => listeners.delete(wrapped);
  },
};
const resolver = new ReferenceResolver(referenceHost, [fictionMapReferenceAdapter], 'consumer');
const worldHost: FictionMapWorldHost = {
  checkAccess: () => world !== 'forbidden',
  resolve: async () => {
    if (slowWorld) {
      slowWorld = false;
      await new Promise<void>((r) => (releaseWorld = r));
    }
    return world === 'ready'
      ? { status: 'ready', label: 'Verified World city' }
      : ({ status: world === 'forbidden' ? 'missing-source' : world } as FictionMapWorldResult);
  },
  subscribe: (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
const workspace = new URLSearchParams(location.search).get('workspace');
function App() {
  const [snapshot, setSnapshot] = useState(host.snapshot),
    [error, setError] = useState(''),
    [ref, setRef] = useState<EmbeddedReference>();
  useEffect(() => host.attach(() => setSnapshot(host.snapshot)), []);
  const attempt = async (fn: () => unknown | Promise<unknown>) => {
    try {
      setError('');
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <main>
      <h1>Independent Fiction Map D3 Host (mock services)</h1>
      <div aria-label="Independent controls">
        <button onClick={() => void attempt(() => host.save())}>Save draft</button>
        <button onClick={() => void attempt(() => host.save({ commitVersion: true }))}>
          Create version
        </button>
        <button
          onClick={() => {
            fail = true;
          }}
        >
          Fail next save
        </button>
        <button
          onClick={() => {
            slow = true;
          }}
        >
          Delay next save
        </button>
        <button onClick={() => release()}>Release save</button>
        <button
          onClick={() => {
            mayEdit = !mayEdit;
            host.refreshPermission();
          }}
        >
          Toggle permission
        </button>
        <button
          onClick={() =>
            void attempt(() => {
              const base = adoptFictionMapBase(host);
              const r = updateFeatureMetadata(base.content, 'place-0', {
                set: { name: `Newer draft ${++renames}` },
              });
              if (!r.ok) throw Error(r.diagnostic.code);
              const p = prepareFictionMapChange(base, r.value);
              if (!p.ok) throw Error(p.diagnostic.code);
              const c = commitFictionMapChange(host, p.value, () => mayEdit);
              if (!c.ok) throw Error(c.diagnostic.code);
            })
          }
        >
          External rename
        </button>
        <button
          onClick={() =>
            void attempt(async () =>
              setRef(
                await resolver.create(
                  {
                    artifactId: host.id,
                    domain: 'fiction-map',
                    target: {
                      kind: 'fiction-map-view',
                      viewId: 'default',
                      featureIds: ['place-0'],
                    },
                  },
                  'fixed',
                ),
              ),
            )
          }
        >
          Create fixed reference
        </button>
        {(['missing-source', 'missing-target', 'stale'] as const).map((s) => (
          <button
            key={s}
            onClick={() => {
              referenceFault = s;
              access = 'ready';
              notify();
            }}
          >
            Reference {s}
          </button>
        ))}
        <button
          onClick={() => {
            referenceFault = undefined;
            access = 'ready';
            notify();
          }}
        >
          Reset reference fault
        </button>
        {(['ready', 'forbidden', 'offline'] as const).map((s) => (
          <button
            key={s}
            onClick={() => {
              access = s;
              notify();
            }}
          >
            Reference {s}
          </button>
        ))}
        <button
          onClick={() => {
            slowWorld = true;
            world = 'ready';
            notify();
          }}
        >
          Delay World lookup
        </button>
        <button onClick={() => releaseWorld()}>Release World lookup</button>
        <button
          onClick={() => {
            delayReference = true;
          }}
        >
          Delay reference check
        </button>
        <button onClick={() => releaseReference()}>Release reference check</button>
        {(['ready', 'forbidden', 'offline', 'missing-source'] as const).map((s) => (
          <button
            key={s}
            onClick={() => {
              world = s;
              notify();
            }}
          >
            World {s}
          </button>
        ))}
      </div>
      <p role="alert">{error}</p>
      <output data-testid="saving">{String(snapshot.saving)}</output>
      <output data-testid="dirty">{String(snapshot.dirty)}</output>
      <output data-testid="revision">{snapshot.revision.sequence}</output>
      <pre data-testid="native">{JSON.stringify(host.content)}</pre>
      <pre data-testid="versions">{JSON.stringify(host.artifact.versions)}</pre>
      <pre data-testid="source-history">
        {JSON.stringify({
          undo: host.canUndo,
          redo: host.canRedo,
          undoCandidate: host.peekHistory('undo'),
          redoCandidate: host.peekHistory('redo'),
        })}
      </pre>
      {ref && (
        <ReferenceImage
          item={{ id: 'map-reference', reference: ref, alt: 'Fixed map reference' }}
          resolver={resolver}
        />
      )}
      {ref && (workspace === 'novel' || workspace === 'manga') && (
        <WorkspaceReference workspace={workspace} reference={ref} resolver={resolver} />
      )}
      <FictionMapWorldPanel content={host.content} host={worldHost} />
      <FictionMapArtifactSurface host={host} onError={setError} />
    </main>
  );
}
void initialized.then(() => createRoot(document.getElementById('root')!).render(<App />));
