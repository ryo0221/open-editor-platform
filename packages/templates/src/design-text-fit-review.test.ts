import { expect, it } from 'vitest';
import {
  createDesign,
  designDrawings,
  makeDesignElement,
  type DesignContent,
} from '@editor-platform/design/model';
import {
  expandTemplate,
  saveAsTemplate,
  measureTemplateTextFit,
  layoutDiagnostics,
} from '@editor-platform/templates';

function resizedText(sx: number, sy: number, nested = false): DesignContent {
  const text = {
    ...makeDesignElement('text'),
    id: 'label',
    text: '確認するための文字列',
    bounds: { x: 0, y: 0, width: 100, height: 26 },
    typography: { fontSize: 12 },
  };
  const instance = {
    ...makeDesignElement('instance'),
    id: 'instance',
    componentId: nested ? 'outer' : 'inner',
    bounds: { x: 20, y: 30, width: 100 * sx, height: 40 * sy },
    rotation: 30,
    flipX: true,
  };
  const template = { type: 'frame' as const, text: '', fill: '#ffffff' };
  return {
    ...createDesign(),
    elements: [instance],
    components: [
      { id: 'inner', name: 'Text', width: 100, height: 40, template, elements: [text] },
      ...(nested
        ? [
            {
              id: 'outer',
              name: 'Outer',
              width: 100,
              height: 40,
              template,
              elements: [
                {
                  ...makeDesignElement('instance'),
                  id: 'nested',
                  componentId: 'inner',
                  bounds: { x: 0, y: 0, width: 50, height: 20 },
                },
              ],
            },
          ]
        : []),
    ],
  };
}
it.each([
  [0.5, 0.5],
  [0.5, 2],
  [2, 0.5],
  [2, 2],
  [1, 0.3],
  [0.7, 0.7],
])(
  'expands against rendered geometry at sx=%s sy=%s, without changing definition-local bounds',
  async (sx, sy) => {
    const source = resizedText(sx, sy);
    const before = JSON.stringify(source);
    const drawing = designDrawings(source, source.elements[0])[0];
    const fit = measureTemplateTextFit({
      text: drawing.text,
      bounds: drawing.bounds,
      fontSize: 12,
      minFontSize: 10,
    });
    const definition = await saveAsTemplate({
      domain: 'design',
      content: source,
      kind: 'whole',
      name: 'Resized',
      purpose: 'Review regression',
      category: 'test',
      slots: [],
      overflow: { policy: 'expand', minFontSize: 10 },
    });
    const expanded = expandTemplate(definition, {}, { remap: false }).content as DesignContent;
    const result = designDrawings(expanded, expanded.elements[0])[0];
    expect(result.bounds.height).toBeCloseTo(Math.max(drawing.bounds.height, fit.requiredHeight));
    expect(result.bounds.width).toBe(drawing.bounds.width);
    expect(layoutDiagnostics(definition, expanded)).toEqual([]);
    expect(expanded.components).toEqual(source.components);
    expect(JSON.stringify(source)).toBe(before);
    if (fit.fits) expect(expanded.elements[0].overrides).toBeUndefined();
  },
);
it('uses cumulative scaling for nested resized instances while preserving templates and sibling widths', async () => {
  const source = resizedText(1.5, 0.5, true);
  const definition = await saveAsTemplate({
    domain: 'design',
    content: source,
    kind: 'whole',
    name: 'Nested',
    purpose: 'Review regression',
    category: 'test',
    slots: [],
    overflow: { policy: 'expand', minFontSize: 10 },
  });
  const expanded = expandTemplate(definition, {}, { remap: false }).content as DesignContent;
  const drawing = designDrawings(expanded, expanded.elements[0])[0];
  expect(
    measureTemplateTextFit({
      text: drawing.text,
      bounds: drawing.bounds,
      fontSize: 12,
      minFontSize: 10,
    }).fits,
  ).toBe(true);
  expect(expanded.components).toEqual(source.components);
  expect(drawing.bounds.width).toBe(75);
});

