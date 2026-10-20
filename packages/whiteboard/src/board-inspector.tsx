import {
  ReferenceInspector,
  type ReferenceSurfaceProps,
} from '@editor-platform/artifact-references/react';
import { unionBounds, type Bounds, type EditorCommand } from '@editor-platform/editor-core';
import { Section, CommitInput } from '@editor-platform/editor-ui';
import { VisualInspector, readImage } from '@editor-platform/canvas-ui';
import {
  patchNodes,
  updateConnector,
  whiteboardDrawing,
  type WhiteboardContent,
  type WhiteboardConnector,
  type WhiteboardNode,
  type WhiteboardSection,
} from './model';
import {
  updateSection,
  dissolveSection,
  assignSection,
  transformBoardCommand,
  sectionMembers,
  nodeSection,
} from './sections';
import { WhiteboardPortsEditor } from './ports';

type Apply = (cmd: EditorCommand<WhiteboardContent>) => boolean;
export interface BoardInspectorProps {
  content: WhiteboardContent;
  nodes: Map<string, { node: WhiteboardNode; index: number }>;
  ids: string[];
  chosen: WhiteboardNode[];
  connector?: WhiteboardConnector;
  selectedSection?: WhiteboardSection;
  references: ReferenceSurfaceProps['references'];
  readOnly: boolean;
  apply: Apply;
  setError: (message: string) => void;
  onDeleteConnector: () => void;
  onExportSection: () => void;
}

export function BoardInspector(props: BoardInspectorProps) {
  const { content, ids, chosen, connector, selectedSection, readOnly, apply } = props;
  return (
    <>
      <ReferenceInspector
        item={content.nodes.find((n) => ids.length === 1 && n.id === ids[0])}
        resolver={props.references}
        readOnly={readOnly}
        patch={(patch) =>
          apply(
            patchNodes(ids, {
              ...patch,
              imageFit: (patch.reference ?? chosen[0]?.reference)?.fit === 'cover' ? 'fill' : 'fit',
            }),
          )
        }
      />
      <fieldset disabled={readOnly} className="inspector-fields">
        {selectedSection ? (
          <SectionInspector {...props} section={selectedSection} />
        ) : connector ? (
          <ConnectorInspector {...props} connector={connector} />
        ) : (
          <NodeInspector {...props} />
        )}
        {!connector && <NodeRelations {...props} />}
        {!connector && !chosen.length && !selectedSection && (
          <p>
            Insert shapes, connect two selected nodes, or draw with the pen. Space pans temporarily;
            Ctrl/⌘ + wheel zooms at the pointer.
          </p>
        )}
      </fieldset>
    </>
  );
}

function SectionInspector({
  content,
  section,
  apply,
  onExportSection,
}: BoardInspectorProps & { section: WhiteboardSection }) {
  return (
    <Section title="Section">
      <CommitInput
        label="Section title"
        value={section.title}
        onCommit={(title) => apply(updateSection(section.id, { title }))}
      />
      <label className="ep-field">
        Section background
        <input
          type="color"
          aria-label="Section background"
          value={section.background}
          onChange={(e) => apply(updateSection(section.id, { background: e.target.value }))}
        />
      </label>
      {(['x', 'y', 'width', 'height'] as const).map((key) => (
        <CommitInput
          key={key}
          label={`Section ${key}`}
          value={section.bounds[key]}
          type="number"
          min={key === 'width' || key === 'height' ? 40 : undefined}
          onCommit={(v) =>
            apply(
              transformBoardCommand([section.id], {
                dx: key === 'x' ? Number(v) - section.bounds.x : 0,
                dy: key === 'y' ? Number(v) - section.bounds.y : 0,
                dw: key === 'width' ? Number(v) - section.bounds.width : 0,
                dh: key === 'height' ? Number(v) - section.bounds.height : 0,
              }),
            )
          }
        />
      ))}
      <p>{sectionMembers(content, section.id).length} members · no clipping</p>
      <button onClick={() => apply(dissolveSection(section.id))}>Dissolve Section</button>
      <button onClick={() => apply(dissolveSection(section.id, true))}>
        Delete Section and contents
      </button>
      <button onClick={onExportSection}>Export Section SVG</button>
    </Section>
  );
}

