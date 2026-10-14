import { groupOperationContract } from '../../../tests/unit/group-contract';
import { arrangeObjects, createDeck, exportSlideSvg, type SlideContent } from './model';
groupOperationContract<SlideContent>('Slide', {
  create: (items) => ({
    ...createDeck(),
    slides: [
      {
        id: 'page',
        title: 'Groups',
        background: '#ffffff',
        objects: items.map(({ kind, parentId, ...item }) => ({
          ...item,
          type: kind,
          groupId: parentId,
          text: '',
        })),
      },
    ],
  }),
  items: (d) =>
    d.slides[0].objects.map((o) => ({
      ...o,
      kind: o.type as 'shape' | 'group' | 'text' | 'image',
      parentId: o.groupId,
      rotation: o.rotation ?? 0,
      flipX: !!o.flipX,
      flipY: !!o.flipY,
    })),
  arrange: (ids, action) => arrangeObjects('page', ids, action),
  svg: (d) => exportSlideSvg(d, d.slides[0]),
});
