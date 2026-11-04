/**
 * Story Timeline T2-2: the editing controls of the timeline screen. Every control builds a
 * command of `commands.ts` and runs it through the workbench, the same command a drag, the
 * keyboard or a headless caller builds (TL18a). A form keeps what the author typed only in the
 * screen until it is confirmed; Cancel drops it without touching any owner.
 *
 * Forms register with their owner's input registry, so leaving the screen (a trip to the
 * source or the manuscript) first confirms them into that owner's own history, or keeps the
 * author here when they cannot be confirmed (TL17).
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { EditorCommand } from '@editor-platform/editor-core';
import type { TimelineForm } from './forms';
import type { StructuredData } from '@editor-platform/structured-data/model';
import {
  deleteEvent,
  deleteOccurrence,
  deleteScene,
  insertRows,
  moveOccurrence,
  removeCitation,
  setCells,
  setTime,
  setDerivation,
  type TimelineRowInput,
  type TimelineTimeInput,
} from './commands';
import type { TimelineProjection } from './projection';
import {
  UNDO_SCOPE_NOTE,
  type TimelineEditResult,
  type TimelineWorkbench,
  type TimelineWorkbenchOwner,
} from './workbench';

export type Notice = { ok: boolean; text: string };
type Row = StructuredData['rows'][number];
const cell = (r: Row | undefined, k: string) => r?.values[k] as string | number | undefined;
const message = (e: unknown) => String(e instanceof Error ? e.message : e);

/** Owner-local keyboard Undo/Redo: never inside a field, never while composing. */
export function isHistoryKey(e: KeyboardEvent): 'undo' | 'redo' | undefined {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.isComposing) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest('input, textarea, select, [contenteditable="true"]')) return;
  const k = e.key.toLowerCase();
  if (k === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (k === 'y' && !e.shiftKey) return 'redo';
}

