import { canonicalJson } from '@editor-platform/artifact-core';
import {
  immutableCommand,
  withCommandReads,
  type EditorCommand,
  type LocalCommandContext,
} from '@editor-platform/editor-core';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { Easing } from '@editor-platform/animation-core';
import type { GeometryTextureRole } from '@editor-platform/geometry-core';
import {
  CharacterValidationError,
  characterLimits,
  type CharacterAssetRef,
  type CharacterDocument,
  type CharacterMaterial,
  type CharacterMorph,
  type CharacterPart,
  type CharacterProp,
  type CharacterSkin,
  type CharacterSubdivision,
  type CharacterKey,
  type CharacterTrack,
  type CharacterKeyValue,
  type CharacterTrackTarget,
} from './model';
import { validateCharacter } from './validation';
import type { PropTransformKey } from './prop-transform';
import { applyRigOperation, characterRigOperationTypes, type CharacterRigOperation } from './rig';

/** The SHA-256 (hex) of a document's canonical JSON, the base an operation is prepared against. */
export const characterContentHash = (doc: CharacterDocument) =>
  bytesToHex(sha256(new TextEncoder().encode(canonicalJson(doc))));

/**
 * C1's edits: names, visibility, and a re-import that replaces the whole document (the Host has
 * shown the ID diff first). Geometry, rig and keys get their own operations later.
 */
