import {
  characterIds,
  freshCharacterId,
  type CharacterDocument,
  type CharacterMorph,
  type CharacterOperation,
} from '@editor-platform/character-core';
import { CommitInput, Section } from '@editor-platform/editor-ui';
import { useEffect, useRef, useState } from 'react';
import { Field } from './pose-inspector';

/**
 * The edit that gives a morph `weight` (C6a): keyed at `tick` when an action is chosen, else its
 * weight when no action drives it. A slider's drag previews this same edit. Undefined when the
 * morph is gone (an edit or Undo removed it) or the action is.
 */
export function morphWeightOperation(
  doc: CharacterDocument,
  morphId: string,
  weight: number,
  actionId: string | undefined,
  tick: number,
): CharacterOperation | undefined {
  if (!doc.morphs.some((m) => m.id === morphId)) return undefined;
  if (actionId === undefined) return { type: 'setMorphWeight', id: morphId, weight };
  if (!doc.actions.some((a) => a.id === actionId)) return undefined;
  const taken = characterIds(doc);
  const trackId = freshCharacterId(doc, `${actionId}/${morphId}/weight`, taken);
  taken.add(trackId);
  return {
    type: 'setKey',
    actionId,
    target: { kind: 'morph', id: morphId, property: 'weight' },
    tick,
    value: weight,
    trackId,
    keyId: freshCharacterId(doc, `${trackId}#${tick}`, taken),
  };
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/**
 * The morphs of one part (C6a): add one (all deltas zero), rename, remove, and a weight slider.
 * The weight shown is the one at the playhead; a change keys it there when an action is chosen,
 * else sets the weight used without one. A slider drag previews and is one edit when let go.
 */
export function MorphInspector({
  partName,
  morphs,
  structureEditable,
  weightEditable,
  reason,
  keying,
  onAdd,
  onRename,
  onRemove,
  onEditShape,
  onWeight,
  onPreview,
}: {
  partName: string;
  morphs: { morph: CharacterMorph; weight: number }[];
  /** Adding, renaming and removing (the mesh changes). */
  structureEditable: boolean;
  weightEditable: boolean;
  /** Why the weights cannot change, when they cannot. */
  reason: string;
  /** True when a weight change keys the action at the playhead. */
  keying: boolean;
  onAdd(): void;
  onRename(id: string, name: string): boolean | void;
  onRemove(id: string): void;
  /** C6b: edit the morph's shape by moving the part's vertices. */
  onEditShape(id: string): void;
  onWeight(id: string, weight: number): boolean | void;
  onPreview(drag: { id: string; weight: number } | undefined): void;
}) {
  const [drag, setDrag] = useState<{ id: string; weight: number }>();
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const move = (id: string, weight: number) => {
    const d = { id, weight };
    setDrag(d);
    onPreview(d);
  };
  // Taken away mid-drag (another part chosen, playback started): the preview goes with it.
  const preview = useRef(onPreview);
  preview.current = onPreview;
  useEffect(
    () => () => {
      if (dragRef.current) preview.current(undefined);
    },
    [],
  );
  useEffect(() => {
    if (weightEditable || !dragRef.current) return;
    setDrag(undefined);
    preview.current(undefined);
  }, [weightEditable]);
  const release = () => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = undefined;
    setDrag(undefined);
    onPreview(undefined);
    const was = morphs.find((m) => m.morph.id === d.id)?.weight;
    if (was !== d.weight) onWeight(d.id, d.weight);
  };
  // A pointer let go outside the slider ends the drag too.
  const releaseRef = useRef(release);
  releaseRef.current = release;
  const dragging = !!drag;
  useEffect(() => {
    if (!dragging) return;
    const up = () => releaseRef.current();
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [dragging]);
  return (
    <Section title={`Morphs · ${partName}`}>
      {!weightEditable && morphs.length > 0 && <p className="character-hint">{reason}</p>}
      {weightEditable && morphs.length > 0 && (
        <p className="character-hint">
          {keying ? 'A change keys the weight at the playhead.' : 'Weights used without an action.'}
        </p>
      )}
      {morphs.map(({ morph, weight }) => {
        const shown = drag?.id === morph.id ? drag.weight : weight;
        return (
          <fieldset key={morph.id} className="character-fields" aria-label={`Morph ${morph.name}`}>
            <legend>{morph.name}</legend>
            {structureEditable && (
              <CommitInput
                label={`Name of ${morph.name}`}
                value={morph.name}
                onCommit={(name) => onRename(morph.id, name)}
              />
            )}
            <label className="character-field character-name-field">
              <span>Weight</span>
              <input
                type="range"
                aria-label={`Weight of ${morph.name}`}
                min={0}
                max={1}
                step={0.01}
                value={Math.min(1, Math.max(0, shown))}
                disabled={!weightEditable}
                onChange={(e) => move(morph.id, Number(e.target.value))}
                onPointerUp={release}
                onKeyUp={release}
                onBlur={release}
              />
            </label>
            <Field
              label={`Weight value of ${morph.name}`}
              unit=""
              value={round(shown)}
              disabled={!weightEditable}
              onCommit={(w) => onWeight(morph.id, w)}
            />
            {structureEditable && (
              <div className="character-mesh-row">
                <button type="button" onClick={() => onEditShape(morph.id)}>
                  Edit shape
                </button>
                <button type="button" onClick={() => onRemove(morph.id)}>
                  Remove morph
                </button>
              </div>
            )}
          </fieldset>
        );
      })}
      {!morphs.length && <p className="character-hint">No morphs.</p>}
      {structureEditable && (
        <div className="character-mesh-row">
          <button type="button" onClick={onAdd}>
            Add morph
          </button>
        </div>
      )}
    </Section>
  );
}