it.each(['hug', 'fill'] as const)(
  'keeps rendered width and owns only the expanded instance size for %s text',
  async (sizing) => {
    const source = resizedText(0.5, 0.5);
    const label = source.components[0].elements![0];
    label.sizing = sizing;
    label.parentId = 'frame';
    source.components[0].elements!.unshift({
      ...makeDesignElement('frame'),
      id: 'frame',
      text: '',
      bounds: { x: 0, y: 0, width: 100, height: 40 },
      layout: { direction: 'row', gap: 0, padding: 0, align: 'start', sizing: 'fixed' },
    });
    const before = designDrawings(source, source.elements[0]).find((d) => d.kind === 'text')!;
    const definition = await saveAsTemplate({
      domain: 'design',
      content: source,
      kind: 'whole',
      name: 'Layout',
      purpose: 'Review regression',
      category: 'test',
      slots: [],
      overflow: { policy: 'expand', minFontSize: 10 },
    });
    const expanded = expandTemplate(definition, {}, { remap: false }).content as DesignContent;
    const drawing = designDrawings(expanded, expanded.elements[0]).find((d) => d.kind === 'text')!;
    expect(layoutDiagnostics(definition, expanded)).toEqual([]);
    expect(drawing.bounds.width).toBe(before.bounds.width);
    expect(expanded.components).toEqual(source.components);
    expect(expanded.elements[0].overrides!.label.sizing).toBe('fixed');
  },
);

it('uses the final canvas layout before expanding resized child instances', async () => {
  const source = resizedText(2, 2);
  source.elements[0].parentId = 'canvas';
  source.elements[0].sizing = 'fill';
  source.elements.unshift({
    ...makeDesignElement('frame'),
    id: 'canvas',
    text: '',
    bounds: { x: 0, y: 0, width: 50, height: 80 },
    layout: { direction: 'row', gap: 0, padding: 0, align: 'start', sizing: 'fixed' },
  });
  const definition = await saveAsTemplate({
    domain: 'design',
    content: source,
    kind: 'whole',
    name: 'Canvas layout',
    purpose: 'Review regression',
    category: 'test',
    slots: [],
    overflow: { policy: 'expand', minFontSize: 10 },
  });
  const expanded = expandTemplate(definition, {}, { remap: false }).content as DesignContent;
  expect(layoutDiagnostics(definition, expanded)).toEqual([]);
  expect(expanded.elements.find((e) => e.id === 'instance')!.bounds.width).toBe(50);
  expect(expanded.components).toEqual(source.components);
});

it.each([false, true])(
  'reports expanded text still hidden by a fixed clipping frame, nested=%s',
  async (nested) => {
    const source = resizedText(1, 1, nested);
    const label = source.components[0].elements![0];
    label.parentId = 'clip';
    label.text = '確認';
    source.components[0].elements!.unshift({
      ...makeDesignElement('frame'),
      id: 'clip',
      text: '',
      clipContent: true,
      bounds: { x: 0, y: 0, width: 100, height: 40 },
    });
    const before = JSON.stringify(source);
    const definition = await saveAsTemplate({
      domain: 'design',
      content: source,
      kind: 'whole',
      name: 'Clipped',
      purpose: 'Review regression',
      category: 'test',
      slots: [
        {
          path: ['components', 0, 'elements', 1, 'text'],
          key: 'label',
          label: 'Label',
          type: 'text',
        },
      ],
      overflow: { policy: 'expand', minFontSize: 10 },
    });
    const sealed = JSON.stringify(definition);
    expect(() =>
      expandTemplate(definition, { label: '一行目\n二行目\n三行目\n四行目' }, { remap: false }),
    ).toThrow(/does not fit/);
    expect(JSON.stringify(source)).toBe(before);
    expect(JSON.stringify(definition)).toBe(sealed);
  },
);

it('checks rotated clipping frames without flagging blank space below short text', async () => {
  const source = resizedText(1, 1);
  const label = source.components[0].elements![0];
  label.parentId = 'clip';
  label.text = '確認';
  label.bounds.height = 100;
  source.components[0].elements!.unshift({
    ...makeDesignElement('frame'),
    id: 'clip',
    text: '',
    clipContent: true,
    bounds: { x: 0, y: 0, width: 100, height: 40 },
  });
  const definition = await saveAsTemplate({
    domain: 'design',
    content: source,
    kind: 'whole',
    name: 'Visible',
    purpose: 'Review regression',
    category: 'test',
    slots: [],
    overflow: { policy: 'expand', minFontSize: 10 },
  });
  const expanded = expandTemplate(definition, {}, { remap: false }).content as DesignContent;
  expect(layoutDiagnostics(definition, expanded)).toEqual([]);
  const clipping = expanded.components[0].elements![0];
  clipping.bounds.height = 10;
  expect(layoutDiagnostics(definition, expanded)).toContainEqual(
    expect.objectContaining({
      code: 'overflow',
      path: 'instance-label',
      message: expect.stringMatching(/clipping frame/),
    }),
  );
  const legacy = { ...definition, overflow: { ...definition.overflow, textScope: undefined } };
  expect(layoutDiagnostics(legacy, expanded)).toEqual([]);
});
