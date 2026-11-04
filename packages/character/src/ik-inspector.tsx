import {
  characterIds,
  freshCharacterId,
  ikChainBones,
  ikPoseRotations,
  poseAt,
  type CharacterBone,
  type CharacterDocument,
  type CharacterOperation,
  type CharacterIkChain,
  type CharacterSkeleton,
  type Vec3,
} from '@editor-platform/character-core';
import { Section } from '@editor-platform/editor-ui';
import { useEffect, useRef, useState } from 'react';
import { Field } from './pose-inspector';

const axes = ['X', 'Y', 'Z'] as const;
const round = (x: number) => {
  const r = Math.round(x * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
};
const withAxis = (v: Vec3, k: number, x: number) => v.map((y, i) => (i === k ? x : y)) as Vec3;

/** How many bones above `bone` a chain ending at it can turn. */
export function bonesAbove(skeleton: CharacterSkeleton, bone: CharacterBone): number {
  const of = new Map(skeleton.bones.map((b) => [b.id, b]));
  let n = 0;
  for (let at = bone.parentId; at && n < skeleton.bones.length; at = of.get(at)?.parentId ?? null)
    n++;
  return n;
}

/**
 * The IK of one bone (C5d): the chains that end at it (how many bones they turn, on or off,
 * the target and pole in character space mm) and how far IK may turn the bone itself. Each
 * change is one rig edit.
 */
export function IkInspector({
  skeleton,
  bone,
  editable,
  reason,
  onAdd,
  onSet,
  onRemove,
  onLimits,
}: {
  skeleton: CharacterSkeleton;
  bone: CharacterBone;
  editable: boolean;
  reason: string;
  onAdd(): void;
  onSet(chain: CharacterIkChain): boolean | void;
  onRemove(id: string): void;
  onLimits(limits: CharacterBone['limits'] | null): boolean | void;
}) {
  const chains = (skeleton.ik ?? []).filter((c) => c.tipBoneId === bone.id);
  const above = bonesAbove(skeleton, bone);
  const limits = bone.limits;
  return (
    <Section title={`IK · ${bone.name}`}>
      {!editable && <p className="character-hint">{reason}</p>}
      {chains.map((c) => (
        <fieldset key={c.id} className="character-fields" aria-label={`IK chain ${c.name}`}>
          <legend>{c.name}</legend>
          <label className="character-field character-name-field">
            <input
              type="checkbox"
              aria-label={`Solve ${c.name}`}
              checked={c.enabled}
              disabled={!editable}
              onChange={(e) => onSet({ ...c, enabled: e.target.checked })}
            />
            <span>Solve (pin the tip to the target)</span>
          </label>
          <Field
            label="Chain bones"
            unit="bones"
            value={c.length}
            disabled={!editable}
            onCommit={(n) =>
              Number.isInteger(n) && n >= 1 && n <= above ? onSet({ ...c, length: n }) : false
            }
          />
          {axes.map((axis, k) => (
            <Field
              key={axis}
              label={`Target ${axis}`}
              unit="mm"
              value={round(c.target[k]!)}
              disabled={!editable}
              onCommit={(v) => onSet({ ...c, target: withAxis(c.target, k, v) })}
            />
          ))}
          <label className="character-field character-name-field">
            <input
              type="checkbox"
              aria-label={`Pole of ${c.name}`}
              checked={!!c.pole}
              disabled={!editable}
              onChange={(e) =>
                onSet({
                  ...c,
                  pole: e.target.checked
                    ? (withAxis(c.target, 1, c.target[1] - 500) as Vec3)
                    : null,
                })
              }
            />
            <span>Pole (the side the chain bends to)</span>
          </label>
          {c.pole &&
            axes.map((axis, k) => (
              <Field
                key={axis}
                label={`Pole ${axis}`}
                unit="mm"
                value={round(c.pole![k]!)}
                disabled={!editable}
                onCommit={(v) => onSet({ ...c, pole: withAxis(c.pole!, k, v) })}
              />
            ))}
          {editable && (
            <div className="character-mesh-row">
              <button type="button" onClick={() => onRemove(c.id)}>
                Remove IK chain
              </button>
            </div>
          )}
        </fieldset>
      ))}
      {editable && !chains.length && above > 0 && (
        <div className="character-mesh-row">
          <button type="button" onClick={onAdd}>
            Add IK chain
          </button>
        </div>
      )}
      <label className="character-field character-name-field">
        <input
          type="checkbox"
          aria-label="Limit rotation"
          checked={!!limits}
          disabled={!editable}
          onChange={(e) =>
            onLimits(e.target.checked ? { min: [-180, -180, -180], max: [180, 180, 180] } : null)
          }
        />
        <span>Limit how far IK turns this bone</span>
      </label>
      {limits &&
        (['min', 'max'] as const).map((end) =>
          axes.map((axis, k) => (
            <Field
              key={`${end}${axis}`}
              label={`Rotation ${axis} ${end}`}
              unit="°"
              value={limits[end][k]!}
              disabled={!editable}
              onCommit={(v) => onLimits({ ...limits, [end]: withAxis(limits[end], k, v) })}
            />
          )),
        )}
    </Section>
  );
}

/** A chain's handle where the view shows it: at its target when it solves, else at its tip. */
export interface ShownIkHandle {
  skeletonId: string;
  chain: CharacterIkChain;
  /** Canvas pixels and normalised depth of the point the handle starts at. */
  at: [number, number, number];
}

/**
 * The IK handles over the view (C5d): a drag moves a handle in the plane facing the camera
 * through where it started. `onDrag` previews, `onDrop` makes the edit (moving a solving chain's
 * target, or keying a free chain's bones at the playhead) and Escape cancels.
 */
export function IkOverlay({
  handles,
  subscribe,
  onDrag,
  onDrop,
  onCancel,
}: {
  handles(): ShownIkHandle[];
  subscribe(f: () => void): () => void;
  onDrag(handle: ShownIkHandle, x: number, y: number): void;
  onDrop(handle: ShownIkHandle, x: number, y: number): void;
  onCancel(): void;
}) {
  const [, setTick] = useState(0);
  useEffect(() => subscribe(() => setTick((t) => t + 1)), [subscribe]);
  const drag = useRef<{ pointerId: number; handle: ShownIkHandle; moved: boolean }>(undefined);
  const [moving, setMoving] = useState<{ id: string; x: number; y: number }>();
  const svg = useRef<SVGSVGElement>(null);
  const local = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !drag.current) return;
      drag.current = undefined;
      setMoving(undefined);
      onCancel();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onCancel]);
  // Taken away mid-drag (playback started, another mode): the preview goes with it.
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(
    () => () => {
      if (drag.current) cancel.current();
    },
    [],
  );
  const shown = handles().filter((h) => h.at.every(Number.isFinite) && Math.abs(h.at[2]) <= 1);
  // The dragged handle went away (playback started, the chain was removed): so does the drag.
  const gone =
    !!drag.current &&
    !shown.some(
      (h) =>
        h.skeletonId === drag.current!.handle.skeletonId &&
        h.chain.id === drag.current!.handle.chain.id,
    );
  useEffect(() => {
    if (!gone) return;
    drag.current = undefined;
    setMoving(undefined);
    cancel.current();
  });
  return (
    <svg ref={svg} className="character-gizmo character-ik-overlay" aria-label="IK handles">
      {shown.map((h) => {
        const id = `${h.skeletonId}/${h.chain.id}`;
        const [x, y] = moving?.id === id ? [moving.x, moving.y] : h.at;
        return (
          <rect
            key={id}
            role="button"
            aria-label={`IK ${h.chain.name}`}
            data-testid={`ik-handle-${h.chain.id}`}
            className={h.chain.enabled ? 'solving' : undefined}
            x={x - 6}
            y={y - 6}
            width={12}
            height={12}
            onPointerDown={(e) => {
              if (e.button !== 0 || drag.current) return;
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.setPointerCapture?.(e.pointerId);
              drag.current = { pointerId: e.pointerId, handle: h, moved: false };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d || d.pointerId !== e.pointerId) return;
              const [px, py] = local(e);
              d.moved = true;
              setMoving({ id, x: px, y: py });
              onDrag(d.handle, px, py);
            }}
            onPointerUp={(e) => {
              const d = drag.current;
              if (!d || d.pointerId !== e.pointerId) return;
              drag.current = undefined;
              setMoving(undefined);
              const [px, py] = local(e);
              if (d.moved) onDrop(d.handle, px, py);
              else onCancel();
            }}
            onPointerCancel={(e) => {
              if (drag.current?.pointerId !== e.pointerId) return;
              drag.current = undefined;
              setMoving(undefined);
              onCancel();
            }}
          />
        );
      })}
    </svg>
  );
}

