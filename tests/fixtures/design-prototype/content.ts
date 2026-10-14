import {
  createDesign,
  makeDesignElement,
  type DesignContent,
  type DesignElement,
  type DesignPrototypeAction,
} from '@editor-platform/design/model';
export function prototypeFixture(): DesignContent {
  const f = (id: string, index: number, width = 600, height = 400): DesignElement => ({
    ...makeDesignElement('frame'),
    id,
    name: id,
    bounds: { x: index * 800, y: 100, width, height },
    clipContent: true,
  });
  const frames = [
    f('Home', 0),
    f('Review', 1),
    f('State', 2),
    f('Dialog', 3, 300, 180),
    f('Done', 4),
  ];
  const button = (
    id: string,
    owner: string,
    x: number,
    action?: DesignPrototypeAction,
  ): DesignElement => {
    const frame = frames.find((f) => f.id === owner)!;
    return {
      ...makeDesignElement('rectangle'),
      id,
      name: id,
      parentId: owner,
      bounds: { x: frame.bounds.x + x, y: frame.bounds.y + 140, width: 160, height: 48 },
      text: id === 'Close dialog' ? 'Close' : id,
      typography: { fontSize: 18 },
      ...(action ? { interactions: [{ trigger: 'click', action }] } : {}),
    };
  };
  const root = {
    ...makeDesignElement('group'),
    id: 'root',
    name: 'Button group',
    bounds: { x: 0, y: 0, width: 150, height: 48 },
  };
  const part = {
    ...makeDesignElement('rectangle'),
    id: 'button/part',
    name: 'Continue',
    parentId: 'root',
    bounds: { x: 0, y: 0, width: 150, height: 48 },
    text: 'Continue',
    typography: { fontSize: 20 },
    interactions: [
      { trigger: 'click' as const, action: { type: 'navigate' as const, frameId: 'Done' } },
    ],
  };
  return {
    ...createDesign(),
    components: [
      {
        id: 'button-component',
        name: 'Button',
        width: 150,
        height: 48,
        template: { type: 'rectangle', text: '', fill: '#d4e3cf' },
        elements: [root, part],
      },
    ],
    elements: [
      ...frames,
      {
        ...button('next/instance', 'Home', 40),
        type: 'instance',
        text: '',
        componentId: 'button-component',
        overrides: {
          'button/part': {
            interactions: [{ trigger: 'click', action: { type: 'navigate', frameId: 'Review' } }],
          },
        },
      },
      button('No link', 'Home', 250),
      button('Show state', 'Review', 40, { type: 'switch', frameId: 'State' }),
      button('Go back', 'State', 40, { type: 'back' }),
      button('Open dialog', 'State', 240, { type: 'open-overlay', frameId: 'Dialog' }),
      {
        ...button('Close dialog', 'Dialog', 20, { type: 'close-overlay' }),
        bounds: { x: frames[3].bounds.x + 20, y: 140, width: 110, height: 44 },
      },
      {
        ...button('Finish', 'Dialog', 160, { type: 'navigate', frameId: 'Done' }),
        bounds: { x: frames[3].bounds.x + 160, y: 140, width: 110, height: 44 },
      },
    ],
    prototyping: {
      schemaVersion: 1,
      startFrameId: 'Home',
      flows: [
        {
          id: 'happy',
          name: 'Five screen flow',
          frameIds: ['Home', 'Review', 'State', 'Dialog', 'Done'],
        },
      ],
    },
  };
}
