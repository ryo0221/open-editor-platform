import { useMemo, useState } from 'react';
import {
  GraphSurface,
  type GraphBinding,
  type GraphProjection,
} from '@editor-platform/structured-graph';
import {
  owdElementKey,
  owdElementKinds,
  owdElements,
  owdIdTaken,
  parseOwdElementKey,
  validOwdId,
  owdRenamedPresentation,
  workflowDefinitionCommand,
  workflowDefinitionDiagnostics,
  workflowDefinitionDiff,
  type OwdDefinition,
  type OwdElementKind,
  type OwdElementRef,
  type OwdRecord,
  type WorkflowDefinitionCheck,
  type WorkflowDefinitionIntent,
} from '../model';
import {
  kindLabels,
  sameRef,
  useWorkflow,
  WorkflowContext,
  type WorkflowMindmapConnection,
  type WorkflowViewContext,
} from './context';
import { WorkflowMindmap } from './mindmap';
import { ProposalPanel, type WorkflowDefinitionProposal } from './proposal';
import { TextField } from './fields';
import { WorkflowLists } from './lists';
import { WorkflowMatrices } from './matrix';
import './styles.css';

export interface WorkflowDefinitionSurfaceProps {
  /**
   * The Host's binding of its OWD JSON (`createOwdGraphAdapter`). Every view reads the definition
   * through it and edits through its `execute`, so all edits share the Host's one Undo.
   */
  binding: GraphBinding<OwdDefinition>;
  /** Changes whenever the Host's source or sidecar changes, so the views read again. */
  revision: string;
  /** The Host's OWD check, shown as diagnostics. Without it the Surface says it is not checked. */
  check?: WorkflowDefinitionCheck;
  /** The version the draft started from; shows the changes tab. */
  baseline?: OwdDefinition;
  /** The view shown first (the flow by default). */
  initialTab?: WorkflowDefinitionTab;
  /** The Host's Mind Map: its branches and link requests; shows the Mind Map tab. */
  mindmap?: WorkflowMindmapConnection;
  /** An edit proposed from outside, shown for preview, apply or reject. */
  proposal?: WorkflowDefinitionProposal;
  /** The person applied (through the Host's `execute`) or rejected the proposal. */
  onProposal?(decision: 'applied' | 'rejected'): void;
}
export type WorkflowDefinitionTab = 'flow' | 'lists' | 'matrix' | 'info' | 'mindmap' | 'changes';
type Tab = WorkflowDefinitionTab;
const tabLabels: Record<Tab, string> = {
  flow: '流れ',
  lists: '一覧',
  matrix: 'マトリクス',
  info: '定義の情報',
  mindmap: 'マインドマップ',
  changes: '差分',
};
const graphKinds = new Set<OwdElementKind>([
  'phase',
  'section',
  'deliverable',
  'acceptance',
  'role',
]);

function AddElement() {
  const { definition, readOnly, edit, selected, select } = useWorkflow();
  const [kind, setKind] = useState<OwdElementKind>('phase'),
    [id, setId] = useState(''),
    [name, setName] = useState(''),
    [error, setError] = useState<string>();
  if (readOnly) return null;
  const problem = !id
    ? undefined
    : !validOwdId(id)
      ? 'ID は英小文字の語を - と . でつなぎます（例 concept・process.complete）'
      : owdIdTaken(definition, kind, id)
        ? `ID ${id} はもう使われています`
        : undefined;
  const add = () => {
    if (!id || problem) return setError(problem ?? 'ID を入れてください');
    const fields: OwdRecord =
      kind === 'acceptance'
        ? { text: name }
        : kind === 'rule'
          ? { type: 'cites', to: [], min: 1 }
          : kind === 'item'
            ? {
                name,
                idForm: `${
                  id
                    .toUpperCase()
                    .replace(/[^A-Z0-9]/g, '')
                    .slice(0, 4) || 'X'
                }-{nn}`,
              }
            : { name };
    // A new phase goes right after the selected one, as the phase order reads.
    const index =
      kind === 'phase' && selected?.kind === 'phase'
        ? owdElements(definition, 'phase').findIndex((p) => p.id === selected.id) + 1
        : undefined;
    const failed = edit([{ type: 'add', kind, id, fields, ...(index ? { index } : {}) }]);
    setError(failed);
    if (!failed) {
      select({ kind, id });
      setId('');
      setName('');
    }
  };
  return (
    <form
      className="ep-wd-add"
      aria-label="Add element"
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
    >
      <select
        aria-label="Element kind"
        value={kind}
        onChange={(e) => setKind(e.target.value as OwdElementKind)}
      >
        {owdElementKinds.map((k) => (
          <option key={k} value={k}>
            {kindLabels[k]}
          </option>
        ))}
      </select>
      <input
        aria-label="New element ID"
        placeholder="ID（英小文字）"
        value={id}
        aria-invalid={!!problem || undefined}
        onChange={(e) => {
          setId(e.target.value);
          setError(undefined);
        }}
      />
      {kind !== 'rule' && (
        <input
          aria-label="New element name"
          placeholder={kind === 'acceptance' ? '条件の文' : '名前'}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      )}
      <button type="submit">追加</button>
      {(problem || error) && (
        <span role="alert" className="ep-wd-error">
          {problem ?? error}
        </span>
      )}
    </form>
  );
}

