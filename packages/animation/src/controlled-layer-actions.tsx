import { useState } from 'react';
import {
  inspectAnimationLayerSubtreeV1,
  duplicateAnimationLayerV1,
  removeAnimationLayerV1,
  readAnimationV1,
  type AnimationContent,
  type AnimationLayerSubtreeV1,
} from '@editor-platform/animation-core';
import { sameLocalRevision } from '@editor-platform/editor-core';
import type {
  ControlledSurfaceController,
  ControlledSurfaceSnapshot,
  PreparedSurfaceCommand,
} from '@editor-platform/extension-contract/controlled-surface';

type OpenView = Extract<ControlledSurfaceSnapshot<AnimationContent>, { state: 'open' }>;
interface Props {
  editor: ControlledSurfaceController<AnimationContent>;
  view: OpenView;
  compositionId: string;
  layerId?: string;
  pending: boolean;
  selectLayer(id: string): void;
  report(message: string): void;
}

/** Local layer operations use the same Host authority/history boundary as transform edits. */
export function ControlledLayerActions({
  editor,
  view,
  compositionId,
  layerId,
  pending,
  selectLayer,
  report,
}: Props) {
  const [removal, setRemoval] = useState<{
    snapshot: OpenView['snapshot'];
    plan: AnimationLayerSubtreeV1;
  } | null>(null);
  const disabled = !view.canEdit || view.saving || pending || !layerId;
  const scope = {
    canEdit: () => {
      const current = editor.getSnapshot();
      return current.state === 'open' && current.canEdit && !current.saving;
    },
  };
  function perform(prepared: PreparedSurfaceCommand<AnimationContent>, selected: string) {
    if (disabled || !scope.canEdit()) return;
    const result = editor.execute(prepared);
    report(result.state === 'refused' ? `${result.code}: ${result.message}` : result.state);
    if (result.state === 'applied') {
      setRemoval(null);
      selectLayer(selected);
    }
  }
  function duplicate() {
    if (disabled || !layerId) return;
    try {
      const current = editor.getSnapshot();
      if (current.state !== 'open') return;
      const plan = inspectAnimationLayerSubtreeV1(current.snapshot.content, compositionId, layerId);
      const ids = [...plan.layerIds, ...plan.trackIds, ...plan.keyIds].map((sourceId) => ({
        sourceId,
        id: crypto.randomUUID(),
      }));
      perform(
        {
          baseRevision: current.snapshot.revision,
          command: duplicateAnimationLayerV1(
            current.snapshot.content,
            compositionId,
            layerId,
            ids,
            scope,
          ),
        },
        ids.find((entry) => entry.sourceId === layerId)!.id,
      );
    } catch (error) {
      report(String(error));
    }
  }
  function reviewRemoval() {
    if (disabled || !layerId) return;
    try {
      const current = editor.getSnapshot();
      if (current.state !== 'open') return;
      const content = readAnimationV1(current.snapshot.content);
      setRemoval({
        snapshot: { ...current.snapshot, content },
        plan: inspectAnimationLayerSubtreeV1(content, compositionId, layerId),
      });
    } catch (error) {
      report(String(error));
    }
  }
  function confirmRemoval() {
    if (disabled || !removal || !layerId) return;
    try {
      perform(
        {
          baseRevision: removal.snapshot.revision,
          command: removeAnimationLayerV1(removal.snapshot.content, compositionId, layerId, scope),
        },
        '',
      );
    } catch (error) {
      report(String(error));
    }
  }
  const stale = removal && !sameLocalRevision(removal.snapshot.revision, view.snapshot.revision);
  return (
    <div className="ac-layer-actions">
      <div className="ac-actions">
        <button disabled={disabled || !!removal} onClick={duplicate}>
          Duplicate selected layer
        </button>
        <button disabled={disabled || !!removal} onClick={reviewRemoval}>
          Delete selected layer…
        </button>
      </div>
      {removal && (
        <fieldset>
          <legend>Delete layer confirmation</legend>
          <p>
            Delete {removal.plan.layerIds.length} layers, {removal.plan.trackIds.length} tracks and{' '}
            {removal.plan.keyIds.length} keys? Undo restores them together.
          </p>
          <ul>
            {removal.plan.layerIds.map((id) => (
              <li key={id}>{id}</li>
            ))}
          </ul>
          {stale && <p role="status">Animation changed. Cancel and review the layers again.</p>}
          <div className="ac-actions">
            <button disabled={disabled || !!stale} onClick={confirmRemoval}>
              Confirm layer deletion
            </button>
            <button onClick={() => setRemoval(null)}>Cancel layer deletion</button>
          </div>
        </fieldset>
      )}
    </div>
  );
}