export type CharacterOperation =
  | {
      type: 'rename';
      collection: 'parts' | 'materials' | 'skeletons' | 'morphs' | 'props' | 'actions';
      id: string;
      name: string;
    }
  | { type: 'renameBone'; skeletonId: string; id: string; name: string }
  | { type: 'setPartVisible'; id: string; visible: boolean }
  | { type: 'replaceDocument'; document: CharacterDocument }
  /** C2b: places a CAD version with the character. */
  | { type: 'addProp'; prop: CharacterProp }
  /** Removes a prop and every track that keys its joints, in one edit. */
  | { type: 'removeProp'; id: string }
  | { type: 'setPropPlacement'; id: string; placement: CharacterProp['placement'] }
  | { type: 'setPropVisible'; id: string; visible: boolean }
  /**
   * MR4: points a prop at another version of its Artifact, keeping its ID, placement and tracks.
   * The Host first checks the tracks against the new version (`prop-source-incompatible`).
   */
  /**
   * MR4: points a prop at another version of its Artifact. `dropTracks` removes, in the same
   * edit, the prop's joint tracks the new version cannot play (the Host checked them).
   */
  | {
      type: 'setPropSource';
      id: string;
      source: CharacterProp['source'];
      dropTracks?: { actionId: string; trackId: string }[];
    }
  /**
   * MR4: puts a transform's keys (`propTransformKeys`) into an action in one edit: the keys of
   * the same targets within [from, to] are replaced, keys outside it are kept.
   */
  | {
      type: 'putPropTransform';
      actionId: string;
      propId: string;
      from: number;
      to: number;
      keys: (PropTransformKey & { trackId: string; keyId: string })[];
    }
  /**
   * Keys `target` at `tick` in an action: replaces the value of a key already at that tick, or
   * inserts one (`keyId`), in the target's track or a new one (`trackId`). Easing is kept on a
   * replaced key unless given.
   */
  | {
      type: 'setKey';
      actionId: string;
      target: CharacterTrackTarget;
      tick: number;
      value: CharacterKeyValue;
      easing?: Easing;
      trackId: string;
      keyId: string;
    }
  /**
   * C5d: several `setKey`s at once, as one edit (an IK pose keys every bone of its chain).
   * Each key is set as `setKey` sets it; two keys may not share a target.
   */
  | {
      type: 'setKeys';
      actionId: string;
      keys: {
        target: CharacterTrackTarget;
        tick: number;
        value: CharacterKeyValue;
        trackId: string;
        keyId: string;
      }[];
    }
  /** Moves keys by `delta` ticks together; a key may not land on another or leave the action. */
  | { type: 'moveKeys'; actionId: string; keys: CharacterKeyAddress[]; delta: number }
  /** Deletes keys; a track left without keys is removed. */
  | { type: 'deleteKeys'; actionId: string; keys: CharacterKeyAddress[] }
  | { type: 'setKeyEasing'; actionId: string; keys: CharacterKeyAddress[]; easing: Easing }
  /**
   * C3: adds a part with its mesh asset (and a material when the part needs a new one), in one
   * edit. The Host has saved the asset's bytes first.
   */
  | {
      type: 'addPart';
      part: CharacterPart;
      asset: CharacterAssetRef;
      material?: CharacterMaterial;
    }
  /**
   * C3: points a part at a new mesh asset (one mesh edit). An asset with the same bytes already
   * named is reused; a ref nothing names any more leaves the content (Undo brings it back).
   */
  | { type: 'setPartMesh'; id: string; asset: CharacterAssetRef }
  | { type: 'setPartSubdivision'; id: string; subdivision: CharacterSubdivision | null }
  /**
   * C7a: sets a part's multires (its chunk assets staged with the Host first, `assets` naming
   * each chunk's ref) or removes it with `multires: null`. Chunks with the same bytes as ones
   * already named are reused; refs nothing names any more are dropped.
   */
  | {
      type: 'setPartMultires';
      id: string;
      multires: { level: number; topology: string } | null;
      assets: CharacterAssetRef[];
    }
  /**
   * C4: sets one map of a material to an image asset (PNG or JPEG, staged with the Host first),
   * or clears it with `asset: null`. Refs nothing names any more are dropped.
   */
  | {
      type: 'setMaterialMap';
      id: string;
      role: GeometryTextureRole;
      asset: CharacterAssetRef | null;
    }
  /**
   * C7d: a baked normal map (a PNG staged with the Host first) on every material of a part, or
   * cleared with `asset: null`. `copies` first gives the part its own copy of materials it
   * shares with other parts (`from` → a new material `id` named `name`), so the map does not
   * land on them. Refs nothing names any more are dropped.
   */
  | {
      type: 'setPartNormalMap';
      id: string;
      asset: CharacterAssetRef | null;
      copies: { from: string; id: string; name: string }[];
    }
  /**
   * C3: removes a part with its morphs, skins and the tracks that drive them. Refused while a
   * part or skeleton hangs from it.
   */
  | { type: 'removePart'; id: string }
  /**
   * C5b: binds a part to a skeleton: its mesh becomes `asset` (the same mesh with weights) and
   * `skin` is added, in one edit. Refused for a part that is bound already.
   */
  | { type: 'bindSkin'; skin: CharacterSkin; asset: CharacterAssetRef }
  /** C5b: removes a skin; the part's mesh becomes `asset` (the same mesh without weights). */
  | { type: 'unbindSkin'; id: string; asset: CharacterAssetRef }
  /**
   * C5c: new weights for a bound part (one paint stroke): its mesh becomes `asset` and its skin's
   * inverse binds become `inverseBind` (one per bone the weights name), in one edit.
   */
  | {
      type: 'setSkinWeights';
      id: string;
      asset: CharacterAssetRef;
      inverseBind: CharacterSkin['inverseBind'];
    }
  /**
   * C6a: adds a morph to its part: the part's mesh becomes `asset` (the same mesh with the
   * morph's deltas, all zero for a new one, last among the part's morphs), in one edit.
   */
  | { type: 'addMorph'; morph: CharacterMorph; asset: CharacterAssetRef }
  /**
   * C6a: removes a morph with the tracks that drive it; the part's mesh becomes `asset` (the
   * same mesh without it).
   */
  | { type: 'removeMorph'; id: string; asset: CharacterAssetRef }
  /** C6a: a morph's weight when no action drives it. */
  | { type: 'setMorphWeight'; id: string; weight: number }
  /** C5a: skeletons and bones. */
  | CharacterRigOperation;
/** A key of an action, by its track and its own ID. */
export interface CharacterKeyAddress {
  trackId: string;
  keyId: string;
}
export type CharacterOperationType = CharacterOperation['type'];

