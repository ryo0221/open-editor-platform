import { useEffect, useMemo, useRef, useState } from 'react';
import type { FictionMapContent } from './model';
export type FictionMapWorldResult =
  | { status: 'ready'; label: string }
  | { status: 'missing-source' | 'offline' | 'error'; message?: string };
export interface FictionMapWorldHost {
  checkAccess(ref: { namespace: string; entityId: string }): boolean | Promise<boolean>;
  resolve(
    ref: { namespace: string; entityId: string },
    signal: AbortSignal,
  ): Promise<FictionMapWorldResult>;
  subscribe?(notify: () => void): () => void;
}
/** Optional consuming Host service. No World native, policy or history is owned here. */
export function FictionMapWorldPanel({
  content,
  host,
}: {
  content: FictionMapContent;
  host?: FictionMapWorldHost;
}) {
  const refs = content.features
      .filter((f) => f.worldEntityRef)
      .map((f) => ({ id: f.id, name: f.name, ref: f.worldEntityRef! })),
    identity = JSON.stringify(refs),
    [epoch, setEpoch] = useState(0),
    scope = useMemo(() => ({ host, identity, epoch }), [host, identity, epoch]),
    [resolved, setResolved] = useState<{
      scope?: typeof scope;
      values: Record<string, FictionMapWorldResult | { status: 'forbidden' | 'loading' }>;
    }>({ values: {} }),
    latest = useRef(host);
  const states = resolved.scope === scope ? resolved.values : {};
  latest.current = host;
  useEffect(
    () =>
      host?.subscribe?.(() => {
        setResolved({ values: {} });
        setEpoch((n) => n + 1);
      }),
    [host],
  );
  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    setResolved({ scope, values: {} });
    if (host)
      for (const item of refs) {
        void (async () => {
          let result: FictionMapWorldResult | { status: 'forbidden' };
          try {
            if (!(await host.checkAccess(item.ref))) result = { status: 'forbidden' };
            else {
              const resolved = await host.resolve(item.ref, abort.signal);
              result = (await host.checkAccess(item.ref)) ? resolved : { status: 'forbidden' };
            }
          } catch {
            result = { status: 'error', message: 'World lookup failed' };
          }
          if (active && latest.current === host)
            setResolved((s) => ({
              scope,
              values: { ...(s.scope === scope ? s.values : {}), [item.id]: result },
            }));
        })();
      }
    return () => {
      active = false;
      abort.abort();
    };
  }, [scope]);
  if (!refs.length) return null;
  return (
    <section aria-label="World reference diagnostics">
      <h3>World references</h3>
      {!host && <p>World service is not connected. References remain opaque native data.</p>}
      {refs.map((item) => {
        const state = host ? states[item.id] : undefined;
        return (
          <p key={item.id} data-world-feature={item.id}>
            {item.name}:{' '}
            {state?.status === 'ready'
              ? state.label
              : (state?.status ?? (host ? 'loading' : 'not-connected'))}
          </p>
        );
      })}
    </section>
  );
}
