/** Reference Host for the external read ports of Geo, Data and work items (ADR 016). Every port
 * is a deterministic mock: synthetic data, no network, no credentials. Real connections are shown
 * in a real Host that uses ep-connectors; this page never imports it. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  geoFeatureReadLimit,
  parseGeoBbox,
  type GeoFeatureRead,
  type GeoFeatureSourceInfo,
} from '@editor-platform/geo-core/host';
import { createMockGeoFeatureHost } from '@editor-platform/geo-core/mock-host';
import type {
  TableRead,
  TableSourceInfo,
  WorkItemSourceInfo,
  WorkItemsRead,
} from '@editor-platform/structured-data/host';
import {
  createMockTableHost,
  createMockWorkItemHost,
  type MockSourceControls,
} from '@editor-platform/structured-data/mock-host';
import {
  createSourceReader,
  type SourcePort,
  type SourceReadState,
} from './external-sources/reader';

type Source = { handle: string; label: string; provider: string; account: string };

function useReader<S extends Source, R>(port: SourcePort<S, R>) {
  const [state, setState] = useState<SourceReadState<S, R>>({ sources: [], status: 'idle' });
  const reader = useMemo(() => createSourceReader(port, setState), [port]);
  useEffect(() => () => reader.dispose(), [reader]);
  return { state, reader };
}

const time = (ms: number) => new Date(ms).toISOString().replace('.000', '');

function Controls({ controls }: { controls: MockSourceControls }) {
  const [complete, setComplete] = useState(true);
  const [fail, setFail] = useState(false);
  const [hold, setHold] = useState(false);
  return (
    <details className="ext-controls">
      <summary>Mock Host controls</summary>
      <label>
        <input
          type="checkbox"
          checked={complete}
          onChange={(e) => {
            setComplete(e.target.checked);
            controls.setComplete(e.target.checked);
          }}
        />
        Complete reads
      </label>
      <label>
        <input
          type="checkbox"
          checked={fail}
          onChange={(e) => {
            setFail(e.target.checked);
            controls.failReads(e.target.checked);
          }}
        />
        Fail reads
      </label>
      <label>
        <input
          type="checkbox"
          checked={hold}
          onChange={(e) => {
            setHold(e.target.checked);
            controls.holdReads(e.target.checked);
          }}
        />
        Hold reads
      </label>
      <button type="button" onClick={() => controls.releaseReads()}>
        Release held reads
      </button>
      <button type="button" onClick={() => controls.changeSource()}>
        Change source
      </button>
      <button type="button" onClick={() => controls.switchAccount()}>
        Switch account
      </button>
    </details>
  );
}

function Panel<S extends Source, R>(props: {
  title: string;
  state: SourceReadState<S, R>;
  reader: ReturnType<typeof createSourceReader<S, R>>;
  controls: MockSourceControls;
  canRead?: boolean;
  options?: ReactNode;
  describe(source: S): string;
  children(read: R): ReactNode;
}) {
  const { state, reader } = props;
  const source = state.sources.find((s) => s.handle === state.selected);
  const status =
    state.status === 'loading'
      ? 'Reading…'
      : state.status === 'failed'
        ? `Not read: ${state.message}`
        : (state.message ?? (state.status === 'ready' ? 'Read.' : 'Not read yet.'));
  return (
    <section className="ext-panel" aria-label={props.title}>
      <h2>{props.title}</h2>
      <Controls controls={props.controls} />
      <div className="ext-bar">
        <label>
          Source
          <select
            value={state.selected ?? ''}
            onChange={(e) => reader.select(e.target.value)}
            disabled={!state.sources.length}
          >
            {state.sources.map((s) => (
              <option key={s.handle} value={s.handle}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {props.options}
        <button
          type="button"
          disabled={!source || props.canRead === false}
          onClick={() => void reader.read()}
        >
          Read
        </button>
      </div>
      {source && (
        <p className="ext-source">
          {source.provider} · {source.account} · {props.describe(source)}
        </p>
      )}
      <p role="status">{status}</p>
      {state.status === 'ready' && state.read !== undefined && props.children(state.read)}
    </section>
  );
}

function Incomplete({ complete, text }: { complete: boolean; text: string }) {
  return complete ? null : <p className="ext-warn">Incomplete: {text}</p>;
}

function GeoPanel() {
  const mock = useMemo(createMockGeoFeatureHost, []);
  const [bboxText, setBboxText] = useState('139.6,35.5,139.9,35.8');
  const bbox = parseGeoBbox(bboxText);
  const bboxRef = useRef(bbox);
  bboxRef.current = bbox;
  const port = useMemo<SourcePort<GeoFeatureSourceInfo, GeoFeatureRead>>(
    () => ({
      listSources: (signal) => mock.read.listSources(signal),
      // A change notice reads again on its own, so the area is checked here and not only by
      // the disabled button.
      read: async (sourceHandle, signal) => {
        const area = bboxRef.current;
        if (!area) throw new Error('Enter four numbers in CRS84 ranges.');
        return mock.read.readFeatures(
          { sourceHandle, bbox: area, limit: geoFeatureReadLimit },
          signal,
        );
      },
      watch: mock.read.watch,
    }),
    [mock],
  );
  const { state, reader } = useReader(port);
  return (
    <Panel
      title="Geo features"
      state={state}
      reader={reader}
      controls={mock.controls}
      canRead={bbox !== undefined}
      describe={(s) => s.attribution}
      options={
        <label>
          Area (CRS84 west,south,east,north)
          <input value={bboxText} onChange={(e) => setBboxText(e.target.value)} />
          {!bbox && <span className="ext-warn"> Enter four numbers in CRS84 ranges.</span>}
        </label>
      }
    >
      {(read) => (
        <>
          <p>
            {read.features.length} features · matched {read.matched ?? 'unknown'} · fetched{' '}
            {time(read.fetchedAt)}
          </p>
          <Incomplete
            complete={read.complete}
            text="features outside what was read are unknown, not absent."
          />
          {read.rejected.length > 0 && (
            <p>
              Left out by the Host:{' '}
              {read.rejected.map((r) => `${r.id ?? `#${r.index}`} (${r.reason})`).join(', ')}
            </p>
          )}
          {read.omittedProperties.length > 0 && (
            <p>Properties not read: {read.omittedProperties.join(', ')}</p>
          )}
          <table aria-label="Features">
            <thead>
              <tr>
                <th>Id</th>
                <th>Geometry</th>
                <th>Properties</th>
              </tr>
            </thead>
            <tbody>
              {read.features.map((f, i) => (
                <tr key={f.id ?? `#${i}`}>
                  <td>{f.id ?? '(none)'}</td>
                  <td>{f.geometry?.type ?? 'No location'}</td>
                  <td>
                    {Object.entries(f.properties)
                      .map(([k, v]) => `${k}: ${v === null ? '—' : String(v)}`)
                      .join(' · ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Panel>
  );
}

function TablePanel() {
  const mock = useMemo(createMockTableHost, []);
  const port = useMemo<SourcePort<TableSourceInfo, TableRead>>(
    () => ({
      listSources: (signal) => mock.read.listSources(signal),
      read: (sourceHandle, signal) => mock.read.readTable({ sourceHandle }, signal),
      watch: mock.read.watch,
    }),
    [mock],
  );
  const { state, reader } = useReader(port);
  return (
    <Panel
      title="Data table"
      state={state}
      reader={reader}
      controls={mock.controls}
      describe={(s) => `Registered range ${s.range}`}
    >
      {(read) => (
        <>
          <p>
            {read.resolvedRange} · {read.rows.length} rows × {read.columnCount} columns ·{' '}
            {read.valueRender} values · fetched {time(read.fetchedAt)}
          </p>
          <Incomplete complete={read.complete} text="rows after the last one are unknown." />
          <table aria-label="Table values">
            <tbody>
              {read.rows.map((row, r) => (
                <tr key={r}>
                  <th scope="row">{r + 1}</th>
                  {row.map((cell, c) => (
                    <td key={c}>{cell === null ? '' : String(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Panel>
  );
}

function WorkItemPanel() {
  const mock = useMemo(createMockWorkItemHost, []);
  const port = useMemo<SourcePort<WorkItemSourceInfo, WorkItemsRead>>(
    () => ({
      listSources: (signal) => mock.read.listSources(signal),
      read: (sourceHandle, signal) => mock.read.readWorkItems({ sourceHandle }, signal),
      watch: mock.read.watch,
    }),
    [mock],
  );
  const { state, reader } = useReader(port);
  return (
    <Panel
      title="Work items"
      state={state}
      reader={reader}
      controls={mock.controls}
      describe={(s) => s.container}
    >
      {(read) => (
        <>
          <p>
            {read.items.length} items in {read.container} · fetched {time(read.fetchedAt)} ·
            deletions reflected up to {time(read.fullReconciledAt)}
          </p>
          <Incomplete complete={read.complete} text="other items are unknown, not absent." />
          <table aria-label="Work items">
            <thead>
              <tr>
                <th>Item</th>
                <th>Title</th>
                <th>State</th>
                <th>Labels</th>
                <th>Assignees</th>
                <th>Milestone</th>
                <th>Updated</th>
                <th>Link (not opened)</th>
              </tr>
            </thead>
            <tbody>
              {read.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    {item.kind === 'issue' ? 'Issue' : 'Pull request'} #{item.number}
                  </td>
                  <td>{item.title}</td>
                  <td>
                    {item.state}
                    {item.draft ? ' (draft)' : ''}
                    {item.stateReason ? ` (${item.stateReason})` : ''}
                  </td>
                  <td>
                    {item.labels.map((l) => l.name).join(', ')}
                    {item.labelsComplete ? '' : ' (more not read)'}
                  </td>
                  <td>
                    {item.assignees.join(', ')}
                    {item.assigneesComplete ? '' : ' (more not read)'}
                  </td>
                  <td>{item.milestone?.title ?? ''}</td>
                  <td>{item.updatedAt}</td>
                  <td>{item.url ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Panel>
  );
}

function App() {
  return (
    <main className="ext-host">
      <header>
        <strong>External sources host</strong>
        <p>
          Reference Host for verification. Every source is a deterministic mock with synthetic data:
          no network, no sign-in. Results stay in memory and are never saved.
        </p>
      </header>
      <GeoPanel />
      <TablePanel />
      <WorkItemPanel />
    </main>
  );
}

const style = document.createElement('style');
style.textContent = `
body { margin: 0; background: #e9edf2; font: 13px/1.4 Arial, sans-serif; }
.ext-host { max-width: 1100px; margin: 0 auto; padding: 12px 16px; }
.ext-host header p { color: #4a525c; }
.ext-panel { background: #fff; border: 1px solid #dfe2e6; border-radius: 6px; padding: 8px 12px; margin-bottom: 12px; overflow-x: auto; }
.ext-panel h2 { font-size: 15px; margin: 4px 0 8px; }
.ext-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.ext-bar label { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.ext-controls { margin-bottom: 8px; }
.ext-controls label, .ext-controls button { margin-right: 10px; }
.ext-source { color: #4a525c; }
.ext-warn { color: #9a3b00; }
.ext-panel table { border-collapse: collapse; }
.ext-panel th, .ext-panel td { border: 1px solid #dfe2e6; padding: 2px 6px; text-align: left; vertical-align: top; }
`;
document.head.append(style);
createRoot(document.getElementById('root')!).render(<App />);