/** Applies one operation to a copy; the result is validated whole, the input never changes. */
export function applyCharacterOperation(
  doc: CharacterDocument,
  op: CharacterOperation,
): CharacterDocument {
  const next = op.type === 'replaceDocument' ? structuredClone(op.document) : structuredClone(doc);
  const missing = () => {
    throw new CharacterValidationError([{ code: 'missing-target', path: '$', message: op.type }]);
  };
  if (op.type === 'rename') {
    const item = (next[op.collection] as { id: string; name: string }[]).find(
      (x) => x.id === op.id,
    );
    if (!item) missing();
    item!.name = op.name;
  } else if (op.type === 'renameBone') {
    const bone = next.skeletons
      .find((s) => s.id === op.skeletonId)
      ?.bones.find((b) => b.id === op.id);
    if (!bone) missing();
    bone!.name = op.name;
  } else if (
    op.type === 'setKey' ||
    op.type === 'moveKeys' ||
    op.type === 'deleteKeys' ||
    op.type === 'setKeyEasing'
  ) {
    const action = next.actions.find((a) => a.id === op.actionId);
    if (!action) missing();
    editKeys(action!, op, missing);
  } else if (op.type === 'setKeys') {
    const action = next.actions.find((a) => a.id === op.actionId);
    if (!action) missing();
    // By the fields that name a channel, in a fixed order (as the track check does).
    const targets = op.keys.map((k) =>
      JSON.stringify([
        k.target.kind,
        k.target.id,
        k.target.kind === 'prop-joint'
          ? k.target.joint
          : k.target.kind === 'prop-mount'
            ? k.target.mount
            : null,
        k.target.property,
      ]),
    );
    if (!op.keys.length || new Set(targets).size !== targets.length)
      fail('keys', 'setKeys needs keys with different targets');
    for (const k of op.keys)
      editKeys(action!, { type: 'setKey', actionId: op.actionId, ...k }, missing);
  } else if (op.type === 'addProp') {
    next.props.push(structuredClone(op.prop));
  } else if (op.type === 'removeProp') {
    if (!next.props.some((p) => p.id === op.id)) missing();
    next.props = next.props.filter((p) => p.id !== op.id);
    for (const a of next.actions)
      a.tracks = a.tracks.filter(
        (t) =>
          !(
            (t.target.kind === 'prop-joint' ||
              t.target.kind === 'prop-mount' ||
              t.target.kind === 'prop') &&
            t.target.id === op.id
          ),
      );
  } else if (op.type === 'setPropSource') {
    const prop = next.props.find((p) => p.id === op.id);
    if (!prop) missing();
    if (op.source.kind !== prop!.source.kind || op.source.artifactId !== prop!.source.artifactId)
      fail('prop-source', 'a prop changes version within its own Artifact only');
    prop!.source = structuredClone(op.source);
    for (const d of op.dropTracks ?? []) {
      const action = next.actions.find((x) => x.id === d.actionId);
      const at = action?.tracks.findIndex(
        (t) =>
          t.id === d.trackId &&
          (t.target.kind === 'prop-joint' || t.target.kind === 'prop-mount') &&
          t.target.id === op.id,
      );
      if (!action || at === undefined || at < 0)
        fail('prop-source', 'dropTracks names joint and mount tracks of this prop only');
      action!.tracks.splice(at!, 1);
    }
  } else if (op.type === 'putPropTransform') {
    const action = next.actions.find((a) => a.id === op.actionId);
    if (!action || !next.props.some((p) => p.id === op.propId)) missing();
    if (!op.keys.length || op.from > op.to || op.from < 0 || op.to > action!.duration)
      fail('keys', 'putPropTransform needs keys within the action');
    const channel = propJointChannel;
    const targets = new Set<string | undefined>();
    for (const k of op.keys) {
      if (
        (k.target.kind !== 'prop-joint' && k.target.kind !== 'prop-mount') ||
        k.target.id !== op.propId
      )
        fail('keys', 'putPropTransform keys one prop’s joints and mounts');
      if (k.tick < op.from || k.tick > op.to) fail('keys', 'a key lies outside the transform');
      targets.add(channel(k.target));
    }
    // The old keys of these joints in the span go; a track of theirs left empty is removed.
    const touched = (t: CharacterTrack) =>
      channel(t.target) !== undefined && targets.has(channel(t.target));
    for (const t of action!.tracks)
      if (touched(t)) t.keys = t.keys.filter((k) => k.tick < op.from || k.tick > op.to);
    action!.tracks = action!.tracks.filter((t) => !touched(t) || t.keys.length);
    for (const k of op.keys)
      editKeys(
        action!,
        {
          type: 'setKey',
          actionId: op.actionId,
          target: k.target,
          tick: k.tick,
          value: k.value,
          easing: k.easing,
          trackId: k.trackId,
          keyId: k.keyId,
        },
        missing,
      );
  } else if (op.type === 'setPropPlacement' || op.type === 'setPropVisible') {
    const prop = next.props.find((p) => p.id === op.id);
    if (!prop) missing();
    if (op.type === 'setPropPlacement') prop!.placement = structuredClone(op.placement);
    else prop!.visible = op.visible;
  } else if (op.type === 'setPartVisible') {
    const part = next.parts.find((p) => p.id === op.id);
    if (!part) missing();
    part!.visible = op.visible;
  } else if (op.type === 'addPart') {
    if (op.material) next.materials.push(structuredClone(op.material));
    const part = structuredClone(op.part);
    part.mesh = nameAsset(next, op.asset);
    next.parts.push(part);
  } else if (op.type === 'setPartMesh') {
    const part = next.parts.find((p) => p.id === op.id);
    if (!part) missing();
    part!.mesh = nameAsset(next, op.asset);
    pruneAssetRefs(next);
  } else if (op.type === 'bindSkin') {
    const part = next.parts.find((p) => p.id === op.skin.partId);
    if (!part) missing();
    if (next.skins.some((k) => k.partId === part!.id)) fail('part-skinned', 'the part is bound');
    part!.mesh = nameAsset(next, op.asset);
    next.skins.push(structuredClone(op.skin));
    pruneAssetRefs(next);
  } else if (op.type === 'setSkinWeights') {
    const skin = next.skins.find((k) => k.id === op.id);
    if (!skin) missing();
    const part = next.parts.find((p) => p.id === skin!.partId)!;
    part.mesh = nameAsset(next, op.asset);
    skin!.inverseBind = structuredClone(op.inverseBind);
    pruneAssetRefs(next);
  } else if (op.type === 'unbindSkin') {
    const skin = next.skins.find((k) => k.id === op.id);
    if (!skin) missing();
    const part = next.parts.find((p) => p.id === skin!.partId)!;
    part.mesh = nameAsset(next, op.asset);
    next.skins = next.skins.filter((k) => k !== skin);
    pruneAssetRefs(next);
  } else if (op.type === 'setPartSubdivision') {
    const part = next.parts.find((p) => p.id === op.id);
    if (!part) missing();
    if (op.subdivision) part!.subdivision = structuredClone(op.subdivision);
    else delete part!.subdivision;
  } else if (op.type === 'setPartMultires') {
    const part = next.parts.find((p) => p.id === op.id);
    if (!part) missing();
    if (op.multires) {
      if (op.assets.length === 0) fail('multires-chunks', 'a multires needs its chunks');
      if (op.assets.some((a) => a.kind !== 'mesh-mres'))
        fail('multires-asset', 'a chunk must be a mesh-mres asset');
      part!.multires = {
        level: op.multires.level,
        topology: op.multires.topology,
        chunks: op.assets.map((a) => nameAsset(next, a)),
      };
    } else delete part!.multires;
    pruneAssetRefs(next);
  } else if (op.type === 'setMaterialMap') {
    const material = next.materials.find((m) => m.id === op.id);
    if (!material) missing();
    if (op.asset) material!.maps[op.role] = nameAsset(next, op.asset);
    else delete material!.maps[op.role];
    pruneAssetRefs(next);
  } else if (op.type === 'setPartNormalMap') {
    const part = next.parts.find((p) => p.id === op.id);
    if (!part) missing();
    if (op.asset && op.asset.kind !== 'texture-png' && op.asset.kind !== 'texture-jpeg')
      fail('asset-kind', 'a normal map is a PNG or JPEG image');
    for (const c of op.copies) {
      const from = next.materials.find((m) => m.id === c.from);
      if (!from || !part!.materials.includes(c.from))
        fail('missing-target', `material ${c.from} is not one of the part's`);
      next.materials.push({ ...structuredClone(from!), id: c.id, name: c.name });
      part!.materials = part!.materials.map((id) => (id === c.from ? c.id : id));
    }
    const named = op.asset ? nameAsset(next, op.asset) : undefined;
    for (const id of new Set(part!.materials)) {
      const m = next.materials.find((x) => x.id === id)!;
      if (named) m.maps.normal = named;
      else delete m.maps.normal;
    }
    pruneAssetRefs(next);
  } else if (op.type === 'addMorph') {
    const part = next.parts.find((p) => p.id === op.morph.partId);
    if (!part) missing();
    part!.mesh = nameAsset(next, op.asset);
    next.morphs.push(structuredClone(op.morph));
    pruneAssetRefs(next);
  } else if (op.type === 'removeMorph' || op.type === 'setMorphWeight') {
    const morph = next.morphs.find((m) => m.id === op.id);
    if (!morph) missing();
    if (op.type === 'setMorphWeight') morph!.weight = op.weight;
    else {
      const part = next.parts.find((p) => p.id === morph!.partId)!;
      part.mesh = nameAsset(next, op.asset);
      next.morphs = next.morphs.filter((m) => m !== morph);
      for (const a of next.actions)
        a.tracks = a.tracks.filter((t) => !(t.target.kind === 'morph' && t.target.id === op.id));
      pruneAssetRefs(next);
    }
  } else if (op.type === 'removePart') {
    if (!next.parts.some((p) => p.id === op.id)) missing();
    if (
      next.parts.some((p) => p.parentId === op.id) ||
      next.skeletons.some((s) => s.parentPartId === op.id)
    )
      fail('part-in-use', 'a part or skeleton hangs from this part');
    const morphs = new Set(next.morphs.filter((m) => m.partId === op.id).map((m) => m.id));
    next.parts = next.parts.filter((p) => p.id !== op.id);
    next.morphs = next.morphs.filter((m) => m.partId !== op.id);
    next.skins = next.skins.filter((k) => k.partId !== op.id);
    for (const a of next.actions)
      a.tracks = a.tracks.filter(
        (t) =>
          !(t.target.kind === 'part' && t.target.id === op.id) &&
          !(t.target.kind === 'morph' && morphs.has(t.target.id)),
      );
    pruneAssetRefs(next);
  } else if ((characterRigOperationTypes as readonly string[]).includes(op.type)) {
    applyRigOperation(next, op as CharacterRigOperation, missing);
  }
  if (op.type !== 'replaceDocument') retire(doc, next);
  const d = validateCharacter(next);
  if (d.length) throw new CharacterValidationError(d);
  return next;
}

