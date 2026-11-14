import {
  characterIds,
  freshCharacterId,
  type CharacterDocument,
} from '@editor-platform/character-core';

/**
 * A re-import replaces the model, not the props placed with it (C2b-3): the imported document
 * keeps the current props, and the joint, placement (MR4) and mount (MR7) tracks of each action the file has
 * too (by action ID), and each action's camera tracks (CR7e: glTF does not keep them). A track or key whose ID the file already uses gets a fresh one. Joint keys of actions the
 * file does not have are named in `dropped`, for the import report.
 */
export function carryProps(
  current: CharacterDocument,
  imported: CharacterDocument,
): { doc: CharacterDocument; dropped: string[] } {
  const doc = structuredClone(imported);
  const dropped: string[] = [];
  const camera = current.actions.some((a) => a.tracks.some((t) => t.target.kind === 'camera'));
  if (!current.props.length && !camera) return { doc, dropped };
  const taken = characterIds(doc);
  // A prop whose ID the file uses is refused by validation as a duplicate: renamed here.
  const renamed = new Map<string, string>();
  doc.props = current.props.map((p) => {
    const id = taken.has(p.id) ? freshCharacterId(doc, p.id, taken) : p.id;
    taken.add(id);
    renamed.set(p.id, id);
    return { ...structuredClone(p), id };
  });
  for (const action of current.actions) {
    const joints = action.tracks.filter(
      (t) =>
        t.target.kind === 'prop-joint' ||
        t.target.kind === 'prop' ||
        t.target.kind === 'prop-mount' ||
        t.target.kind === 'camera',
    );
    if (!joints.length) continue;
    const target = doc.actions.find((a) => a.id === action.id);
    if (!target) {
      dropped.push(`Prop and camera keys of action ${action.name} (not in the file)`);
      continue;
    }
    for (const t of joints) {
      if (
        t.target.kind !== 'prop-joint' &&
        t.target.kind !== 'prop' &&
        t.target.kind !== 'prop-mount' &&
        t.target.kind !== 'camera'
      )
        continue;
      // The file's own camera track (none today: glTF has no camera keys) is kept.
      if (
        t.target.kind === 'camera' &&
        target.tracks.some(
          (x) => x.target.kind === 'camera' && x.target.property === t.target.property,
        )
      )
        continue;
      const keys = t.keys.filter((k) => k.tick <= target.duration);
      if (keys.length < t.keys.length)
        dropped.push(`Prop and camera keys after the end of ${target.name}`);
      if (!keys.length) continue;
      const trackId = taken.has(t.id) ? freshCharacterId(doc, t.id, taken) : t.id;
      taken.add(trackId);
      target.tracks.push({
        id: trackId,
        target:
          t.target.kind === 'camera'
            ? { ...t.target }
            : { ...t.target, id: renamed.get(t.target.id) ?? t.target.id },
        keys: keys.map((k) => {
          const id = taken.has(k.id) ? freshCharacterId(doc, k.id, taken) : k.id;
          taken.add(id);
          return structuredClone({ ...k, id });
        }),
      });
    }
  }
  return { doc, dropped };
}
