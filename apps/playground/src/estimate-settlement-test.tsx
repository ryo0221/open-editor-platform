import { StrictMode, useCallback, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  EditorInputs,
  EditorSession,
  type EditorInputBoundary,
} from '@editor-platform/editor-core';
import { canonicalJson } from '@editor-platform/artifact-core';
import {
  EstimateSurface,
  type EstimateSettlement,
  type EstimatePort,
} from '@editor-platform/estimate';
import { calculateEstimate, type EstimateDocument } from '@editor-platform/estimate-core';
import { estimateFixture } from '../../../packages/estimate-core/src/fixtures';
import '@editor-platform/estimate/styles.css';
function Slot({ name }: { name: string }) {
  const [scope, setScope] = useState(() => ({
    session: new EditorSession(estimateFixture()),
    inputs: new EditorInputs(),
    key: 0,
  }));
  const { session, inputs } = scope;
  const registerInput = useCallback(
    (boundary: EditorInputBoundary) => inputs.register(boundary),
    [inputs],
  );
  // Test-only budget, not a product default. Hosts must choose their own finite bound.
  const [waitMs, setWaitMs] = useState(5000);
  const retired = useRef<{ owner: EstimateSettlement; cleanup: () => void }[]>([]);
  const [mounted, setMounted] = useState(true);
  const [, render] = useState(0);
  const [notice, setNotice] = useState('');
  // Synthetic persistence outcomes for Surface notices, not a product API or deadline.
  const [holdSave, setHoldSave] = useState(false);
  const pendingSave = useRef<((error?: string) => void) | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  const handle = useRef<EstimateSettlement | null>(null);
  const pending = useRef<
    {
      worker: Worker;
      message: { document: EstimateDocument; id: string; scenarioId: string | null };
    }[]
  >([]);
  const worker = useRef(() => {
    const w = {
      onmessage: null,
      onerror: null,
      terminate() {},
      postMessage(message: (typeof pending.current)[number]['message']) {
        pending.current.push({ worker: w as unknown as Worker, message });
      },
    };
    return w as unknown as Worker;
  }).current;
  const port: EstimatePort = {
    read: () => session.content,
    revision: () => canonicalJson(session.revision),
    generation: () => 0,
    canEdit: () => true,
    canRead: () => true,
    canExport: () => true,
    inputsReady: () => true,
    flush() {
      inputs.flush();
    },
    execute(c) {
      session.execute(c);
      render((n) => n + 1);
    },
  };
  const save = async () => {
    const owner = handle.current;
    try {
      if (!owner) throw Error('detached');
      inputs.flush();
      setNotice('waiting');
      const result = await owner.wait({ timeoutMs: waitMs });
      inputs.flush();
      if (
        handle.current !== owner ||
        !owner.isCurrent(result) ||
        (result.status !== 'idle' && result.status !== 'accepted')
      )
        throw Error(result.status);
      // Existing Host input/revision/save responsibilities stay outside the observer.
      const text = JSON.stringify(session.content);
      if (holdSave)
        await new Promise<void>((resolve, reject) => {
          pendingSave.current = (error) => {
            pendingSave.current = null;
            if (error) reject(Error(error));
            else resolve();
          };
        });
      setSaved((previous) => [...previous, text]);
      setNotice('saved');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      // Surface.save is Promise<void>: rejection is required to avoid false success UI.
      throw error;
    }
  };
  return (
    <section aria-label={`Host ${name}`}>
      <button onClick={() => void save().catch(() => {})}>Host save</button>
      <button onClick={() => render((n) => n + 1)}>Rerender</button>
      <label>
        Hold persistence
        <input type="checkbox" checked={holdSave} onChange={(e) => setHoldSave(e.target.checked)} />
      </label>
      <button onClick={() => pendingSave.current?.()}>Resolve persistence</button>
      <button onClick={() => pendingSave.current?.('PUT 500')}>Reject persistence</button>
      <button onClick={() => pendingSave.current?.('timeout')}>Expire persistence</button>
      <button
        onClick={() =>
          setScope((old) => ({
            session: new EditorSession(estimateFixture()),
            inputs: new EditorInputs(),
            key: old.key + 1,
          }))
        }
      >
        Replace
      </button>
      <button
        onClick={() => {
          for (const entry of retired.current) if (entry.owner !== handle.current) entry.cleanup();
        }}
      >
        Replay retired cleanup
      </button>
      <label>
        Wait deadline ms
        <input type="number" value={waitMs} onChange={(e) => setWaitMs(Number(e.target.value))} />
      </label>
      <button
        onClick={() => {
          pending.current.shift()?.worker.onerror?.({ message: 'worker failed' } as ErrorEvent);
        }}
      >
        Fail worker
      </button>
      <button onClick={() => setMounted(false)}>Detach</button>
      <button
        onClick={() => {
          const p = pending.current.shift();
          if (p)
            void calculateEstimate(p.message.document, p.message.id, p.message.scenarioId).then(
              (result) =>
                p.worker.onmessage?.({ data: { id: p.message.id, result } } as MessageEvent),
            );
        }}
      >
        Deliver worker
      </button>
      <output aria-label="Save notice">{notice}</output>
      <output aria-label="Saved calculations">
        {saved.map((text) => (JSON.parse(text) as EstimateDocument).calculations.length).join(',')}
      </output>
      {mounted && (
        <EstimateSurface
          key={scope.key}
          registerInput={registerInput}
          port={port}
          instanceKey={session}
          worker={worker}
          registerSettlement={(owned) => {
            handle.current = owned;
            const cleanup = () => {
              if (handle.current === owned) handle.current = null;
            };
            retired.current.push({ owner: owned, cleanup });
            return cleanup;
          }}
          save={save}
          history={(d) => {
            if (d === 'undo') session.undo();
            else session.redo();
            render((n) => n + 1);
          }}
        />
      )}
    </section>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Slot name="A" />
    <Slot name="B" />
  </StrictMode>,
);
