import { type ContextType, type Dispatch, type SetStateAction } from 'react';
import { EditorInputsContext, Menu } from '@editor-platform/editor-ui';
import { type GraphSourceActions } from './definition';
import {
  type GraphEdge,
  type GraphNode,
  type GraphNodeShape,
  type GraphSection,
  type Position,
} from './model';
import { GraphShapeSelect } from './view-appearance';
import { GraphNodePalette } from './view-palette';
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
  section?: GraphSection;
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
  section,
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
          ...(node || edge || section ? { type: node?.type ?? edge?.type ?? section?.type } : {}),
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
        {node?.type ?? edge?.type ?? section?.type ?? profile.id}
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
  /** Absent when the source cannot save shapes; new nodes then use the type default. */
  nodeShape?: GraphNodeShape | '';
  setNodeShape?: (shape: GraphNodeShape | '') => void;
  onAddNode: () => void;
  /** Absent when the Profile has no Section types or the source cannot hold Sections. */
  sectionType?: string;
  setSectionType?: (type: string) => void;
  onAddSection?: () => void;
  onGraphProperties: () => void;
  onDelete: () => void;
  /** Adds one node of a type from the palette, inside `paletteInto` when it is set. */
  onPaletteAdd?: (type: string) => void;
  paletteInto?: string;
  onArrange?: () => void;
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
          {props.onPaletteAdd && (
            <GraphNodePalette
              profile={profile}
              into={props.paletteInto}
              onAdd={props.onPaletteAdd}
            />
          )}
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
          {props.setNodeShape && (
            <label>
              Shape
              <GraphShapeSelect
                label="New node shape"
                value={props.nodeShape ?? ''}
                typeDefault={profile.nodes[nodeType]?.ui?.shape ?? 'rectangle'}
                onChange={props.setNodeShape}
              />
            </label>
          )}
          <button
            disabled={readOnly || !nodeType || !!profile.nodes[nodeType]?.readOnly}
            onClick={props.onAddNode}
          >
            Add node
          </button>
          {props.onAddSection && props.setSectionType && (
            <>
              <label>
                Section type
                <select
                  aria-label="Section type"
                  value={props.sectionType}
                  onChange={(e) => props.setSectionType!(e.target.value)}
                >
                  {Object.entries(profile.sections).map(([key, t]) => (
                    <option key={key} value={key}>
                      {t.ui?.label ?? key}
                    </option>
                  ))}
                </select>
              </label>
              <button
                disabled={!props.sectionType || !!profile.sections[props.sectionType]?.readOnly}
                onClick={props.onAddSection}
              >
                {node ? 'Add section around node' : 'Add section'}
              </button>
            </>
          )}
          {props.onArrange && <button onClick={props.onArrange}>Arrange diagram</button>}
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