function ConnectorInspector(props: BoardInspectorProps & { connector: WhiteboardConnector }) {
  const { connector, apply } = props;
  const edit = (patch: Partial<WhiteboardConnector>) => apply(updateConnector(connector.id, patch));
  return (
    <>
      <Section title="Connector">
        <CommitInput
          label="Connector label"
          value={connector.label}
          onCommit={(label) => edit({ label })}
        />
        <label className="ep-field">
          Routing
          <select
            aria-label="Connector routing"
            value={connector.routing ?? 'straight'}
            onChange={(e) => edit({ routing: e.target.value as WhiteboardConnector['routing'] })}
          >
            {['straight', 'elbow', 'curve'].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <CommitInput
          label="Connector stroke"
          value={connector.stroke ?? '#637187'}
          onCommit={(stroke) => edit({ stroke })}
        />
        <CommitInput
          label="Connector width (px)"
          type="number"
          min={1}
          value={connector.strokeWidth ?? 2}
          onCommit={(v) => edit({ strokeWidth: Number(v) })}
        />
        <label className="ep-field">
          Arrowheads
          <select
            aria-label="Connector arrowheads"
            value={connector.arrowhead ?? 'end'}
            onChange={(e) =>
              edit({ arrowhead: e.target.value as WhiteboardConnector['arrowhead'] })
            }
          >
            {['none', 'end', 'both'].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        {(['from', 'to'] as const).map((side) => (
          <ConnectorEndpointFields key={side} {...props} side={side} edit={edit} />
        ))}
        <button onClick={props.onDeleteConnector}>Delete connector</button>
        <p className="hint">
          Drag an endpoint onto a node edge to attach it. Dropping on empty space makes it a free
          endpoint. Deleting a connected node removes incident connectors; Undo restores them.
        </p>
      </Section>
    </>
  );
}

function ConnectorEndpointFields({
  content,
  nodes,
  connector,
  side,
  edit,
}: BoardInspectorProps & {
  connector: WhiteboardConnector;
  side: 'from' | 'to';
  edit: (patch: Partial<WhiteboardConnector>) => boolean;
}) {
  return (
    <div>
      <label className="ep-field">
        {side} node
        <select
          aria-label={`${side} node`}
          value={connector[side]}
          onChange={(e) =>
            edit({
              [side]: e.target.value,
              [`${side}Port`]: 'auto',
              [`${side}Point`]: { x: 0, y: 0 },
            })
          }
        >
          <option value="">Free endpoint</option>
          {content.nodes
            .filter((n) => n.kind !== 'freehand')
            .map((n, i) => (
              <option key={n.id} value={n.id}>
                {n.name || `${n.kind} ${i + 1}`}
              </option>
            ))}
        </select>
      </label>
      <label className="ep-field">
        {side} port
        <select
          aria-label={`${side} port`}
          value={connector[`${side}Port`] ?? 'auto'}
          onChange={(e) => edit({ [`${side}Port`]: e.target.value })}
        >
          {['auto', 'top', 'right', 'bottom', 'left'].map((v) => (
            <option key={v}>{v}</option>
          ))}
          {nodes.get(connector[side])?.node.ports?.map((port) => (
            <option key={port.key} value={port.key}>
              {port.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function NodeInspector({ ids, chosen, apply, setError }: BoardInspectorProps) {
  const geometry = (patch: Partial<Bounds>) => {
    const box = unionBounds(chosen.map((n) => n.bounds));
    apply(
      transformBoardCommand(ids, {
        dx: patch.x === undefined ? 0 : patch.x - box.x,
        dy: patch.y === undefined ? 0 : patch.y - box.y,
        dw: patch.width === undefined ? 0 : patch.width - box.width,
        dh: patch.height === undefined ? 0 : patch.height - box.height,
      }),
    );
  };
  return (
    <VisualInspector
      items={chosen.map(whiteboardDrawing)}
      onGeometry={geometry}
      onPatch={({ fill, ...patch }) =>
        apply(patchNodes(ids, { ...patch, ...(fill ? { color: fill } : {}) }))
      }
      onReplace={(file) => {
        void readImage(file)
          .then((src) => apply(patchNodes(ids, { src, reference: undefined })))
          .catch((e) => setError(String(e)));
      }}
    />
  );
}

/** Section membership and ports for selected objects (not shown for connectors). */
function NodeRelations({ content, ids, chosen, apply }: BoardInspectorProps) {
  if (!chosen.length) return null;
  const node = chosen[0];
  return (
    <>
      <Section title="Membership">
        <label className="ep-field">
          Section
          <select
            aria-label="Object Section"
            value={nodeSection(content, node) ?? ''}
            onChange={(e) => apply(assignSection(ids, e.target.value || undefined))}
          >
            <option value="">Outside Sections</option>
            {content.sections?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </label>
      </Section>
      {chosen.length === 1 && (
        <WhiteboardPortsEditor
          ports={node.ports}
          used={content.connectors.flatMap((c) =>
            [
              c.from === node.id ? c.fromPort : undefined,
              c.to === node.id ? c.toPort : undefined,
            ].filter((p): p is string => !!p),
          )}
          onChange={(ports) => apply(patchNodes([node.id], { ports }))}
        />
      )}
    </>
  );
}
