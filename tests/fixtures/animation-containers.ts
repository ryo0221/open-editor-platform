import { createAnimation2, createAnimationLayer2 } from '@editor-platform/animation-core/v2';
export function animationContainerFixture(kind: 'group' | 'composition') {
  const content = createAnimation2(),
    root = content.compositions[0],
    owner = createAnimationLayer2('group', 'container', root.duration),
    child = createAnimationLayer2('rect', 'paint', root.duration);
  owner.transform = { ...owner.transform, x: 100, y: 60, scaleX: 2, scaleY: 2 };
  if (child.type !== 'rect') throw Error('Fixture rectangle');
  child.transform = { ...child.transform, x: 40, y: 30 };
  child.width = 60;
  child.height = 40;
  if (kind === 'group') {
    child.parentId = owner.id;
    root.layers = [owner, child];
  } else {
    root.layers = [
      {
        ...owner,
        type: 'composition',
        source: { type: 'local', compositionId: 'child' },
        time: {
          sourceIn: 0,
          sourceOut: root.duration,
          rate: { numerator: 1, denominator: 1 },
          after: 'hold',
        },
      },
    ];
    content.compositions.push({
      ...structuredClone(root),
      id: 'child',
      name: 'Child',
      layers: [child],
      tracks: [],
    });
  }
  return content;
}
