import type {
  DesignContent,
  DesignElement,
  DesignRasterProvenance,
} from '@editor-platform/design/model';
import type { CreativePartGroup } from './types';

/** A Host example, not a required character hierarchy in the Design model. */
export const characterGroups: readonly CreativePartGroup[] = [
  {
    id: 'group-face',
    label: '顔',
    parts: [
      { id: 'face-base', label: '輪郭' },
      { id: 'eyes', label: '目' },
      { id: 'eyebrows', label: '眉' },
      { id: 'nose', label: '鼻' },
      { id: 'mouth', label: '口' },
      { id: 'ears', label: '耳' },
    ],
  },
  {
    id: 'group-hair',
    label: '髪',
    parts: [
      { id: 'hair-front', label: '前髪' },
      { id: 'hair-back', label: '後髪' },
    ],
  },
  {
    id: 'group-body',
    label: '身体',
    parts: [
      { id: 'torso', label: '胴体' },
      { id: 'arms', label: '腕' },
      { id: 'legs', label: '脚' },
    ],
  },
  {
    id: 'group-clothes',
    label: '服装',
    parts: [
      { id: 'outerwear', label: '上着' },
      { id: 'innerwear', label: '下着' },
      { id: 'clothing-decoration', label: '装飾' },
    ],
  },
  {
    id: 'group-accessories',
    label: '小物',
    parts: [
      { id: 'hat', label: '帽子' },
      { id: 'accessory', label: 'アクセサリー' },
    ],
  },
];
export const characterComponentId = 'component-character';

const outline = '#443e4d';
const skin = '#f2d3be';
const hair = '#57475c';
const source = 'Artifact Host sample / 自作キャラクターラフ';
const license = 'Host sample: self-authored rough; repository licensing applies';

function element(
  id: string,
  type: DesignElement['type'],
  name: string,
  bounds: DesignElement['bounds'],
  fill: string,
  extra: Partial<DesignElement> = {},
): DesignElement {
  return { id, type, name, bounds, text: '', fill, ...extra };
}
function shape(
  id: string,
  parentId: string,
  bounds: DesignElement['bounds'],
  fill: string,
  extra: Partial<DesignElement> = {},
): DesignElement {
  const name = characterGroups
    .flatMap((group) => group.parts)
    .find((part) => part.id === id)!.label;
  return element(id, 'shape', name, bounds, fill, {
    parentId,
    shape: 'ellipse',
    stroke: outline,
    strokeWidth: 1.8,
    ...extra,
  });
}
function vector(
  id: string,
  parentId: string,
  bounds: DesignElement['bounds'],
  fill: string,
  paths: string[],
): DesignElement {
  return shape(id, parentId, bounds, fill, {
    vector: {
      viewBox: { x: 0, y: 0, width: 100, height: 100 },
      paths,
      provenance: { source, name: `${id} / 自作ラフ`, version: '1', license },
    },
  });
}