/**
 * The IDs an edit removed (parts, skins, morphs, props, actions, tracks) join `retiredIds`, so
 * no later element of the document gets them. Asset refs are named after their bytes, and key
 * IDs after their track and tick, so neither is kept.
 */
function retire(before: CharacterDocument, after: CharacterDocument) {
  const live = (d: CharacterDocument) => {
    const out = new Set<string>();
    for (const x of [...d.materials, ...d.parts, ...d.skins, ...d.morphs, ...d.props])
      out.add(x.id);
    for (const s of d.skeletons) {
      out.add(s.id);
      for (const b of s.bones) out.add(b.id);
      for (const c of s.ik ?? []) out.add(c.id);
    }
    for (const a of d.actions) {
      out.add(a.id);
      for (const t of a.tracks) out.add(t.id);
    }
    return out;
  };
  const now = live(after);
  const gone = [...live(before)].filter((id) => !now.has(id));
  if (!gone.length) return;
  const retired = new Set(after.retiredIds ?? []);
  for (const id of gone) retired.add(id);
  after.retiredIds = [...retired];
}

/** The ID content names `asset` by: an existing ref with the same bytes, or the new ref. */
function nameAsset(doc: CharacterDocument, asset: CharacterAssetRef): string {
  const same = doc.assets.find((a) => a.kind === asset.kind && a.sha256 === asset.sha256);
  if (same) return same.id;
  doc.assets.push(structuredClone(asset));
  return asset.id;
}
/** Drops asset refs no part or material names (their bytes stay with the Host for Undo). */
function pruneAssetRefs(doc: CharacterDocument) {
  const named = new Set<string>();
  for (const p of doc.parts) {
    named.add(p.mesh);
    for (const id of p.multires?.chunks ?? []) named.add(id);
  }
  for (const m of doc.materials) for (const id of Object.values(m.maps)) if (id) named.add(id);
  doc.assets = doc.assets.filter((a) => named.has(a.id));
}