/** The bar above the screen: which owner Undo acts on, its state, and unsaved owners. */
export function EditBar({
  workbench: w,
  notice,
  setNotice,
}: {
  workbench: TimelineWorkbench;
  notice?: Notice;
  setNotice(n: Notice): void;
}) {
  const u = w.undoState;
  const owners = [
    ...w.ownersOf('ledger'),
    ...w.ownersOf('scene-cards'),
    ...w.ownersOf('composition'),
    ...w.ownersOf('world'),
  ];
  const history = (d: 'undo' | 'redo') => {
    const r = w.history(d);
    setNotice(
      r.ok
        ? {
            ok: true,
            text: `${u.owner?.name} の操作を${d === 'undo' ? '元に戻しました' : 'やり直しました'}。`,
          }
        : { ok: false, text: r.message },
    );
  };
  const [saving, setSaving] = useState<string>();
  return (
    <section className="tl-editbar" aria-label="編集">
      <p data-undo-owner={u.owner?.id ?? ''}>
        元に戻す対象：{u.owner ? u.owner.name : 'まだありません'}
        {u.owner && !u.blocked && (
          <span className="tl-badge">
            {u.canUndo ? '元に戻せます' : '元に戻す操作はありません'}・
            {u.canRedo ? 'やり直せます' : 'やり直す操作はありません'}
          </span>
        )}
        {u.blocked && <span className="tl-badge">{u.blocked}</span>}
      </p>
      <p className="tl-unsupported">{UNDO_SCOPE_NOTE}</p>
      <p>
        <button type="button" disabled={!u.canUndo} onClick={() => history('undo')}>
          元に戻す
        </button>
        <button type="button" disabled={!u.canRedo} onClick={() => history('redo')}>
          やり直す
        </button>
        <label>
          対象を切り替える{' '}
          <select
            value={u.owner?.id ?? ''}
            onChange={(e) => {
              const r = w.activate(e.currentTarget.value);
              if (!r.ok) setNotice({ ok: false, text: r.message });
            }}
          >
            <option value="" disabled>
              選んでください
            </option>
            {owners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
      </p>
      {w.unsaved.length > 0 && (
        <ul className="tl-unsaved" aria-label="未保存の資料">
          {w.unsaved.map((o) => (
            <li key={o.id} data-unsaved={o.id}>
              {o.name}：未保存の変更があります{' '}
              <button
                type="button"
                disabled={saving === o.id}
                onClick={async () => {
                  const current = w.captureAccess(o.id);
                  setSaving(o.id);
                  const r = await w.save(o.id);
                  setSaving(undefined);
                  if (!current()) return;
                  setNotice(
                    r.ok
                      ? { ok: true, text: `${o.name} を保存しました（${r.versionId}）。` }
                      : { ok: false, text: r.message },
                  );
                }}
              >
                {o.name} を保存
              </button>
            </li>
          ))}
        </ul>
      )}
      {w.closed.length > 0 && (
        <p className="tl-unsupported" data-closed-owners>
          編集できない資料：{w.closed.map((c) => `${c.id}（${c.reason}）`).join('、')}
        </p>
      )}
      {notice &&
        (notice.ok ? (
          <p role="status" className="tl-notice">
            {notice.text}
          </p>
        ) : (
          <p role="alert" className="tl-notice" data-refused>
            {notice.text}
          </p>
        ))}
    </section>
  );
}

/**
 * One small form. Its fields stay in the screen until 確定; while they differ from what the
 * form opened with, the owner's input registry holds them as an unconfirmed input.
 */
export function EditForm({
  owner,
  title,
  dirty,
  closeUnchanged = false,
  build,
  validate,
  success,
  cancel,
  children,
}: {
  owner: TimelineWorkbenchOwner;
  title: string;
  dirty: boolean;
  closeUnchanged?: boolean;
  build?(): EditorCommand<StructuredData>;
  validate?(signal: AbortSignal): Promise<EditorCommand<StructuredData>>;
  success?(): void;
  cancel(): void;
  children: ReactNode;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const element = useRef<HTMLFormElement>(null);
  const latest = useRef({ dirty, build, validate, success, cancel });
  latest.current = { dirty, build, validate, success, cancel };
  const state = useMemo(
    () => ({
      generation: 0,
      controller: undefined as AbortController | undefined,
      consumed: false,
      pending: false,
      composing: false,
      ready: undefined as EditorCommand<StructuredData> | undefined,
    }),
    [owner],
  );
  const form = useMemo<TimelineForm>(
    () => ({
      dirty: () => !state.consumed && (latest.current.dirty || state.pending),
      composing: () => !state.consumed && state.composing,
      prepare: () => {
        if (state.consumed) throw Error('この入力は確定済みです。');
        if (state.composing) throw Error('入力変換を確定してから操作してください。');
        if (state.pending)
          throw Error('参照先を確認しています。完了または取消後に操作してください。');
        const generation = state.generation;
        const command = latest.current.build?.() ?? state.ready;
        if (!command) throw Error('参照先の確認が要る入力は、確定してから移動してください。');
        return {
          ...command,
          apply: (content) => {
            if (state.generation !== generation || state.consumed)
              throw Error('入力が変わりました。再確認してください。');
            return command.apply(content);
          },
        };
      },
      consume: () => {
        state.consumed = true;
        state.controller?.abort();
        state.ready = undefined;
        state.generation++;
      },
      finalize: () => {
        latest.current.cancel();
        latest.current.success?.();
      },
      focus: () => element.current?.querySelector<HTMLElement>('input, select')?.focus(),
    }),
    [state],
  );
  useEffect(() => {
    state.consumed = false;
    const remove = owner.forms.register(form);
    return () => {
      state.generation++;
      state.controller?.abort();
      state.consumed = true;
      remove();
    };
  }, [owner, form, state]);
  useEffect(() => owner.inputs.changed(), [owner, dirty]);
  const invalidate = () => {
    state.generation++;
    state.controller?.abort();
    state.ready = undefined;
  };
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (state.consumed || state.pending) return;
    const generation = state.generation;
    try {
      if (state.composing) throw Error('入力変換を確定してから操作してください。');
      if (closeUnchanged && !latest.current.dirty) {
        form.consume();
        latest.current.cancel();
        return;
      }
      if (latest.current.validate) {
        state.pending = true;
        setBusy(true);
        owner.inputs.changed();
        state.controller?.abort();
        state.controller = new AbortController();
        const command = await latest.current.validate(state.controller.signal);
        if (state.consumed || state.generation !== generation) return;
        state.ready = command;
      }
      state.pending = false;
      owner.forms.prepare(form)();
    } catch (e) {
      if (!state.consumed && state.generation === generation) setError(message(e));
    } finally {
      state.pending = false;
      setBusy(false);
      owner.inputs.changed();
    }
  };
  return (
    <form
      className="tl-form"
      ref={element}
      onSubmit={onSubmit}
      onChangeCapture={invalidate}
      onCompositionStartCapture={() => {
        state.composing = true;
        owner.inputs.changed();
      }}
      onCompositionEndCapture={() => {
        state.composing = false;
        owner.inputs.changed();
      }}
      aria-label={title}
    >
      <h4>{title}</h4>
      {children}
      {error && (
        <p role="alert" data-refused>
          {error}
        </p>
      )}
      <p>
        <button type="submit" disabled={busy}>
          確定
        </button>
        <button
          type="button"
          onClick={() => {
            invalidate();
            state.consumed = true;
            cancel();
          }}
        >
          取消
        </button>
      </p>
    </form>
  );
}

export function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <p className="tl-field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </p>
  );
}
const num = (s: string) => (s.trim() === '' ? undefined : Number(s));
const TIME_KINDS: [TimelineTimeInput['kind'], string][] = [
  ['unset', '時点未定'],
  ['day', '日'],
  ['point', '時点'],
  ['interval', '期間'],
  ['range', '不確定な範囲'],
];