function Info() {
  const { definition, readOnly, edit } = useWorkflow();
  const field = (key: string, label: string, multiline = false) => (
    <TextField
      label={label}
      value={typeof definition[key] === 'string' ? (definition[key] as string) : ''}
      readOnly={readOnly}
      required
      multiline={multiline}
      onCommit={(v) => edit([{ type: 'set-definition', fields: { [key]: v } }])}
    />
  );
  return (
    <section className="ep-wd-info" aria-label="Definition information">
      <label>定義の ID {field('id', 'Definition ID')}</label>
      <label>版 {field('version', 'Version')}</label>
      <label>題 {field('title', 'Title')}</label>
      <label>目的 {field('purpose', 'Purpose', true)}</label>
      <label>
        <input
          type="checkbox"
          aria-label="Strict cites"
          checked={definition.strictCites === true}
          disabled={readOnly}
          onChange={(e) =>
            edit([
              { type: 'set-definition', fields: { strictCites: e.target.checked ? true : null } },
            ])
          }
        />
        規則に無い組の引用を違反にする（strictCites）
      </label>
      {(['gates', 'placements'] as const).map((key) =>
        definition[key] === undefined ? null : (
          <details key={key}>
            <summary>
              {key === 'gates' ? '既定のゲート' : '置き場所の形'}（読むだけ。この Editor
              では編集しません）
            </summary>
            <pre>{JSON.stringify(definition[key], null, 2)}</pre>
          </details>
        ),
      )}
    </section>
  );
}
function Diagnostics() {
  const { diagnostics, select, selected } = useWorkflow();
  const [open, setOpen] = useState(false);
  const blocking = diagnostics.filter((d) => d.blocking).length;
  return (
    <section className="ep-wd-diagnostics" aria-label="Diagnostics">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        診断 {diagnostics.length} 件{blocking ? `（構造の問題 ${blocking}）` : ''}
      </button>
      {open && (
        <ul>
          {diagnostics.map((d, i) => (
            <li key={i} className={d.blocking ? 'ep-wd-blocking' : undefined}>
              <span className="ep-wd-source">{d.source === 'check' ? 'OWD の検査' : '構造'}</span>
              {d.target ? (
                <button
                  type="button"
                  aria-pressed={sameRef(selected, d.target)}
                  onClick={() => select(d.target)}
                >
                  {kindLabels[d.target.kind]} {d.target.id}
                </button>
              ) : (
                <span>定義全体</span>
              )}
              <span>{d.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
function Changes({ baseline }: { baseline: OwdDefinition }) {
  const { definition, select } = useWorkflow();
  const changes = workflowDefinitionDiff(baseline, definition);
  const words = { added: '追加', removed: '削除', changed: '変更', moved: '移動' };
  return (
    <section aria-label="Changes from the version">
      {changes.length === 0 ? (
        <p>版から変わっていません。</p>
      ) : (
        <ul className="ep-wd-changes">
          {changes.map((c, i) => (
            <li key={i}>
              <span className={`ep-wd-${c.change}`}>{words[c.change]}</span>
              {c.target ? (
                <button
                  type="button"
                  onClick={() => select(c.target)}
                  disabled={c.change === 'removed'}
                >
                  {kindLabels[c.target.kind]} {c.target.id}
                </button>
              ) : (
                <span>定義の {c.field}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
function Flow({
  binding,
  projection,
  error,
}: {
  binding: GraphBinding<OwdDefinition>;
  projection?: GraphProjection;
  error?: string;
}) {
  const { readOnly, selected, select } = useWorkflow();
  const [all, setAll] = useState(false),
    [notice, setNotice] = useState<string>();
  if (!projection) return <p role="alert">{error}</p>;
  const phasesOnly = projection.graph.nodes.filter((n) => n.type === 'phase').map((n) => n.id);
  return (
    <div className="ep-wd-flow">
      <label className="ep-wd-toggle">
        <input
          type="checkbox"
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
          aria-label="Show deliverables and acceptance"
        />
        成果物と条件も見る
      </label>
      {notice && (
        <p role="status" className="ep-wd-error">
          {notice}
        </p>
      )}
      <GraphSurface
        content={projection.graph}
        profile={projection.profile}
        stamp={projection.stamp}
        diagnostics={projection.diagnostics}
        readOnly={readOnly}
        locale="ja"
        initialView="fit"
        visibleNodeIds={all ? undefined : phasesOnly}
        visibleEdgeTypes={all ? undefined : ['after']}
        fitOnFilterChange
        toolbar={{ source: false, palette: false, addNode: false, addSection: false }}
        shapeOnCreate={false}
        sectionDrop={binding.sectionDrop}
        selectedId={selected && graphKinds.has(selected.kind) ? owdElementKey(selected) : undefined}
        select={(id) => {
          const ref = parseOwdElementKey(id);
          select(ref && graphKinds.has(ref.kind) ? ref : undefined);
        }}
        onError={setNotice}
        onEdit={(intents, base) => {
          try {
            binding.apply(intents, base);
            setNotice(undefined);
            return true;
          } catch (e) {
            setNotice(e instanceof Error ? e.message : String(e));
            return false;
          }
        }}
      />
    </div>
  );
}
/**
 * The workflow-definition Editor (design §3): flow, lists, matrices and the definition's fields
 * over one OWD JSON owned by the Host. It keeps no copy and no history of its own.
 */
export function WorkflowDefinitionSurface({
  binding,
  revision,
  check,
  baseline,
  initialTab = 'flow',
  mindmap,
  proposal,
  onProposal,
}: WorkflowDefinitionSurfaceProps) {
  const [notice, setNotice] = useState<string>();
  const [tab, setTab] = useState<Tab>(
      (initialTab === 'changes' && !baseline) || (initialTab === 'mindmap' && !mindmap)
        ? 'flow'
        : initialTab,
    ),
    [selected, select] = useState<OwdElementRef>();
  const source = binding.options.read();
  const { projection, error } = useMemo(() => {
    try {
      return { projection: binding.project(), error: undefined };
    } catch (e) {
      return { projection: undefined, error: e instanceof Error ? e.message : String(e) };
    }
    // The Host's revision covers the source and the sidecar.
  }, [binding, revision]);
  const diagnostics = useMemo(
    () => workflowDefinitionDiagnostics(source.content, check),
    [revision, check],
  );
  const context: WorkflowViewContext = {
    definition: source.content,
    readOnly: source.readOnly,
    selected,
    select,
    diagnostics,
    mindmap,
    notify: setNotice,
    edit: (intents: WorkflowDefinitionIntent[]) => {
      const latest = binding.options.read();
      try {
        const command = workflowDefinitionCommand(intents, {
          base: latest.content,
          readOnly: latest.readOnly,
        });
        const { commitWithPresentation, getPresentation, setPresentation } = binding.options;
        // A changed ID takes its saved place and frame along, in the same Undo record when the
        // Host can write both together.
        const moved = owdRenamedPresentation(getPresentation?.(), intents, !commitWithPresentation);
        if (moved && commitWithPresentation)
          commitWithPresentation({ command, presentation: moved, base: binding.project().stamp });
        else {
          binding.options.execute(command);
          if (moved) setPresentation?.(moved);
        }
        return undefined;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
  };
  const tabs: Tab[] = [
    'flow',
    'lists',
    'matrix',
    'info',
    ...(mindmap ? (['mindmap'] as const) : []),
    ...(baseline ? (['changes'] as const) : []),
  ];
  return (
    <WorkflowContext.Provider value={context}>
      <div className="ep-wd" data-read-only={source.readOnly || undefined}>
        <header className="ep-wd-header">
          <h2>{source.content.title || source.content.id}</h2>
          <span className="ep-wd-meta">
            {source.content.id}@{source.content.version}
            {source.readOnly ? '・読み取り専用' : ''}
          </span>
          <Diagnostics />
        </header>
        {notice && (
          <p role="alert" className="ep-wd-error ep-wd-notice">
            {notice}{' '}
            <button type="button" aria-label="Dismiss notice" onClick={() => setNotice(undefined)}>
              ×
            </button>
          </p>
        )}
        {proposal && <ProposalPanel proposal={proposal} resolve={(d) => onProposal?.(d)} />}
        <AddElement />
        <div role="tablist" aria-label="Workflow definition views" className="ep-wd-tabs">
          {tabs.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
            >
              {tabLabels[t]}
            </button>
          ))}
        </div>
        <div role="tabpanel" aria-label={tabLabels[tab]} className="ep-wd-panel">
          {tab === 'flow' && <Flow binding={binding} projection={projection} error={error} />}
          {tab === 'lists' && <WorkflowLists />}
          {tab === 'matrix' && <WorkflowMatrices />}
          {tab === 'info' && <Info />}
          {tab === 'mindmap' && <WorkflowMindmap />}
          {tab === 'changes' && baseline && <Changes baseline={baseline} />}
        </div>
      </div>
    </WorkflowContext.Provider>
  );
}
