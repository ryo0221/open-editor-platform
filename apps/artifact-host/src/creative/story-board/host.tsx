import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { WhiteboardSurface, type WhiteboardInteractionMode } from '@editor-platform/whiteboard';
import { EditorInputsContext, EditorHistoryContext } from '@editor-platform/editor-ui';
import { EditorInputError } from '@editor-platform/editor-core';
import type { StoryBoardController } from './controller';
import type { BoardReadResult, BoardReading, BoardEvent } from './reading';
import { filterStoryBoard } from './filter';
import {
  BOARD_LIMITS,
  boardItemKey,
  validateBoardFilter,
  type BoardFilter,
  type BoardChoice,
} from './settings';
import {
  BoardTimelinePanel,
  BoardMapPanel,
  BoardEventCard,
  boardPositionLabel,
  boardTimeLabel,
  type BoardSelection,
} from './panels';
import { BoardSourceTrip, type BoardTrip } from './source-trip';
import './story-board.css';

export interface StoryBoardHostProps {
  controller: StoryBoardController;
  /** Parent must retain the old controller when this throws (e.g. dirty native owner). */
  changeBoard?(): void;
}
const initialFilter = (r: BoardReading): BoardFilter =>
  r.opened.settings.presets[0]?.filter ?? {
    individuals: { kind: 'all' },
    places: { kind: 'all' },
    groups: { kind: 'all' },
    time: { kind: 'point', clock: r.opened.settings.clock, value: 0 },
    includeUnknown: true,
  };
function Choice({
  title,
  value,
  choices,
  change,
}: {
  title: string;
  value: BoardChoice;
  choices: { id: string; label: string }[];
  change(v: BoardChoice): void;
}) {
  return (
    <details className="sb-choice">
      <summary>
        {title}：{value.kind === 'all' ? 'すべて' : `${value.ids.length}件を選択`}
      </summary>
      <div className="sb-choice-body">
        <button onClick={() => change({ kind: 'all' })}>すべて</button>
        <button onClick={() => change({ kind: 'set', ids: [] })}>選択を空にする</button>
        {choices.map((choice) => (
          <label key={choice.id}>
            <input
              type="checkbox"
              checked={value.kind === 'all' || value.ids.includes(choice.id)}
              onChange={(event) => {
                const current = value.kind === 'all' ? choices.map((c) => c.id) : value.ids;
                change({
                  kind: 'set',
                  ids: event.target.checked
                    ? [...new Set([...current, choice.id])]
                    : current.filter((id) => id !== choice.id),
                });
              }}
            />
            {choice.label}
          </label>
        ))}
      </div>
    </details>
  );
}

