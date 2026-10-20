import { expect, it } from 'vitest';
import {
  animationCommand2,
  createAnimationLayer2,
  evaluateAnimation2,
  prepareAnimation2,
} from '@editor-platform/animation-core/v2';
import { animationContainerFixture } from '../../../../tests/fixtures/animation-containers';
import {
  animationStageDragActions2,
  animationStageDragLayers2,
  selectedAnimationStageAncestor2,
} from './stage-drag';

it('retains a selected group hit through its painted child and converts world deltas through sampled parent transforms', () => {
  const content = animationContainerFixture('group'),
    root = content.compositions[0],
    owner = root.layers[0],
    parent = createAnimationLayer2('group', 'parent', root.duration);
  owner.parentId = parent.id;
  root.layers.unshift(parent);
  root.tracks = [
    {
      id: 'parent-rotation',
      layerId: parent.id,
      property: 'rotation',
      keys: [{ id: 'rotation-key', tick: 0, value: 90, easing: { type: 'hold' } }],
    },
  ];
  content.publicInputs = [
    {
      id: 'parent-scale',
      name: 'Scale',
      kind: 'number',
      min: 0.1,
      max: 4,
      default: 2,
      target: { compositionId: root.id, layerId: parent.id, property: 'scaleX' },
    },
  ];
  parent.transform.scaleY = 2;
  expect(selectedAnimationStageAncestor2(root, ['container'], 'paint')).toBe('container');
  expect(selectedAnimationStageAncestor2(root, [], 'paint')).toBeUndefined();
  const before = structuredClone(content),
    oldScene = evaluateAnimation2(prepareAnimation2(content), root.id, 0),
    layers = animationStageDragLayers2(content, root.id, ['container'], 0, []);
  const next = animationCommand2(
    content,
    animationStageDragActions2(root.id, layers, { x: 40, y: 20 }),
    { canEdit: () => true },
  ).apply(content);
  const moved = next.compositions[0].layers.find((l) => l.id === owner.id)!;
  expect(moved.transform.x).toBeCloseTo(110);
  expect(moved.transform.y).toBeCloseTo(40);
  expect(content).toEqual(before);
  expect(next.compositions[0].layers.find((l) => l.id === 'paint')).toEqual(
    root.layers.find((l) => l.id === 'paint'),
  );
  const scene = evaluateAnimation2(prepareAnimation2(next), root.id, 0);
  expect(scene.items[0].matrix[4] - oldScene.items[0].matrix[4]).toBeCloseTo(40);
  expect(scene.items[0].matrix[5] - oldScene.items[0].matrix[5]).toBeCloseTo(20);
});
it('resolves local composition container poses without requiring a painted container item', () => {
  const content = animationContainerFixture('composition'),
    root = content.compositions[0],
    scene = evaluateAnimation2(prepareAnimation2(content), root.id, 0);
  expect(scene.items.some((item) => item.id === 'container')).toBe(false);
  expect(
    animationStageDragLayers2(content, root.id, ['container'], 0, []).map((layer) => layer.id),
  ).toEqual(['container']);
});
