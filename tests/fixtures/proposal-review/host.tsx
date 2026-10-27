import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { newId } from '@editor-platform/artifact-core';
import {
  EditorSession,
  command,
  reviewProposedCommands,
  transaction,
  withCommandReads,
  type EditorCommand,
  type ProposalDiffAdapter,
  type ProposalReview,
  type ProposedCommands,
} from '@editor-platform/editor-core';
import { updateBlock, type DocumentContent } from '@editor-platform/document/model';
import { documentProposalDiff } from '@editor-platform/document/proposal-diff';
import { removeRow, setCell, type StructuredData } from '@editor-platform/structured-data/model';
import { moveDates, utcDay } from '@editor-platform/structured-data/views';
import { dataProposalDiff } from '@editor-platform/structured-data/proposal-diff';
import {
  deleteNodes,
  transformNodes,
  type WhiteboardContent,
} from '@editor-platform/whiteboard/model';
import { whiteboardProposalDiff } from '@editor-platform/whiteboard/proposal-diff';
import {
  removeEvent,
  setEventTime,
  shiftTime,
  type ScheduleDocument,
} from '@editor-platform/schedule/model';
import { scheduleProposalDiff } from '@editor-platform/schedule/proposal-diff';

// An independent Host (#401): its own sessions, versions and review layout. Only public
// package entrypoints; no Playground state, CSS or build-time substitution.
type Domain = 'document' | 'data' | 'whiteboard' | 'schedule' | 'geo';
interface Entry {
  session: EditorSession<unknown>;
  versionId: string;
  adapter?: ProposalDiffAdapter<unknown>;
  propose(content: unknown, variant: string): EditorCommand<unknown>[];
  /** Host edit that removes the proposal's target. */
  removeTarget: EditorCommand<unknown>;
}
const reading = <T,>(c: EditorCommand<T>, ids: string[]) => withCommandReads(c, { content: ids });

function entries(): Record<Domain, Entry> {
  const document: DocumentContent = {
    schemaVersion: 2,
    blocks: [
      { id: 'title', type: 'heading', level: 1, text: 'Launch plan' },
      { id: 'body', type: 'paragraph', text: 'Ship on Friday.\nThen review.' },
    ],
  };
  const data: StructuredData = {
    schemaVersion: 2,
    columns: [
      { id: 'name', name: 'Task', type: 'text' },
      { id: 'status', name: 'Status', type: 'select', options: ['Planned', 'Active'] },
      { id: 'start', name: 'Start', type: 'date' },
      { id: 'end', name: 'End', type: 'date' },
    ],
    rows: [
      {
        id: 'task-design',
        values: { name: 'Design', status: 'Planned', start: '2026-10-05', end: '2026-10-09' },
      },
    ],
  };
  const timeline = {
    start: 'start',
    end: 'end',
    group: '',
    scale: 'week',
    from: '',
    to: '',
  } as const;
  const board: WhiteboardContent = {
    schemaVersion: 3,
    sections: [],
    nodes: [
      {
        id: 'note-risks',
        kind: 'sticky',
        name: 'Risks',
        text: 'Risks',
        color: '#f2e3a8',
        bounds: { x: 120, y: 120, width: 180, height: 120 },
      },
    ],
    connectors: [],
  };
  const schedule: ScheduleDocument = {
    schemaVersion: 1,
    timeZone: 'Asia/Tokyo',
    lanes: [],
    events: [
      {
        id: 'review',
        title: 'Design review',
        notes: '',
        conference: 'none',
        links: [],
        time: {
          kind: 'timed',
          startLocal: '2026-10-26T10:00',
          endLocal: '2026-10-26T11:00',
          timeZone: 'Asia/Tokyo',
        },
      },
    ],
  };
  const make = <T,>(
    content: T,
    adapter: ProposalDiffAdapter<T> | undefined,
    propose: (content: T, variant: string) => EditorCommand<T>[],
    removeTarget: EditorCommand<T>,
  ): Entry =>
    ({
      session: new EditorSession<T>(content),
      versionId: newId('version'),
      adapter,
      propose,
      removeTarget,
    }) as unknown as Entry;
  return {
    document: make(
      document,
      documentProposalDiff,
      () => [reading(updateBlock('body', { text: 'Ship on Monday.\nThen review.' }), ['body'])],
      command<DocumentContent>('host.delete', 'Delete body', (d) => ({
        ...d,
        blocks: d.blocks.filter((b) => b.id !== 'body'),
      })),
    ),
    data: make(
      data,
      dataProposalDiff,
      (content) => [
        reading(setCell('task-design', 'status', 'Active'), ['task-design']),
        reading(
          moveDates(content, 'task-design', timeline, utcDay('2026-10-12')!, utcDay('2026-10-16')!),
          ['task-design'],
        ),
      ],
      removeRow('task-design'),
    ),
    whiteboard: make(
      board,
      whiteboardProposalDiff,
      () => [
        reading(transformNodes(['note-risks'], { dx: 80, dy: 40, dw: 0, dh: 0 }), ['note-risks']),
      ],
      deleteNodes(['note-risks']),
    ),
    schedule: make(
      schedule,
      scheduleProposalDiff,
      (content, variant) => {
        const event = content.events[0];
        return variant === 'unknown-zone'
          ? // A runtime that writes a zone the Host cannot name; the native command would refuse it.
            [
              reading(
                command<ScheduleDocument>('runtime.set-time', 'Set time', (c) => ({
                  ...c,
                  events: c.events.map((e) => ({
                    ...e,
                    time: { ...e.time, timeZone: 'Mars/Olympus' },
                  })),
                })),
                ['review'],
              ),
            ]
          : [reading(setEventTime('review', shiftTime(event.time, 0, 60)), ['review'])];
      },
      removeEvent('review'),
    ),
    geo: make<{ schemaVersion: 1; layers: unknown[]; sources: unknown[] }>(
      { schemaVersion: 1, layers: [], sources: [] },
      undefined,
      () => [
        command('runtime.add-layer', 'Add layer', (g) => ({
          ...g,
          layers: [...g.layers, { id: 'sites', name: 'Sites', crs: 'EPSG:6677' }],
        })),
      ],
      command('host.noop', 'No-op', (g) => g),
    ),
  };
}

