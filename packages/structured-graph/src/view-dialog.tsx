import { type GraphDocument } from './model';
import { type GraphDeletion } from './view-model';

export function GraphDeletionDialog({
  graph,
  deletion,
  onConfirm,
  onCancel,
}: {
  graph: GraphDocument;
  deletion: GraphDeletion;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="ep-graph-dialog-backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Confirm graph deletion"
        className="ep-graph-dialog"
      >
        <h2>Delete node and related connections?</h2>
        <p>
          This atomically removes{' '}
          {graph.edges.filter((e) => e.from === deletion.id || e.to === deletion.id).length}{' '}
          connections. External sources may refuse protected references.
        </p>
        <button autoFocus onClick={onConfirm}>
          Confirm deletion
        </button>
        <button onClick={onCancel}>Cancel deletion</button>
      </section>
    </div>
  );
}
