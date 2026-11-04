import { TwoStepView } from './two-step-view';
import { SaveRecoveryView } from './save-recovery-view';
import type { TimelineSaveRecovery } from './save-recovery';
import { RepinEdit } from './repin-edit';
import { ClockEdit } from './clock-edit';
import { TimelineAnalysisView } from './analysis-view';
import type { TimelineAnalysisCapabilities } from './analysis-host';
/**
 * Story Timeline: the timeline screen. Three readings of one Story (world time, presentation
 * order, world lines), a details panel and read-only trips to the manuscript and the source
 * owner. Without a workbench nothing here writes: the host receives only a read source
 * (TL32). With one (T2-2), events, SCs and the composition are edited through the owners'
 * own commands, one owner and one Undo per confirmed edit.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import type { Artifact } from '@editor-platform/artifact-core';
import { EditorInputs } from '@editor-platform/editor-core';
import { EditorInputsContext } from '@editor-platform/editor-ui';
import { DocumentSurface } from '@editor-platform/document';
import type { DocumentContent } from '@editor-platform/document/model';
import { DataSurface } from '@editor-platform/structured-data';
import { DesignSurface } from '@editor-platform/design';
import type { DesignContent } from '@editor-platform/design/model';
import type { StructuredData } from '@editor-platform/structured-data/model';
import { defaultView } from '@editor-platform/structured-data/views';
import type { CreativeWorkspaceLinksV2 } from '../workspace/model';
import {
  exactSavedVersion,
  resolveTimelineProjection,
  TimelineQueryGate,
  type TimelineEvent,
  type TimelineManuscriptRegion,
  type TimelineProjection,
  type TimelineRefView,
  type TimelineSource,
  type TimelineTime,
  type TimelineWorldEntry,
} from './projection';
import { moveOccurrence } from './commands';
import {
  EditBar,
  EventEdit,
  isHistoryKey,
  NewEvent,
  NewScene,
  OccurrenceEdit,
  placeBetween,
  SceneEdit,
  type Notice,
} from './edit';
import type { TimelineWorkbench } from './workbench';
import './timeline.css';

import { StoryRelations, WorldEdit } from './story-edit';
import { useEventTimeGestures } from './time-gestures';
import { TimeConstraints } from './time-constraint-view';

export type TimelineMode = 'world' | 'composition' | 'worldline';
const MODES: [TimelineMode, string][] = [
  ['world', '世界時間'],
  ['composition', '構成の提示順'],
  ['worldline', '世界線'],
];
type Selection =
  /** `world` is the world list the event was chosen from: inherited entries read from it. */
  | { kind: 'event'; key: string; world?: string }
  | { kind: 'scene'; key: string }
  | { kind: 'occurrence'; key: string }
  | { kind: 'world'; key: string };
type Trip =
  | { kind: 'manuscript'; region: Extract<TimelineManuscriptRegion, { elementId: string }> }
  | { kind: 'source'; owner: string; row: string; label: string };

/**
 * What this reading Host offers (t0-contract §6.1). T1 reads only: no candidates, no
 * hypotheses, no reading premise, and never shared. Asking for shared is refused, not served
 * as a local reading (TL29b).
 */
export const STORY_TIMELINE_CAPABILITIES = {
  t3a: true,
  t3b: true,
  readingPremise: false,
  shared: false,
} as const;
export const SHARED_UNSUPPORTED =
  '共有（shared）での表示にはこの画面は対応していません。ローカルの表示に切り替えることもしません。';

export interface StoryTimelineHostProps {
  /** Host-authored initial focus only; never changes source, filters, time or native content. */
  initialSelection?: Selection;
  source: TimelineSource;
  links: CreativeWorkspaceLinksV2;
  /** Checked before and after every read; an unreadable target is shown only as partial. */
  mayRead(artifactId: string): boolean;
  /**
   * Bumped by the host whenever read permissions may have changed, also when `mayRead` stays
   * the same function. Any change of the inputs (source, links, mayRead, this epoch) hides
   * the previous reading and closes an open trip at once, before anything is read again.
   */
  permissionEpoch?: number;
  /** A shared reading is not supported: true shows the refusal and reads nothing. */
  shared?: boolean;
  /**
   * The editing workbench of this Story. Absent, the screen only reads. Present, the reading
   * follows the owners' drafts as edited there.
   */
  workbench?: TimelineWorkbench;
  analysisCapabilities?: TimelineAnalysisCapabilities;
  recovery?: TimelineSaveRecovery;
  /** Offered as 「編集を始める」 while there is no workbench. */
  startEditing?(): Promise<void>;
}
type Edit = { workbench: TimelineWorkbench; notify(n: Notice): void };
const noSubscribe = () => () => undefined;

/**
 * True when the world's clock reads the entry at another time than written: an explicit
 * other clock, or the source ledger's default clock of an inherited event.
 */
const converted = (e: TimelineWorldEntry) =>
  !!e.onWorldClock &&
  (e.onWorldClock.start !== displayedTime(e).start || e.onWorldClock.end !== displayedTime(e).end);

const displayedTime = (e: TimelineEvent | TimelineWorldEntry) =>
  e.calculated?.state === 'resolved' ? e.calculated.time : e.time;
const eventTimeText = (e: TimelineEvent | TimelineWorldEntry) =>
  e.calculated?.state === 'resolved' ? `導出：${timeText(e.calculated.time)}` : timeText(e.time);
const calculationReason = {
  unset: '基準時点が未定',
  reference: '基準参照を解決できません',
  cycle: '導出が循環しています',
  clock: '時計を換算できません',
  overflow: '計算可能な日数の範囲外',
};