type KeyOperation = Extract<
  CharacterOperation,
  { type: 'setKey' | 'moveKeys' | 'deleteKeys' | 'setKeyEasing' }
>;
/**
 * The identity of a prop joint value (MR4) or mount (MR7) a track keys, as a fixed-order tuple:
 * IDs may hold spaces, so they are never joined into one string; the target's kind leads, so a
 * joint and a mount never share one. Undefined for any other target.
 */
export const propJointChannel = (t: CharacterTrackTarget) =>
  t.kind === 'prop-joint'
    ? JSON.stringify([t.kind, t.id, t.joint, t.property])
    : t.kind === 'prop-mount'
      ? JSON.stringify([t.kind, t.id, t.mount])
      : undefined;

const fail = (code: string, message = code): never => {
  throw new CharacterValidationError([{ code, path: '$', message }]);
};
function editKeys(
  action: CharacterDocument['actions'][number],
  op: KeyOperation,
  missing: () => void,
) {
  const keyAt = (a: CharacterKeyAddress) => {
    const track = action.tracks.find((t) => t.id === a.trackId);
    const key = track?.keys.find((k) => k.id === a.keyId);
    if (!track || !key) missing();
    return { track: track!, key: key! };
  };
  if (op.type === 'setKey') {
    const same = (t: CharacterTrackTarget) =>
      t.kind === op.target.kind &&
      t.id === op.target.id &&
      t.property === op.target.property &&
      (t.kind !== 'prop-joint' || op.target.kind !== 'prop-joint' || t.joint === op.target.joint) &&
      (t.kind !== 'prop-mount' || op.target.kind !== 'prop-mount' || t.mount === op.target.mount);
    let track = action.tracks.find((t) => same(t.target));
    if (!track) {
      track = { id: op.trackId, target: structuredClone(op.target), keys: [] };
      action.tracks.push(track);
    }
    const value = structuredClone(op.value);
    const at = track.keys.find((k) => k.tick === op.tick);
    if (at) {
      at.value = value;
      if (op.easing) at.easing = structuredClone(op.easing);
    } else {
      const key: CharacterKey = {
        id: op.keyId,
        tick: op.tick,
        value,
        // MR7: a mount key only holds.
        easing: structuredClone(
          op.easing ?? (op.target.kind === 'prop-mount' ? { type: 'hold' } : { type: 'linear' }),
        ),
      };
      track.keys.splice(
        track.keys.findIndex((k) => k.tick > op.tick) === -1
          ? track.keys.length
          : track.keys.findIndex((k) => k.tick > op.tick),
        0,
        key,
      );
    }
    return;
  }
  const chosen = op.keys.map(keyAt);
  if (new Set(chosen.map((c) => c.key)).size !== chosen.length) fail('duplicate-key');
  if (op.type === 'setKeyEasing') {
    for (const c of chosen) c.key.easing = structuredClone(op.easing);
    return;
  }
  if (op.type === 'deleteKeys') {
    const gone = new Set(chosen.map((c) => c.key));
    for (const t of action.tracks) t.keys = t.keys.filter((k) => !gone.has(k));
    action.tracks = action.tracks.filter((t) => t.keys.length > 0);
    return;
  }
  if (!Number.isSafeInteger(op.delta)) fail('tick');
  const moved = new Set(chosen.map((c) => c.key));
  for (const c of chosen) {
    const tick = c.key.tick + op.delta;
    if (tick < 0 || tick > action.duration) fail('tick', 'a key would leave the action');
    if (c.track.keys.some((k) => !moved.has(k) && k.tick === tick))
      fail('key-collision', 'a key would land on another key');
  }
  for (const c of chosen) c.key.tick += op.delta;
  for (const t of action.tracks) t.keys.sort((a, b) => a.tick - b.tick);
}

