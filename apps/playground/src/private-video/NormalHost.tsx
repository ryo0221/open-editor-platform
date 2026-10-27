import { useCallback, useEffect, useRef, useState } from 'react';
import build from 'virtual:private-video-m2-build';
import { readM2Catalog, type PrivateVideoM2Entry } from '../private-video-m2/catalog';
import {
  privateVideoM2,
  privateVideoM2Route,
  privateVideoM2Url,
} from '../private-video-m2/registration';
import { ReferencePlayground } from '../shared-host';
interface PrivateHandle {
  close(): Promise<void>;
  inspection(): Promise<unknown>;
}
interface PrivateRuntime {
  contract: string;
  mount(
    root: HTMLElement,
    entryId?: string,
    navigate?: (url: string) => void,
  ): Promise<PrivateHandle>;
}
declare global {
  interface Window {
    editorPrivateVideoM2?: PrivateRuntime;
    editorPrivateVideoHandle?: PrivateHandle;
  }
}
async function loadRuntime(): Promise<PrivateRuntime> {
  if (!build.enabled) throw new Error('Private Video build is not configured');
  const integrity = build.integrity;
  if (!window.editorPrivateVideoM2)
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/private-video-m2-runtime.js';
      script.integrity = integrity;
      script.onload = () => resolve();
      script.onerror = () =>
        reject(new Error('Private Video bundle could not be verified or loaded'));
      document.head.append(script);
    });
  const runtime = window.editorPrivateVideoM2;
  if (
    !runtime ||
    runtime.contract !== privateVideoM2.contract ||
    typeof runtime.mount !== 'function'
  )
    throw new Error('Unsupported private Video contract');
  return runtime;
}
function Workspace({ entryId, navigate }: { entryId?: string; navigate: (url: string) => void }) {
  const root = useRef<HTMLDivElement>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false,
      handle: PrivateHandle | undefined;
    void loadRuntime()
      .then(async (runtime) => {
        if (cancelled) return;
        handle = await runtime.mount(root.current!, entryId, navigate);
        if (cancelled) await handle.close();
        else window.editorPrivateVideoHandle = handle;
      })
      .catch((cause) => {
        if (!cancelled) {
          root.current?.shadowRoot?.replaceChildren();
          setError(String(cause));
        }
      });
    return () => {
      cancelled = true;
      if (window.editorPrivateVideoHandle === handle) delete window.editorPrivateVideoHandle;
      void handle?.close().catch(() => {
        /* Explicit navigation owns drain; abrupt exit is not acceptance. */
      });
    };
  }, [entryId, navigate]);
  return (
    <>
      <div ref={root} />
      {error && (
        <main>
          <p role="alert">{error}</p>
          <button onClick={() => navigate('/')}>Return to local Library</button>
        </main>
      )}
    </>
  );
}
export function NormalHost() {
  const [navigation, setNavigation] = useState(0);
  const navigate = useCallback((destination: string) => {
    const url = new URL(destination, location.href);
    if (url.origin !== location.origin || url.pathname !== '/')
      throw new Error('Unsupported local Video destination');
    privateVideoM2Route(url.search);
    // Runtime calls only after the guarded workspace/lease drain. Keep the
    // already loaded app/runtime alive; this does not promise offline startup.
    history.replaceState(null, '', url.href);
    setNavigation((value) => value + 1);
  }, []);
  let route,
    problem = '';
  let entries: PrivateVideoM2Entry[] = [];
  try {
    if (new URLSearchParams(location.search).get('privateEditor') === 'video-v1-review')
      throw Error(
        'Unsupported legacy Video editor. Current v3 format required; stored data is unchanged.',
      );
    route = privateVideoM2Route(location.search);
  } catch (error) {
    return (
      <main>
        <p role="alert">{String(error)}</p>
        <button onClick={() => navigate('/')}>Return to local Library</button>
      </main>
    );
  }
  if (route) return <Workspace key={navigation} entryId={route.entryId} navigate={navigate} />;
  if (build.enabled)
    try {
      entries = readM2Catalog();
    } catch (error) {
      problem = String(error);
    }
  return (
    <>
      {problem && <p role="alert">Video Library unavailable: {problem}</p>}
      <ReferencePlayground
        privateM2Entries={entries}
        onOpenPrivateM2={
          build.enabled && !problem ? (id) => navigate(privateVideoM2Url(id)) : undefined
        }
      />
    </>
  );
}