/** The time as the author reads it. The clock is an internal ID and is not shown. */
export function timeText(t: TimelineTime): string {
  switch (t.kind) {
    case 'day':
      return `${t.start}日目`;
    case 'point':
      return `${t.start}`;
    case 'interval':
      return `${t.start}〜${t.end}`;
    case 'range':
      return `${t.start ?? '？'}〜${t.end ?? '？'}の間`;
    case 'derived':
      return '導出（算出不能）';
    default:
      return '時点未定';
  }
}
const refText = (r: TimelineRefView) =>
  r.state === 'unreadable'
    ? '読めない参照'
    : `${r.artifact} ${r.version} · ${r.item}${r.facet ? `（${r.facet}）` : ''}`;
const REF_STATE: Record<TimelineRefView['state'], string> = {
  resolved: '',
  missing: '欠落',
  invalid: '不一致',
  unreadable: '読めません',
};

export function StoryTimelineHost({
  initialSelection,
  source,
  links,
  mayRead,
  permissionEpoch = 0,
  shared = false,
  workbench,
  recovery,
  startEditing,
  analysisCapabilities = STORY_TIMELINE_CAPABILITIES,
}: StoryTimelineHostProps) {
  const revision = useSyncExternalStore(
    workbench ? (l) => workbench.subscribe(l) : noSubscribe,
    () => workbench?.revision ?? 0,
  );
  const [notice, setNotice] = useState<Notice>();
  const [starting, setStarting] = useState(false);
  const edit: Edit | undefined = useMemo(
    () => (workbench ? { workbench, notify: setNotice } : undefined),
    [workbench],
  );
  /** What is read: the owners' drafts as edited here, or the stored artifacts. */
  const readSource = workbench?.source ?? source;
  const [mode, setMode] = useState<TimelineMode>('world');
  const [world, setWorld] = useState<string>();
  /** What a reading or a trip was made from. A reading or trip of other inputs is not shown. */
  const inputs = useMemo(
    () => ({ source, links, mayRead, permissionEpoch, workbench }),
    [source, links, mayRead, permissionEpoch, workbench],
  );
  const [view, setView] = useState<{
    world?: string;
    inputs: typeof inputs;
    projection: TimelineProjection;
  }>();
  const [error, setError] = useState('');
  const [selection, setSelection] = useState<Selection | undefined>(() => initialSelection);
  const [openTrip, setTrip] = useState<{ trip: Trip; inputs: typeof inputs }>();
  // Decided while rendering, so not even one frame shows content read under old permissions.
  const trip = openTrip?.inputs === inputs ? openTrip.trip : undefined;
  const returnFocus = useRef<string | undefined>(undefined);
  const gate = useMemo(() => new TimelineQueryGate(), []);
  useEffect(() => {
    setError('');
    if (shared) return;
    void gate
      .run(() => resolveTimelineProjection(readSource, links, world ? { world } : {}, mayRead))
      .then(
        (r) => {
          if (!r.current) return;
          setView({ world, inputs, projection: r.value });
          setError('');
        },
        (e) => setError(String(e instanceof Error ? e.message : e)),
      );
    // `revision` reads the drafts again after every edit; the last reading stays until then.
  }, [gate, inputs, readSource, links, world, mayRead, shared, revision]);
  useEffect(() => {
    setNotice(undefined);
    workbench?.invalidate();
  }, [permissionEpoch, mayRead, source, workbench]);
  // Restores focus to the control that opened a trip when the author comes back.
  useEffect(() => {
    if (trip || !returnFocus.current) return;
    const key = returnFocus.current;
    returnFocus.current = undefined;
    document.querySelector<HTMLElement>(`[data-tl-focus="${CSS.escape(key)}"]`)?.focus();
  }, [trip]);

  // Ctrl+Z / Redo of the screen: the active owner only, never inside a field (TL18).
  const showTrip = !!trip;
  useEffect(() => {
    if (!workbench || showTrip) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const d = isHistoryKey(e);
      if (!d || e.defaultPrevented) return;
      e.preventDefault();
      const name = workbench.undoState.owner?.name;
      const r = workbench.history(d);
      setNotice(
        r.ok
          ? {
              ok: true,
              text: `${name} の操作を${d === 'undo' ? '元に戻しました' : 'やり直しました'}。`,
            }
          : { ok: false, text: r.message },
      );
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [workbench, showTrip]);

  // The last reading keeps the world selector usable while a new query loads; its lists are
  // not shown as the current reading until the newest query returns (TL32).
  // A reading made under other inputs (permissions, source, links) is dropped, not shown as
  // stale: only a world switch keeps the last reading's selector while loading (TL32).
  const current = view?.inputs === inputs ? view : undefined;
  const p = current?.projection;
  const stale = current !== undefined && current.world !== world;
  const shownWorld = world ?? p?.worlds[0]?.id;
  const leaveInput = () => {
    const flushed = workbench?.flushInputs();
    if (flushed && !flushed.ok) {
      setNotice({ ok: false, text: flushed.message });
      return false;
    }
    return true;
  };
  const select = (next: Selection) => {
    if (selection?.kind === next.kind && selection.key === next.key) return;
    if (leaveInput()) setSelection(next);
  };
  const changeMode = (next: TimelineMode) => {
    if (next === mode) return true;
    if (!leaveInput()) return false;
    setMode(next);
    return true;
  };
  const changeWorld = (next: string) => {
    if (next !== world && leaveInput()) setWorld(next);
  };
  const open = (t: Trip, focusKey: string) => {
    if (!leaveInput()) return;
    returnFocus.current = focusKey;
    setTrip({ trip: t, inputs });
  };
  if (shared)
    return (
      <div className="story-timeline">
        <p role="alert" data-shared-refused>
          {SHARED_UNSUPPORTED}
        </p>
      </div>
    );
  if (trip)
    return (
      <div className="story-timeline">
        <TripView
          trip={trip}
          source={readSource}
          mayRead={mayRead}
          back={() => setTrip(undefined)}
        />
      </div>
    );

  const tabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n =
      e.key === 'ArrowRight'
        ? (i + 1) % MODES.length
        : e.key === 'ArrowLeft'
          ? (i + MODES.length - 1) % MODES.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? MODES.length - 1
              : -1;
    if (n < 0) return;
    e.preventDefault();
    if (!changeMode(MODES[n][0])) return;
    document.getElementById(`tl-tab-${MODES[n][0]}`)?.focus();
  };
  return (
    <div className="story-timeline">
      <header>
        <h1>物語タイムライン</h1>
        {workbench ? (
          <p className="tl-unsupported" role="note">
            編集中です。変更は各資料の下書きに入り、保存するまで保存版は変わりません。導出時点は参照から計算した表示です。「診断と試算」では保存版・下書き案・仮定の結果を分けて確認できます。原稿への反映は未対応です。
          </p>
        ) : (
          <p className="tl-unsupported" role="note">
            読み取り専用です。導出時点は参照から計算した表示です。明示された時間制約を個別に確認します。編集・認識等の意味診断は行わず、元資料は変更しません。
          </p>
        )}
        {!workbench && startEditing && (
          <button
            type="button"
            disabled={starting}
            onClick={async () => {
              setStarting(true);
              try {
                await startEditing();
              } catch (e) {
                setError(String(e instanceof Error ? e.message : e));
              } finally {
                setStarting(false);
              }
            }}
          >
            編集を始める
          </button>
        )}
      </header>
      {workbench && (
        <EditBar
          workbench={workbench}
          notice={current ? notice : undefined}
          setNotice={setNotice}
        />
      )}
      {workbench && <RepinEdit workbench={workbench} notify={setNotice} />}
      {workbench && (
        <TimelineAnalysisView
          workbench={workbench}
          capabilities={analysisCapabilities}
          notify={setNotice}
          select={(key) => select({ kind: 'scene', key })}
          selectOccurrence={(key) => {
            if (changeMode('composition')) select({ kind: 'occurrence', key });
          }}
        />
      )}
      {workbench && <TwoStepView workbench={workbench} notify={setNotice} />}
      {workbench && recovery?.workbench === workbench && (
        <SaveRecoveryView recovery={recovery} notify={setNotice} />
      )}
      {workbench && (
        <nav aria-label="場面一覧">
          {workbench.ownersOf('scene-cards').flatMap((o) =>
            workbench
              .rows(o.id)
              .filter((r) => r.values['tl1.row'] === 'scene')
              .map((r) => (
                <button
                  key={o.id + r.id}
                  type="button"
                  onClick={() => select({ kind: 'scene', key: `${o.id}#${r.id}` })}
                >
                  {r.id} {String(r.values['tl1.label'] ?? '')}
                </button>
              )),
          )}
        </nav>
      )}
      <div role="tablist" aria-label="読み方" className="tl-tabs">
        {MODES.map(([id, label], i) => (
          <button
            key={id}
            id={`tl-tab-${id}`}
            role="tab"
            aria-selected={mode === id}
            aria-controls="tl-panel"
            tabIndex={mode === id ? 0 : -1}
            onClick={() => changeMode(id)}
            onKeyDown={(e) => tabKey(e, i)}
          >
            {label}
          </button>
        ))}
      </div>
      {error && <p role="alert">{error}</p>}
      {!p && !error && (
        <p role="status" className="tl-loading">
          読み込んでいます…
        </p>
      )}
      {p && (
        <>
          <Status projection={p} />
          <div className="tl-body">
            <section
              id="tl-panel"
              role="tabpanel"
              aria-labelledby={`tl-tab-${mode}`}
              className="tl-main"
            >
              {mode === 'world' && (
                <WorldTime
                  projection={p}
                  world={shownWorld}
                  stale={stale}
                  setWorld={changeWorld}
                  selection={selection}
                  select={select}
                  edit={edit}
                />
              )}
              {stale && mode !== 'world' && <Loading />}
              {!stale && mode === 'composition' && (
                <Composition
                  projection={p}
                  selection={selection}
                  select={select}
                  open={open}
                  edit={edit}
                />
              )}
              {!stale && mode === 'worldline' && (
                <>
                  <Worldlines projection={p} selection={selection} select={select} />
                  <StoryRelations projection={p} edit={edit} />
                  {edit && <ClockEdit {...edit} />}
                </>
              )}
            </section>
            <Details projection={p} selection={selection} select={select} open={open} edit={edit} />
          </div>
        </>
      )}
    </div>
  );
}

