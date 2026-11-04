import {
  createDesign,
  makeDesignElement,
  makeDesignVector,
  type DesignContent,
} from '@editor-platform/design/model';
export const coatSource =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
// Different native src; the decoded PNG remains a valid renderable fixture.
export const replacementCoatSource = coatSource + '\n';
export function creativeDesignFixture(): DesignContent {
  return {
    ...createDesign(),
    elements: ['A', 'B'].map((id, index) => ({
      ...makeDesignElement('instance'),
      id,
      name: `Candidate ${id}`,
      componentId: 'person',
      bounds: { x: 30 + 280 * index, y: 30, width: 220, height: 300 },
    })),
    components: [
      {
        id: 'person',
        name: 'Person',
        width: 220,
        height: 300,
        template: { type: 'frame', text: '', fill: 'none' },
        elements: [
          {
            ...makeDesignElement('shape'),
            id: 'bangs',
            name: 'Bangs',
            fill: '#40352f',
            bounds: { x: 60, y: 10, width: 100, height: 50 },
          },
          {
            ...makeDesignVector({
              viewBox: { x: 0, y: 0, width: 20, height: 10 },
              paths: ['M0 0H20V10H0Z'],
              provenance: {
                source: 'local fixture',
                name: 'Eyes',
                version: '1',
                license: 'CC0',
              },
            }),
            id: 'eyes',
            name: 'Vector eyes',
            fill: '#224466',
            bounds: { x: 75, y: 90, width: 70, height: 20 },
          },
          {
            ...makeDesignElement('image'),
            id: 'coat',
            name: 'Coat',
            src: coatSource,
            bounds: { x: 45, y: 145, width: 130, height: 130 },
          },
        ],
      },
    ],
  };
}
