import { useState, type PointerEvent } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import {
  graphLimits,
  graphSectionAncestors,
  graphSectionSubtree,
  type GraphDocument,
  type GraphEdge,
  type GraphNode,
  type GraphSection,
} from './model';
import { type GraphProfile } from './profile';
import { type GraphSectionBounds } from './commands';
import { graphLabelColor, resolveGraphSectionStyle } from './shape';
import { graphFillPalette } from './view-appearance';
import { useGraphLabels } from './labels';
import {
  type GraphApply,
  type GraphEndpointGesture,
  type GraphScene,
  type GraphSectionDrag,
} from './view-model';

export interface SectionDragHandlers {
  start(event: PointerEvent<HTMLElement>, id: string, mode: GraphSectionDrag['mode']): void;
  move(event: PointerEvent<HTMLElement>, commit?: boolean): void;
  cancel(): void;
}

/** Frame gestures: one move-section or resize-section on release; Escape or cancel changes nothing. */
export function createSectionDragHandlers(context: {
  drag?: GraphSectionDrag;
  setDrag: (drag: GraphSectionDrag | undefined) => void;
  readOnly: boolean;
  graph: GraphDocument;
  profile: GraphProfile;
  choose: (id: string) => boolean;
  stamp: string;
  zoom: number;
  apply: GraphApply;
}): SectionDragHandlers {
  const { drag, setDrag, readOnly, graph, profile, choose, stamp, zoom, apply } = context;
  return {
    start(event, id, mode) {
      const section = graph.sections.find((s) => s.id === id);
      if (event.button !== 0 || readOnly || !section || profile.sections[section.type]?.readOnly)
        return;
      event.preventDefault();
      event.stopPropagation();
      // Focus the handle so Escape reaches the canvas, not an attribute input that had focus.
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      if (!choose(id)) return;
      const { x, y, width, height } = graph.presentation.sections[id];
      const initial = { x, y, width, height };
      setDrag({
        id,
        mode,
        pointer: event.pointerId,
        start: { x: event.clientX, y: event.clientY },
        initial,
        bounds: initial,
        base: stamp,
      });
    },
    move(event, commit = false) {
      if (!drag || drag.pointer !== event.pointerId) return;
      const dx = (event.clientX - drag.start.x) / zoom,
        dy = (event.clientY - drag.start.y) / zoom,
        { initial } = drag;
      const bounds: GraphSectionBounds =
        drag.mode === 'move'
          ? { ...initial, x: initial.x + dx, y: initial.y + dy }
          : {
              ...initial,
              width: Math.max(graphLimits.sectionMinSize, initial.width + dx),
              height: Math.max(graphLimits.sectionMinSize, initial.height + dy),
            };
      if (!commit) {
        setDrag({ ...drag, bounds });
        return;
      }
      if (canonicalJson(bounds) !== canonicalJson(initial))
        apply(
          [
            drag.mode === 'move'
              ? { type: 'move-section', id: drag.id, position: { x: bounds.x, y: bounds.y } }
              : { type: 'resize-section', id: drag.id, bounds },
          ],
          drag.base,
        );
      setDrag(undefined);
    },
    cancel: () => setDrag(undefined),
  };
}

