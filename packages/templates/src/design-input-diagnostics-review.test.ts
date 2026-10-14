import { expect, it } from 'vitest';
import {
  createDesign,
  makeDesignElement,
  designDrawings,
  type DesignContent,
} from '@editor-platform/design/model';
import { saveAsTemplate, expandTemplate, TemplateError } from '@editor-platform/templates';

function textComponent(nested = false): DesignContent {
  const template = { type: 'frame' as const, text: '', fill: 'none' };
  return {
    ...createDesign(),
    elements: [
      {
        ...makeDesignElement('instance'),
        id: 'instance',
        componentId: nested ? 'outer' : 'inner',
        bounds: { x: 0, y: 0, width: 100, height: 40 },
      },
    ],
    components: [
      {
        id: 'inner',
        name: 'Inner',
        width: 100,
        height: 40,
        template,
        elements: [
          {
            ...makeDesignElement('frame'),
            id: 'clip',
            text: '',
            clipContent: true,
            bounds: { x: 0, y: 0, width: 100, height: 40 },
          },
          {
            ...makeDesignElement('text'),
            id: 'label',
            parentId: 'clip',
            text: '確認',
            typography: { fontSize: 12 },
            bounds: { x: 0, y: 0, width: 100, height: 26 },
          },
        ],
      },
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
                  id: 'inner-instance',
                  componentId: 'inner',
                  bounds: { x: 0, y: 0, width: 100, height: 40 },
                },
              ],
            },
          ]
        : []),
    ],
  };
}
const metadata = {
  domain: 'design' as const,
  kind: 'whole' as const,
  name: 'Input diagnostics',
  purpose: 'Review regression',
  category: 'test',
};
const longText = '一行目\n二行目\n三行目\n四行目';
it.each([false, true])('maps nested instance override text, remap=%s', async (remap) => {
  const source = textComponent(true);
  source.elements[0].overrides = { 'inner-instance': { overrides: { label: { text: '確認' } } } };
  const definition = await saveAsTemplate({
    ...metadata,
    content: source,
    slots: [
      {
        path: ['elements', 0, 'overrides', 'inner-instance', 'overrides', 'label', 'text'],
        key: 'caption',
        label: 'Caption',
        type: 'text',
      },
    ],
    overflow: { policy: 'expand', minFontSize: 10 },
  });
  expect(
    overflowPaths(() => expandTemplate(definition, { caption: longText }, { remap })).every(
      (path) => path === 'caption',
    ),
  ).toBe(true);
});

it.each([false, true])(
  'maps singleton template text with no native owner ID, remap=%s',
  async (remap) => {
    const source = textComponent();
    source.components[0] = {
      id: 'inner',
      name: 'Singleton',
      width: 100,
      height: 26,
      template: { type: 'text', text: '確認', fill: '#253044', typography: { fontSize: 12 } },
    };
    source.elements[0].bounds.height = 26;
    const definition = await saveAsTemplate({
      ...metadata,
      content: source,
      slots: [
        {
          path: ['components', 0, 'template', 'text'],
          key: 'caption',
          label: 'Caption',
          type: 'text',
        },
      ],
      overflow: { policy: 'error', minFontSize: 10 },
    });
    expect(
      overflowPaths(() => expandTemplate(definition, { caption: longText }, { remap })).every(
        (path) => path === 'caption',
      ),
    ).toBe(true);
  },
);

it.each(['fixed', 'hug', 'fill'] as const)(
  'keeps empty %s text in nested scaled auto-layout unchanged',
  async (sizing) => {
    const source = textComponent(true);
    source.elements[0].bounds.height = 4;
    source.components[0].elements![0].layout = {
      direction: 'row',
      gap: 0,
      padding: 0,
      align: 'start',
      sizing: 'fixed',
    };
    const label = source.components[0].elements![1];
    label.sizing = sizing;
    label.text = '';
    label.bounds.height = 4;
    const before = designDrawings(source, source.elements[0]).find((d) => d.kind === 'text')!;
    expect(before.bounds.height).toBeLessThan(8);
    const definition = await saveAsTemplate({
      ...metadata,
      content: source,
      slots: [],
      overflow: { policy: 'expand', minFontSize: 10 },
    });
    const expanded = expandTemplate(definition, {}, { remap: false }).content as DesignContent;
    expect(expanded.elements).toEqual(source.elements);
    expect(expanded.components).toEqual(source.components);
    expect(
      designDrawings(expanded, expanded.elements[0]).find((d) => d.kind === 'text')!.bounds,
    ).toEqual(before.bounds);
  },
);

