import { useState, type PointerEvent } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import {
  graphLimits,
  graphSectionAncestors,
  graphSectionSubtree,
  type GraphDocument,
  type GraphNode,
  type GraphSection,
} from './model';
import { type GraphProfile } from './profile';
import { type GraphSectionBounds } from './commands';
import { graphLabelColor, resolveGraphSectionStyle } from './shape';
import { graphFillPalette } from './view-appearance';
import { type GraphApply, type GraphScene, type GraphSectionDrag } from './view-model';

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

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
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
        className={`ep-graph-section ${selected === section.id ? 'selected' : ''} ${isCollapsed ? 'collapsed' : ''}`}
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
  if (!Object.keys(profile.sections).length) return null;
  return (
    <label className="ep-graph-membership">
      Section
      <select
        aria-label="Node section"
        value={node.sectionId ?? ''}
        disabled={readOnly || !!profile.nodes[node.type]?.readOnly}
        onChange={(e) =>
          apply([{ type: 'set-node-section', id: node.id, sectionId: e.target.value || null }])
        }
      >
        <option value="">No section</option>
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
  const [confirming, setConfirming] = useState(false);
  const disabled = readOnly || !!profile.sections[section.type]?.readOnly,
    style = graph.presentation.sections[section.id].style,
    nodes = graph.nodes.filter((n) => n.sectionId === section.id),
    children = graph.sections.filter((s) => s.parentId === section.id),
    destination = section.parentId ? label(section.parentId) : 'the top level';
  return (
    <fieldset className="ep-graph-appearance" aria-label="Section settings">
      <legend>Section</legend>
      <p className="ep-graph-section-members">
        {count(nodes.length, 'node')} and {count(children.length, 'section')} inside
      </p>
      {onFit && (
        <button type="button" onClick={onFit}>
          Fit section
        </button>
      )}
      <label>
        Parent
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
          <option value="">No parent</option>
          {sectionOptions(graph, label, section.id).map((o) => (
            <option key={o.id} value={o.id}>
              {o.text}
            </option>
          ))}
        </select>
      </label>
      <label>
        Fill
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
          <option value="">Type default</option>
          {style?.fill && !graphFillPalette.some((c) => c.value === style.fill) && (
            <option value={style.fill}>{style.fill}</option>
          )}
          {graphFillPalette.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      {!disabled && !confirming && (
        <button onClick={() => setConfirming(true)}>Delete section</button>
      )}
      {!disabled && confirming && (
        <div role="group" aria-label="Confirm section deletion">
          <p>
            Deleting “{label(section.id)}” moves {count(nodes.length, 'node')} and{' '}
            {count(children.length, 'section')} to {destination}. Nodes and connections stay.
          </p>
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
              if (apply([{ type: 'delete-section', id: section.id }]))
                choose(section.parentId ?? graph.id);
            }}
          >
            Delete and move contents up
          </button>
          <button onClick={() => setConfirming(false)}>Cancel section deletion</button>
        </div>
      )}
    </fieldset>
  );
}