/** The chains of a skeleton whose bones are all there (a chain the rig no longer fits is not shown). */
export const liveChains = (skeleton: CharacterSkeleton) =>
  (skeleton.ik ?? []).filter((c) => ikChainBones(skeleton, c));

/**
 * The edit a drop of an IK handle at `point` makes (C5d): a solving chain's target moves; a free
 * chain's bones are keyed at `tick` in the action, all in one `setKeys`. The drag previews this
 * same edit, so what is shown is what is made. Undefined when the chain is no longer the one
 * dragged (an edit or Undo changed or removed it) or a free chain has no action to key.
 */
export function ikDropOperation(
  doc: CharacterDocument,
  handle: Pick<ShownIkHandle, 'skeletonId' | 'chain'>,
  point: Vec3,
  actionId: string | undefined,
  tick: number,
): CharacterOperation | undefined {
  const chain = doc.skeletons
    .find((k) => k.id === handle.skeletonId)
    ?.ik?.find((c) => c.id === handle.chain.id);
  if (!chain || !sameChain(chain, handle.chain)) return undefined;
  if (chain.enabled)
    return {
      type: 'setIkChain',
      skeletonId: handle.skeletonId,
      chain: { ...chain, target: point },
    };
  const action = doc.actions.find((a) => a.id === actionId);
  if (!action) return undefined;
  const turns = ikPoseRotations(doc, poseAt(doc, action, tick), handle.skeletonId, chain.id, point);
  if (!turns) return undefined;
  const taken = characterIds(doc);
  const fresh = (base: string) => {
    const id = freshCharacterId(doc, base, taken);
    taken.add(id);
    return id;
  };
  return {
    type: 'setKeys',
    actionId: action.id,
    keys: [...turns].map(([id, rotation]) => {
      const trackId = fresh(`${action.id}/${id}/rotation`);
      return {
        target: { kind: 'bone' as const, id, property: 'rotation' as const },
        tick,
        value: rotation,
        trackId,
        keyId: fresh(`${trackId}#${tick}`),
      };
    }),
  };
}

const sameChain = (a: CharacterIkChain, b: CharacterIkChain) =>
  a.id === b.id &&
  a.name === b.name &&
  a.tipBoneId === b.tipBoneId &&
  a.length === b.length &&
  a.enabled === b.enabled &&
  a.target.every((x, i) => x === b.target[i]) &&
  (a.pole === null || b.pole === null
    ? a.pole === b.pole
    : a.pole.every((x, i) => x === b.pole![i]));