function Status({ projection: p }: { projection: TimelineProjection }) {
  const bad = p.owners.filter((o) => o.state !== 'valid');
  const empty = !p.events.length && !p.occurrences.length && !p.worlds.length;
  return (
    <div className="tl-status">
      {p.scope === 'partial' && (
        <p role="status" data-scope="partial">
          {p.unreadable
            ? '読めない資料があるため、表示は部分的です。'
            : '欠落または不一致の参照があるため、表示は部分的です。'}
        </p>
      )}
      {bad.map((o) => (
        <p key={o.artifactId} data-owner-state={o.state}>
          {o.artifactId}：
          {o.state === 'missing'
            ? '資料がありません。'
            : '表の形式が契約と合わないため読めません。'}
          {o.problems?.length ? `（${o.problems[0]}）` : ''}
        </p>
      ))}
      {empty && (
        <p data-empty>
          このStoryにはまだ出来事・場面・提示位置がありません。元資料に行を追加すると表示されます。
        </p>
      )}
    </div>
  );
}

function Item({
  focusKey,
  selected,
  onSelect,
  drag,
  onKeyDown,
  children,
}: {
  focusKey: string;
  selected: boolean;
  onSelect(): void;
  drag?: React.HTMLAttributes<HTMLLIElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLButtonElement>;
  children: React.ReactNode;
}) {
  return (
    <li {...drag}>
      <button
        type="button"
        onKeyDown={onKeyDown}
        className="tl-item"
        aria-pressed={selected}
        data-tl-focus={focusKey}
        onClick={onSelect}
      >
        {children}
      </button>
    </li>
  );
}