/** Every ID of the document's one namespace (assets, parts, bones, actions, tracks, keys …). */
export function characterIds(doc: CharacterDocument): Set<string> {
  const out = new Set<string>();
  for (const x of [
    ...doc.assets,
    ...doc.materials,
    ...doc.parts,
    ...doc.skins,
    ...doc.morphs,
    ...doc.props,
  ])
    out.add(x.id);
  for (const s of doc.skeletons) {
    out.add(s.id);
    for (const b of s.bones) out.add(b.id);
    for (const c of s.ik ?? []) out.add(c.id);
  }
  for (const a of doc.actions) {
    out.add(a.id);
    for (const t of a.tracks) {
      out.add(t.id);
      for (const k of t.keys) out.add(k.id);
    }
  }
  // Removed elements' IDs stay taken (docs/character/README.md: no ID is used again).
  for (const id of doc.retiredIds ?? []) out.add(id);
  return out;
}
/**
 * `base`, or `base-2`, `base-3` … : the first that the document does not use yet. A base made
 * of long IDs is cut to its first code points and a digest of the whole, leaving room for the
 * suffix, so the result always fits `characterLimits.idCodePoints`.
 */
export function freshCharacterId(doc: CharacterDocument, base: string, taken = characterIds(doc)) {
  const room = characterLimits.idCodePoints - 8; // "-" and up to 7 digits
  const points = [...base];
  const stem =
    points.length <= room
      ? base
      : `${points.slice(0, room - 17).join('')}~${bytesToHex(sha256(new TextEncoder().encode(base))).slice(0, 16)}`;
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n++) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
}

