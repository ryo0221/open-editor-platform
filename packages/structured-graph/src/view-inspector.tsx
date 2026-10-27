import { type ContextType, useEffect, useRef } from 'react';
import { EditorInputsContext } from '@editor-platform/editor-ui';
import { type GraphAttributeDraft } from './attribute-draft';
import { GraphAttributes } from './attributes';
import { GraphDefinitionEditor } from './definition-editor';
import { GraphNodeAppearance } from './view-appearance';
import { GraphNodeSectionField, GraphSectionPanel } from './view-sections';
import { type GraphSourceActions } from './definition';
import { formatGraphDiagnostic, type GraphLocale } from './diagnostics';
import {
  type Attributes,
  type GraphDiagnostic,
  type GraphDocument,
  type GraphEdge,
  type GraphNode,
  type GraphSection,
} from './model';
import { type GraphProfile, type GraphType } from './profile';
import {
  graphConnectionLabelField,
  type GraphConnectionInput,
  type GraphConnectionPatch,
} from './view-connection';
import {
  graphInspectorTitle,
  retainedDeletedDrafts,
  type GraphApply,
  type GraphDefinitionTarget,
  type GraphScope,
} from './view-model';

export interface GraphConnectionFormProps {
  graph: GraphDocument;
  profile: GraphProfile;
  edge?: GraphEdge;
  readOnly: boolean;
  label: (id: string) => string;
  connection: GraphConnectionInput;
  connectionStale: boolean;
  editConnection: (patch: GraphConnectionPatch) => void;
  resetConnection: () => void;
  onSubmitConnection: () => void;
}

function graphNodeOptions({ graph, label }: Pick<GraphConnectionFormProps, 'graph' | 'label'>) {
  return graph.nodes.map((n) => (
    <option key={n.id} value={n.id}>
      {label(n.id)}
    </option>
  ));
}

function GraphConnectionForm(props: GraphConnectionFormProps) {
  const { profile, edge, readOnly, connection, editConnection, resetConnection } = props;
  const { from, to, type: edgeType } = connection;
  const labelField = edge ? undefined : graphConnectionLabelField(profile, edgeType);
  // A disabled or removed input may never deliver compositionend.
  const labelGone = readOnly || !labelField;
  useEffect(() => {
    if (connection.composing && labelGone) editConnection({ composing: false });
  }, [connection.composing, labelGone]);
  // The form unmounts when the Host turns read-only; release the flag but keep the text.
  const latest = useRef({ composing: connection.composing, editConnection });
  latest.current = { composing: connection.composing, editConnection };
  useEffect(
    () => () => {
      if (latest.current.composing) latest.current.editConnection({ composing: false });
    },
    [],
  );
  return (
    <form
      aria-label="Connection editor"
      className="ep-graph-connection"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmitConnection();
      }}
    >
      <h3>{edge ? 'Retarget connection' : 'Connect nodes'}</h3>
      <label>
        Relation type
        <select
          aria-label="Relation type"
          disabled={readOnly || !!edge}
          value={edge?.type ?? edgeType}
          onChange={(e) => editConnection({ type: e.target.value })}
        >
          <option value="">Choose relation</option>
          {Object.entries(profile.edges).map(([key, t]) => (
            <option key={key} value={key}>
              {t.ui?.label ?? key}
            </option>
          ))}
        </select>
      </label>
      <label>
        From
        <select
          aria-label="Connection from"
          value={from}
          disabled={readOnly}
          onChange={(e) => editConnection({ from: e.target.value })}
        >
          <option value="">Choose node</option>
          {graphNodeOptions(props)}
        </select>
      </label>
      <label>
        To
        <select
          aria-label="Connection to"
          value={to}
          disabled={readOnly}
          onChange={(e) => editConnection({ to: e.target.value })}
        >
          <option value="">Choose node</option>
          {graphNodeOptions(props)}
        </select>
      </label>
      {labelField && (
        <label>
          Connection label
          <input
            aria-label="Connection label"
            value={connection.label}
            disabled={readOnly}
            maxLength={profile.edges[edgeType].schema[labelField].maxLength}
            onChange={(e) => editConnection({ label: e.target.value })}
            onCompositionStart={() => editConnection({ composing: true })}
            onCompositionEnd={(e) =>
              editConnection({ composing: false, label: e.currentTarget.value })
            }
          />
        </label>
      )}
      {edge && (
        <button
          type="button"
          onClick={() => {
            resetConnection();
          }}
        >
          Use selected connection
        </button>
      )}
      <button type="button" onClick={() => resetConnection()}>
        Cancel connection input
      </button>
      {props.connectionStale && (
        <p role="status">Connection input is stale. Reload current values.</p>
      )}
      <button type="button" onClick={() => resetConnection()}>
        Reload connection
      </button>
      <button
        disabled={
          readOnly ||
          !Object.keys(profile.edges).length ||
          !!(edge ? profile.edges[edge.type].readOnly : profile.edges[edgeType]?.readOnly)
        }
        type="submit"
      >
        {edge ? 'Retarget connection' : 'Add connection'}
      </button>
    </form>
  );
}