function overflowPaths(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TemplateError);
    const diagnostics = (error as TemplateError).diagnostics;
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.every((d) => d.code === 'overflow')).toBe(true);
    return diagnostics.map((d) => d.path);
  }
  throw new Error('Expected overflow diagnostics');
}

it.each(['fixed', 'hug', 'fill'] as const)(
  'empty %s text preserves a short placeholder without overrides',
  async (sizing) => {
    const source = textComponent();
    const part = source.components[0].elements![1];
    part.sizing = sizing;
    part.bounds.height = 4;
    part.text = '';
    const definition = await saveAsTemplate({
      ...metadata,
      content: source,
      slots: [],
      overflow: { policy: 'expand', minFontSize: 10 },
    });
    const before = JSON.stringify(definition);
    const expanded = expandTemplate(definition, {}, { remap: false }).content as DesignContent;
    expect(expanded.elements[0].overrides).toBeUndefined();
    expect(expanded.components[0].elements![1]).toEqual(part);
    expect(
      designDrawings(expanded, expanded.elements[0]).find((d) => d.kind === 'text')!.bounds.height,
    ).toBe(4);
    expect(JSON.stringify(definition)).toBe(before);
  },
);

it.each([false, true])(
  'maps composite and nested text diagnostics to the input slot, remap=%s',
  async (remap) => {
    for (const nested of [false, true])
      for (const policy of ['error', 'expand'] as const) {
        const source = textComponent(nested);
        const definition = await saveAsTemplate({
          ...metadata,
          content: source,
          slots: [
            {
              path: ['components', 0, 'elements', 1, 'text'],
              key: 'caption',
              label: 'Caption',
              type: 'text',
            },
          ],
          overflow: { policy, minFontSize: 10 },
        });
        const sealed = JSON.stringify(definition);
        const paths = overflowPaths(() =>
          expandTemplate(definition, { caption: longText }, { remap }),
        );
        expect(paths.every((path) => path === 'caption')).toBe(true);
        expect(JSON.stringify(definition)).toBe(sealed);
      }
  },
);

it.each([false, true])('maps text bound to native instance overrides, remap=%s', async (remap) => {
  const source = textComponent();
  source.elements[0].overrides = { label: { text: '確認' } };
  const definition = await saveAsTemplate({
    ...metadata,
    content: source,
    slots: [
      {
        path: ['elements', 0, 'overrides', 'label', 'text'],
        key: 'caption',
        label: 'Caption',
        type: 'text',
      },
    ],
    overflow: { policy: 'expand', minFontSize: 10 },
  });
  expect(
    overflowPaths(() => expandTemplate(definition, { caption: longText }, { remap })).every(
      (path) => path === 'caption',
    ),
  ).toBe(true);
});

it.each([false, true])(
  'distinguishes duplicate part IDs in separate component definitions, remap=%s',
  async (remap) => {
    const source = textComponent();
    source.components.push({ ...structuredClone(source.components[0]), id: 'second' });
    source.elements.push({
      ...source.elements[0],
      id: 'second-instance',
      componentId: 'second',
      bounds: { x: 200, y: 0, width: 100, height: 40 },
    });
    const definition = await saveAsTemplate({
      ...metadata,
      content: source,
      slots: [0, 1].map((index) => ({
        path: ['components', index, 'elements', 1, 'text'],
        key: index ? 'second' : 'first',
        label: 'Caption',
        type: 'text' as const,
      })),
      overflow: { policy: 'expand', minFontSize: 10 },
    });
    expect(
      overflowPaths(() =>
        expandTemplate(definition, { first: '確認', second: longText }, { remap }),
      ).every((path) => path === 'second'),
    ).toBe(true);
  },
);
