import { type GraphDocument } from './model';
import { type GraphDeletion } from './view-model';
import { useGraphLabels } from './labels';

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
  const t = useGraphLabels();
  return (
    <div className="ep-graph-dialog-backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Confirm graph deletion"
        className="ep-graph-dialog"
      >
        <h2>{t.deleteNodeTitle}</h2>
        <p>
          {t.deleteNodeBody(
            graph.edges.filter((e) => e.from === deletion.id || e.to === deletion.id).length,
          )}
        </p>
        <button autoFocus onClick={onConfirm}>
          {t.confirmDeletion}
        </button>
        <button onClick={onCancel}>{t.cancelDeletion}</button>
      </section>
    </div>
  );
}
