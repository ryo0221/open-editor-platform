/** Independent Schedule Host: public package entrypoints only, never Playground App, model or
 * CSS. Synthetic data and a deterministic mock Host stand in for calendars (docs/schedule). */
import { useEffect, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  commitVersion,
  contentHash,
  createArtifact,
  deepFreeze,
  serializeArtifact,
  updateDraft,
  type Artifact,
} from '@editor-platform/artifact-core';
import { EditorInputs, EditorSession, type EditorCommand } from '@editor-platform/editor-core';
import { EditorInputsContext } from '@editor-platform/editor-ui';
import {
  ReferenceError,
  ReferenceResolver,
  type ReferenceHost,
  type ReferenceSnapshot,
} from '@editor-platform/artifact-references';
import {
  dataReferenceAdapter,
  dataTimelineOptions,
  scheduleLaneHost,
} from '@editor-platform/reference-adapters';
import { makeRow, type StructuredData } from '@editor-platform/structured-data/model';
import { defaultView } from '@editor-platform/structured-data/views';
import {
  assertSchedule,
  createSchedule,
  readOnlyText,
  readScheduleArtifact,
  stepScheduleHistory,
  type ScheduleDocument,
} from '@editor-platform/schedule';
import { ScheduleSurface } from '@editor-platform/schedule/view';
import {
  createMockScheduleHost,
  type MockEffectScenario,
} from '@editor-platform/schedule/mock-host';

const storageKey = 'ep-schedule-host';
const params = new URLSearchParams(location.search);
const initialDate = params.get('date') ?? '2026-10-26';
const zone = params.get('zone') ?? 'Asia/Tokyo';
// Extra synthetic tasks for a large plan (?tasks=N), so the long related-work list can be tested.
const extraTasks = Math.min(Number(params.get('tasks')) || 0, 200);

/** A saved synthetic Data plan with a Timeline view. Version 2 removes one task. */
function plan(version: 1 | 2): StructuredData {
  const columns = [
    { id: 'col-name', name: 'Task', type: 'text' as const, required: true, defaultValue: 'Task' },
    { id: 'col-start', name: 'Start', type: 'date' as const },
    { id: 'col-end', name: 'End', type: 'date' as const },
  ];
  const base: StructuredData = { schemaVersion: 2, columns, rows: [] };
  const row = (id: string, name: string, start: string, end: string) => ({
    ...makeRow(base, id),
    values: { 'col-name': name, 'col-start': start, 'col-end': end },
  });
  const rows = [
    row('row-api', 'API design review', '2026-10-26', '2026-10-28'),
    row('row-ui', 'Schedule editing UI', '2026-10-27', '2026-10-30'),
    row('row-beta', 'Beta deadline', '2026-10-30', '2026-10-30'),
    ...Array.from({ length: extraTasks }, (_, i) =>
      row(`row-extra-${i + 1}`, `Workstream task ${i + 1}`, '2026-10-26', '2026-10-29'),
    ),
  ].filter((r) => version === 1 || r.id !== 'row-ui');
  const view = {
    ...defaultView({ ...base, rows }),
    id: 'view-plan',
    name: 'Release plan',
    projection: 'Timeline' as const,
    timeline: {
      start: 'col-start',
      end: 'col-end',
      group: '',
      scale: 'week' as const,
      from: '',
      to: '',
    },
  };
  return { ...base, rows, views: [view] };
}

function useDataSource() {
  const versions = useRef<ReferenceSnapshot[]>([]);
  const listeners = useRef(new Set<(id: string) => void>());
  const access = useRef(true);
  const publish = async (version: 1 | 2) => {
    const content = plan(version);
    versions.current.push({
      artifactId: 'artifact_plan',
      domain: 'data',
      versionId: `version_plan_${version}`,
      revision: versions.current.length + 1,
      contentHash: await contentHash(content),
      content,
      dependencies: [],
    });
    listeners.current.forEach((l) => l('artifact_plan'));
  };
  const host: ReferenceHost = {
    async list() {
      return [];
    },
    async read() {
      const latest = versions.current.at(-1);
      if (!latest) throw new Error('Save the Data plan first');
      return latest;
    },
    subscribe(listener) {
      listeners.current.add(listener);
      return () => listeners.current.delete(listener);
    },
    checkAccess() {
      if (!access.current)
        throw new ReferenceError('forbidden', 'Access to the Data plan was revoked.');
    },
  };
  return { versions, publish, host, access, listeners };
}