export interface CharacterCommandOptions {
  /** `characterContentHash` of the base the operation was prepared against. */
  expectedHash: string;
  /** Trusted, current edit authority, re-read on apply. */
  canEdit: () => boolean;
  context?: LocalCommandContext;
}
const labels: Record<CharacterOperationType, string> = {
  rename: 'Rename',
  renameBone: 'Rename bone',
  setPartVisible: 'Show or hide part',
  replaceDocument: 'Import model',
  addProp: 'Add prop',
  removeProp: 'Remove prop',
  setPropPlacement: 'Move prop',
  setPropSource: 'Update prop version',
  putPropTransform: 'Make transform',
  setPropVisible: 'Show or hide prop',
  setKey: 'Set key',
  setKeys: 'Set keys',
  moveKeys: 'Move keys',
  deleteKeys: 'Delete keys',
  setKeyEasing: 'Set key easing',
  addPart: 'Add part',
  setPartMesh: 'Edit mesh',
  setPartSubdivision: 'Set subdivision',
  setPartMultires: 'Set multires',
  setMaterialMap: 'Set material image',
  setPartNormalMap: 'Bake normal map',
  removePart: 'Remove part',
  addSkeleton: 'Add skeleton',
  removeSkeleton: 'Remove skeleton',
  addBone: 'Add bone',
  removeBone: 'Remove bone',
  setBoneRest: 'Move bone',
  setBoneParent: 'Set bone parent',
  addIkChain: 'Add IK chain',
  setIkChain: 'Edit IK chain',
  removeIkChain: 'Remove IK chain',
  setBoneLimits: 'Set bone limits',
  bindSkin: 'Bind to skeleton',
  unbindSkin: 'Unbind from skeleton',
  setSkinWeights: 'Paint weights',
  addMorph: 'Add morph',
  removeMorph: 'Remove morph',
  setMorphWeight: 'Set morph weight',
};
/** One ordinary EditorSession transaction; re-checks base, authority and the whole document. */
export function characterEditorCommand(
  op: CharacterOperation,
  options: CharacterCommandOptions,
): EditorCommand<CharacterDocument> {
  if ('name' in op && [...op.name].length > characterLimits.nameCodePoints)
    throw new CharacterValidationError([{ code: 'name', path: '$', message: 'name too long' }]);
  const prepared = structuredClone(op);
  const run = (content: CharacterDocument) => {
    if (!options.canEdit()) throw new Error('permission-denied');
    if (characterContentHash(content) !== options.expectedHash)
      throw new Error('character-base-mismatch');
    return applyCharacterOperation(content, prepared);
  };
  const cmd = options.context
    ? immutableCommand(`character.${op.type}`, labels[op.type], run, options.context)
    : immutableCommand(`character.${op.type}`, labels[op.type], run);
  return withCommandReads(cmd, { content: ['*'] });
}