function Value({ value }: { value: unknown }) {
  return <>{value === undefined ? '—' : JSON.stringify(value)}</>;
}
function Review({ review }: { review: ProposalReview<unknown> }) {
  if (review.status === 'refused')
    return (
      <section aria-label="Host review">
        <p role="alert" data-reason={review.reason}>
          Refused ({review.reason}): {review.message}
        </p>
        {review.elementIds.length > 0 && <p>Items: {review.elementIds.join(', ')}</p>}
        {review.fallback.map((f, i) => (
          <pre
            key={i}
            aria-label="JSON fallback"
            style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
          >
            {f.reason}: <Value value={f.after} />
          </pre>
        ))}
      </section>
    );
  return (
    <section aria-label="Host review">
      <p>
        Ready · base {review.base.versionId} · {review.domain}
      </p>
      <ul aria-label="Content changes">
        {review.changes.map((c, i) => (
          <li key={i} data-element-id={c.elementId}>
            {c.elementLabel} [{c.elementId}] {c.kind} {c.propertyLabel ?? c.property}
            {c.units ? ` (${c.units})` : ''}: <Value value={c.before} /> → <Value value={c.after} />
          </li>
        ))}
      </ul>
      <ul aria-label="Display changes">
        {review.view.map((c, i) => (
          <li key={i}>
            {c.elementId} {c.property}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Host() {
  const all = useRef(entries());
  const [domain, setDomain] = useState<Domain>('document');
  const [proposal, setProposal] = useState<ProposedCommands<unknown>>();
  const [review, setReview] = useState<ProposalReview<unknown>>();
  const [, refresh] = useState(0);
  const entry = all.current[domain];
  const check = (p: ProposedCommands<unknown>) =>
    reviewProposedCommands(
      {
        content: entry.session.content,
        base: { artifactId: domain, versionId: entry.versionId, revision: entry.session.revision },
      },
      p,
      entry.adapter,
    );
  const request = (variant = '') => {
    const p: ProposedCommands<unknown> = {
      id: newId('proposal'),
      summary: 'Runtime says: all requested changes are done.',
      source: 'Independent Host runtime',
      baseLocalRevision: entry.session.revision,
      reads: { target: { artifactId: domain, versionId: entry.versionId }, references: [] },
      commands: entry.propose(entry.session.content, variant),
    };
    setProposal(p);
    setReview(check(p));
  };
  return (
    <main style={{ fontFamily: 'sans-serif', padding: 12, display: 'grid', gap: 8 }}>
      <label>
        Host domain{' '}
        <select
          aria-label="Host domain"
          value={domain}
          onChange={(e) => {
            setDomain(e.target.value as Domain);
            setProposal(undefined);
            setReview(undefined);
          }}
        >
          {Object.keys(all.current).map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
      </label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <button onClick={() => request()}>Request proposal</button>
        <button onClick={() => request('unknown-zone')}>Request unknown-zone proposal</button>
        <button disabled={!proposal} onClick={() => proposal && setReview(check(proposal))}>
          Check proposal again
        </button>
        <button
          onClick={() => {
            entry.versionId = newId('version');
            refresh((n) => n + 1);
          }}
        >
          Host save version
        </button>
        <button
          onClick={() => {
            entry.session.execute(entry.removeTarget);
            refresh((n) => n + 1);
          }}
        >
          Host delete target
        </button>
        <button
          disabled={review?.status !== 'ready'}
          onClick={() => {
            if (!proposal) return;
            const current = check(proposal);
            setReview(current);
            if (current.status !== 'ready') return;
            entry.session.execute(
              transaction(proposal.summary, proposal.commands, {
                origin: 'proposal',
                transactionId: newId('transaction'),
                proposalId: proposal.id,
              }),
            );
            setProposal(undefined);
            setReview(undefined);
          }}
        >
          Host apply
        </button>
        <button
          onClick={() => {
            setProposal(undefined);
            setReview(undefined);
          }}
        >
          Host reject
        </button>
        <button
          disabled={!entry.session.canUndo}
          onClick={() => {
            entry.session.undo();
            refresh((n) => n + 1);
          }}
        >
          Host undo
        </button>
      </div>
      {review && <Review review={review} />}
      <pre data-testid="host-content" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {JSON.stringify(entry.session.content)}
      </pre>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Host />);
