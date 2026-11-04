import { graphNodeShapes, type GraphDocument, type GraphNode, type GraphNodeShape } from './model';
import { type GraphProfile } from './profile';
import { resolveGraphNodeLook } from './shape';
import { type GraphApply } from './view-model';
import { useGraphLabels } from './labels';

export const graphShapeLabels: Record<GraphNodeShape, string> = {
  rectangle: 'Rectangle',
  'rounded-rectangle': 'Rounded rectangle',
  ellipse: 'Ellipse',
  diamond: 'Diamond',
  cylinder: 'Cylinder',
  hexagon: 'Hexagon',
  cloud: 'Cloud',
};
/** The fill choices the Inspector offers. Saved styles may hold any validated hex colour. */
export const graphFillPalette = [
  { value: '#ffffff', label: 'White' },
  { value: '#e2e8f0', label: 'Grey' },
  { value: '#dbeafe', label: 'Blue' },
  { value: '#dcfce7', label: 'Green' },
  { value: '#fef3c7', label: 'Amber' },
  { value: '#fee2e2', label: 'Red' },
  { value: '#ede9fe', label: 'Violet' },
  { value: '#334155', label: 'Dark' },
] as const;

/** A shape choice where the empty value means "use the node type's default". */
export function GraphShapeSelect({
  value,
  typeDefault,
  label,
  disabled,
  onChange,
}: {
  value: GraphNodeShape | '';
  typeDefault: GraphNodeShape;
  label: string;
  disabled?: boolean;
  onChange: (shape: GraphNodeShape | '') => void;
}) {
  const t = useGraphLabels();
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as GraphNodeShape | '')}
    >
      <option value="">{t.typeDefaultShape(t.shapes[typeDefault])}</option>
      {graphNodeShapes.map((shape) => (
        <option key={shape} value={shape}>
          {t.shapes[shape]}
        </option>
      ))}
    </select>
  );
}

/**
 * Node shape and paint. Changes are presentation intents: they never touch the node's type,
 * attributes or connections, and each choice is one undoable edit.
 */
export function GraphNodeAppearance({
  graph,
  profile,
  node,
  readOnly,
  editable,
  apply,
}: {
  graph: GraphDocument;
  profile: GraphProfile;
  node: GraphNode;
  readOnly: boolean;
  editable: boolean;
  apply: GraphApply;
}) {
  const t = useGraphLabels();
  const look = resolveGraphNodeLook(graph, profile, node),
    saved = graph.presentation.nodes[node.id],
    ui = profile.nodes[node.type]?.ui,
    typeDefault = ui?.shape ?? 'rectangle';
  if (readOnly || !editable)
    return (
      <p className="ep-graph-appearance-summary">
        {t.shapeSummary(t.shapes[look.shape])}
        {!editable && !readOnly && t.shapeKeptByType}
      </p>
    );
  const disabled = !!profile.nodes[node.type]?.readOnly;
  const setStyle = (key: 'fill' | 'dash', value: string | number[] | undefined) => {
    const style = { ...saved?.style };
    if (value === undefined) delete style[key];
    else Object.assign(style, { [key]: value });
    apply([
      { type: 'set-node-style', id: node.id, style: Object.keys(style).length ? style : null },
    ]);
  };
  return (
    <fieldset className="ep-graph-appearance" aria-label="Node appearance">
      <legend>{t.appearance}</legend>
      <label>
        {t.shape}
        <GraphShapeSelect
          label="Node shape"
          value={saved?.shape ?? ''}
          typeDefault={typeDefault}
          disabled={disabled}
          onChange={(shape) =>
            apply([{ type: 'set-node-shape', id: node.id, shape: shape || null }])
          }
        />
      </label>
      <label>
        {t.fill}
        <select
          aria-label="Node fill"
          value={saved?.style?.fill ?? ''}
          disabled={disabled}
          onChange={(e) => setStyle('fill', e.target.value || undefined)}
        >
          <option value="">{t.typeDefault}</option>
          {saved?.style?.fill && !graphFillPalette.some((c) => c.value === saved.style!.fill) && (
            <option value={saved.style.fill}>{saved.style.fill}</option>
          )}
          {graphFillPalette.map((c) => (
            <option key={c.value} value={c.value}>
              {t.fills[c.value] ?? c.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t.outline}
        <select
          aria-label="Node outline"
          value={saved?.style?.dash ? (saved.style.dash.length ? 'dashed' : 'solid') : ''}
          disabled={disabled}
          onChange={(e) =>
            setStyle(
              'dash',
              e.target.value === 'dashed' ? [6, 4] : e.target.value === 'solid' ? [] : undefined,
            )
          }
        >
          <option value="">{t.typeDefault}</option>
          <option value="solid">{t.solid}</option>
          <option value="dashed">{t.dashed}</option>
        </select>
      </label>
    </fieldset>
  );
}
