import {
  createDesign,
  makeDesignElement,
  type DesignContent,
  type DesignElement,
} from '@editor-platform/design/model';

export function nestedTextFixture(): DesignContent {
  const element = (
    type: DesignElement['type'],
    id: string,
    text: string,
    y = 0,
  ): DesignElement => ({
    ...makeDesignElement(type),
    id,
    name: id,
    text,
    bounds: { x: 0, y, width: 240, height: 56 },
    typography: { fontSize: 24, overflow: 'expand' },
  });
  const instance = {
    ...element('instance', 'card', ''),
    componentId: 'outer',
    bounds: { x: 30, y: 30, width: 300, height: 220 },
    overrides: {},
  };
  return {
    ...createDesign(),
    elements: [instance, { ...instance, id: 'other', bounds: { ...instance.bounds, x: 380 } }],
    components: [
      {
        id: 'inner',
        name: 'Inner',
        width: 240,
        height: 160,
        template: { type: 'text', text: '', fill: '#000000' },
        elements: [
          element('text', 'title', 'Nested title'),
          element('text', 'body', 'Nested body', 70),
        ],
      },
      {
        id: 'outer',
        name: 'Outer',
        width: 300,
        height: 220,
        template: { type: 'text', text: '', fill: '#000000' },
        elements: [
          {
            ...element('instance', 'section', ''),
            componentId: 'inner',
            bounds: { x: 20, y: 20, width: 240, height: 160 },
            overrides: { body: { text: 'Retained body', typography: { bold: true } } },
          },
        ],
      },
    ],
  };
}

/** Distant invisible records must not enlarge the visible card's interaction/export geometry. */
export function styledHiddenGeometryFixture(): DesignContent {
  const d = nestedTextFixture();
  d.styles = [{ id: 'hide', name: 'Hidden', appearance: { hidden: true } }];
  d.components.push({
    ...d.components[0],
    id: 'primitive',
    elements: undefined,
    template: { type: 'text', text: 'Hidden primitive', fill: '#000000' },
  });
  const hidden = (id: string, x: number): DesignElement => ({
    ...makeDesignElement('rectangle'),
    id,
    name: id,
    styleId: 'hide',
    bounds: { x, y: x, width: 300, height: 220 },
  });
  d.elements = [
    d.elements[0],
    { ...d.elements[1], styleId: 'hide', bounds: hidden('unused', 5000).bounds },
    { ...hidden('primitive', 10000), type: 'instance', componentId: 'primitive' },
    hidden('rectangle', 15000),
    { ...hidden('parent', 20000), type: 'group' },
    { ...hidden('child', 20000), parentId: 'parent', styleId: undefined },
  ];
  return d;
}
