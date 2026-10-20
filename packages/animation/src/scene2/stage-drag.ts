import {
  animationLayerLocked2,
  evaluateAnimation2,
  inspectAnimationSelection2,
  inverseMatrix2,
  prepareAnimation2,
  type AnimationAction2,
  type AnimationContent2,
  type AnimationInputValues2,
  type Composition2,
} from '@editor-platform/animation-core/v2';

/** A painted native child remains a hit on its already-selected container. */
export function selectedAnimationStageAncestor2(
  c: Composition2,
  selection: readonly string[],
  id: string,
) {
  let layer = c.layers.find((l) => l.id === id);
  while (layer) {
    if (selection.includes(layer.id)) return layer.id;
    layer = layer.parentId ? c.layers.find((l) => l.id === layer!.parentId) : undefined;
  }
}
export function animationStageDragLayers2(
  content: AnimationContent2,
  compositionId: string,
  selected: readonly string[],
  tick: number,
  inputs: AnimationInputValues2,
) {
  const comp = content.compositions.find((c) => c.id === compositionId)!;
  const scene = evaluateAnimation2(prepareAnimation2(content), compositionId, tick, inputs),
    ids = inspectAnimationSelection2(content, compositionId, selected).roots;
  return ids.map((id) => {
    const layer = comp.layers.find((l) => l.id === id)!,
      pose = scene.layerPoses.find((p) => p.id === id);
    if (
      !pose ||
      animationLayerLocked2(comp, id) ||
      layer.motion ||
      content.publicInputs.some(
        (input) =>
          input.target.compositionId === compositionId &&
          input.target.layerId === id &&
          ['x', 'y'].includes(input.target.property),
      ) ||
      comp.tracks.some((track) => track.layerId === id && ['x', 'y'].includes(track.property))
    )
      throw Error('Use properties, public inputs or keys to move this layer');
    return {
      id,
      x: layer.transform.x,
      y: layer.transform.y,
      inverse: inverseMatrix2(pose.parentMatrix),
    };
  });
}
export function animationStageDragActions2(
  compositionId: string,
  layers: ReturnType<typeof animationStageDragLayers2>,
  delta: { x: number; y: number },
): AnimationAction2[] {
  return layers.map((layer) => ({
    type: 'layer.patch',
    compositionId,
    id: layer.id,
    patch: {
      transform: {
        x: layer.x + layer.inverse[0] * delta.x + layer.inverse[2] * delta.y,
        y: layer.y + layer.inverse[1] * delta.x + layer.inverse[3] * delta.y,
      },
    },
  }));
}