/** Section frames, parents first, drawn under nodes and connections. */
export function GraphSectionFrames({
  graph,
  profile,
  scene,
  selected,
  readOnly,
  collapsed,
  toggle,
  choose,
  handlers,
  edge,
  endpoint,
}: {
  graph: GraphDocument;
  profile: GraphProfile;
  scene: GraphScene;
  selected: string;
  readOnly: boolean;
  collapsed: ReadonlySet<string>;
  toggle: (id: string) => void;
  choose: (id: string) => boolean;
  handlers: SectionDragHandlers;
  /** The selected connection: a Section at either end is marked as connected (#594). */
  edge?: GraphEdge;
  /** A dragged connection end over a Section marks it as a valid or refused target. */
  endpoint?: GraphEndpointGesture;
}) {
  return scene.sections.order.map((section) => {
    const type = profile.sections[section.type],
      isCollapsed = collapsed.has(section.id),
      frame = scene.sections.collapsedBoxes[section.id] ?? scene.sections.frames[section.id],
      style = resolveGraphSectionStyle(graph, profile, section),
      name = scene.label(section.id),
      editable = !readOnly && !type?.readOnly,
      gesture = (mode: GraphSectionDrag['mode']) => ({
        onPointerDown: (event: PointerEvent<HTMLElement>) =>
          handlers.start(event, section.id, mode),
        onPointerMove: (event: PointerEvent<HTMLElement>) => handlers.move(event),
        onPointerUp: (event: PointerEvent<HTMLElement>) => handlers.move(event, true),
        onPointerCancel: () => handlers.cancel(),
        onLostPointerCapture: () => handlers.cancel(),
      });
    return (
      <div
        key={section.id}
        className={`ep-graph-section ${selected === section.id ? 'selected' : ''} ${isCollapsed ? 'collapsed' : ''} ${edge && (edge.from === section.id || edge.to === section.id) ? 'connected' : ''} ${endpoint?.target === section.id ? (endpoint.reason ? 'invalid-target' : 'valid-target') : ''}`}
        data-section-id={section.id}
        style={{
          left: frame.x,
          top: frame.y,
          width: frame.width,
          height: frame.height,
          ...(style.fill
            ? { '--ep-graph-section-fill': style.fill, color: graphLabelColor(style.fill) }
            : {}),
          ...(style.stroke ? { '--ep-graph-section-stroke': style.stroke } : {}),
          ...(style.dash?.length ? { '--ep-graph-section-border-style': 'dashed' } : {}),
        }}
      >
        <div className="ep-graph-section-header">
          <button
            className="ep-graph-section-toggle"
            aria-label={isCollapsed ? `Expand section ${name}` : `Collapse section ${name}`}
            aria-expanded={!isCollapsed}
            onClick={() => toggle(section.id)}
          >
            {isCollapsed ? '▸' : '▾'}
          </button>
          <button
            className="ep-graph-section-select"
            aria-label={`Select section ${name}`}
            title={name}
            onClick={() => choose(section.id)}
            {...(editable ? gesture('move') : {})}
          >
            {name}
            <small>{type?.ui?.label ?? section.type}</small>
          </button>
          {editable && (
            <button
              className="ep-graph-drag"
              aria-label={`Move section ${name}`}
              {...gesture('move')}
            >
              ↔
            </button>
          )}
        </div>
        {editable && !isCollapsed && (
          <button
            className="ep-graph-section-resize"
            aria-label={`Resize section ${name}`}
            {...gesture('resize')}
          />
        )}
      </div>
    );
  });
}

/** Sections a node or Section may move into, as labelled options. */
function sectionOptions(graph: GraphDocument, label: (id: string) => string, exclude?: string) {
  const blocked = exclude ? graphSectionSubtree(graph.sections, exclude) : new Set<string>();
  return graph.sections
    .filter((s) => !blocked.has(s.id))
    .map((s) => ({
      id: s.id,
      text: `${'— '.repeat(graphSectionAncestors(graph.sections, s.id)?.length ?? 0)}${label(s.id)}`,
    }));
}

