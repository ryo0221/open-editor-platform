import { expect, it } from 'vitest';
import { deepFreeze } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import {
  createDesign,
  makeDesignElement,
  createComponent,
  insertInstance,
  overrideInstance,
  designDrawings,
  updateComponentPart,
  detachInstance,
  reparentElement,
  layoutDesign,
  patchDesign,
  exportDesignSvg,
  transformElements,
  designPreview,
  designPaintOrder,
  type DesignContent,
  appearance,
  groupElements,
  designDiff,
  transformDesign,
} from './model';
it('transforms immutable Frame constraints once and reuses unrelated immutable geometry', () => {
  const frame = {
    ...makeDesignElement('frame'),
    bounds: { x: 100, y: 100, width: 200, height: 100 },
  };
  const child = {
    ...makeDesignElement('text'),
    parentId: frame.id,
    bounds: { x: 120, y: 130, width: 80, height: 20 },
    constraints: { horizontal: 'right' as const, vertical: 'stretch' as const },
    typography: { fontSize: 18 },
  };
  const unrelated = makeDesignElement('rectangle');
  const source = deepFreeze({ ...createDesign(), elements: [child, unrelated, frame] });
  const before = structuredClone(source);
  const next = transformDesign(source, [frame.id, child.id], { dx: 10, dy: 5, dw: 50, dh: 20 });
  expect(next.elements[2].bounds).toEqual({ x: 110, y: 105, width: 250, height: 120 });
  expect(next.elements[0].bounds).toEqual({ x: 180, y: 135, width: 80, height: 40 });
  expect(next.elements[0].typography).toBe(source.elements[0].typography);
  expect(next.elements[1]).toBe(source.elements[1]);
  expect(source).toEqual(before);
});
it.each([false, true])(
  'owns nested geometry and appearance from mutable or shallow-frozen input (%s)',
  (shallow) => {
    const element = { ...makeDesignElement('text'), typography: { fontSize: 18 } };
    const unrelated = { ...makeDesignElement('text'), typography: { fontSize: 24 } };
    const source = { ...createDesign(), elements: [element, unrelated] };
    if (shallow) {
      Object.freeze(source);
      source.elements.forEach(Object.freeze);
    }
    const next = transformDesign(source, [element.id], { dx: 10, dy: 0, dw: 0, dh: 0 });
    element.bounds.x = 999;
    element.typography.fontSize = 99;
    unrelated.typography.fontSize = 77;
    expect(next.elements[0].bounds.x).toBe(70);
    expect(next.elements.map((e) => e.typography?.fontSize)).toEqual([18, 24]);
    expect(next.elements[1]).not.toBe(unrelated);
  },
);
it('describes instance overrides using the before and after component appearances', () => {
  const text = { ...makeDesignElement('text'), text: '元の表題' };
  const before = createComponent(text.id).apply({ ...createDesign(), elements: [text] });
  const after = overrideInstance(text.id, 'root', { text: '変更した表題' }).apply(before);
  const change = designDiff(before, after).changes[0];
  expect(change.before).toContain('元の表題');
  expect(change.after).toContain('変更した表題');
});
it('groups only sibling roots and preserves their frame parent without flattening nested children', () => {
  const frame = makeDesignElement('frame'),
    other = makeDesignElement('frame');
  const a = { ...makeDesignElement('rectangle'), parentId: frame.id },
    b = { ...makeDesignElement('rectangle'), parentId: frame.id };
  const source = { ...createDesign(), elements: [frame, other, a, b] };
  const cmd = groupElements([a.id, b.id]),
    grouped = cmd.apply(source);
  const group = grouped.elements.find((e) => e.type === 'group')!;
  expect(group.parentId).toBe(frame.id);
  expect(cmd.apply(source)).toEqual(grouped);
  expect(() => groupElements([a.id, other.id]).apply(source)).toThrow('same parent');
  // Selecting a parent together with its own descendants is a single root.
  expect(() => groupElements([group.id, a.id, b.id]).apply(grouped)).toThrow('at least two');
});
it('preserves primitive component typography and rotated instance hierarchy/clips through detach', () => {
  const text = {
    ...makeDesignElement('text'),
    typography: { fontSize: 18, bold: true, lineHeight: 1.4 },
    stroke: '#123456',
    strokeWidth: 2,
  };
  let d = createComponent(text.id).apply({ ...createDesign(), elements: [text] });
  d = insertInstance(d.components[0].id).apply(d);
  expect(appearance(d, d.elements[1])).toMatchObject({
    typography: text.typography,
    stroke: text.stroke,
    strokeWidth: 2,
  });

  const frame = {
    ...makeDesignElement('frame'),
    clipContent: true,
    bounds: { x: 100, y: 100, width: 200, height: 100 },
  };
  const child = { ...text, parentId: frame.id, bounds: { x: 250, y: 130, width: 100, height: 30 } };
  d = createComponent(frame.id).apply({ ...createDesign(), elements: [frame, child] });
  const instance = { ...d.elements[0], rotation: 90, flipX: true };
  const outer = {
    ...makeDesignElement('frame'),
    clipContent: true,
    bounds: { x: 0, y: 0, width: 500, height: 500 },
  };
  instance.parentId = outer.id;
  d = { ...d, elements: [outer, instance] };
  const drawing = designDrawings(d, instance).find((e) => e.kind === 'text')!;
  expect(drawing.bounds.x).toBeCloseTo(155);
  expect(drawing.bounds.y).toBeCloseTo(35);
  expect(drawing.rotation).toBe(90);
  expect(drawing.flipX).toBe(true);
  expect(drawing.clipBounds).toHaveLength(2);
  expect(drawing.clipBounds?.[0].rotation).toBe(90);
  const detached = detachInstance(instance.id).apply(d);
  const part = detached.elements.find((e) => e.type === 'text')!;
  const detachedDrawing = designDrawings(detached, part)[0];
  expect(detachedDrawing.bounds).toEqual(drawing.bounds);
  expect(detachedDrawing.clipBounds).toEqual(drawing.clipBounds);
  expect(detachedDrawing.rotation).toEqual(drawing.rotation);
});
it('keeps multi-element instance overrides separate from shared definition and detaches at world positions', () => {
  const a = {
      ...makeDesignElement('rectangle'),
      bounds: { x: 100, y: 100, width: 200, height: 120 },
    },
    b = {
      ...makeDesignElement('text'),
      bounds: { x: 110, y: 120, width: 160, height: 60 },
      text: 'Shared',
    };
  let d: DesignContent = { ...createDesign(), elements: [a, b] };
  d = createComponent([a.id, b.id]).apply(d);
  const component = d.components[0];
  d = insertInstance(component.id).apply(d);
  const first = d.elements[0],
    second = d.elements[1];
  d = overrideInstance(first.id, b.id, { text: 'Only this card' }).apply(d);
  d = updateComponentPart(component.id, b.id, { text: 'Updated for other cards' }).apply(d);
  expect(designDrawings(d, first).map((x) => x.text)).not.toContain('Only this card'); // snapshots are immutable; resolve the current element below
  const current = d.elements.find((e) => e.id === first.id)!;
  expect(designDrawings(d, current).map((x) => x.text)).toContain('Only this card');
  expect(
    designDrawings(d, d.elements.find((e) => e.id === second.id)!).map((x) => x.text),
  ).toContain('Updated for other cards');
  const before = designDrawings(d, current).find((x) => x.kind === 'text')!;
  d = detachInstance(first.id).apply(d);
  const detached = d.elements.find((e) => e.text === 'Only this card')!;
  expect(detached.bounds).toEqual(before.bounds);
  expect(detached.id).not.toBe(b.id);
});
it('resizes Frames by constraints, scales Groups, and retains independent component overrides in two Frames', () => {
  const frame = {
    ...makeDesignElement('frame'),
    bounds: { x: -600, y: 50, width: 400, height: 300 },
  };
  const fixed = {
    ...makeDesignElement('text'),
    parentId: frame.id,
    bounds: { x: -580, y: 70, width: 100, height: 30 },
  };
  const pinned = {
    ...makeDesignElement('rectangle'),
    parentId: frame.id,
    bounds: { x: -330, y: 220, width: 100, height: 80 },
    constraints: { horizontal: 'right' as const, vertical: 'bottom' as const },
  };
  const stretch = {
    ...makeDesignElement('rectangle'),
    parentId: frame.id,
    bounds: { x: -580, y: 120, width: 360, height: 40 },
    constraints: { horizontal: 'stretch' as const, vertical: 'top' as const },
  };
  const d = { ...createDesign(), elements: [frame, fixed, pinned, stretch] };
  const delta = { dx: -50, dy: -20, dw: 200, dh: 100 };
  const session = new EditorSession(d);
  session.execute(transformElements([frame.id, fixed.id], delta));
  expect(session.content.elements[1].bounds).toEqual({ x: -630, y: 50, width: 100, height: 30 });
  expect(session.content.elements[2].bounds).toEqual({ x: -180, y: 300, width: 100, height: 80 });
  expect(session.content.elements[3].bounds).toEqual({ x: -630, y: 100, width: 560, height: 40 });
  expect(designPreview(d, [frame.id], delta).get(fixed.id)!.bounds).toEqual(
    session.content.elements[1].bounds,
  );
  expect(session.undo()).toEqual(d);
  const group = { ...d, elements: [{ ...frame, type: 'group' as const }, fixed, pinned, stretch] };
  expect(
    transformElements([frame.id], { dx: 0, dy: 0, dw: 400, dh: 300 }).apply(group).elements[1]
      .bounds.width,
  ).toBe(200);

  let components = createComponent([fixed.id, stretch.id]).apply(d);
  const definition = components.components[0];
  const frame2 = {
    ...makeDesignElement('frame'),
    bounds: { x: 200, y: 50, width: 400, height: 300 },
  };
  components = { ...components, elements: [...components.elements, frame2] };
  components = insertInstance(definition.id).apply(components);
  const instances = components.elements.filter((e) => e.type === 'instance');
  components = reparentElement(instances[1].id, frame2.id).apply(components);
  const storedOutOfPaintOrder = {
    ...components,
    elements: [...components.elements.filter((e) => e.id !== frame2.id), frame2],
  };
  expect(designPaintOrder(storedOutOfPaintOrder).findIndex((e) => e.id === frame2.id)).toBeLessThan(
    designPaintOrder(storedOutOfPaintOrder).findIndex((e) => e.id === instances[1].id),
  );
  components = overrideInstance(instances[0].id, fixed.id, { text: '個別の文字' }).apply(
    components,
  );
  components = updateComponentPart(definition.id, fixed.id, { text: '共通の文字' }).apply(
    components,
  );
  const before = structuredClone(components);
  components = transformElements([frame.id], { dx: 0, dy: 0, dw: 240, dh: 0 }).apply(components);
  for (const instance of instances)
    expect(components.elements.find((e) => e.id === instance.id)).toEqual(
      before.elements.find((e) => e.id === instance.id),
    );
  expect(
    designDrawings(components, components.elements.find((e) => e.id === instances[0].id)!).map(
      (e) => e.text,
    ),
  ).toContain('個別の文字');
  expect(
    designDrawings(components, components.elements.find((e) => e.id === instances[1].id)!).map(
      (e) => e.text,
    ),
  ).toContain('共通の文字');
});
it('propagates auto-layout fill into nested Frame constraints without scaling fixed text', () => {
  const frame = {
    ...makeDesignElement('frame'),
    bounds: { x: 0, y: 0, width: 400, height: 200 },
    layout: {
      direction: 'row' as const,
      padding: 20,
      gap: 10,
      align: 'start' as const,
      sizing: 'fixed' as const,
    },
  };
  const child = {
    ...makeDesignElement('frame'),
    parentId: frame.id,
    sizing: 'fill' as const,
    bounds: { x: 20, y: 20, width: 360, height: 100 },
  };
  const text = {
    ...makeDesignElement('text'),
    parentId: child.id,
    bounds: { x: 30, y: 30, width: 100, height: 30 },
    constraints: { horizontal: 'right' as const, vertical: 'top' as const },
  };
  const d = { ...createDesign(), elements: [frame, child, text] };
  const next = transformElements([frame.id], { dx: 0, dy: 0, dw: 200, dh: 0 }).apply(d);
  expect(next.elements[1].bounds.width).toBe(560);
  expect(next.elements[2].bounds).toEqual({ x: 230, y: 30, width: 100, height: 30 });
});
it('reparents without world-coordinate changes, rejects cycles and uses a single undoable layout update', () => {
  const frame = {
      ...makeDesignElement('frame'),
      bounds: { x: 50, y: 50, width: 500, height: 300 },
    },
    card = { ...makeDesignElement('group'), bounds: { x: 100, y: 100, width: 220, height: 100 } },
    text = {
      ...makeDesignElement('text'),
      bounds: { x: 110, y: 120, width: 100, height: 30 },
      parentId: card.id,
    };
  let d: DesignContent = { ...createDesign(), elements: [frame, card, text] };
  d = reparentElement(card.id, frame.id).apply(d);
  expect(d.elements[1].bounds).toEqual(card.bounds);
  expect(() => reparentElement(frame.id, card.id).apply(d)).toThrow(/ancestor/);
  const session = new EditorSession(d);
  session.execute(
    patchDesign([frame.id], {
      layout: { direction: 'row', gap: 24, padding: 16, align: 'start', sizing: 'hug' },
    }),
  );
  expect(session.content.elements[1].bounds.x).toBe(66);
  expect(session.content.elements[2].bounds.x).toBe(76);
  expect(session.undo()).toEqual(d);
});
it('lays out added children and produces clipped frame exports without domain IDs', () => {
  const frame = {
      ...makeDesignElement('frame'),
      clipContent: true,
      layout: {
        direction: 'column' as const,
        gap: 12,
        padding: 20,
        align: 'start' as const,
        sizing: 'fixed' as const,
      },
    },
    a = { ...makeDesignElement('rectangle'), parentId: frame.id },
    b = { ...makeDesignElement('rectangle'), parentId: frame.id };
  const d = layoutDesign({ ...createDesign(), elements: [frame, a, b] });
  expect(d.elements[2].bounds.y - d.elements[1].bounds.y).toBe(a.bounds.height + 12);
  const svg = exportDesignSvg(d, [frame.id]);
  expect(svg).toContain('clipPath');
  expect(svg).not.toContain(a.id);
});
