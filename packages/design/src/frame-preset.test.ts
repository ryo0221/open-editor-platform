import { it, expect } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import {
  applyFramePreset,
  createDesign,
  makeDesignElement,
  layoutDesign,
  type DesignContent,
} from './model';
it.each([true, false])(
  'refuses child fitting for absolute layout (explicit=%s), while fixed size preserves children and Undo',
  (explicit) => {
    const frame = {
      ...makeDesignElement('frame'),
      id: 'absolute',
      bounds: { x: 20, y: 30, width: 1000, height: 1000 },
      ...(explicit
        ? {
            layout: {
              direction: 'absolute' as const,
              gap: 16,
              padding: 16,
              align: 'start' as const,
              sizing: 'hug' as const,
            },
          }
        : { layout: undefined }),
    };
    const child = {
      ...makeDesignElement('rectangle'),
      id: 'child',
      parentId: frame.id,
      bounds: { x: 900, y: 800, width: 600, height: 700 },
    };
    const source: DesignContent = { ...createDesign(), elements: [frame, child] };
    const session = new EditorSession(source);
    expect(() => session.execute(applyFramePreset(frame.id, 390, 844, true))).toThrow(
      'row or column',
    );
    expect(session.content).toEqual(source);
    expect(session.canUndo).toBe(false);
    session.execute(applyFramePreset(frame.id, 390, 844));
    expect(session.content.elements[0].bounds).toMatchObject({ width: 390, height: 844 });
    expect(session.content.elements[1]).toEqual(child);
    expect(session.undo()).toEqual(source);
  },
);
it('explicitly switches Hug to exact fixed dimensions, optionally fits children, and Undo restores layout/geometry', () => {
  const content = createDesign();
  const frame = {
    ...makeDesignElement('frame', 0),
    id: 'frame',
    bounds: { x: 20, y: 20, width: 800, height: 600 },
    layout: {
      direction: 'column' as const,
      gap: 16,
      padding: 16,
      align: 'start' as const,
      sizing: 'hug' as const,
    },
  };
  const child = {
    ...makeDesignElement('rectangle', 1),
    id: 'child',
    parentId: 'frame',
    bounds: { x: 36, y: 36, width: 840, height: 80 },
  };
  const source = layoutDesign({ ...content, elements: [frame, child] });
  const session = new EditorSession(source);
  session.execute(applyFramePreset(frame.id, 390, 844));
  expect(session.content.elements[0].bounds).toMatchObject({ width: 390, height: 844 });
  expect(session.content.elements[1].bounds.width).toBe(840);
  expect(session.undo()).toEqual(source);
  session.redo();
  expect(session.content.elements[0].layout?.sizing).toBe('fixed');
  const fitted = applyFramePreset(frame.id, 390, 844, true).apply(source);
  expect(fitted.elements[1].bounds.width).toBe(358);
  expect(source.elements[1].bounds.width).toBe(840);
});
it.each(['start', 'center', 'end'] as const)(
  'fits multiple row children on both axes with %s alignment and restores them with Undo',
  (align) => {
    const frame = {
      ...makeDesignElement('frame'),
      id: 'row',
      bounds: { x: 20, y: 30, width: 1000, height: 1000 },
      layout: { direction: 'row' as const, gap: 16, padding: 16, align, sizing: 'hug' as const },
    };
    const children = [0, 1].map((i) => ({
      ...makeDesignElement('rectangle', i),
      id: `child-${i}`,
      parentId: frame.id,
      bounds: { x: 0, y: 0, width: 600, height: 900 },
    }));
    const source = layoutDesign({ ...createDesign(), elements: [frame, ...children] });
    const session = new EditorSession(source);
    session.execute(applyFramePreset(frame.id, 390, 300, true));
    const [fixed, first, second] = session.content.elements;
    expect(fixed.bounds).toEqual({ x: 20, y: 30, width: 390, height: 300 });
    expect(first.bounds).toEqual({ x: 36, y: 46, width: 171, height: 268 });
    expect(second.bounds).toEqual({ x: 223, y: 46, width: 171, height: 268 });
    expect(first.sizing).toBe('fill');
    expect(second.sizing).toBe('fill');
    const fitted = session.content;
    expect(session.undo()).toEqual(source);
    expect(session.redo()).toEqual(fitted);
  },
);
