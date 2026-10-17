import { expect, it } from 'vitest';
import { deepFreeze } from '@editor-platform/artifact-core';
import { createDesignRenderCache, designRenderSnapshot } from './render-cache';
import { designDrawings, makeDesignElement, type DesignContent } from './model';

function fixture(): DesignContent {
  const frame = { ...makeDesignElement('frame'), id: 'frame', clipContent: true };
  const instance = {
    ...makeDesignElement('instance'),
    id: 'instance',
    parentId: frame.id,
    componentId: 'card',
    overrides: { body: { text: '案件の本文' } },
  };
  return {
    schemaVersion: 2,
    elements: [frame, instance, { ...makeDesignElement('rectangle'), id: 'other' }],
    styles: [{ id: 'brand', name: 'Brand', appearance: { fill: '#ff0000' } }],
    components: [
      {
        id: 'card',
        name: 'Card',
        width: 220,
        height: 160,
        template: { type: 'text', text: 'Default', fill: '#000000' },
        elements: [{ ...makeDesignElement('text'), id: 'body', styleId: 'brand' }],
      },
    ],
  };
}

it('retains immutable unchanged component drawings across an unrelated edit', () => {
  const source = deepFreeze(fixture()),
    render = createDesignRenderCache();
  const first = render(source)(source.elements[1]);
  const next = deepFreeze({
    ...source,
    elements: source.elements.map((e) =>
      e.id === 'other' ? { ...e, bounds: { ...e.bounds, x: e.bounds.x + 10 } } : e,
    ),
  });
  expect(render(next)(next.elements[1])).toBe(first);
  expect(first).toEqual(designDrawings(next, next.elements[1]));
  expect(first[0].text).toBe('案件の本文');
  expect(() => {
    first[0].fill = '#000000';
  }).toThrow();
});

it('invalidates definitions, styles and ancestor clipping while preserving native overrides', () => {
  let source = deepFreeze(fixture());
  const render = createDesignRenderCache();
  let previous = render(source)(source.elements[1]);
  const updates: ((d: DesignContent) => DesignContent)[] = [
    (d) => ({
      ...d,
      components: d.components.map((c) => ({
        ...c,
        elements: c.elements!.map((e) => ({ ...e, typography: { fontSize: 36 } })),
      })),
    }),
    (d) => ({ ...d, styles: [{ ...d.styles![0], appearance: { fill: '#0000ff' } }] }),
    (d) => ({
      ...d,
      elements: d.elements.map((e) =>
        e.id === 'frame' ? { ...e, bounds: { ...e.bounds, x: e.bounds.x + 20 }, rotation: 10 } : e,
      ),
    }),
    (d) => ({
      ...d,
      elements: d.elements.map((e) => (e.id === 'frame' ? { ...e, clipContent: false } : e)),
    }),
  ];
  for (const update of updates) {
    source = deepFreeze(update(source));
    const current = render(source)(source.elements[1]);
    expect(current).not.toBe(previous);
    expect(current).toEqual(designDrawings(source, source.elements[1]));
    expect(current[0].text).toBe('案件の本文');
    previous = current;
  }
  expect(previous[0]).toMatchObject({
    fill: '#0000ff',
    typography: { fontSize: 36 },
    clipBounds: [],
  });
});

it('owns preview geometry and redraws rotation, resizing and cancellation without editing content', () => {
  const source = deepFreeze(fixture()),
    before = structuredClone(source);
  const raw = source.elements[1],
    project = createDesignRenderCache()(source);
  const bounds = { ...raw.bounds, x: raw.bounds.x + 40, width: raw.bounds.width + 20 };
  const preview = project(raw, bounds, 30);
  expect(preview).toEqual(designDrawings(source, { ...raw, bounds, rotation: 30 }));
  bounds.x += 100;
  expect(Object.isFrozen(bounds)).toBe(false);
  expect(project(raw, bounds, 30)).not.toEqual(preview);
  expect(project(raw)).toEqual(designDrawings(source, raw));
  expect(source).toEqual(before);
});

it.each([false, true])('rechecks mutable or shallow-frozen Host input (%s)', (shallow) => {
  const source = fixture();
  if (shallow) Object.freeze(source);
  const render = createDesignRenderCache(),
    project = render(source);
  const first = project(source.elements[1]);
  source.styles![0].appearance.fill = '#00ff00';
  source.elements[0] = { ...source.elements[0], clipContent: false };
  source.elements[1].overrides!.body.text = '外部の本文変更';
  const next = project(source.elements[1]);
  expect(next).not.toEqual(first);
  expect(next).toEqual(designDrawings(source, source.elements[1]));
  expect(next[0]).toMatchObject({ fill: '#00ff00', text: '外部の本文変更', clipBounds: [] });
  expect(Object.isFrozen(source.styles![0])).toBe(false);
});

it.each([false, true])('owns one drawing snapshot per mutable Host render (%s)', (shallow) => {
  const source = fixture();
  if (shallow) Object.freeze(source);
  const cache = createDesignRenderCache();
  const render = designRenderSnapshot(source, cache);
  const first = render(source.elements[1]);
  expect(render(source.elements[1])).toBe(first);
  source.styles![0].appearance.fill = '#00ff00';
  source.elements[0] = { ...source.elements[0], clipContent: false };
  source.elements[1].overrides!.body.text = 'Host revision';
  expect(render(source.elements[1])).toBe(first);
  const next = designRenderSnapshot(source, cache)(source.elements[1]);
  expect(next).toEqual(designDrawings(source, source.elements[1]));
  expect(next).toMatchObject([{ fill: '#00ff00', text: 'Host revision', clipBounds: [] }]);
  expect(Object.isFrozen(source.elements)).toBe(false);
  expect(Object.isFrozen(source.styles![0])).toBe(false);
});