type Stored = Artifact<ScheduleDocument>;
function load(): Stored {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (raw) {
      const value = JSON.parse(raw) as Stored;
      assertSchedule(value.draft.content);
      return value;
    }
  } catch {
    /* fall through to a new artifact */
  }
  return createArtifact('schedule', 'Schedule', createSchedule(zone));
}

function App() {
  const [artifact, setArtifact] = useState<Stored>(load);
  // Import reloads the page, so one session per page load is enough.
  const [session] = useState(() => new EditorSession(artifact.draft.content));
  const [inputs] = useState(() => new EditorInputs());
  const [, render] = useReducer((n: number) => n + 1, 0);
  const [readOnly, setReadOnly] = useState(params.get('readonly') === '1');
  const [withEffects, setWithEffects] = useState(params.get('effects') !== '0');
  const [withRead, setWithRead] = useState(params.get('read') !== '0');
  const [status, setStatus] = useState('');
  const [links, setLinks] = useState<Record<string, string>>({});
  // The Host's own selection, as a comment jump or another panel would set it.
  const [hostSelection, setHostSelection] = useState<string>();
  const [mock] = useState(() => {
    const value = createMockScheduleHost();
    // Test hook for the reference Host's E2E; a product Host has no such controls.
    (window as unknown as { scheduleHostMock: typeof value.controls }).scheduleHostMock =
      value.controls;
    return value;
  });
  const data = useDataSource();
  const [resolver] = useState(
    () => new ReferenceResolver(data.host, [dataReferenceAdapter], artifact.id),
  );
  // Mock control: hold lane references (new lanes and the save's capture) so a permission
  // change can land while one is pending.
  const laneHold = useRef<{ on: boolean; held: (() => void)[] }>({ on: false, held: [] });
  const [lanes] = useState(() => {
    const host = scheduleLaneHost(resolver, async () =>
      dataTimelineOptions(
        data.versions.current.length
          ? [
              {
                id: 'artifact_plan',
                name: 'Release plan data',
                content: data.versions.current.at(-1)!.content,
              },
            ]
          : [],
      ),
    );
    return {
      ...host,
      async create(...args: Parameters<typeof host.create>) {
        if (laneHold.current.on)
          await new Promise<void>((resolve) => laneHold.current.held.push(resolve));
        return host.create(...args);
      },
    };
  });
  const [ready, setReady] = useState(false);
  const publish = useRef(data.publish);
  useEffect(() => {
    void publish.current(1).then(() => setReady(true));
  }, []);
  // Frozen views of the session: unchanged events keep their identity, so the Schedule reuses
  // their checks and placements.
  const view = useRef<ScheduleDocument>(null!);
  view.current ??= deepFreeze(session.content);
  const content = view.current;
  // The submission boundary checks permissions as they are now, even for a late lane reference.
  const readOnlyNow = useRef(readOnly);
  readOnlyNow.current = readOnly;
  const assertWritable = () => {
    if (readOnlyNow.current) throw new Error(readOnlyText);
  };
  const execute = (cmd: EditorCommand<ScheduleDocument>) => {
    assertWritable();
    view.current = session.executeView(cmd);
    setArtifact((a) => updateDraft(a, session.content));
    render();
    return true;
  };
  /** Lanes as the resolver captures them now (access checked, follow lanes at their newest saved
   * version), validated as a whole Schedule. Save and export write only this. */
  async function captureLanes(content: ScheduleDocument): Promise<ScheduleDocument> {
    const captured = await resolver.capture(
      content.lanes.map((l) => ({ id: l.id, reference: l.reference })),
    );
    const next = {
      ...content,
      lanes: content.lanes.map((l, i) => ({ id: l.id, reference: captured[i].reference! })),
    };
    assertSchedule(next);
    return next;
  }
  // One save at a time: each commits against the artifact it started from.
  const saving = useRef(false);
  const [busy, setBusy] = useState(false);
  async function save() {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    try {
      // The Host's own write boundaries refuse too, not only the disabled editor controls.
      assertWritable();
      // Commit pending inputs first; composition or invalid input throws and blocks the save.
      flushSync(() => inputs.flush());
      // Read after the flush so a just-committed title is in the saved version.
      const flushed = session.content;
      // Following lanes capture the newest saved Data version at save time.
      if (laneHold.current.on)
        await new Promise<void>((resolve) => laneHold.current.held.push(resolve));
      const next = await captureLanes(flushed);
      const saved = await commitVersion(updateDraft(artifact, next), 'person-a', null);
      // Read-only can be switched on while lanes are captured or hashed: check again on store.
      assertWritable();
      sessionStorage.setItem(storageKey, serializeArtifact(saved));
      setArtifact(saved);
      setStatus(`Saved version ${saved.versions.length}`);
    } catch (e) {
      setStatus(`Not saved: ${(e as Error).message}`);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  async function exportJson() {
    try {
      // Same input boundary as save: pending text is committed, refused or composing text stops it.
      flushSync(() => inputs.flush());
      // Native JSON carries lane references as captured now, as a save would record them.
      const current = updateDraft(artifact, await captureLanes(session.content));
      const blob = new Blob([serializeArtifact(current)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'schedule.json';
      a.click();
    } catch (e) {
      setStatus(`Not exported: ${(e as Error).message}`);
    }
  }
  function history(direction: 'undo' | 'redo') {
    const pending = inputs.getSnapshot();
    const step = stepScheduleHistory(session, direction, view.current, pending);
    if ('refused' in step) return setStatus(step.refused);
    view.current = step.content;
    setArtifact((a) => updateDraft(a, session.content));
    render();
  }
  async function importFile(file: File) {
    try {
      assertWritable();
      // Importing replaces the page: pending text is committed first, refused or composing text
      // stops it. Checked again after parsing, since typing can continue meanwhile.
      flushSync(() => inputs.flush());
      const imported = await readScheduleArtifact(await file.text());
      assertWritable();
      flushSync(() => inputs.flush());
      sessionStorage.setItem(storageKey, serializeArtifact(imported));
      location.reload();
    } catch (e) {
      setStatus(`Import refused: ${(e as Error).message}`);
    }
  }
  if (!ready) return <p>Loading…</p>;
  return (
    <EditorInputsContext.Provider value={inputs}>
      <div className="schedule-host">
        <header className="schedule-host-bar">
          <strong>Schedule host</strong>
          <button type="button" disabled={readOnly || busy} onClick={() => void save()}>
            Save version
          </button>
          <button
            type="button"
            disabled={!session.canUndo || readOnly}
            onClick={() => history('undo')}
          >
            Undo
          </button>
          <button
            type="button"
            disabled={!session.canRedo || readOnly}
            onClick={() => history('redo')}
          >
            Redo
          </button>
          <button type="button" onClick={() => void exportJson()}>
            Export JSON
          </button>
          <label>
            Import JSON
            <input
              type="file"
              accept="application/json"
              disabled={readOnly}
              onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])}
            />
          </label>
          <span role="status" className="schedule-host-status">
            {status}
          </span>
        </header>
        <details className="schedule-host-controls">
          <summary>Mock Host controls</summary>
          <label>
            Host selection
            <select
              value={hostSelection ?? ''}
              onChange={(e) => setHostSelection(e.target.value || undefined)}
            >
              <option value="">None</option>
              {content.events.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.title || 'Untitled event'}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={readOnly}
              onChange={(e) => {
                const next = e.target.checked;
                // Read-only replaces the text inputs: a refused or composing one stops the switch.
                if (next)
                  try {
                    flushSync(() => inputs.flush());
                  } catch (error) {
                    setStatus(`Not switched to read-only: ${(error as Error).message}`);
                    return;
                  }
                setReadOnly(next);
              }}
            />
            Read-only
          </label>
          <label>
            <input
              type="checkbox"
              checked={withEffects}
              onChange={(e) => setWithEffects(e.target.checked)}
            />
            Calendar effects port
          </label>
          <label>
            <input
              type="checkbox"
              checked={withRead}
              onChange={(e) => setWithRead(e.target.checked)}
            />
            Calendar read port
          </label>
          <label>
            Effect result
            <select
              aria-label="Effect result"
              defaultValue="verified"
              onChange={(e) =>
                mock.controls.setEffectScenario(e.target.value as MockEffectScenario)
              }
            >
              <option value="verified">verified</option>
              <option value="unknown">unknown</option>
              <option value="partial">partial</option>
              <option value="rejected">rejected</option>
              <option value="failed-after-acceptance">failed-after-acceptance</option>
              <option value="conflict">conflict</option>
              <option value="send-error">send-error</option>
              <option value="queued">queued</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              onChange={(e) =>
                mock.controls.setPrepareFailure(
                  e.target.checked ? 'The Host could not reach the calendar.' : undefined,
                )
              }
            />
            Fail planning
          </label>
          <label>
            <input
              type="checkbox"
              onChange={(e) => mock.controls.setOverlayComplete(!e.target.checked)}
            />
            Incomplete calendar read
          </label>
          <label>
            <input
              type="checkbox"
              onChange={(e) => mock.controls.failTeamReads(e.target.checked)}
            />
            Fail team calendar read
          </label>
          <label>
            <input type="checkbox" onChange={(e) => mock.controls.holdReads(e.target.checked)} />
            Hold calendar reads
          </label>
          <button type="button" onClick={() => mock.controls.releaseReads()}>
            Release held reads
          </button>
          <label>
            <input type="checkbox" onChange={(e) => mock.controls.holdSends(e.target.checked)} />
            Hold calendar sends
          </label>
          <button type="button" onClick={() => mock.controls.releaseSends()}>
            Release held sends
          </button>
          <label>
            <input
              type="checkbox"
              onChange={(e) => void (laneHold.current.on = e.target.checked)}
            />
            Hold lane references
          </label>
          <button
            type="button"
            onClick={() => laneHold.current.held.splice(0).forEach((release) => release())}
          >
            Release held lane references
          </button>
          <button type="button" onClick={() => mock.controls.switchAccount()}>
            Switch account
          </button>
          <button type="button" onClick={() => void data.publish(2)}>
            Save Data plan v2
          </button>
          <label>
            <input
              type="checkbox"
              onChange={(e) => (
                (data.access.current = !e.target.checked),
                data.listeners.current.forEach((l) => l('artifact_plan'))
              )}
            />
            Revoke Data access
          </label>
        </details>
        <div className="schedule-host-surface">
          <ScheduleSurface
            content={content}
            execute={execute}
            readOnly={readOnly}
            lanes={lanes}
            read={withRead ? mock.read : undefined}
            effects={withEffects ? mock.effects : undefined}
            initialDate={initialDate}
            selectedId={hostSelection}
            select={(ids) => setHostSelection(ids[0])}
            renderRelated={(eventId) => (
              <label>
                Thread
                <select
                  aria-label="Linked thread"
                  value={links[eventId] ?? ''}
                  onChange={(e) => setLinks((l) => ({ ...l, [eventId]: e.target.value }))}
                >
                  <option value="">None</option>
                  <option value="thread-launch">Launch planning (Host thread)</option>
                  <option value="thread-review">Design review (Host thread)</option>
                </select>
              </label>
            )}
          />
        </div>
      </div>
    </EditorInputsContext.Provider>
  );
}

const style = document.createElement('style');
style.textContent = `
body { margin: 0; background: #e9edf2; font: 13px/1.4 Arial, sans-serif; }
.schedule-host { display: flex; flex-direction: column; height: 100vh; }
.schedule-host-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 12px; background: #fff; border-bottom: 1px solid #dfe2e6; }
.schedule-host-controls { padding: 4px 12px; background: #fff; border-bottom: 1px solid #dfe2e6; }
.schedule-host-controls label, .schedule-host-controls button { margin-right: 10px; }
.schedule-host-controls output { display: block; font-size: 11px; color: #666e79; overflow-wrap: anywhere; }
.schedule-host-surface { flex: 1; min-height: 0; }
`;
document.head.append(style);
createRoot(document.getElementById('root')!).render(<App />);
