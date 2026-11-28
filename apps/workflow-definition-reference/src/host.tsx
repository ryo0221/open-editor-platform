// Reference Host for the workflow-definition Editor (#99 WD3): it owns the OWD JSON, the
// presentation sidecar and one Undo history, in memory only.
import { StrictMode, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { canonicalJson, clone } from '@editor-platform/artifact-core';
import { type EditorCommand } from '@editor-platform/editor-core';
import { GraphBinding, type PresentationSidecar } from '@editor-platform/structured-graph/model';
import { MindmapSurface } from '@editor-platform/mindmap';
import {
  mindmapFingerprint,
  mindmapProposalCommand,
  type MindmapContent,
} from '@editor-platform/mindmap-core';
import {
  WorkflowDefinitionSurface,
  type WorkflowDefinitionProposal,
  type WorkflowMindmapConnection,
} from '@editor-platform/workflow-definition';
import {
  createOwdGraphAdapter,
  readOwdDefinition,
  type OwdDefinition,
  type WorkflowDefinitionCheck,
} from '@editor-platform/workflow-definition/model';
import { check as owdCheck } from '../../../packages/workflow-definition/fixtures/owd-446706b/src/check.mjs';
import '@editor-platform/structured-graph/styles.css';
import { sampleDefinition, sampleMindmap, sampleProposal } from './sample';
import './host.css';

interface State {
  source: OwdDefinition;
  sidecar?: PresentationSidecar;
}
/** One Undo record: a source edit, or (with `sidecar`) a source edit and its sidecar together. */
interface Record {
  source: OwdDefinition;
  sidecar?: { value?: PresentationSidecar };
}
/** The reference check: the pinned OWD copy, injected as a real Host would inject its own. */
const check: WorkflowDefinitionCheck = (definition) => owdCheck(definition);

export function WorkflowDefinitionHost() {
  const [state, setState] = useState<State>({ source: clone(sampleDefinition) });
  const [baseline, setBaseline] = useState<OwdDefinition>(clone(sampleDefinition)),
    [readOnly, setReadOnly] = useState(false),
    [atomic, setAtomic] = useState(true),
    [checked, setChecked] = useState(true),
    [status, setStatus] = useState('Ready'),
    [revision, setRevision] = useState(1),
    [json, setJson] = useState<string>();
  const current = useRef(state),
    past = useRef<Record[]>([]),
    future = useRef<Record[]>([]),
    flags = useRef({ readOnly });
  current.current = state;
  flags.current = { readOnly };
  // The Mind Map is another artifact with its own Undo (design §7: two edits, two records).
  const [mindmap, setMindmap] = useState<MindmapContent>(clone(sampleMindmap)),
    [mindmapStatus, setMindmapStatus] = useState(''),
    [mindmapRefuses, setMindmapRefuses] = useState(false),
    [proposal, setProposal] = useState<WorkflowDefinitionProposal>();
  const mindmapNow = useRef(mindmap),
    mindmapPast = useRef<MindmapContent[]>([]);
  mindmapNow.current = mindmap;
  /** Runs a Mind Map command; the reason when it was refused. */
  const runMindmap = (cmd: EditorCommand<MindmapContent>): string | undefined => {
    try {
      const before = mindmapNow.current;
      const next = cmd.apply(before);
      mindmapPast.current.push(before);
      mindmapNow.current = next;
      setMindmap(next);
      setMindmapStatus(cmd.label);
      return undefined;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      setMindmapStatus(reason);
      return reason;
    }
  };
  const branches: WorkflowMindmapConnection['branches'][number][] = [];
  (function walk(id: string) {
    const n = mindmap.nodes[id];
    if (!n) return;
    if (id !== mindmap.rootId)
      branches.push({ nodeId: id, title: n.text, ...(n.link ? { link: n.link } : {}) });
    n.children.forEach(walk);
  })(mindmap.rootId);
  const connection: WorkflowMindmapConnection = {
    branches,
    // Applied as the Mind Map's own proposal, checked against the content it was made from.
    requestLinks: (requests) => {
      if (mindmapRefuses) return 'The Mind Map is read only';
      const now = mindmapNow.current;
      try {
        return runMindmap(
          mindmapProposalCommand(
            {
              before: mindmapFingerprint(now),
              steps: requests.map((r) => ({ kind: 'link', id: r.nodeId, link: r.link })),
            },
            now,
          ),
        );
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
  };
  const commit = (next: State, record?: Record, message = 'Unsaved draft') => {
    if (record) {
      past.current.push(record);
      future.current = [];
    }
    current.current = next;
    setState(next);
    setRevision((n) => n + 1);
    setStatus(message);
  };
  const binding = useMemo(
    () =>
      new GraphBinding<OwdDefinition>({
        adapter: createOwdGraphAdapter({ check: checked ? check : undefined }),
        sourceId: 'reference-definition',
        read: () => ({
          content: current.current.source,
          revision: String(revision),
          readOnly: flags.current.readOnly,
        }),
        execute: (cmd: EditorCommand<OwdDefinition>) => {
          if (flags.current.readOnly) throw new Error('The definition is read only');
          const before = current.current;
          commit({ ...before, source: cmd.apply(clone(before.source)) }, { source: before.source });
        },
        getPresentation: () => current.current.sidecar,
        // Presentation alone stays out of the definition's Undo.
        setPresentation: (sidecar) => {
          if (flags.current.readOnly) throw new Error('The definition is read only');
          commit({ ...current.current, sidecar }, undefined, 'Unsaved layout');
        },
        ...(atomic
          ? {
              commitWithPresentation: ({ command, presentation }) => {
                if (flags.current.readOnly) throw new Error('The definition is read only');
                const before = current.current;
                // Both or neither: the command is applied first (it checks the stamp), then the sidecar.
                const source = command.apply(clone(before.source));
                commit(
                  { source, sidecar: presentation },
                  { source: before.source, sidecar: { value: before.sidecar } },
                );
              },
            }
          : {}),
      }),
    // A new binding when the Host's options change; the revision is read through the ref.
    [atomic, checked, revision],
  );
  const history = (direction: 'undo' | 'redo') => {
    const from = direction === 'undo' ? past.current : future.current,
      to = direction === 'undo' ? future.current : past.current;
    const record = from.pop();
    if (!record || readOnly) return;
    const now = current.current;
    to.push({ source: now.source, ...(record.sidecar ? { sidecar: { value: now.sidecar } } : {}) });
    const next = {
      source: record.source,
      sidecar: record.sidecar ? record.sidecar.value : now.sidecar,
    };
    current.current = next;
    setState(next);
    setRevision((n) => n + 1);
    setStatus(direction === 'undo' ? 'Undone' : 'Redone');
  };
  const importJson = () => {
    try {
      const value = readOwdDefinition(JSON.parse(json ?? ''));
      past.current = [];
      future.current = [];
      setBaseline(clone(value));
      commit({ source: clone(value) }, undefined, 'Imported');
      setJson(undefined);
    } catch (e) {
      setStatus(`Import refused: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return (
    <main className="wd-host">
      <h1>Workflow definition reference Host</h1>
      <div className="wd-host-bar" role="toolbar" aria-label="Host">
        <button
          type="button"
          onClick={() => history('undo')}
          disabled={readOnly || !past.current.length}
        >
          Undo
        </button>
        <button
          type="button"
          onClick={() => history('redo')}
          disabled={readOnly || !future.current.length}
        >
          Redo
        </button>
        <button
          type="button"
          onClick={() => {
            setBaseline(clone(current.current.source));
            setStatus('Version saved');
          }}
        >
          Save version
        </button>
        <label>
          <input
            type="checkbox"
            checked={readOnly}
            onChange={(e) => setReadOnly(e.target.checked)}
          />{' '}
          Read only
        </label>
        <label>
          <input type="checkbox" checked={atomic} onChange={(e) => setAtomic(e.target.checked)} />{' '}
          Host commits layout with edits
        </label>
        <label>
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />{' '}
          OWD check
        </label>
        <button type="button" onClick={() => setProposal(sampleProposal)}>
          Propose
        </button>
        <label>
          <input
            type="checkbox"
            checked={mindmapRefuses}
            onChange={(e) => setMindmapRefuses(e.target.checked)}
          />{' '}
          Mind Map refuses links
        </label>
        <button
          type="button"
          onClick={() => setJson(JSON.stringify(current.current.source, null, 2))}
        >
          JSON
        </button>
        <output aria-label="Host status">{status}</output>
      </div>
      {json !== undefined && (
        <section aria-label="Definition JSON" className="wd-host-json">
          <textarea
            aria-label="Definition JSON text"
            value={json}
            onChange={(e) => setJson(e.target.value)}
          />
          <button type="button" onClick={importJson}>
            Import
          </button>
          <button type="button" onClick={() => setJson(undefined)}>
            Close
          </button>
        </section>
      )}
      <WorkflowDefinitionSurface
        key={`${atomic}-${checked}`}
        binding={binding}
        revision={canonicalJson([revision, readOnly])}
        check={checked ? check : undefined}
        baseline={baseline}
        mindmap={connection}
        proposal={proposal}
        onProposal={(decision) => {
          setProposal(undefined);
          setStatus(decision === 'applied' ? 'Proposal applied' : 'Proposal rejected');
        }}
      />
      <section aria-label="Mind Map" className="wd-host-mindmap">
        <h2>Mind Map</h2>
        <div className="wd-host-bar" role="toolbar" aria-label="Mind Map Host">
          <button
            type="button"
            disabled={!mindmapPast.current.length}
            onClick={() => {
              const before = mindmapPast.current.pop();
              if (!before) return;
              mindmapNow.current = before;
              setMindmap(before);
              setMindmapStatus('Undone');
            }}
          >
            Mind Map Undo
          </button>
          <output aria-label="Mind Map status">{mindmapStatus}</output>
        </div>
        <MindmapSurface
          content={mindmap}
          readOnly={mindmapRefuses}
          execute={(cmd) => runMindmap(cmd) === undefined}
          fileName="sample"
        />
      </section>
    </main>
  );
}
const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <StrictMode>
      <WorkflowDefinitionHost />
    </StrictMode>,
  );