const Loading = () => (
  <p role="status" className="tl-loading">
    読み込んでいます…
  </p>
);

function WorldTime({
  projection: p,
  world,
  stale,
  setWorld,
  selection,
  select,
  edit,
}: {
  projection: TimelineProjection;
  world?: string;
  stale: boolean;
  setWorld(w: string): void;
  selection?: Selection;
  select(s: Selection): void;
  edit?: Edit;
}) {
  const back = new Set(p.backEvents);
  const gestures = useEventTimeGestures(edit, !stale);
  const [adding, setAdding] = useState(false);
  const entry = (e: TimelineWorldEntry) => (
    <Item
      key={e.key}
      {...gestures.props(e)}
      focusKey={`event:${e.key}`}
      selected={selection?.kind === 'event' && selection.key === e.key}
      onSelect={() => select({ kind: 'event', key: e.key, ...(world ? { world } : {}) })}
    >
      <span className="tl-time">{eventTimeText(e)}</span>
      {converted(e) && (
        <span className="tl-badge">
          世界の時計で{timeText({ kind: displayedTime(e).kind, ...e.onWorldClock })}
        </span>
      )}
      <span className="tl-label">{e.label}</span>
      {back.has(e.key) && <span className="tl-badge">裏の出来事</span>}
      {e.inherited && <span className="tl-badge">継承 {e.inherited.version}</span>}
      {e.reason === 'clock' && <span className="tl-badge">別の時計（換算できません）</span>}
      {e.reason === 'overflow' && <span className="tl-badge">計算可能な日数の範囲外</span>}
      {e.calculated?.state === 'unavailable' && (
        <span className="tl-badge">{calculationReason[e.calculated.reason]}</span>
      )}
    </Item>
  );
  const add = edit && (
    <div className="tl-add">
      {adding ? (
        <NewEvent
          workbench={edit.workbench}
          world={world}
          done={() => setAdding(false)}
          notify={edit.notify}
        />
      ) : (
        <button type="button" onClick={() => setAdding(true)}>
          出来事を追加
        </button>
      )}
    </div>
  );
  if (!p.worlds.length)
    return (
      <>
        <p>世界がまだありません。</p>
        {add}
      </>
    );
  const placed = (world && p.worldTime[world]) || [];
  const unplaced = (world && p.unplaced[world]) || [];
  return (
    <>
      <p className="tl-world">
        <label htmlFor="tl-world">世界</label>
        <select id="tl-world" value={world} onChange={(e) => setWorld(e.currentTarget.value)}>
          {p.worlds.map((w) => (
            <option key={w.id} value={w.id}>
              {w.label}
            </option>
          ))}
        </select>
      </p>
      {stale ? (
        <Loading />
      ) : (
        <>
          {edit && (
            <p className="tl-unsupported">
              出来事は Alt+←／Alt+→
              で1日移動できます。ドラッグは落とし先の開始時点へ移動します。精度と期間は保ち、未定・導出はフォームで変更します。Escapeで移動を取消できます。
            </p>
          )}
          {gestures.pending && <p role="status">時点の移動を確認しています…</p>}
          <h2>時点順</h2>
          {placed.length ? (
            <ol className="tl-list">{placed.map(entry)}</ol>
          ) : (
            <p>時点のある出来事はありません。</p>
          )}
          <h2>時点未定</h2>
          {unplaced.length ? (
            <ul className="tl-list" data-unplaced>
              {unplaced.map(entry)}
            </ul>
          ) : (
            <p>時点未定の出来事はありません。</p>
          )}
        </>
      )}
      {add}
    </>
  );
}

