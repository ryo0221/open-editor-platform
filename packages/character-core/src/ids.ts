import { canonicalJson } from '@editor-platform/artifact-core';
import { ikChainBones } from './ik';
import type { CharacterDocument } from './model';

/** The elements other artifacts may address (ADR 019): parts, bones, morphs, materials, actions. */
export type CharacterElementKind = 'part' | 'bone' | 'morph' | 'material' | 'action';
export interface CharacterElementRef {
  kind: CharacterElementKind;
  id: string;
  name: string;
}
export interface CharacterIdDiff {
  added: CharacterElementRef[];
  removed: CharacterElementRef[];
  /**
   * Same ID, different content (geometry or texture asset, skin binding, rest pose, values, keys
   * or name). A morph counts
   * as changed when its part's mesh asset changed, since its deltas are stored there.
   */
  changed: CharacterElementRef[];
  kept: CharacterElementRef[];
}

/** Every addressable element with a canonical form of what it is, in document order. */
export function characterElements(doc: CharacterDocument) {
  const out: (CharacterElementRef & { form: string })[] = [];
  const add = (kind: CharacterElementKind, id: string, name: string, value: unknown) =>
    out.push({ kind, id, name, form: canonicalJson(value) });
  // Content digests by asset ID (meshes and images).
  const meshSha = new Map(doc.assets.map((a) => [a.id, a.sha256]));
  // A part's skin binding (skeleton and inverse binds) deforms its vertices: part of the part.
  const skinOf = new Map(
    doc.skins.map((s) => [s.partId, { skeletonId: s.skeletonId, inverseBind: s.inverseBind }]),
  );
  doc.parts.forEach((p) =>
    add('part', p.id, p.name, { ...p, mesh: meshSha.get(p.mesh), skin: skinOf.get(p.id) ?? null }),
  );
  // A skeleton's attachment to a part is the base of every bone's placement.
  // So are the IK chains that turn a bone or that it is the tip of (C5d): they move it.
  doc.skeletons.forEach((s) =>
    s.bones.forEach((b) => {
      const ik = (s.ik ?? []).filter((c) => {
        const found = ikChainBones(s, c);
        return found && (found.tip.id === b.id || found.bones.some((x) => x.id === b.id));
      });
      // Without chains the form is as before: bones without IK compare as they always did.
      add('bone', b.id, b.name, { ...b, attachedTo: s.parentPartId, ...(ik.length ? { ik } : {}) });
    }),
  );
  // A morph's deltas live in its part's mesh asset: a changed mesh may change the expression.
  const partMesh = new Map(doc.parts.map((p) => [p.id, meshSha.get(p.mesh)]));
  doc.morphs.forEach((m) => add('morph', m.id, m.name, { ...m, mesh: partMesh.get(m.partId) }));
  // Texture bytes live in assets: a replaced image under the same ID changes the material.
  doc.materials.forEach((m) =>
    add('material', m.id, m.name, {
      ...m,
      mapSha: Object.fromEntries(
        Object.entries(m.maps).map(([role, id]) => [role, meshSha.get(id!)]),
      ),
    }),
  );
  doc.actions.forEach((a) => add('action', a.id, a.name, a));
  return out;
}

/**
 * What a re-import (or any new version) did to the addressable elements, matched by kind and ID.
 * The Host lists `removed` and `changed` to whoever references them; nothing is rewritten.
 */
export function diffCharacterIds(
  before: CharacterDocument,
  after: CharacterDocument,
): CharacterIdDiff {
  const key = (e: { kind: string; id: string }) => `${e.kind}\u0000${e.id}`;
  const old = new Map(characterElements(before).map((e) => [key(e), e]));
  const now = characterElements(after);
  const strip = ({ kind, id, name }: CharacterElementRef) => ({ kind, id, name });
  const diff: CharacterIdDiff = { added: [], removed: [], changed: [], kept: [] };
  for (const e of now) {
    const was = old.get(key(e));
    if (!was) diff.added.push(strip(e));
    else (was.form === e.form ? diff.kept : diff.changed).push(strip(e));
    old.delete(key(e));
  }
  diff.removed = [...old.values()].map(strip);
  return diff;
}
