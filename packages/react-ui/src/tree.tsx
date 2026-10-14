import { useState, type ReactNode } from 'react';
import {
  duplicateReactUiCommand,
  makeReactUiNode,
  reactUiInsertionProblem,
  reactUiCommand,
  reactUiParent,
  reactUiSubtree,
  reactComponentKey,
  type ReactUiDocument,
} from '@editor-platform/react-ui-core';
import type { EditorCommand } from '@editor-platform/editor-core';
export function ReactUiTree({
  document,
  selectedId,
  select,
  readOnly,
  execute,
}: {
  document: ReactUiDocument;
  selectedId?: string;
  select(id: string): void;
  readOnly: boolean;
  execute(command: EditorCommand<ReactUiDocument>): void;
}) {
  const [destination, setDestination] = useState('root');
  const [error, setError] = useState('');
  const node = document.nodes.find((n) => n.id === selectedId);
  const forbidden = new Set(node ? reactUiSubtree(document, node.id) : []);
  const targets = document.nodes.flatMap((n) => {
    const component = document.components.find(
      (c) => reactComponentKey(c.ref) === reactComponentKey(n.component),
    );
    return Object.keys(component?.slots ?? {}).map((slotId) => ({ nodeId: n.id, slotId }));
  });
  const parent =
    destination === 'root' ? null : (JSON.parse(destination) as { nodeId: string; slotId: string });
  const run = (command: EditorCommand<ReactUiDocument>) => {
    try {
      if (readOnly) throw new Error('Read only');
      execute(command);
      setError('');
    } catch (error) {
      setError(String(error));
    }
  };
  const render = (id: string, seen: Set<string> = new Set()): ReactNode => {
    const n = document.nodes.find((n) => n.id === id);
    if (!n || seen.has(id)) return null;
    const next = new Set([...seen, id]);
    return (
      <li key={id}>
        <button
          aria-pressed={selectedId === id}
          onClick={() => select(id)}
          draggable={!readOnly}
          onDragStart={(event) => event.dataTransfer.setData('application/x-react-ui-node', id)}
          onKeyDown={(event) => {
            if (event.key === 'Delete' && !readOnly) {
              event.stopPropagation();
              run(reactUiCommand([{ type: 'delete', nodeId: id }], 'Delete component subtree'));
            }
          }}
        >
          {id} · {n.component.componentId}
        </button>
        {Object.entries(n.slots).map(([slotId, children]) => (
          <div
            key={slotId}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const dragged = event.dataTransfer.getData('application/x-react-ui-node');
              if (dragged)
                run(
                  reactUiCommand(
                    [
                      {
                        type: 'move',
                        nodeId: dragged,
                        parent: { nodeId: id, slotId },
                        beforeId: null,
                      },
                    ],
                    'Move component to slot',
                  ),
                );
            }}
          >
            <small>{slotId}</small>
            <ul>{children.map((child) => render(child, next))}</ul>
          </div>
        ))}
      </li>
    );
  };
  return (
    <>
      <h3>Registered Library</h3>
      <label>
        Target slot
        <select
          aria-label="Target slot"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
        >
          <option value="root">Root</option>
          {targets.map((target) => (
            <option key={JSON.stringify(target)} value={JSON.stringify(target)}>
              {target.nodeId} / {target.slotId}
            </option>
          ))}
        </select>
      </label>
      {document.components.map((component, index) => {
        const problem = reactUiInsertionProblem(component);
        const description = `react-ui-insert-recovery-${index}`;
        return (
          <div key={reactComponentKey(component.ref)}>
            <button
              key={reactComponentKey(component.ref)}
              disabled={readOnly || !!problem}
              aria-describedby={problem ? description : undefined}
              onClick={() => {
                const inserted = makeReactUiNode(component);
                run(
                  reactUiCommand(
                    [{ type: 'insert', node: inserted, parent, beforeId: null }],
                    `Insert ${component.name}`,
                  ),
                );
                select(inserted.id);
              }}
            >
              Insert {component.name}
            </button>
            {problem && <p id={description}>{problem}</p>}
          </div>
        );
      })}
      <h3>Component tree</h3>
      <ul className="react-ui-tree">{document.roots.map((id) => render(id))}</ul>
      {node && (
        <>
          <button
            disabled={readOnly}
            onClick={() => run(duplicateReactUiCommand(document, node.id))}
          >
            Duplicate subtree
          </button>
          <button
            disabled={readOnly}
            onClick={() =>
              run(reactUiCommand([{ type: 'delete', nodeId: node.id }], 'Delete component subtree'))
            }
          >
            Delete subtree
          </button>
          <button
            disabled={readOnly || !!(parent && forbidden.has(parent.nodeId))}
            onClick={() =>
              run(
                reactUiCommand(
                  [{ type: 'move', nodeId: node.id, parent, beforeId: null }],
                  'Move component to slot',
                ),
              )
            }
          >
            Move to target slot
          </button>
          <small>Current: {JSON.stringify(reactUiParent(document, node.id))}</small>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