function TimeFields({
  kind,
  start,
  end,
  set,
  derived = false,
}: {
  kind: TimelineTimeInput['kind'];
  start: string;
  end: string;
  set(next: { kind?: TimelineTimeInput['kind']; start?: string; end?: string }): void;
  derived?: boolean;
}) {
  return (
    <>
      <Field label="時点の種類">
        {(id) => (
          <select
            id={id}
            value={kind}
            onChange={(e) => set({ kind: e.currentTarget.value as TimelineTimeInput['kind'] })}
          >
            {TIME_KINDS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
            {derived && <option value="derived">別の出来事から導出</option>}
          </select>
        )}
      </Field>
      {kind !== 'unset' && kind !== 'derived' && (
        <Field label={kind === 'day' ? '日' : '始まり'}>
          {(id) => (
            <input
              id={id}
              inputMode="numeric"
              value={start}
              onChange={(e) => set({ start: e.currentTarget.value })}
            />
          )}
        </Field>
      )}
      {(kind === 'interval' || kind === 'range') && (
        <Field label="終わり">
          {(id) => (
            <input
              id={id}
              inputMode="numeric"
              value={end}
              onChange={(e) => set({ end: e.currentTarget.value })}
            />
          )}
        </Field>
      )}
    </>
  );
}
const timeOf = (t: { kind: TimelineTimeInput['kind']; start: string; end: string }) =>
  ({
    kind: t.kind,
    ...(t.kind !== 'unset' && t.kind !== 'derived' && num(t.start) !== undefined
      ? { start: num(t.start) }
      : {}),
    ...((t.kind === 'interval' || t.kind === 'range') && num(t.end) !== undefined
      ? { end: num(t.end) }
      : {}),
  }) as TimelineTimeInput;
const rowTime = (r: Row | undefined): TimelineTimeInput => ({
  kind: (cell(r, 'tl1.time.kind') ?? 'unset') as TimelineTimeInput['kind'],
  start: cell(r, 'tl1.time.start') as number | undefined,
  end: cell(r, 'tl1.time.end') as number | undefined,
  clock: cell(r, 'tl1.clock') as string | undefined,
});

/** Adding an event to a ledger of the Story (TL01): no SC is made for it. */
export function NewEvent({
  workbench: w,
  world,
  done,
  notify,
}: {
  workbench: TimelineWorkbench;
  world?: string;
  done(): void;
  notify(n: Notice): void;
}) {
  const ledgers = w.ownersOf('ledger').filter((o) => w.editable(o.id));
  const [ledger, setLedger] = useState(
    (ledgers.find((l) => l.world === world) ?? ledgers[0])?.id ?? '',
  );
  const [label, setLabel] = useState('');
  const [time, setT] = useState({ kind: 'day' as TimelineTimeInput['kind'], start: '', end: '' });
  const owner = w.owner(ledger);
  const ids = useRef(new Map<string, string>());
  if (!owner) return <p>出来事を加えられる台帳がありません。</p>;
  if (!ids.current.has(ledger)) ids.current.set(ledger, w.nextId(ledger, 'EV'));
  const id = ids.current.get(ledger)!;
  const build = () => {
    const t = timeOf(time);
    return insertRows(
      'ledger',
      [
        {
          id,
          values: {
            'tl1.row': 'event',
            'tl1.label': label,
            'tl1.time.kind': t.kind,
            'tl1.time.start': t.start,
            'tl1.time.end': t.end,
          },
        },
      ],
      '出来事を追加',
    );
  };
  return (
    <EditForm
      owner={owner}
      title="出来事を追加"
      dirty={label !== '' || time.start !== '' || time.end !== '' || time.kind !== 'day'}
      build={build}
      success={() => notify({ ok: true, text: `${owner.name} に ${id}「${label}」を加えました。` })}
      cancel={done}
    >
      <Field label="台帳">
        {(fid) => (
          <select id={fid} value={ledger} onChange={(e) => setLedger(e.currentTarget.value)}>
            {ledgers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <p className="tl-unsupported">ID {id}。場面は作りません（裏の出来事として残ります）。</p>
      <Field label="名前">
        {(fid) => (
          <input id={fid} value={label} onChange={(e) => setLabel(e.currentTarget.value)} />
        )}
      </Field>
      <TimeFields {...time} set={(n) => setT({ ...time, ...n })} />
    </EditForm>
  );
}

/** Adding an SC to scene cards. It is not placed in the composition until the author does. */
export function NewScene({
  workbench: w,
  done,
  notify,
}: {
  workbench: TimelineWorkbench;
  done(): void;
  notify(n: Notice): void;
}) {
  const cards = w.ownersOf('scene-cards').filter((o) => w.editable(o.id));
  const [owner, setOwner] = useState(cards[0]?.id ?? '');
  const [label, setLabel] = useState('');
  const o = w.owner(owner);
  const ids = useRef(new Map<string, string>());
  if (!o) return <p>場面を加えられるシーンカードがありません。</p>;
  if (!ids.current.has(owner)) ids.current.set(owner, w.nextId(owner, 'SC'));
  const id = ids.current.get(owner)!;
  return (
    <EditForm
      owner={o}
      title="場面を追加"
      dirty={label !== ''}
      build={() =>
        insertRows(
          'scene-cards',
          [{ id, values: { 'tl1.row': 'scene', 'tl1.label': label } }],
          '場面を追加',
        )
      }
      success={() =>
        notify({ ok: true, text: `${o.name} に ${id}「${label}」を加えました（構成に未配置）。` })
      }
      cancel={done}
    >
      <Field label="シーンカード">
        {(fid) => (
          <select id={fid} value={owner} onChange={(e) => setOwner(e.currentTarget.value)}>
            {cards.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <p className="tl-unsupported">ID {id}。</p>
      <Field label="名前">
        {(fid) => (
          <input id={fid} value={label} onChange={(e) => setLabel(e.currentTarget.value)} />
        )}
      </Field>
    </EditForm>
  );
}

function Rename({
  workbench: _w,
  owner,
  role,
  row,
  notify,
}: {
  workbench: TimelineWorkbench;
  owner: TimelineWorkbenchOwner;
  role: 'ledger' | 'scene-cards';
  row: Row;
  notify(n: Notice): void;
}) {
  const seen = String(cell(row, 'tl1.label') ?? '');
  const [open, setOpen] = useState<{ seen: string }>();
  const [label, setLabel] = useState(seen);
  if (!open)
    return (
      <button type="button" onClick={() => (setLabel(seen), setOpen({ seen }))}>
        名前を変更
      </button>
    );
  return (
    <EditForm
      owner={owner}
      title={`${row.id} の名前`}
      closeUnchanged
      dirty={label !== open.seen}
      build={() =>
        setCells(role, row.id, { 'tl1.label': label }, { 'tl1.label': open.seen }, '名前を変更')
      }
      success={() => notify({ ok: true, text: `${row.id} の名前を変えました。` })}
      cancel={() => setOpen(undefined)}
    >
      <Field label="名前">
        {(id) => <input id={id} value={label} onChange={(e) => setLabel(e.currentTarget.value)} />}
      </Field>
    </EditForm>
  );
}

function Retime({
  workbench: w,
  owner,
  row,
  notify,
}: {
  workbench: TimelineWorkbench;
  owner: TimelineWorkbenchOwner;
  row: Row;
  notify(n: Notice): void;
}) {
  const [open, setOpen] = useState<TimelineTimeInput>();
  const [time, setT] = useState({ kind: 'day' as TimelineTimeInput['kind'], start: '', end: '' });
  const [relation, setRelation] = useState<TimelineRowInput>();
  const [relationId, setRelationId] = useState('');
  const [input, setInput] = useState({
    source: 'local',
    exact: '',
    base: '',
    anchor: 'start' as 'start' | 'end',
    min: '0',
    max: '0',
  });
  const [initial, setInitial] = useState(input);
  if (!open)
    return (
      <button
        type="button"
        onClick={() => {
          const t = rowTime(row);
          const old = w
            .rows(owner.id)
            .find(
              (r) => r.values['tl1.row'] === 'derive-time' && r.values['tl1.subject'] === row.id,
            );
          setRelation(old ? (structuredClone(old) as TimelineRowInput) : undefined);
          setRelationId(old?.id ?? w.nextRelationId(owner.id, row.id + '.derive'));
          const next = {
            source: old?.values['tl1.ref.artifact'] ? 'saved' : 'local',
            exact: old?.values['tl1.ref.artifact']
              ? JSON.stringify(
                  Object.fromEntries(
                    Object.entries(old.values).filter(([k]) => k.startsWith('tl1.ref.')),
                  ),
                )
              : '',
            base: old?.values['tl1.ref.artifact'] ? '' : String(old?.values['tl1.ref.item'] ?? ''),
            anchor: (old?.values['tl1.anchor'] ?? 'start') as 'start' | 'end',
            min: String(old?.values['tl1.offset.min'] ?? 0),
            max: String(old?.values['tl1.offset.max'] ?? 0),
          };
          setInput(next);
          setInitial(next);
          setT({ kind: t.kind, start: t.start?.toString() ?? '', end: t.end?.toString() ?? '' });
          setOpen(t);
        }}
      >
        時点を変更
      </button>
    );
  const t = timeOf(time);
  const buildLocal = () =>
    time.kind === 'derived'
      ? setDerivation(
          row.id,
          relationId,
          input.base,
          input.anchor,
          num(input.min) ?? NaN,
          num(input.max) ?? NaN,
          open,
          relation,
        )
      : setTime(row.id, { ...t, clock: open.clock }, open, relation);
  const external = time.kind === 'derived' && input.source === 'saved';
  const build = async () => {
    if (!external) return buildLocal();
    if (!input.exact) throw Error('保存版の導出元を選んでください。');
    const base = await w.verify([
      {
        id: relationId,
        values: { 'tl1.row': 'derive-time', 'tl1.subject': row.id, ...JSON.parse(input.exact) },
      },
    ]);
    return setDerivation(
      row.id,
      relationId,
      base,
      input.anchor,
      num(input.min) ?? NaN,
      num(input.max) ?? NaN,
      open,
      relation,
    );
  };
  const asynchronous = external || w.needsTimeValidation(owner.id, buildLocal);
  const savedChoices = w
    .ownersOf('ledger')
    .filter((o) => o.id !== owner.id)
    .flatMap((o) => {
      const a = o.editor.artifact;
      // Choices describe saved cells, never the editable draft's labels or newly added events.
      const v = a.versions.find((v) => v.versionId === a.draft.baseVersionId);
      return v
        ? v.content.rows
            .filter((r) => r.values['tl1.row'] === 'event')
            .map((r) => ({
              key: JSON.stringify({
                'tl1.ref.artifact': o.id,
                'tl1.ref.version': v.versionId,
                'tl1.ref.hash': v.contentHash,
                'tl1.ref.item': r.id,
              }),
              label: `${o.name} · ${r.id} · ${String(r.values['tl1.label'])}（保存版 ${v.versionId}）`,
            }))
        : [];
    });
  if (input.source === 'saved' && input.exact && !savedChoices.some((c) => c.key === input.exact)) {
    const ref = JSON.parse(input.exact) as Record<string, string>;
    const savedOwner = w.owner(ref['tl1.ref.artifact']);
    const version = savedOwner?.editor.artifact.versions.find(
      (v) => v.versionId === ref['tl1.ref.version'] && v.contentHash === ref['tl1.ref.hash'],
    );
    const savedRow = version?.content.rows.find((r) => r.id === ref['tl1.ref.item']);
    if (savedOwner && version && savedRow)
      savedChoices.push({
        key: input.exact,
        label: `${savedOwner.name} · ${savedRow.id} · ${String(savedRow.values['tl1.label'])}（保存版 ${version.versionId}）`,
      });
  }
  return (
    <EditForm
      owner={owner}
      title={`${row.id} の時点`}
      closeUnchanged
      dirty={
        (time.kind === 'derived' && JSON.stringify(input) !== JSON.stringify(initial)) ||
        JSON.stringify(t) !==
          JSON.stringify(
            timeOf({
              kind: open.kind,
              start: open.start?.toString() ?? '',
              end: open.end?.toString() ?? '',
            }),
          )
      }
      validate={
        asynchronous ? (signal) => w.prepareTimeEdit(owner.id, row.id, build, signal) : undefined
      }
      build={asynchronous ? undefined : buildLocal}
      success={() => notify({ ok: true, text: `${row.id} の時点を変えました。` })}
      cancel={() => setOpen(undefined)}
    >
      <TimeFields {...time} derived set={(n) => setT({ ...time, ...n })} />
      {time.kind === 'derived' && (
        <>
          <p>
            同じ台帳は編集中の内容、別の台帳は選んだ保存版から計算します。導出元は変更しません。
          </p>
          <Field label="導出元の種類">
            {(id) => (
              <select
                id={id}
                value={input.source}
                onChange={(e) => setInput({ ...input, source: e.currentTarget.value })}
              >
                <option value="local">同じ台帳</option>
                <option value="saved">別の台帳の保存版</option>
              </select>
            )}
          </Field>
          {input.source === 'saved' ? (
            <Field label="導出元（保存版）">
              {(id) => (
                <select
                  id={id}
                  value={input.exact}
                  onChange={(e) => setInput({ ...input, exact: e.currentTarget.value })}
                >
                  <option value="">読める保存版を選んでください</option>
                  {savedChoices.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : (
            <Field label="導出元（同じ台帳）">
              {(id) => (
                <select
                  id={id}
                  value={input.base}
                  onChange={(e) => setInput({ ...input, base: e.currentTarget.value })}
                >
                  <option value="">選んでください</option>
                  {w
                    .rows(owner.id)
                    .filter((r) => r.values['tl1.row'] === 'event' && r.id !== row.id)
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.id} · {String(r.values['tl1.label'])}
                      </option>
                    ))}
                </select>
              )}
            </Field>
          )}
          <Field label="基準の端">
            {(id) => (
              <select
                id={id}
                value={input.anchor}
                onChange={(e) =>
                  setInput({ ...input, anchor: e.currentTarget.value as 'start' | 'end' })
                }
              >
                <option value="start">始まり</option>
                <option value="end">終わり</option>
              </select>
            )}
          </Field>
          <Field label="最小日差">
            {(id) => (
              <input
                id={id}
                inputMode="numeric"
                value={input.min}
                onChange={(e) => setInput({ ...input, min: e.currentTarget.value })}
              />
            )}
          </Field>
          <Field label="最大日差">
            {(id) => (
              <input
                id={id}
                inputMode="numeric"
                value={input.max}
                onChange={(e) => setInput({ ...input, max: e.currentTarget.value })}
              />
            )}
          </Field>
        </>
      )}
    </EditForm>
  );
}

function DeleteButton({
  label,
  run,
  notify,
}: {
  label: string;
  run(): TimelineEditResult;
  notify(n: Notice): void;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        const r = run();
        notify(r.ok ? { ok: true, text: `${label}しました。` } : { ok: false, text: r.message });
      }}
    >
      {label}
    </button>
  );
}

/** The edit controls of the selected event (a ledger row of this Story, not an inherited one). */
export function EventEdit({
  workbench: w,
  owner: ownerId,
  id,
  notify,
}: {
  workbench: TimelineWorkbench;
  owner: string;
  id: string;
  notify(n: Notice): void;
}) {
  const owner = w.owner(ownerId);
  const row = w.rows(ownerId).find((r) => r.id === id);
  if (!owner || !row || !w.editable(ownerId))
    return <p className="tl-unsupported">この出来事の台帳は編集できません。</p>;
  return (
    <div className="tl-edit" data-edit-event={id}>
      <Rename workbench={w} owner={owner} role="ledger" row={row} notify={notify} />
      <Retime workbench={w} owner={owner} row={row} notify={notify} />
      <DeleteButton
        label={`${id} を削除`}
        run={() => w.run(ownerId, () => deleteEvent(id))}
        notify={notify}
      />
    </div>
  );
}

/** Citing an event: its newest saved version, confirmed before it is written. */
async function citeRows(
  w: TimelineWorkbench,
  sceneOwner: string,
  scene: string,
  event: string,
  citeId?: string,
): Promise<TimelineEditResult & { rows?: Awaited<ReturnType<TimelineWorkbench['verify']>> }> {
  const [ledger, item] = event.split('#');
  const ref = w.savedRef(ledger, item);
  if (!ref)
    return {
      ok: false,
      message: '読める保存版に項目がありません。先に台帳を保存してください。',
    };
  const existing = citeId ? w.rows(sceneOwner).find((r) => r.id === citeId) : undefined;
  if (citeId && !existing)
    return { ok: false, message: '引用が変わりました。再確認してください。' };
  const id = citeId ?? w.nextRelationId(sceneOwner, `${scene}.cite.${item}`);
  try {
    return {
      ok: true,
      rows: await w.verify([
        {
          id,
          values: {
            ...(existing?.values ?? {
              'tl1.row': 'cite',
              'tl1.subject': scene,
              'tl1.ref.facet': 'whole',
            }),
            ...ref,
          },
        },
      ]),
    };
  } catch (e) {
    return { ok: false, message: message(e) };
  }
}

/** The edit controls of the selected SC: its name, its citations, its placement. */
export function SceneEdit({
  workbench: w,
  projection: p,
  owner: ownerId,
  id,
  notify,
}: {
  workbench: TimelineWorkbench;
  projection: TimelineProjection;
  owner: string;
  id: string;
  notify(n: Notice): void;
}) {
  const owner = w.owner(ownerId);
  const row = w.rows(ownerId).find((r) => r.id === id);
  const [event, setEvent] = useState('');
  const lifetime = useMemo(() => ({ current: new AbortController() }), [ownerId, id]);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, [lifetime]);
  const [pendingCitations, setPendingCitations] = useState(0);
  const [placing, setPlacing] = useState<string>();
  if (!owner || !row || !w.editable(ownerId))
    return <p className="tl-unsupported">この場面のシーンカードは編集できません。</p>;
  const cites = w
    .rows(ownerId)
    .filter(
      (r) =>
        r.values['tl1.row'] === 'cite' &&
        r.values['tl1.subject'] === id &&
        w.readable(String(r.values['tl1.ref.artifact'] ?? ownerId)),
    );
  const events = p.events.filter((e) => w.owner(e.owner));
  const composition = w.ownersOf('composition')[0];
  const citation = async (cite?: Row, to = event) => {
    if (!to) return notify({ ok: false, text: '引用する出来事を選んでください。' });
    const signal = lifetime.current.signal;
    setPendingCitations((n) => n + 1);
    const prepare = async () => {
      const c = await citeRows(w, ownerId, id, to, cite?.id);
      if (!c.ok || !c.rows) throw Error(c.ok ? '参照がありません。' : c.message);
      return c.rows;
    };
    try {
      const r = cite
        ? await w.retarget(ownerId, cite.id, prepare, signal)
        : await w.addCitation(ownerId, id, prepare, signal);
      if (signal.aborted) return;
      notify(
        r.ok
          ? {
              ok: true,
              text: cite ? `${cite.id} を付け替えました。` : `${id} に引用を加えました。`,
            }
          : { ok: false, text: r.message },
      );
    } finally {
      setPendingCitations((n) => n - 1);
    }
  };
  return (
    <div className="tl-edit" data-edit-scene={id}>
      <Rename workbench={w} owner={owner} role="scene-cards" row={row} notify={notify} />
      <h4>引用</h4>
      {pendingCitations > 0 && (
        <button
          type="button"
          onClick={() => {
            lifetime.current.abort();
            lifetime.current = new AbortController();
          }}
        >
          引用の確認を取り消す
        </button>
      )}
      <ul className="tl-cites">
        {cites.map((c) => (
          <li key={c.id} data-cite={c.id}>
            {w.readable(String(c.values['tl1.ref.artifact'] ?? ''))
              ? `${c.values['tl1.ref.artifact']} ${c.values['tl1.ref.version']} · ${c.values['tl1.ref.item']}`
              : '読めない参照があります'}{' '}
            <DeleteButton
              label={`${c.id} を外す`}
              run={() => w.run(ownerId, () => removeCitation(c.id))}
              notify={notify}
            />
            {w.links.story.ledgers.some((l) => l.artifactId === c.values['tl1.ref.artifact']) ? (
              <label>
                付け替え先{' '}
                <select
                  value=""
                  onChange={(e) => void citation(c, e.currentTarget.value)}
                  aria-label={`${c.id} の付け替え先`}
                >
                  <option value="">選ぶ</option>
                  {events.map((e) => (
                    <option key={e.key} value={e.key}>
                      {e.id} {e.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </li>
        ))}
      </ul>
      <p>
        <label>
          引用する出来事{' '}
          <select value={event} onChange={(e) => setEvent(e.currentTarget.value)}>
            <option value="">選ぶ</option>
            {events.map((e) => (
              <option key={e.key} value={e.key}>
                {e.id} {e.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => void citation()}>
          引用を追加
        </button>
      </p>
      {composition && w.editable(composition.id) && !placing && (
        <button type="button" onClick={() => setPlacing(w.nextId(composition.id, 'OC'))}>
          構成に配置
        </button>
      )}
      {composition && placing && (
        <Place
          workbench={w}
          composition={composition}
          sceneOwner={ownerId}
          scene={id}
          id={placing}
          label={String(cell(row, 'tl1.label') ?? id)}
          done={() => setPlacing(undefined)}
          notify={notify}
        />
      )}
      <DeleteButton
        label={`${id} を削除`}
        run={() => w.run(ownerId, () => deleteScene(id))}
        notify={notify}
      />
    </div>
  );
}

function Place({
  workbench: w,
  composition,
  sceneOwner,
  scene,
  label,
  id,
  done,
  notify,
}: {
  workbench: TimelineWorkbench;
  composition: TimelineWorkbenchOwner;
  sceneOwner: string;
  scene: string;
  label: string;
  id: string;
  done(): void;
  notify(n: Notice): void;
}) {
  const rows = w.rows(composition.id);
  const last = Math.max(
    0,
    ...rows
      .filter((r) => r.values['tl1.row'] === 'occurrence')
      .map((r) => Number(r.values['tl1.order'])),
  );
  const [initialOrder] = useState(String(last + 10));
  const [order, setOrder] = useState(initialOrder);
  const [part, setPart] = useState('');
  return (
    <EditForm
      owner={composition}
      title={`${scene} を構成に配置`}
      dirty={part !== '' || order !== initialOrder}
      validate={async () => {
        const ref = w.savedRef(sceneOwner, scene);
        if (!ref) throw Error('保存した場面がありません。先にシーンカードを保存してください。');
        const verified = await w.verify([
          {
            id,
            values: {
              'tl1.row': 'occurrence',
              'tl1.label': `${part} ${label}`.trim(),
              'tl1.order': num(order),
              'tl1.part': part,
              ...ref,
            },
          },
        ]);
        // The native validator checks duplicate order/ID; unrelated rows need not stay unchanged.
        return insertRows('composition', verified, '提示位置を追加');
      }}
      success={() =>
        notify({ ok: true, text: `${id} として構成に配置しました（原稿には反映しません）。` })
      }
      cancel={done}
    >
      <p className="tl-unsupported">ID {id}。</p>
      <Field label="提示の並び">
        {(fid) => (
          <input
            id={fid}
            inputMode="numeric"
            value={order}
            onChange={(e) => setOrder(e.currentTarget.value)}
          />
        )}
      </Field>
      <Field label="話・章">
        {(fid) => <input id={fid} value={part} onChange={(e) => setPart(e.currentTarget.value)} />}
      </Field>
    </EditForm>
  );
}

/** The edit controls of the selected occurrence: where it is presented. */
export function OccurrenceEdit({
  workbench: w,
  id,
  notify,
}: {
  workbench: TimelineWorkbench;
  id: string;
  notify(n: Notice): void;
}) {
  const owner = w.ownersOf('composition')[0];
  const row = owner && w.rows(owner.id).find((r) => r.id === id);
  const [open, setOpen] = useState<{ order: number; part?: string }>();
  const [order, setOrder] = useState('');
  const [part, setPart] = useState('');
  if (!owner || !row || !w.editable(owner.id))
    return <p className="tl-unsupported">作品構成は編集できません。</p>;
  return (
    <div className="tl-edit" data-edit-occurrence={id}>
      {!open ? (
        <button
          type="button"
          onClick={() => {
            const seen = {
              order: Number(cell(row, 'tl1.order')),
              part: cell(row, 'tl1.part') as string | undefined,
            };
            setOrder(String(seen.order));
            setPart(seen.part ?? '');
            setOpen(seen);
          }}
        >
          位置を変更
        </button>
      ) : (
        <EditForm
          owner={owner}
          title={`${id} の位置`}
          closeUnchanged
          dirty={order !== String(open.order) || part !== (open.part ?? '')}
          build={() =>
            moveOccurrence(id, { order: num(order) as number, part: part || undefined }, open)
          }
          success={() =>
            notify({ ok: true, text: `${id} を移動しました（原稿には反映しません）。` })
          }
          cancel={() => setOpen(undefined)}
        >
          <Field label="提示の並び">
            {(fid) => (
              <input
                id={fid}
                inputMode="numeric"
                value={order}
                onChange={(e) => setOrder(e.currentTarget.value)}
              />
            )}
          </Field>
          <Field label="話・章">
            {(fid) => (
              <input id={fid} value={part} onChange={(e) => setPart(e.currentTarget.value)} />
            )}
          </Field>
        </EditForm>
      )}
      <DeleteButton
        label={`${id} を削除`}
        run={() => w.run(owner.id, () => deleteOccurrence(id))}
        notify={notify}
      />
    </div>
  );
}

/**
 * Where a drag or Alt+Arrow puts an occurrence: a free order strictly between its new
 * neighbours. Only that occurrence moves and it keeps its part; with no free order between
 * the neighbours the move is refused instead of renumbering the others.
 */
export function placeBetween(
  list: { id: string; order: number }[],
  id: string,
  index: number,
): { order: number } | { message: string } {
  const others = list.filter((o) => o.id !== id);
  const before = others[index - 1];
  const after = others[index];
  const lo = before?.order ?? (after ? after.order - 20 : 0);
  const hi = after?.order ?? lo + 20;
  const order = Math.floor((lo + hi) / 2);
  if (order <= lo || order >= hi)
    return { message: '間に入る提示の並びがありません。位置の欄で番号を指定してください。' };
  return { order };
}
