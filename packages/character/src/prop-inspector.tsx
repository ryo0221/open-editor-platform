import { Trash2 } from 'lucide-react';
import {
  eulerXyzToQuat,
  isCharacterJointAngle,
  quatToEulerXyz,
  type CharacterJointValueKey,
  type CharacterProp,
  type Vec3,
} from '@editor-platform/character-core';
import { IconButton, Section } from '@editor-platform/editor-ui';
import { formatTicks } from './playback';
import { Field } from './pose-inspector';
import type { CharacterPropView } from './props';

const round = (x: number, digits: number) => {
  const f = 10 ** digits;
  const r = Math.round(x * f) / f;
  return Object.is(r, -0) ? 0 : r;
};
const valueLabels: Record<CharacterJointValueKey, string> = {
  angle: 'Angle',
  angle2: 'Angle 2',
  angle3: 'Angle 3',
  distance: 'Distance',
  u: 'U',
  v: 'V',
};
const deg = 180 / Math.PI;

/**
 * A prop (C2b): where it stands, and its version's joints at the playhead. A joint value keys it
 * at the playhead in the chosen action, as a bone's pose does; placement and removal are edits
 * of the prop itself, not keys.
 */
export function PropInspector({
  prop,
  view,
  values,
  missing,
  tick,
  canKey,
  reason,
  readOnly,
  placement,
  placementKeyed,
  onKey,
  onPlace,
  onKeyPlacement,
  onRemove,
}: {
  prop: CharacterProp;
  view: CharacterPropView | undefined;
  /** Keyed joint values at the playhead (a joint left out shows its saved value). */
  values: ReadonlyMap<string, Partial<Record<CharacterJointValueKey, number>>>;
  /** Joints keyed in the document that this version does not have. */
  missing: string[];
  tick: number;
  canKey: boolean;
  reason: string;
  readOnly: boolean;
  /** MR4: where the prop is at the playhead (its keyed placement, else its own). */
  placement: CharacterProp['placement'];
  /** MR4: the chosen action keys this prop's placement: a change keys it at the playhead. */
  placementKeyed: boolean;
  /** False when refused, so a pending value is not lost by a save. */
  onKey(joint: string, key: CharacterJointValueKey, value: number): boolean | void;
  onPlace(placement: CharacterProp['placement']): boolean | void;
  /** MR4: keys the placement (translation and rotation) at the playhead. */
  onKeyPlacement(
    placement: CharacterProp['placement'],
    only?: 'translation' | 'rotation',
  ): boolean | void;
  onRemove(): void;
}) {
  const euler = quatToEulerXyz(placement.rotation).map((x) => round(x, 2)) as Vec3;
  const at = placement.translation.map((x) => round(x, 2)) as Vec3;
  // A keyed placement is changed by keys only, and only while keys can be set.
  const placeLocked = readOnly || (placementKeyed && !canKey);
  // A field keys only what it changes; "Key placement" keys both.
  const put = (next: CharacterProp['placement'], only: 'translation' | 'rotation') =>
    placementKeyed ? onKeyPlacement(next, only) : onPlace(next);
  return (
    <>
      <Section title={`Prop · ${prop.name}`}>
        <p className="character-hint">
          Version {prop.source.versionId} of a{' '}
          {prop.source.kind === 'bim' ? 'building' : 'CAD Artifact'}, fixed by its content hash.
        </p>
        {placementKeyed && (
          <p className="character-hint" data-testid="character-prop-placement-keyed">
            {canKey
              ? `The action keys this prop's placement: a change keys it at ${formatTicks(tick)}.`
              : `The action keys this prop's placement. ${reason}`}
          </p>
        )}
        <fieldset className="character-fields" aria-label="Prop position" disabled={placeLocked}>
          <legend>Position</legend>
          {(['X', 'Y', 'Z'] as const).map((axis, k) => (
            <Field
              key={axis}
              label={`Prop position ${axis}`}
              unit="mm"
              value={at[k]!}
              disabled={placeLocked}
              onCommit={(v) => {
                const next = [...placement.translation] as Vec3;
                next[k] = v;
                return put({ translation: next, rotation: placement.rotation }, 'translation');
              }}
            />
          ))}
        </fieldset>
        <fieldset className="character-fields" aria-label="Prop rotation" disabled={placeLocked}>
          <legend>Rotation</legend>
          {(['X', 'Y', 'Z'] as const).map((axis, k) => (
            <Field
              key={axis}
              label={`Prop rotation ${axis}`}
              unit="°"
              value={euler[k]!}
              disabled={placeLocked}
              onCommit={(v) => {
                const next = [...euler] as Vec3;
                next[k] = v;
                return put(
                  { translation: placement.translation, rotation: eulerXyzToQuat(next) },
                  'rotation',
                );
              }}
            />
          ))}
        </fieldset>
        <button
          type="button"
          disabled={!canKey}
          title={canKey ? undefined : reason}
          onClick={() => onKeyPlacement(placement)}
        >
          Key placement
        </button>
        <IconButton
          icon={Trash2}
          label="Remove prop"
          disabled={readOnly}
          reason="Read only"
          onClick={onRemove}
        />
      </Section>
      <Section title="Joints">
        {view?.status === 'pending' && <p className="character-hint">Calculating the shape…</p>}
        {view?.status === 'failed' && (
          <p className="character-hint" role="status">
            Not shown: {view.message}
          </p>
        )}
        {!view && <p className="character-hint">This Host shows no props.</p>}
        {view?.status === 'ready' &&
          (view.joints.length ? (
            <>
              <p className="character-hint">
                {canKey ? `A change keys the joint at ${formatTicks(tick)}.` : reason}
              </p>
              {view.joints.map((j) => (
                <fieldset
                  key={j.id}
                  className="character-fields"
                  aria-label={`Joint ${j.name}`}
                  disabled={!canKey}
                >
                  <legend>{j.name}</legend>
                  {j.values.map((v) => {
                    const now = values.get(j.id)?.[v.key] ?? v.saved;
                    const angle = isCharacterJointAngle(v.key);
                    return (
                      <Field
                        key={v.key}
                        label={`${j.name} ${valueLabels[v.key]}`}
                        unit={angle ? '°' : 'mm'}
                        value={round(angle ? now * deg : now, 2)}
                        disabled={!canKey}
                        onCommit={(n) => onKey(j.id, v.key, angle ? n / deg : n)}
                      />
                    );
                  })}
                </fieldset>
              ))}
            </>
          ) : (
            <p className="character-hint">This version has no joints to key.</p>
          ))}
        {missing.length > 0 && (
          <p className="character-hint" role="status">
            Keyed joints this version does not have: {missing.join(', ')}
          </p>
        )}
      </Section>
    </>
  );
}