function Composition({
  projection: p,
  selection,
  select,
  open,
  edit,
}: {
  projection: TimelineProjection;
  selection?: Selection;
  select(s: Selection): void;
  open(t: Trip, focusKey: string): void;
  edit?: Edit;
}) {
  const label = (k?: string) => p.scenes.find((s) => s.key === k)?.label;
  const [adding, setAdding] = useState(false);
  const [dragged, setDragged] = useState<string>();
  const w = edit?.workbench;
  const composition = w?.ownersOf('composition')[0];
  const movable = !!composition && w!.editable(composition.id);
  /** A drag or Alt+Arrow: the same `timeline.move-occurrence` as the form (TL18a). */
  const moveTo = (id: string, destination: { before: string } | { delta: number }) => {
    if (!w || !composition) return;
    // Projection refresh is asynchronous. Apply gestures against the current owner draft,
    // not the order rendered before an immediately preceding form/keyboard operation.
    const live = w
      .rows(composition.id)
      .filter((r) => r.values['tl1.row'] === 'occurrence')
      .map((r) => ({ id: r.id, order: Number(r.values['tl1.order']) }))
      .sort((a, b) => a.order - b.order);
    const from = live.findIndex((r) => r.id === id);
    if (from < 0) return;
    const index =
      'delta' in destination
        ? from + destination.delta
        : live.filter((r) => r.id !== id).findIndex((r) => r.id === destination.before);
    if (index < 0 || index >= live.length) return;
    const at = placeBetween(live, id, index);
    if ('message' in at) return edit!.notify({ ok: false, text: at.message });
    const row = w.rows(composition.id).find((r) => r.id === id);
    const seen = {
      order: Number(row?.values['tl1.order']),
      part: row?.values['tl1.part'] as string | undefined,
    };
    const r = w.run(composition.id, () =>
      moveOccurrence(id, { order: at.order, part: seen.part }, seen),
    );
    edit!.notify(
      r.ok
        ? {
            ok: true,
            text: `${id} を提示の並び ${at.order} へ移動しました（原稿には反映しません）。`,
          }
        : { ok: false, text: r.message },
    );
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(`[data-tl-focus="occurrence:${CSS.escape(id)}"]`)
        ?.focus(),
    );
  };
  const add = edit && (
    <div className="tl-add">
      {adding ? (
        <NewScene workbench={edit.workbench} done={() => setAdding(false)} notify={edit.notify} />
      ) : (
        <button type="button" onClick={() => setAdding(true)}>
          場面を追加
        </button>
      )}
    </div>
  );
  if (!p.occurrences.length)
    return (
      <>
        <p>提示位置がまだありません。</p>
        {add}
      </>
    );
  return (
    <>
      {movable && (
        <p className="tl-unsupported">
          提示位置はドラッグか Alt+↑／Alt+↓ で並べ替えられます。原稿の章順は変わりません。
        </p>
      )}
      <ol className="tl-list">
        {p.occurrences.map((o) => (
          <li
            key={o.id}
            className="tl-occurrence"
            data-occurrence={o.id}
            draggable={movable}
            onDragStart={(e) => {
              setDragged(o.id);
              e.dataTransfer.setData('text/plain', o.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => movable && dragged && e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const from = dragged ?? e.dataTransfer.getData('text/plain');
              setDragged(undefined);
              if (!from || from === o.id) return;
              // Dropped on an occurrence: placed just before it.
              moveTo(from, { before: o.id });
            }}
            onDragEnd={() => setDragged(undefined)}
          >
            <button
              type="button"
              className="tl-item"
              aria-pressed={selection?.kind === 'occurrence' && selection.key === o.id}
              data-tl-focus={`occurrence:${o.id}`}
              onClick={() => select({ kind: 'occurrence', key: o.id })}
              onKeyDown={(e) => {
                if (!movable || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
                e.preventDefault();
                moveTo(o.id, { delta: e.key === 'ArrowUp' ? -1 : 1 });
              }}
            >
              <span className="tl-time">
                {o.order}. {o.part}
              </span>
              <span className="tl-label">{o.label}</span>
              <span className="tl-scene">
                {o.scene.state === 'resolved'
                  ? (label(o.sceneKey ?? o.fixedScene?.scene) ?? o.scene.item)
                  : `場面：${REF_STATE[o.scene.state]}`}
              </span>
              {o.fixedScene && (
                <span className="tl-badge">{o.fixedScene.version}の場面・再確認</span>
              )}
            </button>
            <Regions regions={o.manuscript} owner={o.id} open={open} />
          </li>
        ))}
      </ol>
      {add}
    </>
  );
}

function Regions({
  regions,
  owner,
  open,
}: {
  regions: TimelineManuscriptRegion[];
  owner: string;
  open(t: Trip, focusKey: string): void;
}) {
  if (!regions.length) return <p className="tl-regions">原稿未接続</p>;
  return (
    <p className="tl-regions">
      {regions.map((r, i) => {
        const key = `region:${owner}:${r.link}:${r.sceneId}:${i}`;
        if (r.state === 'unreadable')
          return (
            <span key={key} className="tl-badge">
              原稿を読めません
            </span>
          );
        if (r.state === 'link-fixed')
          return (
            <span key={key} className="tl-badge" data-region-state={r.state} title={r.reason}>
              {r.version}の提示位置に結んだ原稿・再確認
            </span>
          );
        if (r.state === 'link-missing' || r.state === 'link-invalid')
          return (
            <span key={key} className="tl-badge" data-region-state={r.state} title={r.reason}>
              提示位置の対応が{r.state === 'link-missing' ? '欠落' : '不一致'}
            </span>
          );
        if (r.state !== 'current')
          return (
            <span key={key} className="tl-badge" data-region-state={r.state}>
              原稿の位置が{r.state === 'missing' ? '欠落' : '不一致'}
            </span>
          );
        return (
          <button
            key={key}
            type="button"
            data-tl-focus={key}
            onClick={() => open({ kind: 'manuscript', region: r }, key)}
          >
            原稿を開く（{r.artifactId} · {r.sceneId}）
          </button>
        );
      })}
    </p>
  );
}

function Worldlines({
  projection: p,
  selection,
  select,
}: {
  projection: TimelineProjection;
  selection?: Selection;
  select(s: Selection): void;
}) {
  // Transfers are rows of the world settings: shown even when it has no world line yet.
  const transfers = p.transfers.length > 0 && (
    <section className="tl-transfers" aria-label="世界間の移送">
      <h3>世界間の移送</h3>
      <ul className="tl-list">
        {p.transfers.map((t) => (
          <li key={t.id} data-transfer={t.id}>
            <span className="tl-label">{t.label}</span>
            {t.individual && <span className="tl-scene">{t.individual}</span>}
            <span className="tl-scene">
              出発 {t.from ? refText(t.from) : 'なし'}
              {t.from && REF_STATE[t.from.state] && (
                <span className="tl-badge">{REF_STATE[t.from.state]}</span>
              )}
            </span>
            <span className="tl-scene">
              到着 {t.to ? refText(t.to) : 'なし'}
              {t.to && REF_STATE[t.to.state] && (
                <span className="tl-badge">{REF_STATE[t.to.state]}</span>
              )}
            </span>
            {t.carries.length > 0 && (
              <span className="tl-scene">運ぶ情報 {t.carries.join('、')}</span>
            )}
          </li>
        ))}
      </ul>
      <p className="tl-unsupported">
        移送は書かれたとおりに読みます。到着側が情報を得たかどうかは、この段階では判定しません。
      </p>
    </section>
  );
  if (!p.worlds.length)
    return (
      <>
        <p>世界線がまだありません。</p>
        {transfers}
      </>
    );
  const children = (parent?: string) => p.worlds.filter((w) => w.parent === parent);
  const known = new Set(p.worlds.map((w) => w.id));
  const tree = (parent?: string): React.ReactNode => {
    const list = parent
      ? children(parent)
      : p.worlds.filter((w) => !w.parent || !known.has(w.parent));
    if (!list.length) return null;
    return (
      <ul className="tl-list tl-tree">
        {list.map((w) => (
          <li key={w.id}>
            <button
              type="button"
              className="tl-item"
              aria-pressed={selection?.kind === 'world' && selection.key === w.id}
              data-tl-focus={`world:${w.id}`}
              onClick={() => select({ kind: 'world', key: w.id })}
            >
              <span className="tl-label">{w.label}</span>
              {w.parent && w.branchPoint && (
                <span className="tl-time">分岐 {timeText(w.branchPoint)}</span>
              )}
              <span className="tl-scene">
                出来事 {(p.worldTime[w.id] ?? []).length + (p.unplaced[w.id] ?? []).length}件
              </span>
            </button>
            {tree(w.id)}
          </li>
        ))}
      </ul>
    );
  };
  return (
    <>
      {tree()}
      {transfers}
    </>
  );
}

/** The persisted derivation; its calculated display never replaces these cells. */
const derivationText = (d: NonNullable<TimelineEvent['derivation']>) => {
  const base = d.base.state === 'internal' ? `同じ台帳の ${d.base.item}` : refText(d.base);
  const { min, max } = d.offset;
  const days = min === max ? `${min}日` : `${min ?? '？'}〜${max ?? '？'}日`;
  return `${base} の${d.anchor === 'end' ? '終わり' : '始まり'}から ${days}`;
};
/** The derivation rows of an event's details: a draft event's, or an inherited version's. */
function Derivation({ d }: { d?: TimelineEvent['derivation'] }) {
  if (!d) return null;
  return (
    <>
      <dt>導出</dt>
      <dd data-derivation={d.base.state}>
        {derivationText(d)}
        {d.base.state !== 'internal' && REF_STATE[d.base.state] && (
          <span className="tl-badge">{REF_STATE[d.base.state]}</span>
        )}
      </dd>
    </>
  );
}

function Details({
  projection: p,
  selection,
  select,
  open,
  edit,
}: {
  projection: TimelineProjection;
  selection?: Selection;
  select(s: Selection): void;
  open(t: Trip, focusKey: string): void;
  edit?: Edit;
}) {
  const world = (id: string) => p.worlds.find((w) => w.id === id)?.label ?? id;
  const sceneLabel = (k: string) => p.scenes.find((s) => s.key === k)?.label ?? k;
  const sourceButton = (owner: string, row: string, label: string) => {
    const key = `source:${owner}#${row}`;
    return (
      <button
        type="button"
        data-tl-focus={key}
        onClick={() => open({ kind: 'source', owner, row, label }, key)}
      >
        元資料を開く（{owner} · {row}）
      </button>
    );
  };
  let body: React.ReactNode = <p>項目を選ぶと詳細を表示します。</p>;
  const inheritedEntry =
    selection?.kind === 'event' && selection.world
      ? [...(p.worldTime[selection.world] ?? []), ...(p.unplaced[selection.world] ?? [])].find(
          (x) => x.key === selection.key && x.inherited,
        )
      : undefined;
  if (selection?.kind === 'event' && selection.world && inheritedEntry) {
    // An inherited entry is the exact saved version the world inherits, read in that world:
    // never the parent ledger's current draft (which may have changed or been removed).
    const e = inheritedEntry;
    const version = e.inherited!.version;
    const cut = e.key.lastIndexOf('#');
    const [owner, id] = [e.key.slice(0, cut), e.key.slice(cut + 1)];
    const citing = p.scenes.filter((s) =>
      s.cites.some(
        (c) =>
          c.state === 'resolved' && c.artifact === owner && c.item === id && c.version === version,
      ),
    );
    body = (
      <>
        <h3>{e.label}</h3>
        <dl>
          <dt>世界</dt>
          <dd data-inherited-detail>
            {world(selection.world)}（{owner} の {version} から継承）
          </dd>
          <dt>時点</dt>
          <dd>
            {eventTimeText(e)}
            {converted(e) &&
              `（世界の時計で${timeText({ kind: displayedTime(e).kind, ...e.onWorldClock })}）`}
          </dd>
          <Derivation d={e.derivation} />
          <dt>関与</dt>
          <dd>{e.participants.length ? e.participants.join('、') : 'なし'}</dd>
          <dt>この版を引用した場面</dt>
          <dd>
            {citing.length ? (
              <ul>
                {citing.map((s) => (
                  <li key={s.key}>
                    <button type="button" onClick={() => select({ kind: 'scene', key: s.key })}>
                      {s.label}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              'なし'
            )}
          </dd>
        </dl>
        <p className="tl-unsupported">
          元資料は継承元の今の表で開きます（継承した版とは違うことがあります）。
        </p>
        {sourceButton(owner, id, e.label)}
      </>
    );
  } else if (selection?.kind === 'event') {
    const e: TimelineEvent | undefined = p.events.find((x) => x.key === selection.key);
    body = e ? (
      <>
        <h3>{e.label}</h3>
        <dl>
          <dt>世界</dt>
          <dd>{world(e.world)}</dd>
          <dt>時点</dt>
          <dd data-calculated-time={e.calculated?.state}>{eventTimeText(e)}</dd>
          {e.calculated?.state === 'unavailable' && (
            <dd>{calculationReason[e.calculated.reason]}</dd>
          )}
          <Derivation d={e.derivation} />
          <dt>関与</dt>
          <dd>{e.participants.length ? e.participants.join('、') : 'なし'}</dd>
          <dt>場面</dt>
          <dd>
            {e.scenes.length ? (
              <ul>
                {e.scenes.map((s) => (
                  <li key={s}>
                    <button type="button" onClick={() => select({ kind: 'scene', key: s })}>
                      {sceneLabel(s)}
                    </button>
                  </li>
                ))}
              </ul>
            ) : e.fixedScenes.length ? (
              'なし（今の内容を描いた場面はありません）'
            ) : (
              '裏の出来事（どの場面にも書かれていません）'
            )}
          </dd>
          {e.fixedScenes.length > 0 && (
            <>
              <dt>旧版を引用</dt>
              <dd data-fixed-scenes>
                <ul>
                  {e.fixedScenes.map((f) => (
                    <li key={`${f.scene}@${f.version}`}>
                      <button type="button" onClick={() => select({ kind: 'scene', key: f.scene })}>
                        {sceneLabel(f.scene)}
                      </button>{' '}
                      <span className="tl-badge">{f.version}を引用・再確認</span>
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          )}
        </dl>
        <TimeConstraints checks={e.constraints} />
        {sourceButton(e.owner, e.id, e.label)}
        {edit && (
          <EventEdit
            key={e.key}
            workbench={edit.workbench}
            owner={e.owner}
            id={e.id}
            notify={edit.notify}
          />
        )}
      </>
    ) : (
      <p>この出来事は現在の表示にありません。</p>
    );
  } else if (selection?.kind === 'scene') {
    const s = p.scenes.find((x) => x.key === selection.key);
    body = s ? (
      <>
        <h3>{s.label}</h3>
        <dl>
          <dt>世界</dt>
          <dd>
            {s.worlds.map(world).join('、') || 'なし'}
            {!s.worldsComplete && '（参照の欠落があり不完全）'}
          </dd>
          <dt>引用</dt>
          <dd>
            <ul>
              {s.cites.map((c, i) => (
                <li key={i} data-ref-state={c.state}>
                  {refText(c)}
                  {REF_STATE[c.state] && <span className="tl-badge">{REF_STATE[c.state]}</span>}
                </li>
              ))}
            </ul>
          </dd>
          <dt>提示位置</dt>
          <dd>
            {s.occurrences.length ? (
              <ul>
                {s.occurrences.map((o) => (
                  <li key={o}>
                    <button type="button" onClick={() => select({ kind: 'occurrence', key: o })}>
                      {p.occurrences.find((x) => x.id === o)?.label ?? o}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              '未配置'
            )}
          </dd>
          {s.fixedOccurrences.length > 0 && (
            <>
              <dt>旧版を提示</dt>
              <dd data-fixed-occurrences>
                <ul>
                  {s.fixedOccurrences.map((o) => (
                    <li key={o}>
                      <button type="button" onClick={() => select({ kind: 'occurrence', key: o })}>
                        {p.occurrences.find((x) => x.id === o)?.label ?? o}
                      </button>{' '}
                      <span className="tl-badge">旧版・再確認</span>
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          )}
        </dl>
        {sourceButton(s.owner, s.id, s.label)}
        {edit && (
          <SceneEdit
            key={s.key}
            workbench={edit.workbench}
            projection={p}
            owner={s.owner}
            id={s.id}
            notify={edit.notify}
          />
        )}
      </>
    ) : (
      <p>この場面は現在の表示にありません。</p>
    );
  } else if (selection?.kind === 'occurrence') {
    const o = p.occurrences.find((x) => x.id === selection.key);
    const composition = p.owners.find((x) => x.role === 'composition')?.artifactId;
    body = o ? (
      <>
        <h3>{o.label}</h3>
        <dl>
          <dt>提示順</dt>
          <dd>
            {o.order}（{o.part}）
          </dd>
          <dt>場面</dt>
          <dd>
            {o.sceneKey ? (
              <button type="button" onClick={() => select({ kind: 'scene', key: o.sceneKey! })}>
                {sceneLabel(o.sceneKey)}
              </button>
            ) : o.fixedScene ? (
              <>
                <button
                  type="button"
                  onClick={() => select({ kind: 'scene', key: o.fixedScene!.scene })}
                >
                  {sceneLabel(o.fixedScene.scene)}
                </button>{' '}
                <span className="tl-badge">
                  {o.fixedScene.version}を提示・今のdraftと違うため再確認
                </span>
              </>
            ) : (
              <>
                {refText(o.scene)} <span className="tl-badge">{REF_STATE[o.scene.state]}</span>
              </>
            )}
          </dd>
          <dt>原稿</dt>
          <dd>
            <Regions regions={o.manuscript} owner={`detail:${o.id}`} open={open} />
          </dd>
        </dl>
        {composition && sourceButton(composition, o.id, o.label)}
        {edit && (
          <OccurrenceEdit key={o.id} workbench={edit.workbench} id={o.id} notify={edit.notify} />
        )}
      </>
    ) : (
      <p>この提示位置は現在の表示にありません。</p>
    );
  } else if (selection?.kind === 'world') {
    const w = p.worlds.find((x) => x.id === selection.key);
    const owner = p.owners.find((x) => x.role === 'world')?.artifactId;
    body = w ? (
      <>
        <h3>{w.label}</h3>
        <dl>
          <dt>親</dt>
          <dd>{w.parent ? world(w.parent) : 'なし'}</dd>
          <dt>分岐点</dt>
          <dd>{w.branchPoint ? timeText(w.branchPoint) : 'なし'}</dd>
          <dt>継承</dt>
          <dd>
            {w.inherits.length ? (
              <ul>
                {w.inherits.map((r, i) => (
                  <li key={i} data-ref-state={r.state}>
                    {refText(r)}
                    {REF_STATE[r.state] && <span className="tl-badge">{REF_STATE[r.state]}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              'なし'
            )}
          </dd>
        </dl>
        {owner && sourceButton(owner, w.id, w.label)}
        {edit && <WorldEdit key={w.id} {...edit} id={w.id} />}
      </>
    ) : (
      <p>この世界は現在の表示にありません。</p>
    );
  }
  return (
    <aside className="tl-details" aria-label="詳細">
      <h2>詳細</h2>
      {body}
    </aside>
  );
}

/** A read-only trip: the exact manuscript version, or the source owner's current table. */
function TripView({
  trip,
  source,
  mayRead,
  back,
}: {
  trip: Trip;
  source: TimelineSource;
  mayRead(id: string): boolean;
  back(): void;
}) {
  const id = trip.kind === 'manuscript' ? trip.region.artifactId : trip.owner;
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; artifact: Artifact<unknown>; content: unknown }
    | { kind: 'failed'; message: string }
  >({ kind: 'loading' });
  const [inputs] = useState(() => new EditorInputs());
  const backButton = useRef<HTMLButtonElement>(null);
  useEffect(() => backButton.current?.focus(), []);
  useEffect(() => {
    let live = true;
    void (async () => {
      if (!mayRead(id)) return { kind: 'failed' as const, message: 'この資料を読めません。' };
      const a = await source.get(id);
      if (!mayRead(id)) return { kind: 'failed' as const, message: 'この資料を読めません。' };
      if (!a) return { kind: 'failed' as const, message: '資料がありません。' };
      if (trip.kind === 'manuscript') {
        const v = await exactSavedVersion(a, trip.region.versionId);
        if ('reason' in v) return { kind: 'failed' as const, message: v.reason };
        if (!mayRead(id)) return { kind: 'failed' as const, message: 'この資料を読めません。' };
        return { kind: 'ready' as const, artifact: a, content: v.content };
      }
      return { kind: 'ready' as const, artifact: a, content: a.draft.content };
    })().then(
      (s) => live && setState(s),
      (e) => live && setState({ kind: 'failed', message: String(e) }),
    );
    return () => {
      live = false;
    };
  }, [id, trip, source, mayRead]);
  const focusAddress = useMemo(
    () =>
      trip.kind === 'manuscript'
        ? { artifactId: trip.region.artifactId, elementId: trip.region.elementId }
        : undefined,
    [trip],
  );
  const focusRequest = useMemo(
    () => (trip.kind === 'manuscript' ? { id: trip.region.elementId } : undefined),
    [trip],
  );
  const row =
    trip.kind === 'source' && state.kind === 'ready'
      ? (state.content as StructuredData).rows?.find((r) => r.id === trip.row)
      : undefined;
  // The source opens in a private unfiltered grid (the saved views are not changed), so the
  // table's first saved view cannot hide or aggregate the row away. The row itself is shown
  // in the cue as a record, since the grid mounts only the rows near its scroll position;
  // its cells are also marked when they are mounted.
  const sourceView = useMemo(
    () =>
      trip.kind === 'source' && state.kind === 'ready'
        ? defaultView(state.content as StructuredData)
        : undefined,
    [trip, state],
  );
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (trip.kind !== 'source' || state.kind !== 'ready' || !surface.current) return;
    const cells = surface.current.querySelectorAll<HTMLElement>(
      `[data-row-id="${CSS.escape(trip.row)}"]`,
    );
    cells.forEach((c) => c.setAttribute('data-tl-target', ''));
  }, [trip, state]);
  const columns = state.kind === 'ready' ? ((state.content as StructuredData).columns ?? []) : [];
  return (
    <div className="tl-trip">
      <header>
        <button type="button" ref={backButton} onClick={back}>
          戻る
        </button>
        <h1>
          {state.kind === 'ready' ? state.artifact.name : id}
          {trip.kind === 'manuscript' ? ` · ${trip.region.versionId}` : ''}
        </h1>
        <p className="tl-unsupported" role="note">
          読み取り専用で開いています。変更はできません。
        </p>
      </header>
      {state.kind === 'loading' && <p role="status">読み込んでいます…</p>}
      {state.kind === 'failed' && <p role="alert">{state.message}</p>}
      {trip.kind === 'source' && state.kind === 'ready' && (
        <div className="tl-row-cue" data-row={trip.row} role="status">
          <p>
            {row
              ? `行 ${trip.row}「${trip.label}」を表示しています。`
              : `行 ${trip.row} は現在の表にありません。`}
          </p>
          {row && (
            <dl data-tl-record>
              {columns
                .filter((c) => row.values[c.id] !== undefined && row.values[c.id] !== null)
                .map((c) => (
                  <div key={c.id}>
                    <dt>{c.name}</dt>
                    <dd>{String(row.values[c.id])}</dd>
                  </div>
                ))}
            </dl>
          )}
        </div>
      )}
      {state.kind === 'ready' && (
        <div className="tl-trip-surface" ref={surface}>
          <EditorInputsContext.Provider value={inputs}>
            {trip.kind === 'manuscript' && trip.region.kind === 'design' ? (
              <DesignSurface
                content={state.content as DesignContent}
                focusRequest={focusRequest}
                select={() => undefined}
                execute={() => false}
                readOnly
                layout={{ viewKey: 'story-timeline-design', defaultPanels: { right: false } }}
              />
            ) : trip.kind === 'manuscript' ? (
              <DocumentSurface
                content={state.content as DocumentContent}
                focusAddress={focusAddress}
                select={() => undefined}
                execute={() => false}
                readOnly
                layout={{ viewKey: 'story-timeline-manuscript', defaultPanels: { right: false } }}
              />
            ) : (
              <DataSurface
                content={state.content as StructuredData}
                initialView={sourceView}
                select={() => undefined}
                execute={() => false}
                readOnly
                layout={{ viewKey: 'story-timeline-source', defaultPanels: { right: false } }}
              />
            )}
          </EditorInputsContext.Provider>
        </div>
      )}
    </div>
  );
}
