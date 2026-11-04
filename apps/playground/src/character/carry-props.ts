import {
  characterIds,
  freshCharacterId,
  type CharacterDocument,
} from '@editor-platform/character-core';

/**
 * A re-import replaces the model, not the props placed with it (C2b-3): the imported document
 * keeps the current props, and the joint tracks of each action the file has too (by action
 * ID). A track or key whose ID the file already uses gets a fresh one. Joint keys of actions the
 * file does not have are named in `dropped`, for the import report.
 */
export function carryProps(
  current: CharacterDocument,
  imported: CharacterDocument,
): { doc: CharacterDocument; dropped: string[] } {
  const doc = structuredClone(imported);
  const dropped: string[] = [];
  if (!current.props.length) return { doc, dropped };
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
    const joints = action.tracks.filter((t) => t.target.kind === 'prop-joint');
    if (!joints.length) continue;
    const target = doc.actions.find((a) => a.id === action.id);
    if (!target) {
      dropped.push(`Prop joint keys of action ${action.name} (not in the file)`);
      continue;
    }
    for (const t of joints) {
      if (t.target.kind !== 'prop-joint') continue;
      const keys = t.keys.filter((k) => k.tick <= target.duration);
      if (keys.length < t.keys.length)
        dropped.push(`Prop joint keys after the end of ${target.name}`);
      if (!keys.length) continue;
      const trackId = taken.has(t.id) ? freshCharacterId(doc, t.id, taken) : t.id;
      taken.add(trackId);
      target.tracks.push({
        id: trackId,
        target: { ...t.target, id: renamed.get(t.target.id) ?? t.target.id },
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
