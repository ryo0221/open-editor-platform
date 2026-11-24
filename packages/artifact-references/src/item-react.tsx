import { useEffect, useMemo, useRef, useState } from 'react';
import {
  itemRefStatusLabel,
  type ItemCandidate,
  type ItemReferenceHost,
  type ItemRefSource,
  type ItemRefState,
  type ItemSelectionLedger,
} from './items';

/** What a Surface passes to show business item references (docs/analysis-references-design.md §3). */
export interface ItemReferenceSurfaceProps {
  itemReferences?: { host: ItemReferenceHost; artifactId: string; ledger: ItemSelectionLedger };
}

const stateText = (s: ItemRefState | undefined) =>
  !s
    ? '確かめています'
    : s.status === 'ok'
      ? s.title
      : s.status === 'kept'
        ? `${itemRefStatusLabel.kept}：${s.title}${s.reason ? `（${s.reason}）` : ''}`
        : `${itemRefStatusLabel[s.status]}：${s.reason}`;

/**
 * One reference field of one element. Candidates, states and opening come from the Host; a choice
 * is one ordinary edit (`change`), so Undo, Redo, saving and import or export follow the usual path.
 * States are shown only: the values are never rewritten here.
 */
export function ItemReferenceField({
  host,
  ledger,
  from,
  label,
  ids,
  multiple,
  readOnly,
  change,
}: {
  host: ItemReferenceHost;
  ledger: ItemSelectionLedger;
  from: ItemRefSource;
  label: string;
  ids: readonly string[];
  /** Whether the field holds several IDs (an array) or one (a string). */
  multiple: boolean;
  readOnly?: boolean;
  /**
   * Applies the new IDs as one command. Returns whether it was applied. It may wait, for example
   * for pending inputs of the same element to be committed and shown first.
   */
  change(ids: string[]): boolean | Promise<boolean>;
}) {
  const [states, setStates] = useState<ReadonlyMap<string, ItemRefState>>(new Map());
  const [tick, setTick] = useState(0);
  const [candidates, setCandidates] = useState<readonly ItemCandidate[] | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const idsKey = JSON.stringify(ids);
  const fromKey = JSON.stringify([from.artifactId, from.elementId, from.field]);
  const alive = useRef(true);
  // The field's current value, to refuse a choice that returns after the field changed
  const current = useRef(idsKey);
  current.current = idsKey;
  useEffect(() => {
    // Strict Mode runs setup, cleanup and setup again: the second setup must mark it mounted
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => host.subscribe?.(() => setTick((n) => n + 1)), [host]);
  useEffect(() => {
    if (!ids.length) return void setStates(new Map());
    const abort = new AbortController();
    host.resolve(from, ids, abort.signal).then(
      (m) => !abort.signal.aborted && setStates(m),
      () =>
        !abort.signal.aborted &&
        setStates(
          new Map(ids.map((id) => [id, { status: 'offline', reason: '状態を確かめられません' }])),
        ),
    );
    return () => abort.abort();
    // from and ids are compared by value
  }, [host, fromKey, idsKey, tick]);
  // A different element or field closes the candidate list.
  useEffect(() => {
    setCandidates(null);
    setMessage('');
  }, [fromKey]);
  const shown = useMemo(() => new Set(ids), [idsKey]);
  async function openList() {
    setMessage('');
    setBusy(true);
    try {
      const list = await host.candidates(from, new AbortController().signal);
      if (alive.current) setCandidates(list.filter((c) => !shown.has(c.id)));
    } catch {
      if (alive.current) setMessage('候補を読めませんでした');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function choose(id: string) {
    setBusy(true);
    setMessage('');
    try {
      const at = { ...from };
      const startedWith = idsKey;
      const r = await host.select(at, id, new AbortController().signal);
      if (!alive.current) return;
      if (current.current !== startedWith)
        return void setMessage('選んでいる間に欄が変わりました。選び直してください');
      if (!r.accepted) return void setMessage(`選べません：${stateText(r.state)}`);
      const next = multiple ? [...ids.filter((x) => x !== id), id] : [id];
      // The command goes in first; the choice is kept only when the edit was applied.
      if (await change(next)) {
        // Choices of replaced IDs stay until the save: Undo may bring them back, and a save
        // sends evidence only for citations it holds
        ledger.choose(at, id, r);
        setCandidates(null);
      } else setMessage('変更できませんでした');
    } catch {
      if (alive.current) setMessage('候補を確かめられませんでした');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function remove(id: string) {
    // The choice stays until the save so that Undo of the removal keeps its evidence
    setMessage('');
    try {
      if (!(await change(ids.filter((x) => x !== id))) && alive.current)
        setMessage('変更できませんでした');
    } catch {
      if (alive.current) setMessage('変更できませんでした');
    }
  }
  async function open(id: string) {
    setMessage('');
    try {
      const r = await host.open(id, from);
      if (alive.current && !r.opened) setMessage(`開けません：${stateText(r.state)}`);
    } catch {
      if (alive.current) setMessage('開けませんでした');
    }
  }
  return (
    <section className="ep-item-refs" aria-label={label}>
      <h4>{label}</h4>
      {ids.length ? (
        <ul>
          {ids.map((id) => {
            const s = states.get(id);
            return (
              <li key={id} data-status={s?.status ?? 'loading'}>
                <code>{id}</code> <span>{stateText(s)}</span>
                <button type="button" onClick={() => void open(id)} aria-label={`${id} を開く`}>
                  開く
                </button>
                {!readOnly && (
                  <button type="button" onClick={() => void remove(id)} aria-label={`${id} を外す`}>
                    外す
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p>引用はありません</p>
      )}
      {!readOnly && (
        <button type="button" disabled={busy} onClick={() => void openList()}>
          候補から選ぶ
        </button>
      )}
      {candidates && (
        <ul aria-label={`${label}の候補`}>
          {candidates.length ? (
            candidates.map((c) => (
              <li key={c.id}>
                <button type="button" disabled={busy} onClick={() => void choose(c.id)}>
                  <code>{c.id}</code> {c.title}
                </button>{' '}
                <small>
                  {c.artifactTitle}
                  {c.note ? `・${c.note}` : ''}
                </small>
              </li>
            ))
          ) : (
            <li>選べる候補はありません</li>
          )}
        </ul>
      )}
      {message && <p role="alert">{message}</p>}
    </section>
  );
}