export function StoryBoardHost({ controller: c, changeBoard }: StoryBoardHostProps) {
  useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  const epoch = c.epoch;
  const operation = c.operationState;
  const operationStatus = operation?.status;
  const [loaded, setLoaded] = useState<{ epoch: number; value: BoardReadResult }>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState<BoardFilter>();
  const [selection, setSelection] = useState<BoardSelection>();
  const [mode, setMode] = useState<WhiteboardInteractionMode>('content');
  const [trip, setTrip] = useState<BoardTrip>();
  const [name, setName] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);
  const nameBuffer = useRef({ value: '', composing: false, confirming: false });
  nameBuffer.current.value = name;
  useEffect(
    () =>
      c.inputs.register({
        label: '表示名',
        read: () => ({
          dirty: !!nameBuffer.current.value,
          composing: nameBuffer.current.composing,
        }),
        prepare: () => {
          if (!nameBuffer.current.confirming)
            throw new EditorInputError('表示名を保存または取り消してください。');
          return () => true;
        },
        focus: () => nameInput.current?.focus(),
      }),
    [c],
  );
  useEffect(() => c.inputs.changed(), [c, name]);
  const [list, setList] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 800px)').matches,
  );
  const [rangeStart, setRangeStart] = useState(''),
    [rangeEnd, setRangeEnd] = useState('');
  const returnedFocus = useRef<HTMLButtonElement>(null);
  const focusAfterReturn = useRef(false);
  useEffect(() => {
    if (trip || operationStatus === 'cancelled') return;
    let live = true;
    void c
      .read()
      .then((value) => {
        if (!live || c.epoch !== epoch || (value.state === 'ready' && !value.current())) return;
        setLoaded({ epoch, value });
        setError('');
        if (value.state === 'ready')
          setFilter((current) => current ?? structuredClone(initialFilter(value)));
      })
      .catch(() => {
        if (live) {
          setLoaded(undefined);
          setError(
            '資料が変わったか、現在このボードを表示できません。再openして確認してください。',
          );
        }
      });
    return () => {
      live = false;
    };
  }, [c, epoch, trip, operationStatus]);
  const reading =
    loaded?.epoch === epoch && loaded.value.state === 'ready' && loaded.value.current()
      ? loaded.value
      : undefined;
  const view = useMemo(() => {
    if (!reading || !filter) return undefined;
    try {
      return filterStoryBoard(reading, filter);
    } catch {
      return undefined;
    }
  }, [reading, filter]);
  useEffect(() => {
    if (focusAfterReturn.current && reading && !trip) {
      returnedFocus.current?.focus();
      focusAfterReturn.current = false;
    }
  }, [reading, trip]);
  const choose = (next: BoardFilter) => {
    if (!reading?.current()) return;
    try {
      const owned = validateBoardFilter(next),
        nextView = filterStoryBoard(reading, owned);
      if (
        selection &&
        !(selection.kind === 'individual'
          ? nextView.individuals.some((p) => p.key === selection.key)
          : selection.kind === 'event'
            ? nextView.events.some((e) => e.key === selection.key)
            : nextView.presences.some((p) => p.place === selection.key))
      ) {
        setSelection(undefined);
        setNotice('表示条件の対象外になった選択を解除しました。');
      }
      setFilter(owned);
    } catch {
      setNotice('表示条件を適用できません。時計と参照を確認してください。');
    }
  };
  const run = (work: () => void | Promise<unknown>) => {
    try {
      const value = work();
      if (value instanceof Promise)
        void value
          .then((ok) => {
            if (ok === false) setNotice('保存は完了していません。再試行か取消を選んでください。');
            else setNotice('操作が完了しました。');
          })
          .catch(() =>
            setNotice(
              '入力・保存・権限の状態を確認してください。未確定の入力を確定または取り消してください。',
            ),
          );
    } catch {
      setNotice(
        '入力・保存・権限の状態を確認してください。未確定の入力を確定または取り消してください。',
      );
    }
  };
  const open = (value: BoardTrip) =>
    run(() => {
      c.guard();
      setNotice('');
      setTrip(value);
    });
  const source = (event: BoardEvent) =>
    open({
      kind: 'timeline',
      selection: {
        kind: 'event',
        key: `${event.ref.artifactId}#${event.ref.itemId}`,
        world: reading?.opened.settings.world,
      },
    });
  const back = () =>
    run(() => {
      c.guard();
      focusAfterReturn.current = true;
      setNotice(
        c.workbench.unsaved.length
          ? '元資料の未保存変更を保持しています。ボードは採用保存版を表示します。'
          : '元資料から戻りました。表示条件と時点を保持しています。',
      );
      setTrip(undefined);
    });
  const safeSelect = (value: BoardSelection) => {
    if (reading?.current()) {
      setSelection(value);
      setNotice('');
    }
  };
  const actions = {
    select: safeSelect,
    point: (value: number) => {
      if (filter && reading)
        choose({ ...filter, time: { kind: 'point', clock: reading.opened.settings.clock, value } });
    },
    source,
  };
  const operationControls =
    operation && operation.status !== 'cancelled' ? (
      <div role="alert">
        {operation.status === 'failed' ? '保存未完了' : '保存中'}：
        {operation.phase === 'board'
          ? '配置'
          : operation.phase === 'settings'
            ? '表示条件'
            : '参照確認'}
        {operation.status === 'failed' && (
          <button
            onClick={() =>
              run(async () => {
                const ok = await c.retry();
                if (ok && operation.kind === 'preset') setName('');
                return ok;
              })
            }
          >
            保存を再試行
          </button>
        )}
        <button
          onClick={() => {
            c.cancel();
            if (operation.kind === 'preset') setName('');
          }}
        >
          保存を取消
        </button>
      </div>
    ) : null;
  if (trip)
    return (
      <BoardSourceTrip
        key={JSON.stringify(trip)}
        controller={c}
        trip={trip}
        back={back}
        notice={notice}
      />
    );
  if (operation?.status === 'cancelled')
    return (
      <main className="story-board sb-start">
        <h1>操作を取り消しました</h1>
        <p>
          遅延結果は表示に適用していません。保存先が受理済みの場合は、状態を再確認すると採用版を読み直します。
        </p>
        <button
          disabled={!operation.settled}
          onClick={() =>
            run(async () => {
              await c.resumeAfterCancel();
              setName('');
            })
          }
        >
          状態を再確認
        </button>
        {changeBoard && (
          <button
            disabled={!operation.settled}
            onClick={() =>
              run(() => {
                c.close();
                changeBoard();
              })
            }
          >
            操作を終了して別のボードを開く
          </button>
        )}
        <p role="status">{notice}</p>
      </main>
    );
  if (!reading || !view || !filter) {
    const exit = changeBoard && (
      <button
        disabled={c.busy}
        onClick={() =>
          run(() => {
            c.close();
            changeBoard();
          })
        }
      >
        別のボードを開く
      </button>
    );
    const cancelName = name && (
      <button disabled={c.busy} onClick={() => setName('')}>
        入力中の表示名を取消
      </button>
    );
    const available = c.access.mayRead(c.boardArtifactId) && c.access.mayRead(c.settingsId);
    const message =
      error ||
      (reading && !view && filter
        ? '表示条件の時計を確認し、このボードの時点を選び直してください。'
        : '') ||
      (loaded?.value.state === 'partial'
        ? '資料の一部を読めないか変更されたため、連動表示を伏せています。'
        : '保存版を読み込んでいます…');
    if (!available)
      return (
        <main className="story-board sb-start">
          <h1>物語ボード</h1>
          <p role="status">{message}</p>
          {cancelName}
          {exit}
          {operationControls}
          <p role="status">{notice}</p>
        </main>
      );
    const native = c.boardSnapshot;
    // Keep the native Surface at the same React position while derived reading is stale.
    // Only neutral frames and independently authored board content remain visible.
    return (
      <div className="story-board">
        <header className="sb-header">
          <h1>物語ボード</h1>
        </header>
        <nav className="sb-toolbar" aria-label="表示条件">
          <span role="status">{message}</span>
        </nav>
        <div className="sb-timebar">
          <span>連動表示を再確認しています。</span>
        </div>
        <div className="sb-body">
          <aside className="sb-sidebar">
            {cancelName}
            {reading && filter && (
              <button
                onClick={() =>
                  choose({
                    ...filter,
                    time: { kind: 'point', clock: reading.opened.settings.clock, value: 0 },
                  })
                }
              >
                このボードの0日目を見る
              </button>
            )}
            {exit}
            <button
              disabled={c.busy || native.readOnly || !native.canUndo}
              onClick={() => run(() => c.history('board', 'undo'))}
            >
              配置をUndo
            </button>
          </aside>
          <main className="sb-canvas" aria-label="物語のキャンバス">
            {list ? (
              <div className="sb-list">
                <p>{message}</p>
              </div>
            ) : (
              <EditorInputsContext.Provider value={c.inputs}>
                <EditorHistoryContext.Provider
                  value={{
                    undo: () => run(() => c.history('board', 'undo')),
                    redo: () => run(() => c.history('board', 'redo')),
                  }}
                >
                  <WhiteboardSurface
                    key={c.viewKey}
                    content={native.content}
                    execute={(command) => {
                      try {
                        return c.executeBoard(command);
                      } catch {
                        return false;
                      }
                    }}
                    select={() => undefined}
                    readOnly={native.readOnly || c.busy}
                    interactionMode={mode}
                    layout={{ viewKey: c.viewKey, defaultPanels: { left: false, right: false } }}
                  />
                </EditorHistoryContext.Provider>
              </EditorInputsContext.Provider>
            )}
          </main>
        </div>
        <footer className="sb-footer">
          <span role="status">{notice}</span>
          {operationControls}
        </footer>
      </div>
    );
  }
  const board = c.boardSnapshot,
    settings = c.settingsSnapshot;
  const selectedEvent =
    selection?.kind === 'event' ? view.events.find((e) => e.key === selection.key) : undefined;
  const world = reading.timeline.worlds.find((w) => w.id === reading.opened.settings.world);
  const sourceDescription =
    'Storyはこのセッションの採用保存版。未保存draftは反映しません。地図は固定版です。';
  const times = [...reading.events.map((e) => e.time), ...reading.presences.map((p) => p.time)]
    .flatMap((t) => [t?.start, t?.end])
    .filter((n): n is number => n !== undefined);
  const point = filter.time.kind === 'point' ? filter.time.value : 3;
  return (
    <div className="story-board">
      <header className="sb-header">
        <div>
          <span className="sb-eyebrow">STORY WORKSPACE</span>
          <h1>
            {reading.opened.boardArtifact.name} <span>人物・地図・出来事</span>
          </h1>
        </div>
        <div className="sb-save-state" role="status">
          配置：{board.dirty ? '未保存' : '保存済み'} / 表示条件：
          {settings.dirty ? '未保存' : '保存済み'}
        </div>
        <button disabled={c.busy || board.readOnly} onClick={() => run(() => c.saveBoard())}>
          配置を保存
        </button>
        <button
          disabled={c.busy || settings.readOnly || !settings.dirty}
          onClick={() => run(() => c.saveSettings())}
        >
          表示条件を保存
        </button>
        {changeBoard && (
          <button
            disabled={c.busy}
            onClick={() =>
              run(() => {
                c.close();
                changeBoard();
              })
            }
          >
            別のボード
          </button>
        )}
      </header>
      <nav className="sb-toolbar" aria-label="表示条件">
        <span className="sb-world">世界：{world?.label ?? '指定世界'}</span>
        <Choice
          title="人物"
          value={filter.individuals}
          choices={reading.individuals.map((p) => ({
            id: p.key,
            label: `${p.label}・${reading.timeline.worlds.find((w) => w.id === p.origin)?.label ?? p.origin}`,
          }))}
          change={(individuals) => choose({ ...filter, individuals })}
        />
        <Choice
          title="場所"
          value={filter.places}
          choices={reading.places.map((p) => ({ id: p.key, label: p.label }))}
          change={(places) => choose({ ...filter, places })}
        />
        <Choice
          title="筋"
          value={filter.groups}
          choices={reading.opened.settings.groups.map((g) => ({ id: g.id, label: g.name }))}
          change={(groups) => choose({ ...filter, groups })}
        />
        <label>
          保存した表示
          <select
            aria-label="保存した表示"
            value=""
            onChange={(event) => {
              const preset = reading.opened.settings.presets.find(
                (p) => p.id === event.target.value,
              );
              if (preset) choose(preset.filter);
            }}
          >
            <option value="">選んで適用</option>
            {reading.opened.settings.presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={() =>
            run(() => {
              c.guard();
              setList((current) => !current);
            })
          }
          aria-pressed={list}
        >
          {list ? 'キャンバスへ' : '一覧で見る'}
        </button>
      </nav>
      <div className="sb-timebar">
        <strong>
          {filter.time.kind === 'point'
            ? `${filter.time.value}日目・日内未区分`
            : filter.time.kind === 'range'
              ? `${filter.time.start}〜${filter.time.end}日目`
              : '全期間'}
        </strong>
        <label>
          共通の時点
          <input
            aria-label="共通の時点"
            type="range"
            min={Math.min(0, point, ...times)}
            max={Math.max(10, point, ...times)}
            step={1}
            value={filter.time.kind === 'point' ? filter.time.value : 3}
            onChange={(event) => actions.point(Number(event.target.value))}
          />
        </label>
        <label>
          日
          <input
            aria-label="時点の日"
            type="number"
            min={-1000000000}
            max={1000000000}
            step={1}
            value={filter.time.kind === 'point' ? filter.time.value : ''}
            onChange={(event) => {
              if (event.target.value !== '') actions.point(Number(event.target.value));
            }}
          />
        </label>
        <button onClick={() => choose({ ...filter, time: { kind: 'all' } })}>全期間</button>
        <details className="sb-choice">
          <summary>期間で絞る</summary>
          <div className="sb-choice-body">
            <label>
              開始日
              <input
                aria-label="表示期間の開始日"
                type="number"
                step={1}
                value={rangeStart}
                onChange={(e) => setRangeStart(e.target.value)}
              />
            </label>
            <label>
              終了日（含まない）
              <input
                aria-label="表示期間の終了日"
                type="number"
                step={1}
                value={rangeEnd}
                onChange={(e) => setRangeEnd(e.target.value)}
              />
            </label>
            <button
              onClick={() => {
                if (rangeStart === '' || rangeEnd === '') {
                  setNotice('期間の開始日と終了日を入力してください。');
                  return;
                }
                choose({
                  ...filter,
                  time: {
                    kind: 'range',
                    clock: reading.opened.settings.clock,
                    start: Number(rangeStart),
                    end: Number(rangeEnd),
                  },
                });
              }}
            >
              期間を適用
            </button>
            <button
              onClick={() => {
                setRangeStart('');
                setRangeEnd('');
              }}
            >
              期間入力を取消
            </button>
          </div>
        </details>
        <label>
          <input
            type="checkbox"
            checked={filter.includeUnknown}
            onChange={(e) => choose({ ...filter, includeUnknown: e.target.checked })}
          />
          所在不明も表示
        </label>
        <span>在場の記録に連動・位置の補間なし</span>
      </div>
      <div className="sb-body">
        <aside className="sb-sidebar">
          <section>
            <h2>表示と配置</h2>
            <div className="sb-segment">
              <button
                aria-pressed={mode === 'content'}
                disabled={c.busy}
                onClick={() =>
                  run(() => {
                    c.guard();
                    setMode('content');
                  })
                }
              >
                内容を選択
              </button>
              <button
                aria-pressed={mode === 'layout'}
                disabled={c.busy}
                onClick={() =>
                  run(() => {
                    c.guard();
                    setMode('layout');
                  })
                }
              >
                配置を編集
              </button>
            </div>
            <p>
              {mode === 'content'
                ? 'パネル内の出来事・場所を選択します。'
                : '枠や付箋を移動します。時刻や在場は変わりません。'}
            </p>
            <div className="sb-history">
              <button
                disabled={c.busy || board.readOnly || !board.canUndo}
                onClick={() => run(() => c.history('board', 'undo'))}
              >
                配置をUndo
              </button>
              <button
                disabled={c.busy || board.readOnly || !board.canRedo}
                onClick={() => run(() => c.history('board', 'redo'))}
              >
                配置をRedo
              </button>
            </div>
            <div className="sb-history">
              <button
                disabled={c.busy || settings.readOnly || !settings.canUndo}
                onClick={() => run(() => c.history('settings', 'undo'))}
              >
                表示条件をUndo
              </button>
              <button
                disabled={c.busy || settings.readOnly || !settings.canRedo}
                onClick={() => run(() => c.history('settings', 'redo'))}
              >
                表示条件をRedo
              </button>
            </div>
          </section>
          <section>
            <h2>名前付き表示</h2>
            <label>
              表示名
              <input
                ref={nameInput}
                aria-label="表示名"
                disabled={c.busy}
                value={name}
                maxLength={512}
                onChange={(e) => setName(e.target.value)}
                onCompositionStart={() => {
                  nameBuffer.current.composing = true;
                  c.inputs.changed();
                }}
                onCompositionEnd={() => {
                  nameBuffer.current.composing = false;
                  c.inputs.changed();
                }}
                onKeyDown={(e) => {
                  if (
                    e.key === 'Escape' &&
                    !e.nativeEvent.isComposing &&
                    !nameBuffer.current.composing
                  )
                    setName('');
                }}
              />
            </label>
            <button
              disabled={
                c.busy ||
                settings.readOnly ||
                !name.trim() ||
                reading.opened.settings.presets.length >= BOARD_LIMITS.presets
              }
              onClick={() =>
                run(async () => {
                  // Only this explicit action admits the buffered name. prepare remains pure;
                  // all native edits and async reference validation stay in the Controller.
                  let pending: Promise<boolean>;
                  nameBuffer.current.confirming = true;
                  try {
                    pending = c.savePreset(name, filter);
                  } finally {
                    nameBuffer.current.confirming = false;
                  }
                  const ok = await pending;
                  if (ok) setName('');
                  return ok;
                })
              }
            >
              この条件を名前付きで保存
            </button>
            <button disabled={c.busy} onClick={() => setName('')}>
              表示名を取消
            </button>
            {reading.opened.settings.presets.length >= BOARD_LIMITS.presets && (
              <p>保存できる表示は32件までです。</p>
            )}
          </section>
          <section>
            <h2>選択</h2>
            {!selection ? (
              <p>人物・出来事・地物を選択してください。</p>
            ) : (
              <>
                <button onClick={() => setSelection(undefined)}>選択を解除</button>
                {selectedEvent && (
                  <>
                    <h3>{selectedEvent.label}</h3>
                    <p>{boardTimeLabel(selectedEvent.time)}</p>
                    <button onClick={() => source(selectedEvent)}>
                      選んだ出来事の元資料を開く
                    </button>
                    <button
                      disabled={
                        selectedEvent.time?.start === undefined ||
                        selectedEvent.time.clock !== reading.opened.settings.clock
                      }
                      onClick={() => {
                        if (selectedEvent.time?.start !== undefined)
                          actions.point(selectedEvent.time.start);
                      }}
                    >
                      この時点を見る
                    </button>
                    <button
                      disabled={
                        c.busy ||
                        board.readOnly ||
                        settings.readOnly ||
                        reading.opened.settings.panels.length >= BOARD_LIMITS.panels
                      }
                      onClick={() => run(() => c.addCard(selectedEvent.ref))}
                    >
                      同じ出来事のカードを追加
                    </button>
                  </>
                )}
                {selection.kind === 'place' && (
                  <>
                    <h3>{reading.places.find((p) => p.key === selection.key)?.label}</h3>
                    <button
                      onClick={() =>
                        choose({ ...filter, places: { kind: 'set', ids: [selection.key] } })
                      }
                    >
                      ここで絞る
                    </button>
                  </>
                )}
                {selection.kind === 'individual' && (
                  <h3>{reading.individuals.find((p) => p.key === selection.key)?.label}</h3>
                )}
              </>
            )}
          </section>
          <section>
            <h2>採用版と元資料</h2>
            <p>{sourceDescription}</p>
            <p>
              通常のWhiteboard書出しは配置と自由メモが対象です。連動パネルの画像書出しは未対応です。
            </p>
            <button ref={returnedFocus} onClick={() => open({ kind: 'timeline' })}>
              物語タイムラインで確認・編集
            </button>
            <button onClick={() => open({ kind: 'map' })}>固定地図を元の画面で見る</button>
            <details>
              <summary>読取版の根拠</summary>
              <ul>
                {reading.adopted.map((r) => (
                  <li key={r.artifactId}>
                    {r.artifactId}
                    <br />
                    {r.versionId}
                  </li>
                ))}
              </ul>
              <p>地図：{reading.opened.settings.map.versionId}</p>
              <p>表示設定：{reading.opened.settingsVersion}</p>
            </details>
          </section>
        </aside>
        <main className="sb-canvas" aria-label="物語のキャンバス">
          {list ? (
            <div className="sb-list">
              <h2>同じ表示条件の一覧</h2>
              <p>
                {view.individuals.length}個体・{view.events.length}出来事
              </p>
              {view.positions.map((p) => (
                <article key={p.individual.key} data-board-position={p.individual.key}>
                  <button onClick={() => safeSelect({ kind: 'individual', key: p.individual.key })}>
                    {p.individual.label}・{p.individual.origin}
                  </button>
                  <p>{boardPositionLabel(reading, p)}</p>
                </article>
              ))}
              <h3>出来事</h3>
              {view.events.slice(0, 200).map((event) => (
                <article key={event.key}>
                  <button onClick={() => safeSelect({ kind: 'event', key: event.key })}>
                    {event.label}
                  </button>
                  <p>{boardTimeLabel(event.time)}</p>
                  <button onClick={() => source(event)}>元資料を開く</button>
                </article>
              ))}
              {view.events.length > 200 && <p>先頭200件を表示しています。条件を絞ってください。</p>}
            </div>
          ) : (
            <EditorInputsContext.Provider value={c.inputs}>
              <EditorHistoryContext.Provider
                value={{
                  undo: () => run(() => c.history('board', 'undo')),
                  redo: () => run(() => c.history('board', 'redo')),
                }}
              >
                <WhiteboardSurface
                  key={c.viewKey}
                  content={board.content}
                  execute={(command) => {
                    try {
                      return c.executeBoard(command);
                    } catch {
                      setNotice('配置を変更できません。入力・保存・権限を確認してください。');
                      return false;
                    }
                  }}
                  select={() => undefined}
                  readOnly={board.readOnly || c.busy}
                  interactionMode={mode}
                  layout={{ viewKey: c.viewKey, defaultPanels: { left: false, right: false } }}
                  renderNodeContent={({ node, size }) => {
                    if (!reading.current()) return undefined;
                    const panel = reading.opened.settings.panels.find((p) => p.nodeId === node.id);
                    if (!panel || node.kind !== 'shape' || node.shape !== 'rectangle')
                      return undefined;
                    if (size.width < 220 || size.height < 200)
                      return (
                        <g>
                          <rect width={size.width} height={size.height} fill="#fffdf8" />
                          <text x={8} y={24} fontSize={12}>
                            パネルを拡大してください
                          </text>
                        </g>
                      );
                    const props = {
                      reading,
                      view,
                      width: size.width,
                      height: size.height,
                      mode,
                      selection,
                      actions,
                    };
                    if (panel.kind === 'timeline') return <BoardTimelinePanel {...props} />;
                    if (panel.kind === 'map') return <BoardMapPanel {...props} />;
                    if (panel.kind !== 'event-card') return undefined;
                    return (
                      <BoardEventCard
                        {...props}
                        event={view.events.find((e) => e.key === boardItemKey(panel.event))}
                      />
                    );
                  }}
                />
              </EditorHistoryContext.Provider>
            </EditorInputsContext.Provider>
          )}
        </main>
      </div>
      <footer className="sb-footer">
        <span role="status">
          {notice || `${view.individuals.length}個体・${view.events.length}出来事を表示`}
        </span>
        {operationControls}
        {reading.opened.orphanPanels.length > 0 && (
          <span>未接続のパネルがあります。元のnodeをUndoで戻すか設定を確認してください。</span>
        )}
      </footer>
    </div>
  );
}
