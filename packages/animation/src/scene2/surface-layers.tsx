import type {
  AnimationAction2,
  AnimationContent2,
  Composition2 as AnimationComposition2,
  Layer2 as AnimationLayer2,
} from '@editor-platform/animation-core/v2';

export type AnimationRemovalPlan2 = {
  base: AnimationContent2;
  ids: string[];
  names: string[];
  tracks: number;
  keys: number;
  inputs: number;
};

type LayerToggle = 'visible' | 'locked' | 'maskOnly';

export function AnimationLayerList2({
  composition,
  selection,
  pending,
  onSelect,
}: {
  composition: AnimationComposition2;
  selection: string[];
  pending: boolean;
  onSelect(ids: string[]): void;
}) {
  return (
    <nav aria-label="Animation layers">
      <h3>Layers</h3>
      {composition.layers.map((l) => (
        <label className="a2-layer" key={l.id} data-layer-id={l.id}>
          <input
            type="checkbox"
            aria-label={`Select ${l.name}`}
            checked={selection.includes(l.id)}
            disabled={pending}
            onChange={(e) =>
              onSelect(
                e.target.checked ? [...selection, l.id] : selection.filter((id) => id !== l.id),
              )
            }
          />
          <button
            disabled={pending}
            aria-label={`${l.type} ${l.name}`}
            aria-pressed={selection.includes(l.id)}
            onClick={() => onSelect([l.id])}
          >
            {l.name}
            {l.locked ? ' 🔒' : ''}
            {!l.visible ? ' (hidden)' : ''}
          </button>
        </label>
      ))}
    </nav>
  );
}

function MotionButtons({
  composition: c,
  layer,
  disabled,
  actions,
}: {
  composition: AnimationComposition2;
  layer: AnimationLayer2 | undefined;
  disabled: boolean;
  actions(values: AnimationAction2[]): void;
}) {
  return (
    <>
      <button
        disabled={disabled || !layer}
        onClick={() =>
          actions([
            {
              type: 'layer.patch',
              compositionId: c.id,
              id: layer!.id,
              patch: {
                motion: layer!.motion
                  ? null
                  : {
                      path: [
                        ['M', 0, 0],
                        ['C', 40, -80, 160, -80, 200, 0],
                      ],
                      start: 0,
                      end: c.duration,
                      orient: false,
                    },
              },
            },
          ])
        }
      >
        {layer?.motion ? 'Remove motion path' : 'Add motion path'}
      </button>
      {layer?.motion && (
        <button
          disabled={disabled}
          onClick={() =>
            actions([
              {
                type: 'layer.patch',
                compositionId: c.id,
                id: layer.id,
                patch: { motion: { ...layer.motion, orient: !layer.motion!.orient } },
              },
            ])
          }
        >
          Toggle path orientation
        </button>
      )}
    </>
  );
}

function ClipMaskSelect({
  composition: c,
  layer,
  disabled,
  actions,
}: {
  composition: AnimationComposition2;
  layer: AnimationLayer2 | undefined;
  disabled: boolean;
  actions(values: AnimationAction2[]): void;
}) {
  return (
    <label>
      Clip mask
      <select
        aria-label="Clip mask"
        disabled={disabled || !layer}
        value={layer?.clipId ?? ''}
        onChange={(e) =>
          actions([
            {
              type: 'layer.patch',
              compositionId: c.id,
              id: layer!.id,
              patch: { clipId: e.target.value || null },
            },
          ])
        }
      >
        <option value="">None</option>
        {c.layers
          .filter((l) => l.id !== layer?.id && ['rect', 'path'].includes(l.type))
          .map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
      </select>
    </label>
  );
}

export function AnimationLayerActions2({
  composition: c,
  layer,
  selectionCount,
  disabled,
  onDuplicate,
  onReviewDelete,
  onReorder,
  onToggle,
  onGroup,
  onNest,
  onUnnest,
  actions,
}: {
  composition: AnimationComposition2;
  layer: AnimationLayer2 | undefined;
  selectionCount: number;
  disabled: boolean;
  onDuplicate(): void;
  onReviewDelete(): void;
  onReorder(direction: -1 | 1): void;
  onToggle(property: LayerToggle): void;
  onGroup(): void;
  onNest(): void;
  onUnnest(): void;
  actions(values: AnimationAction2[]): void;
}) {
  const none = disabled || !selectionCount;
  const notOne = disabled || selectionCount !== 1;
  return (
    <div className="a2-actions">
      <button disabled={none} onClick={onDuplicate}>
        Duplicate layers
      </button>
      <button disabled={none} onClick={onReviewDelete}>
        Delete layers…
      </button>
      <button disabled={notOne} onClick={() => onReorder(-1)}>
        Move backward
      </button>
      <button disabled={notOne} onClick={() => onReorder(1)}>
        Move forward
      </button>
      <button disabled={disabled || !layer} onClick={() => onToggle('visible')}>
        {layer?.visible ? 'Hide layer' : 'Show layer'}
      </button>
      <button disabled={disabled || !layer} onClick={() => onToggle('locked')}>
        {layer?.locked ? 'Unlock layer' : 'Lock layer'}
      </button>
      <button
        disabled={disabled || !layer || !['rect', 'path'].includes(layer.type)}
        onClick={() => onToggle('maskOnly')}
      >
        Toggle mask-only
      </button>
      <button disabled={none} onClick={onGroup}>
        Group layers
      </button>
      <button disabled={none} onClick={onNest}>
        Nest layers
      </button>
      <button disabled={disabled || layer?.type !== 'composition'} onClick={onUnnest}>
        Unnest layer
      </button>
      <ClipMaskSelect composition={c} layer={layer} disabled={disabled} actions={actions} />
      <MotionButtons composition={c} layer={layer} disabled={disabled} actions={actions} />
    </div>
  );
}

export function AnimationRemovalConfirmation2({
  removal,
  stale,
  disabled,
  onConfirm,
  onCancel,
}: {
  removal: AnimationRemovalPlan2;
  stale: boolean;
  disabled: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <fieldset>
      <legend>Delete layer confirmation</legend>
      <p>
        Delete {removal.names.length} layers, {removal.tracks} tracks and {removal.keys} keys?
      </p>
      {!!removal.inputs && <p>{removal.inputs} public inputs will also be removed.</p>}
      <ul>
        {removal.names.map((name, i) => (
          <li key={i}>{name}</li>
        ))}
      </ul>
      {stale && <p>Animation changed. Cancel and review the layers again.</p>}
      <button disabled={disabled || stale} onClick={onConfirm}>
        Confirm layer deletion
      </button>
      <button onClick={onCancel}>Cancel layer deletion</button>
    </fieldset>
  );
}
