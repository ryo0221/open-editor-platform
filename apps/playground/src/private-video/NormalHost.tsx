import { useEffect, useRef, useState } from 'react';
import build from 'virtual:private-video-build';
import m2Build from 'virtual:private-video-m2-build';
import { readM2Catalog } from '../private-video-m2/catalog';
import {
  privateVideoM2,
  privateVideoM2Route,
  privateVideoM2Url,
} from '../private-video-m2/registration';
import { ReferencePlayground } from '../shared-host';
import { readCatalog, type PrivateVideoEntry } from './catalog';
import { privateVideo, privateVideoRoute, privateVideoUrl } from './registration';
interface PrivateHandle {
  close(): Promise<void>;
  inspection(): Promise<unknown>;
}
interface PrivateRuntime {
  contract: string;
  mount(root: HTMLElement, entryId?: string, validation?: boolean): Promise<PrivateHandle>;
}
declare global {
  interface Window {
    editorPrivateVideo?: PrivateRuntime;
    editorPrivateVideoM2?: PrivateRuntime;
    editorPrivateVideoHandle?: PrivateHandle;
  }
}
async function loadRuntime(m2: boolean): Promise<PrivateRuntime> {
  const selected = m2 ? m2Build : build;
  const key = m2 ? 'editorPrivateVideoM2' : 'editorPrivateVideo';
  if (!selected.enabled) throw new Error('Private Video build is not configured');
  const integrity = selected.integrity;
  if (!window[key])
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = m2 ? '/private-video-m2-runtime.js' : '/private-video-runtime.js';
      script.integrity = integrity;
      script.onload = () => resolve();
      script.onerror = () =>
        reject(new Error('Private Video bundle could not be verified or loaded'));
      document.head.append(script);
    });
  const runtime = window[key];
  if (
    !runtime ||
    runtime.contract !== (m2 ? privateVideoM2.contract : privateVideo.contract) ||
    typeof runtime.mount !== 'function'
  )
    throw new Error('Unsupported private Video contract');
  return runtime;
}
function Workspace({ entryId, m2 }: { entryId?: string; m2: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false,
      handle: PrivateHandle | undefined;
    void loadRuntime(m2)
      .then(async (runtime) => {
        if (cancelled) return;
        handle = await runtime.mount(root.current!, entryId, m2Build.enabled);
        if (cancelled) await handle.close();
        else window.editorPrivateVideoHandle = handle;
      })
      .catch((cause) => setError(String(cause)));
    return () => {
      cancelled = true;
      if (window.editorPrivateVideoHandle === handle) delete window.editorPrivateVideoHandle;
      void handle?.close().catch(() => {
        /* Guarded UI navigation closes first; abrupt page exit is not drain acceptance. */
      });
    };
  }, [entryId, m2]);
  return (
    <>
      <div ref={root} />
      {error && (
        <main>
          <p role="alert">{error}</p>
          <a href="/">Return to local Library</a>
        </main>
      )}
    </>
  );
}
export function NormalHost() {
  let route,
    problem = '',
    m2Problem = '';
  let entries: PrivateVideoEntry[] = [];
  let m2Entries: PrivateVideoEntry[] = [];
  const m2 = new URLSearchParams(location.search).get('privateEditor') === privateVideoM2.id;
  try {
    route = m2 ? privateVideoM2Route(location.search) : privateVideoRoute(location.search);
  } catch (error) {
    return (
      <main>
        <p role="alert">{String(error)}</p>
        <a href="/">Return to local Library</a>
      </main>
    );
  }
  if (route) return <Workspace entryId={route.entryId} m2={m2} />;
  if (build.enabled) {
    try {
      entries = readCatalog();
    } catch (error) {
      problem = String(error);
    }
  }
  if (m2Build.enabled) {
    try {
      m2Entries = readM2Catalog();
    } catch (error) {
      m2Problem = String(error);
    }
  }
  return (
    <>
      {m2Problem && <p role="alert">Private Video M2 Library unavailable: {m2Problem}</p>}
      {problem && <p role="alert">Private Video Library unavailable: {problem}</p>}
      <ReferencePlayground
        privateEntries={entries}
        privateM2Entries={m2Entries}
        onOpenPrivateM2={
          m2Build.enabled && !m2Problem ? (id) => location.assign(privateVideoM2Url(id)) : undefined
        }
        onOpenPrivateEditor={
          build.enabled && !problem ? (id) => location.assign(privateVideoUrl(id)) : undefined
        }
      />
    </>
  );
}
