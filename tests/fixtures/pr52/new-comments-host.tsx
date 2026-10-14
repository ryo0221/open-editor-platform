/** Independent public-API Host for retained inputs, rejected slide commands and delayed source lookup. */
import { useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  EditorInputs,
  EditorSession,
  addAnnotation,
  type Region,
} from '@editor-platform/editor-core';
import {
  EditorInputsContext,
  EditorExportGuardContext,
  CommitInput,
} from '@editor-platform/editor-ui';
import { canonicalJson } from '@editor-platform/artifact-core';
import { DocumentSurface, createDocument, type DocumentContent } from '@editor-platform/document';
import {
  GraphSurface,
  createRelationGraph,
  relationProfile,
  graphCommand,
} from '@editor-platform/structured-graph';
import { SlideSurface, createDeck, makeSlideObject } from '@editor-platform/slide';
import {
  ReviewSurface,
  createReview,
  reviewRevision,
  type ReviewResolvedSource,
} from '@editor-platform/review-surfaces';
import '@editor-platform/editor-ui/styles.css';
import { DataOutputHost, ScalarGraphHost } from './data-output-host';

function InputsHost() {
  const [inputs] = useState(() => new EditorInputs());
  const pending = useSyncExternalStore(inputs.subscribe, inputs.getSnapshot);
  const [number, setNumber] = useState(100);
  const [text, setText] = useState('Initial');
  const [accept, setAccept] = useState(false);
  const [status, setStatus] = useState('Ready');
  return (
    <EditorInputsContext.Provider value={inputs}>
      <CommitInput
        label="Numeric draft"
        type="number"
        min={40}
        value={number}
        onCommit={(value) => setNumber(Number(value))}
      />
      <CommitInput
        label="Rejected draft"
        value={text}
        onCommit={(value) => {
          if (!accept) return false;
          setText(value);
        }}
      />
      <label>
        <input
          type="checkbox"
          aria-label="Accept input"
          checked={accept}
          onChange={(event) => setAccept(event.target.checked)}
        />
        Accept input
      </label>
      <button
        onClick={() => {
          setNumber((value) => value + 10);
          setText((value) => value + ' remote');
        }}
      >
        Incoming canonical update
      </button>
      <button
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          try {
            flushSync(() => inputs.flush());
            setStatus('Accepted');
          } catch {
            setStatus('Blocked');
          }
        }}
      >
        Host save
      </button>
      <output aria-label="Canonical number">{number}</output>
      <output aria-label="Canonical text">{text}</output>
      <output aria-label="Pending inputs">{pending.dirty}</output>
      <output aria-label="Save status">{status}</output>
    </EditorInputsContext.Provider>
  );
}
function SlidesHost() {
  const [inputs] = useState(() => new EditorInputs());
  const [accept, setAccept] = useState(false);
  const [session] = useState(() => {
    const deck = createDeck();
    deck.slides[0].objects = [
      {
        ...makeSlideObject('text', 0),
        id: 'text',
        text: 'Original',
        bounds: { x: 80, y: 80, width: 300, height: 100 },
      },
    ];
    return new EditorSession(deck);
  });
  const [, refresh] = useState(0);
  const [selection, setSelection] = useState<string[]>([]);
  return (
    <EditorInputsContext.Provider value={inputs}>
      <label>
        <input
          type="checkbox"
          aria-label="Host accepts commands"
          checked={accept}
          onChange={(event) => setAccept(event.target.checked)}
        />
        Host accepts commands
      </label>
      <div style={{ height: 650 }}>
        <SlideSurface
          content={session.content}
          select={(ids) => setSelection([ids].flat())}
          execute={(cmd) => {
            if (!accept) return false;
            session.execute(cmd);
            refresh((value) => value + 1);
            return true;
          }}
        />
      </div>
      <output aria-label="Selected objects">{selection.join(',')}</output>
      <pre data-testid="slide-source">{JSON.stringify(session.content)}</pre>
    </EditorInputsContext.Provider>
  );
}
function ReviewHost() {
  const [content] = useState(() => createReview());
  const file = content.files[0];
  const [selection, setSelection] = useState<Region>();
  const [lookup, setLookup] = useState('Idle');
  const finish = useRef<((source: ReviewResolvedSource) => void) | undefined>(undefined);
  const [annotations] = useState(() =>
    ['retained', reviewRevision(file, 'new')].map((revisionId, index) =>
      addAnnotation(
        {
          addresses: [
            {
              artifactId: 'host',
              elementId: file.id,
              region: { type: 'lines', start: 2, end: 2, side: 'new', revisionId },
            },
          ],
        },
        index ? 'Current annotation' : 'Outdated annotation',
        'Host',
      ),
    ),
  );
  return (
    <>
      <button
        onClick={() => {
          finish.current?.({
            name: file.name,
            revisionId: 'retained',
            side: 'new',
            text: 'line one\nRetained text',
          });
          setLookup('Finished');
        }}
      >
        Finish source lookup
      </button>
      <output aria-label="Source lookup status">{lookup}</output>
      <output aria-label="Selected revision">
        {selection?.type === 'lines' ? selection.revisionId : ''}
      </output>
      <div style={{ height: 650 }}>
        <ReviewSurface
          content={content}
          annotations={annotations}
          execute={() => {}}
          select={(_, region) => setSelection(region)}
          resolveAnnotationSource={() => {
            setLookup('Pending');
            return new Promise((resolve) => {
              finish.current = resolve;
            });
          }}
        />
      </div>
    </>
  );
}
function DocumentHost() {
  const [inputs] = useState(() => new EditorInputs());
  const pending = useSyncExternalStore(inputs.subscribe, inputs.getSnapshot);
  const [session] = useState(
    () =>
      new EditorSession<DocumentContent>({
        ...createDocument(),
        blocks: [
          {
            id: 'image',
            type: 'image' as const,
            text: '',
            src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
            alt: 'Original alt',
            width: 100,
          },
        ],
      }),
  );
  const [, refresh] = useState(0);
  const [second, setSecond] = useState(false),
    [accept, setAccept] = useState(false),
    [value, setValue] = useState('Original second');
  const calls = useRef(0);
  const [selected, setSelected] = useState<string>();
  return (
    <EditorInputsContext.Provider value={inputs}>
      <EditorExportGuardContext.Provider value={() => flushSync(() => inputs.flush())}>
        <div style={{ height: 650 }}>
          <DocumentSurface
            content={session.content}
            select={(ids) => setSelected([ids].flat()[0])}
            selectedId={selected}
            focusAddress={selected ? { artifactId: 'host', elementId: selected } : undefined}
            execute={(command) => {
              session.execute(command);
              calls.current++;
              refresh((n) => n + 1);
              return true;
            }}
          />
        </div>
        <button onClick={() => setSecond(true)}>Enable second buffer</button>
        {second && (
          <CommitInput
            label="Second buffer"
            value={value}
            onCommit={(next) => {
              if (!accept) return false;
              setValue(next);
              return true;
            }}
          />
        )}
        <label>
          <input
            type="checkbox"
            aria-label="Accept second buffer"
            checked={accept}
            onChange={(event) => setAccept(event.target.checked)}
          />
          Accept second buffer
        </label>
        <output aria-label="Native command count">{calls.current}</output>
        <output aria-label="Pending inputs">{pending.dirty}</output>
        <output aria-label="Canonical second">{value}</output>
        <pre data-testid="document-source">{JSON.stringify(session.content)}</pre>
      </EditorExportGuardContext.Provider>
    </EditorInputsContext.Provider>
  );
}
function GraphHost() {
  const [inputs] = useState(() => new EditorInputs());
  const [session] = useState(() => new EditorSession(createRelationGraph()));
  const [selected, select] = useState('relation-a-b'),
    [readOnly, setReadOnly] = useState(false),
    [status, setStatus] = useState('Ready');
  const [, refresh] = useState(0);
  return (
    <EditorInputsContext.Provider value={inputs}>
      <button
        onClick={() => {
          session.execute(
            graphCommand(relationProfile, [
              { type: 'move-node', id: 'resource-a', position: { x: 80, y: 60 } },
            ]),
          );
          refresh((n) => n + 1);
        }}
      >
        External layout update
      </button>
      <label>
        <input
          type="checkbox"
          aria-label="Graph Host read only"
          checked={readOnly}
          onChange={(event) => setReadOnly(event.target.checked)}
        />
        Read only
      </label>
      <button
        onClick={() => {
          try {
            flushSync(() => inputs.flush());
            setStatus('Accepted');
          } catch (error) {
            setStatus(String(error));
          }
        }}
      >
        Host save
      </button>
      <output aria-label="Graph save status">{status}</output>
      <div style={{ height: 650 }}>
        <GraphSurface
          content={session.content}
          profile={relationProfile}
          stamp={canonicalJson(session.revision)}
          selectedId={selected}
          select={select}
          readOnly={readOnly}
          onEdit={(intents) => {
            if (readOnly) return false;
            session.execute(graphCommand(relationProfile, intents));
            refresh((n) => n + 1);
            return true;
          }}
        />
      </div>
      <pre data-testid="graph-boundary-source">{JSON.stringify(session.content)}</pre>
    </EditorInputsContext.Provider>
  );
}
const kind = new URLSearchParams(location.search).get('kind');
createRoot(document.getElementById('root')!).render(
  kind === 'data-output' ? (
    <DataOutputHost />
  ) : kind === 'scalar-graph' ? (
    <ScalarGraphHost />
  ) : kind === 'slide' ? (
    <SlidesHost />
  ) : kind === 'review' ? (
    <ReviewHost />
  ) : kind === 'document' ? (
    <DocumentHost />
  ) : kind === 'graph' ? (
    <GraphHost />
  ) : (
    <InputsHost />
  ),
);
