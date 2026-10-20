import { type ContextType, type Dispatch, type SetStateAction } from 'react';
import { EditorInputsContext, Menu } from '@editor-platform/editor-ui';
import { type GraphSourceActions } from './definition';
import { type GraphEdge, type GraphNode, type Position } from './model';
import { type GraphProfile } from './profile';
import {
  errorMessage,
  zoomInStep,
  zoomOutStep,
  type GraphDefinitionTarget,
  type GraphScope,
} from './view-model';

interface GraphSourceMenuProps {
  profile: GraphProfile;
  sourceActions?: GraphSourceActions;
  node?: GraphNode;
  edge?: GraphEdge;
  id: string;
  scope: GraphScope;
  inputs: ContextType<typeof EditorInputsContext>;
  hasPendingInput: () => boolean;
  setDefinitionTarget: (target: GraphDefinitionTarget | undefined) => void;
  setError: (message: string) => void;
}

function GraphSourceMenu({
  profile,
  sourceActions,
  node,
  edge,
  id,
  scope,
  inputs,
  hasPendingInput,
  setDefinitionTarget,
  setError,
}: GraphSourceMenuProps) {
  const openSource = () => {
    if (sourceActions?.onOpenSource) sourceActions.onOpenSource(id);
    else {
      try {
        inputs?.flush();
        setDefinitionTarget(undefined);
      } catch (error) {
        setError(errorMessage(error));
      }
    }
  };
  const openDefinition = () => {
    if (sourceActions?.onOpenDefinition) sourceActions.onOpenDefinition(id);
    else {
      try {
        inputs?.flush();
        if (!inputs && hasPendingInput())
          throw new Error('属性・接続を適用するか、キャンセルしてから定義を開いてください。');
        setDefinitionTarget({
          scope,
          ...(node || edge ? { type: node?.type ?? edge?.type } : {}),
        });
      } catch (error) {
        setError(errorMessage(error));
      }
    }
  };
  return (
    <Menu label="Graph source and definitions">
      <p>
        所有元: {sourceActions?.owner ?? `Host Profile ${profile.id}`} ·{' '}
        {node?.type ?? edge?.type ?? profile.id}
      </p>
      <button onClick={openSource}>元データを開く</button>
      <button onClick={openDefinition}>データ定義</button>
    </Menu>
  );
}

export interface GraphToolbarProps extends GraphSourceMenuProps {
  readOnly: boolean;
  selectionReadOnly: boolean;
  nodeType: string;
  setNodeType: (type: string) => void;
  onAddNode: () => void;
  onGraphProperties: () => void;
  onDelete: () => void;
  zoom: number;
  setZoom: Dispatch<SetStateAction<number>>;
  setPan: Dispatch<SetStateAction<Position>>;
}

export function GraphToolbar(props: GraphToolbarProps) {
  const { readOnly, profile, node, edge, nodeType, setNodeType, zoom, setZoom, setPan } = props;
  return (
    <div className="ep-graph-toolbar" role="toolbar" aria-label="Graph tools">
      {!readOnly && (
        <>
          <GraphSourceMenu {...props} />
          <label>
            Node type
            <select
              aria-label="Node type"
              value={nodeType}
              onChange={(e) => setNodeType(e.target.value)}
              disabled={readOnly}
            >
              {Object.entries(profile.nodes).map(([key, t]) => (
                <option key={key} value={key}>
                  {t.ui?.label ?? key}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={readOnly || !nodeType || !!profile.nodes[nodeType]?.readOnly}
            onClick={props.onAddNode}
          >
            Add node
          </button>
          <button onClick={props.onGraphProperties}>Graph properties</button>
          <button
            disabled={readOnly || (!node && !edge) || props.selectionReadOnly}
            onClick={props.onDelete}
          >
            Delete selection
          </button>
        </>
      )}
      <button aria-label="Zoom out" onClick={() => setZoom(zoomOutStep)}>
        −
      </button>
      <output aria-label="Graph zoom">{Math.round(zoom * 100)}%</output>
      <button aria-label="Zoom in" onClick={() => setZoom(zoomInStep)}>
        +
      </button>
      <button
        onClick={() => {
          setZoom(1);
          setPan({ x: 0, y: 0 });
        }}
      >
        Reset view
      </button>
      <button aria-label="Pan left" onClick={() => setPan((p) => ({ ...p, x: p.x - 50 }))}>
        ←
      </button>
      <button aria-label="Pan right" onClick={() => setPan((p) => ({ ...p, x: p.x + 50 }))}>
        →
      </button>
    </div>
  );
}

export function GraphViewControls({
  setPan,
  onFit,
}: {
  setPan: Dispatch<SetStateAction<Position>>;
  onFit: () => void;
}) {
  return (
    <div className="ep-graph-view-controls">
      <button aria-label="Pan up" onClick={() => setPan((p) => ({ ...p, y: p.y - 50 }))}>
        ↑
      </button>
      <button aria-label="Pan down" onClick={() => setPan((p) => ({ ...p, y: p.y + 50 }))}>
        ↓
      </button>
      <button onClick={onFit}>Fit graph</button>
    </div>
  );
}