/** Explicit node membership; the node's position never changes with it. */
export function GraphNodeSectionField({
  graph,
  profile,
  node,
  readOnly,
  label,
  apply,
}: {
  graph: GraphDocument;
  profile: GraphProfile;
  node: GraphNode;
  readOnly: boolean;
  label: (id: string) => string;
  apply: GraphApply;
}) {
  const t = useGraphLabels();
  if (!Object.keys(profile.sections).length) return null;
  return (
    <label className="ep-graph-membership">
      {t.section}
      <select
        aria-label="Node section"
        value={node.sectionId ?? ''}
        disabled={readOnly || !!profile.nodes[node.type]?.readOnly}
        onChange={(e) =>
          apply([{ type: 'set-node-section', id: node.id, sectionId: e.target.value || null }])
        }
      >
        <option value="">{t.noSection}</option>
        {sectionOptions(graph, label).map((o) => (
          <option key={o.id} value={o.id}>
            {o.text}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Parent, frame paint and deletion of the selected Section. */
export function GraphSectionPanel({
  graph,
  profile,
  section,
  readOnly,
  label,
  apply,
  choose,
  onFit,
}: {
  graph: GraphDocument;
  profile: GraphProfile;
  section: GraphSection;
  readOnly: boolean;
  label: (id: string) => string;
  apply: GraphApply;
  choose: (id: string) => boolean;
  /** Fits the camera to this Section's frame; a view change only. */
  onFit?: () => void;
}) {
  const t = useGraphLabels();
  const [confirming, setConfirming] = useState(false);
  const disabled = readOnly || !!profile.sections[section.type]?.readOnly,
    style = graph.presentation.sections[section.id].style,
    nodes = graph.nodes.filter((n) => n.sectionId === section.id),
    children = graph.sections.filter((s) => s.parentId === section.id),
    connections = graph.edges.filter((e) => e.from === section.id || e.to === section.id).length,
    destination = section.parentId ? label(section.parentId) : undefined;
  return (
    <fieldset className="ep-graph-appearance" aria-label="Section settings">
      <legend>{t.section}</legend>
      <p className="ep-graph-section-members">{t.sectionMembers(nodes.length, children.length)}</p>
      {onFit && (
        <button type="button" onClick={onFit}>
          {t.fitSection}
        </button>
      )}
      <label>
        {t.parent}
        <select
          aria-label="Parent section"
          value={section.parentId ?? ''}
          disabled={disabled}
          onChange={(e) =>
            apply([
              { type: 'set-section-parent', id: section.id, parentId: e.target.value || null },
            ])
          }
        >
          <option value="">{t.noParent}</option>
          {sectionOptions(graph, label, section.id).map((o) => (
            <option key={o.id} value={o.id}>
              {o.text}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t.fill}
        <select
          aria-label="Section fill"
          value={style?.fill ?? ''}
          disabled={disabled}
          onChange={(e) => {
            const next = { ...style };
            if (e.target.value) next.fill = e.target.value;
            else delete next.fill;
            apply([
              {
                type: 'set-section-style',
                id: section.id,
                style: Object.keys(next).length ? next : null,
              },
            ]);
          }}
        >
          <option value="">{t.typeDefault}</option>
          {style?.fill && !graphFillPalette.some((c) => c.value === style.fill) && (
            <option value={style.fill}>{style.fill}</option>
          )}
          {graphFillPalette.map((c) => (
            <option key={c.value} value={c.value}>
              {t.fills[c.value] ?? c.label}
            </option>
          ))}
        </select>
      </label>
      {!disabled && !confirming && (
        <button onClick={() => setConfirming(true)}>{t.deleteSection}</button>
      )}
      {!disabled && confirming && (
        <div role="group" aria-label="Confirm section deletion">
          <p>
            {t.deleteSectionConfirm(label(section.id), nodes.length, children.length, destination)}
          </p>
          {connections > 0 && <p>{t.deleteSectionConnections(connections)}</p>}
          {[...nodes, ...children].length > 0 && (
            <ul>
              {nodes.map((n) => (
                <li key={n.id}>{label(n.id)}</li>
              ))}
              {children.map((s) => (
                <li key={s.id}>{label(s.id)}</li>
              ))}
            </ul>
          )}
          <button
            onClick={() => {
              // The confirmation names the connections that end at the Section (#594).
              if (apply([{ type: 'delete-section', id: section.id, cascade: true }]))
                choose(section.parentId ?? graph.id);
            }}
          >
            {t.deleteSectionApply}
          </button>
          <button onClick={() => setConfirming(false)}>{t.cancelSectionDeletion}</button>
        </div>
      )}
    </fieldset>
  );
}