/** Self-authored, inert image bytes: no remote asset or external license claim. */
function jacket(kind: 'uniform' | 'casual' | 'battle'): DesignRasterProvenance {
  const drawings = {
    uniform:
      '<path fill="#435b8b" d="M30 8 45 0h30l15 8 28 37-20 14-8-18v99H30V41L22 59 2 45Z"/><path fill="#f5f2df" d="m45 0 15 25L75 0 68 50H52Z"/><path fill="#b85965" d="m60 23 7 12-7 30-7-30Z"/><path d="M60 65v75M39 88h12M69 88h12"/>',
    casual:
      '<path fill="#ce986d" d="M30 8 43 0h34l13 8 28 37-20 14-8-18v99H30V41L22 59 2 45Z"/><path fill="#f3e6d7" d="m43 0 17 30L77 0 70 72H50Z"/><path d="m43 0-7 32 17 10M77 0l7 32-17 10M60 72v68"/><path fill="#805a48" d="M37 85h17v21H37Zm29 0h17v21H66Z"/>',
    battle:
      '<path fill="#536c67" d="M30 8 43 0h34l13 8 28 37-20 14-8-18v99H30V41L22 59 2 45Z"/><path fill="#8a9e99" d="m43 0 17 12L77 0l8 22-10 53H45L35 22Z"/><path fill="#384b4a" d="M30 83h60v18H30Z"/><path fill="#d5b36c" d="M55 83h10v18H55Z"/><path d="m43 14 17 12 17-12M60 26v48M38 112h44"/>',
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="142" viewBox="0 0 120 142"><g stroke="#443e4d" stroke-width="2" stroke-linejoin="round" fill="none">${drawings[kind]}</g></svg>`;
  const src = `data:image/svg+xml;base64,${btoa(svg)}`;
  return { src, source, license, name: `${kind} / 自作上着ラフ`, version: '1' };
}

function componentParts(): DesignElement[] {
  const group = (id: string) => {
    const entry = characterGroups.find((item) => item.id === id)!;
    return element(id, 'group', entry.label, { x: 0, y: 0, width: 260, height: 460 }, 'none');
  };
  const uniform = jacket('uniform');
  // Native paint order keeps the body behind the face, hair and clothing.
  return [
    group('group-body'),
    vector('legs', 'group-body', { x: 91, y: 297, width: 78, height: 138 }, '#697084', [
      'M4 0H96L88 89 100 96V100H56L52 32H48L44 100H0V96L12 89Z',
    ]),
    vector('torso', 'group-body', { x: 87, y: 151, width: 86, height: 168 }, skin, [
      'M36 0H64V15L87 24 100 100H0L13 24 36 15Z',
    ]),
    vector('arms', 'group-body', { x: 48, y: 181, width: 164, height: 143 }, skin, [
      'M14 0 27 4 18 91 12 100 3 98 0 90Z',
      'M86 0 73 4 82 91 88 100 97 98 100 90Z',
    ]),
    group('group-face'),
    vector('ears', 'group-face', { x: 77, y: 103, width: 106, height: 29 }, skin, [
      'M13 8C-3-12-4 88 15 95Z',
      'M87 8C103-12 104 88 85 95Z',
    ]),
    shape('face-base', 'group-face', { x: 85, y: 57, width: 90, height: 112 }, skin),
    vector('eyes', 'group-face', { x: 100, y: 105, width: 60, height: 17 }, '#587c99', [
      'M0 46Q14 0 30 46 14 100 0 46Z',
      'M70 46Q86 0 100 46 86 100 70 46Z',
    ]),
    vector('eyebrows', 'group-face', { x: 98, y: 93, width: 64, height: 5 }, hair, [
      'M0 80 29 0 31 30 1 100Z',
      'M69 30 71 0 100 80 99 100Z',
    ]),
    vector('nose', 'group-face', { x: 127, y: 119, width: 7, height: 15 }, '#d9ac99', [
      'M40 0 0 90 100 100',
    ]),
    vector('mouth', 'group-face', { x: 118, y: 144, width: 24, height: 5 }, '#b77473', [
      'M0 0Q50 100 100 0Q50 60 0 0Z',
    ]),
    group('group-hair'),
    vector('hair-back', 'group-hair', { x: 72, y: 47, width: 116, height: 137 }, hair, [
      'M15 10Q-8 39 5 100L19 86 16 44 28 3Z',
      'M85 10Q108 39 95 100L81 86 84 44 72 3Z',
    ]),
    vector('hair-front', 'group-hair', { x: 80, y: 43, width: 100, height: 65 }, hair, [
      'M0 72Q-2 0 50 0 102 0 100 72L85 60 83 94 63 57 47 100 35 62 16 94 15 62Z',
    ]),
    group('group-clothes'),
    shape('innerwear', 'group-clothes', { x: 94, y: 179, width: 72, height: 124 }, '#eee6d8', {
      shape: 'rounded-rectangle',
      radius: 6,
    }),
    element('outerwear', 'image', '上着', { x: 70, y: 174, width: 120, height: 142 }, 'none', {
      parentId: 'group-clothes',
      src: uniform.src,
      provenance: uniform,
      imageFit: 'fit',
    }),
    shape(
      'clothing-decoration',
      'group-clothes',
      { x: 126, y: 253, width: 8, height: 8 },
      '#d7bc77',
      { shape: 'diamond', strokeWidth: 1 },
    ),
    group('group-accessories'),
    shape('hat', 'group-accessories', { x: 100, y: 28, width: 60, height: 22 }, '#435b8b', {
      shape: 'rounded-rectangle',
      radius: 6,
      hidden: true,
    }),
    shape('accessory', 'group-accessories', { x: 171, y: 124, width: 7, height: 12 }, '#d7bc77', {
      shape: 'diamond',
      strokeWidth: 1,
    }),
  ];
}

export function createCharacterDesign(name: string): DesignContent {
  const candidates = [
    { id: 'candidate-1', label: '制服', kind: 'uniform' },
    { id: 'candidate-2', label: '私服', kind: 'casual' },
    { id: 'candidate-3', label: '戦闘服', kind: 'battle' },
  ] as const;
  return {
    schemaVersion: 2,
    elements: candidates.flatMap((candidate, index) => {
      const x = 32 + index * 324;
      const provenance = jacket(candidate.kind);
      return [
        element(
          candidate.id,
          'frame',
          `${name} / ${candidate.label}`,
          {
            x,
            y: 32,
            width: 292,
            height: 526,
          },
          '#fbf8f2',
          { stroke: '#d9d1c5', strokeWidth: 1, clipContent: true },
        ),
        element(
          `label-${candidate.id}`,
          'text',
          candidate.label,
          {
            x: x + 16,
            y: 48,
            width: 260,
            height: 30,
          },
          outline,
          {
            parentId: candidate.id,
            text: candidate.label,
            typography: { fontSize: 18, bold: true, align: 'center' },
          },
        ),
        element(
          `instance-${candidate.id}`,
          'instance',
          `${name} / ${candidate.label}`,
          {
            x: x + 16,
            y: 86,
            width: 260,
            height: 460,
          },
          'none',
          {
            parentId: candidate.id,
            componentId: characterComponentId,
            // Clothing differs locally; the face, hair and body continue to inherit.
            overrides: { outerwear: { src: provenance.src, provenance } },
          },
        ),
      ];
    }),
    components: [
      {
        id: characterComponentId,
        name: `${name} / 共有の人物ラフ`,
        width: 260,
        height: 460,
        template: { type: 'group', text: '', fill: 'none' },
        elements: componentParts(),
      },
    ],
  };
}
