import {
  animationCommand2,
  evaluateAnimation2,
  prepareAnimation2,
  sampleAnimationTrack2,
  type AnimationContent2,
  type AnimationInputValues2,
  type AnimationAction2,
  type Property2,
  type Track2,
} from '@editor-platform/animation-core/v2';
export type KeySelection2 = { trackId: string; keyId: string };
export type CopiedAnimationKeys2 = Pick<Track2, 'layerId' | 'property' | 'keys'>[];
type Scope = { canEdit(): boolean };
const id = () => crypto.randomUUID();
export function addAnimationKeys2(
  content: AnimationContent2,
  compositionId: string,
  layers: readonly string[],
  property: Property2,
  tick: number,
  inputs: AnimationInputValues2,
  scope: Scope,
) {
  const comp = content.compositions.find((c) => c.id === compositionId)!,
    scene = evaluateAnimation2(prepareAnimation2(content), comp.id, tick, inputs),
    edits: AnimationAction2[] = [],
    selection: KeySelection2[] = [];
  for (const layerId of layers) {
    const layer = comp.layers.find((l) => l.id === layerId)!;
    const evaluated =
      scene.items.find((i) => i.id === layerId && i.instancePath.length === 2)?.layer ?? layer;
    const track = structuredClone(
      comp.tracks.find((t) => t.layerId === layerId && t.property === property) ?? {
        id: id(),
        layerId,
        property,
        keys: [],
      },
    );
    if (track.keys.some((k) => k.tick === tick)) throw Error('A key already exists at this frame');
    const value = track.keys.length
      ? sampleAnimationTrack2(track, tick)
      : property in evaluated.transform
        ? (evaluated.transform as unknown as Record<string, number>)[property]
        : (evaluated as unknown as Record<string, number | string>)[property];
    if (value === undefined) throw Error('This property is not available on the selected layer');
    const keyId = id();
    track.keys.push({
      id: keyId,
      tick,
      value,
      easing: { type: property === 'text' ? 'hold' : 'linear' },
    });
    track.keys.sort((a, b) => a.tick - b.tick);
    edits.push({ type: 'track.put', compositionId, track });
    selection.push({ trackId: track.id, keyId });
  }
  return { command: animationCommand2(content, edits, scope, 'Add Animation keys'), selection };
}
export function deleteAnimationKeys2(
  content: AnimationContent2,
  compositionId: string,
  selection: readonly KeySelection2[],
  scope: Scope,
) {
  const comp = content.compositions.find((c) => c.id === compositionId)!,
    edits: AnimationAction2[] = [];
  for (const track of comp.tracks) {
    const keys = track.keys.filter(
      (key) => !selection.some((s) => s.trackId === track.id && s.keyId === key.id),
    );
    if (keys.length !== track.keys.length)
      edits.push(
        keys.length
          ? { type: 'track.put', compositionId, track: { ...track, keys } }
          : { type: 'track.remove', compositionId, id: track.id },
      );
  }
  return animationCommand2(content, edits, scope, 'Delete Animation keys');
}
export function copyAnimationKeys2(
  tracks: readonly Track2[],
  selection: readonly KeySelection2[],
): CopiedAnimationKeys2 {
  return structuredClone(
    tracks.flatMap((track) => {
      const keys = track.keys.filter((key) =>
        selection.some((s) => s.trackId === track.id && s.keyId === key.id),
      );
      return keys.length ? [{ layerId: track.layerId, property: track.property, keys }] : [];
    }),
  );
}
export function pasteAnimationKeys2(
  content: AnimationContent2,
  compositionId: string,
  copied: CopiedAnimationKeys2 | null,
  tick: number,
  scope: Scope,
) {
  if (!copied?.length) throw Error('Copy keys first');
  const comp = content.compositions.find((c) => c.id === compositionId)!,
    start = Math.min(...copied.flatMap((t) => t.keys.map((k) => k.tick))),
    edits: AnimationAction2[] = [];
  for (const item of copied) {
    const track = structuredClone(
      comp.tracks.find((t) => t.layerId === item.layerId && t.property === item.property) ?? {
        id: id(),
        layerId: item.layerId,
        property: item.property,
        keys: [],
      },
    );
    track.keys.push(
      ...item.keys.map((key) => ({ ...key, id: id(), tick: key.tick - start + tick })),
    );
    track.keys.sort((a, b) => a.tick - b.tick);
    edits.push({ type: 'track.put', compositionId, track });
  }
  return animationCommand2(content, edits, scope, 'Paste Animation keys');
}