function GraphRetainedDrafts({
  drafts,
  graph,
  inputs,
  setError,
}: {
  drafts: Map<string, GraphAttributeDraft>;
  graph: GraphDocument;
  inputs: ContextType<typeof EditorInputsContext>;
  setError: (message: string) => void;
}) {
  return retainedDeletedDrafts(drafts, graph).map(([id, draft]) => (
    <details key={id}>
      <summary>削除された対象の未確定入力があります</summary>
      <textarea
        aria-label="Retained deleted Graph input"
        readOnly
        value={JSON.stringify(draft.values, null, 2)}
      />
      <button
        onClick={() => {
          drafts.delete(id);
          inputs?.changed();
          setError('');
        }}
      >
        Discard deleted Graph input
      </button>
    </details>
  ));
}

interface GraphOverviewProps {
  graph: GraphDocument;
  profile: GraphProfile;
  locale: GraphLocale;
  readOnly: boolean;
  problems: GraphDiagnostic[];
  label: (id: string) => string;
  choose: (id: string) => boolean;
}

function GraphOverview({
  graph,
  profile,
  locale,
  readOnly,
  problems,
  label,
  choose,
}: GraphOverviewProps) {
  return (
    <>
      <section aria-label="Graph diagnostics">
        <h3>Diagnostics ({problems.length})</h3>
        {problems.map((d, i) => (
          <button
            key={`${d.elementId}:${d.code}:${i}`}
            className="ep-graph-diagnostic"
            onClick={() => choose(d.elementId)}
          >
            {formatGraphDiagnostic(d, graph, profile, locale)}
          </button>
        ))}
      </section>
      <details>
        <summary>Nodes and connections</summary>
        {readOnly && <button onClick={() => choose(graph.id)}>Graph summary</button>}
        {graph.nodes.map((n) => (
          <button key={n.id} onClick={() => choose(n.id)}>
            {label(n.id)}
          </button>
        ))}
        {graph.edges.map((e) => (
          <button key={e.id} onClick={() => choose(e.id)}>
            {profile.edges[e.type]?.ui?.label ?? e.type}: {label(e.from)} → {label(e.to)}
          </button>
        ))}
      </details>
    </>
  );
}

export interface GraphInspectorProps extends GraphConnectionFormProps, GraphOverviewProps {
  showInspector: boolean;
  sourceActions?: GraphSourceActions;
  node?: GraphNode;
  id: string;
  scope: GraphScope;
  type: GraphType;
  attributes: Attributes;
  stamp: string;
  definitionTarget?: GraphDefinitionTarget;
  onCloseDefinition: () => void;
  apply: GraphApply;
  drafts: Map<string, GraphAttributeDraft>;
  inputs: ContextType<typeof EditorInputsContext>;
  setError: (message: string) => void;
  error: string;
  /** False when the source cannot save node shapes and styles. */
  shapeEditing: boolean;
  section?: GraphSection;
  sectionEditing: boolean;
  onFitSection?: () => void;
}

function GraphSelectionPanels(props: GraphInspectorProps) {
  const { graph, profile, locale, readOnly, type, id, problems } = props;
  return (
    <>
      <GraphAttributes
        key={id}
        attributes={props.attributes}
        schema={type.schema}
        ui={type.ui}
        scope={props.scope}
        id={id}
        stamp={props.stamp}
        readOnly={readOnly || !!type.readOnly}
        viewOnly={readOnly}
        onEdit={props.apply}
        diagnostics={problems
          .filter((d) => d.elementId === id)
          .map((diagnostic) => ({
            ...diagnostic,
            message: formatGraphDiagnostic(diagnostic, graph, profile, locale),
          }))}
        drafts={props.drafts}
      />
      {props.node && (
        <GraphNodeAppearance
          key={`appearance:${props.node.id}`}
          graph={graph}
          profile={profile}
          node={props.node}
          readOnly={readOnly}
          editable={props.shapeEditing}
          apply={props.apply}
        />
      )}
      {props.node && (
        <GraphNodeSectionField
          graph={graph}
          profile={profile}
          node={props.node}
          readOnly={readOnly || !props.sectionEditing}
          label={props.label}
          apply={props.apply}
        />
      )}
      {props.section && (
        <GraphSectionPanel
          key={`section:${props.section.id}`}
          graph={graph}
          profile={profile}
          section={props.section}
          readOnly={readOnly || !props.sectionEditing}
          label={props.label}
          apply={props.apply}
          choose={props.choose}
          onFit={props.onFitSection}
        />
      )}
      {!readOnly && <GraphConnectionForm {...props} />}
      {!readOnly && <GraphRetainedDrafts {...props} />}
      <GraphOverview {...props} />
    </>
  );
}

export function GraphInspector(props: GraphInspectorProps) {
  const { graph, profile, node, edge, readOnly, sourceActions, definitionTarget, label } = props;
  return (
    <aside
      className="ep-graph-inspector"
      aria-label="Graph Inspector"
      hidden={!props.showInspector}
    >
      <h2>{graphInspectorTitle(profile, label, node, edge, props.section)}</h2>
      <p className="ep-graph-source-owner">
        所有元: {sourceActions?.owner ?? `Host Profile ${profile.id}`} · 種類:{' '}
        {node?.type ?? edge?.type ?? props.section?.type ?? 'graph'}
      </p>
      {definitionTarget && (
        <div hidden={readOnly}>
          <GraphDefinitionEditor
            key={`${definitionTarget.scope}:${definitionTarget.type ?? ''}`}
            graph={graph}
            profile={profile}
            {...definitionTarget}
            host={sourceActions}
            readOnly={readOnly}
            onClose={props.onCloseDefinition}
          />
        </div>
      )}
      {(!definitionTarget || readOnly) && <GraphSelectionPanels {...props} />}
      {props.error && <p role="alert">{props.error}</p>}
    </aside>
  );
}
