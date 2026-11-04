import {
  eulerXyzToQuat,
  quatToEulerXyz,
  type CharacterBone,
  type CharacterSkeleton,
  type Vec3,
} from '@editor-platform/character-core';
import { CommitInput, Section } from '@editor-platform/editor-ui';
import { Field } from './pose-inspector';

const round = (x: number, digits: number) => {
  const f = 10 ** digits;
  const r = Math.round(x * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

/** The bones of a skeleton in tree order (each after its parent), with their depth. */
export function boneTree(skeleton: CharacterSkeleton): { bone: CharacterBone; depth: number }[] {
  const out: { bone: CharacterBone; depth: number }[] = [];
  const children = new Map<string | null, CharacterBone[]>();
  for (const b of skeleton.bones) {
    const list = children.get(b.parentId) ?? [];
    list.push(b);
    children.set(b.parentId, list);
  }
  const visit = (parent: string | null, depth: number) => {
    for (const b of children.get(parent) ?? []) {
      out.push({ bone: b, depth });
      visit(b.id, depth + 1);
    }
  };
  visit(null, 0);
  return out;
}

/** The bones below `id` (its children, theirs, and so on). */
const below = (skeleton: CharacterSkeleton, id: string) => {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of skeleton.bones)
      if (b.parentId && (b.parentId === id || out.has(b.parentId)) && !out.has(b.id)) {
        out.add(b.id);
        grew = true;
      }
  }
  return out;
};

/**
 * Rig editing for one bone (C5a): its name, parent and rest pose (relative to its parent, in mm
 * and XYZ degrees), a child bone, removing it, and removing its skeleton. Each change is one edit.
 */
export function BoneInspector({
  skeleton,
  bone,
  editable,
  reason,
  onRename,
  onRest,
  onParent,
  onAddChild,
  onRemove,
  onRemoveSkeleton,
}: {
  skeleton: CharacterSkeleton;
  bone: CharacterBone;
  editable: boolean;
  /** Why the rig cannot be edited now. */
  reason: string;
  onRename(name: string): boolean | void;
  onRest(rest: CharacterBone['rest']): boolean | void;
  onParent(parentId: string | null): boolean | void;
  onAddChild(): void;
  onRemove(): void;
  onRemoveSkeleton(): void;
}) {
  const euler = quatToEulerXyz(bone.rest.rotation).map((x) => round(x, 2)) as Vec3;
  const at = bone.rest.translation.map((x) => round(x, 2)) as Vec3;
  const blocked = below(skeleton, bone.id);
  return (
    <Section title={`Bone · ${bone.name}`}>
      {!editable && <p className="character-hint">{reason}</p>}
      {/* The shared field: IME composition is never committed or flushed half-typed. */}
      <div className="character-name-field">
        {editable ? (
          <CommitInput label="Bone name" value={bone.name} onCommit={(name) => onRename(name)} />
        ) : (
          <p className="character-hint">{bone.name}</p>
        )}
      </div>
      <label className="character-field character-name-field">
        <span>Parent</span>
        <select
          aria-label="Parent bone"
          value={bone.parentId ?? ''}
          disabled={!editable}
          onChange={(e) => onParent(e.target.value || null)}
        >
          <option value="">{skeleton.name} (root)</option>
          {skeleton.bones
            .filter((b) => b.id !== bone.id && !blocked.has(b.id))
            .map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
        </select>
      </label>
      <fieldset className="character-fields" aria-label="Rest position" disabled={!editable}>
        <legend>Rest position</legend>
        {(['X', 'Y', 'Z'] as const).map((axis, k) => (
          <Field
            key={axis}
            label={`Rest position ${axis}`}
            unit="mm"
            value={at[k]!}
            disabled={!editable}
            onCommit={(v) => {
              const next = [...bone.rest.translation] as Vec3;
              next[k] = v;
              return onRest({ ...bone.rest, translation: next });
            }}
          />
        ))}
      </fieldset>
      <fieldset className="character-fields" aria-label="Rest rotation" disabled={!editable}>
        <legend>Rest rotation</legend>
        {(['X', 'Y', 'Z'] as const).map((axis, k) => (
          <Field
            key={axis}
            label={`Rest rotation ${axis}`}
            unit="°"
            value={euler[k]!}
            disabled={!editable}
            onCommit={(v) => {
              const next = [...euler] as Vec3;
              next[k] = v;
              return onRest({ ...bone.rest, rotation: eulerXyzToQuat(next) });
            }}
          />
        ))}
      </fieldset>
      {editable && (
        <div className="character-mesh-row">
          <button type="button" onClick={onAddChild}>
            Add child bone
          </button>
          <button type="button" onClick={onRemove}>
            Remove bone
          </button>
          <button type="button" onClick={onRemoveSkeleton}>
            Remove skeleton
          </button>
        </div>
      )}
    </Section>
  );
}
