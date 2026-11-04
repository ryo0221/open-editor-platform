import type {
  DesignContent,
  DesignElement,
  DesignRasterProvenance,
} from '@editor-platform/design/model';
import type { CreativePartGroup } from './types';

/** An optional Host preset. Native Design has no fixed location hierarchy. */
export const settingGroups: readonly CreativePartGroup[] = [
  {
    id: 'group-building',
    label: '建物',
    parts: [
      { id: 'wall', label: '外壁' },
      { id: 'roof', label: '屋根' },
      { id: 'windows', label: '窓' },
      { id: 'door', label: '扉' },
    ],
  },
  {
    id: 'group-interior',
    label: '室内',
    parts: [{ id: 'furniture', label: '家具' }],
  },
  {
    id: 'group-background',
    label: '背景',
    parts: [
      { id: 'sky', label: '空' },
      { id: 'background', label: '遠景' },
    ],
  },
];
export const settingComponentId = 'component-setting';

const outline = '#544e4b';
const source = 'Artifact Host sample / 自作の舞台ラフ';
const license = 'Host sample: self-authored rough; repository licensing applies';
type BackgroundKind = 'day' | 'night' | 'interior' | 'winter';

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

function part(
  id: string,
  groupId: string,
  bounds: DesignElement['bounds'],
  fill: string,
  extra: Partial<DesignElement> = {},
): DesignElement {
  const name = settingGroups.flatMap((group) => group.parts).find((item) => item.id === id)!.label;
  return element(id, 'shape', name, bounds, fill, {
    parentId: groupId,
    shape: 'rectangle',
    stroke: outline,
    strokeWidth: 1.6,
    ...extra,
  });
}

function vector(
  id: string,
  groupId: string,
  bounds: DesignElement['bounds'],
  fill: string,
  paths: string[],
): DesignElement {
  return part(id, groupId, bounds, fill, {
    vector: {
      viewBox: { x: 0, y: 0, width: 100, height: 100 },
      paths,
      provenance: { source, name: `${id} / 自作の舞台ラフ`, version: '1', license },
    },
  });
}

/** Inert, self-authored embedded image bytes. No remote assets or external license claims. */
function background(kind: BackgroundKind): DesignRasterProvenance {
  const drawings: Record<BackgroundKind, string> = {
    day: '<circle cx="352" cy="46" r="20" fill="#f9df9a"/><path fill="#a6c0bc" d="M0 138 65 88l69 56 63-48 99 56 72-65 52 45v168H0Z"/><path fill="#8ab4c5" d="M0 170q100-14 210 0t210 0v130H0Z"/><path fill="#97aa87" d="M0 240q92-41 210-9t210-3v72H0Z"/><path fill="none" stroke="#dce8e8" stroke-width="2" d="M22 193h77m215-3h66M10 216h51m286-5h61"/>',
    night:
      '<circle cx="352" cy="46" r="20" fill="#f0e5ba"/><path fill="#283f5a" d="M0 138 65 88l69 56 63-48 99 56 72-65 52 45v168H0Z"/><path fill="#264b67" d="M0 170q100-14 210 0t210 0v130H0Z"/><path fill="#3b514c" d="M0 240q92-41 210-9t210-3v72H0Z"/><g fill="#f1e9cd"><circle cx="45" cy="31" r="1.7"/><circle cx="116" cy="58" r="1.7"/><circle cx="222" cy="24" r="1.7"/><circle cx="290" cy="68" r="1.7"/></g>',
    interior:
      '<path fill="#efe2cd" d="M0 0h420v205H0Z"/><path fill="#c7a47e" d="M0 205h420v95H0Z"/><path fill="none" stroke="#ad8864" stroke-width="2" d="M0 238h420M0 270h420M74 205 55 300M180 205l-6 95m118-95 17 95"/><path fill="#f6f0df" stroke="#c7ad89" stroke-width="4" d="M285 35h80v110h-80Z"/><path fill="#bed8dd" d="M294 44h62v92h-62Z"/><path stroke="#f6f0df" stroke-width="4" d="M325 44v92m-31-46h62"/>',
    winter:
      '<circle cx="352" cy="46" r="18" fill="#f7efd9"/><path fill="#c4d0d7" d="M0 138 65 88l69 56 63-48 99 56 72-65 52 45v168H0Z"/><path fill="#a6becb" d="M0 170q100-14 210 0t210 0v130H0Z"/><path fill="#edf1ed" d="M0 240q92-41 210-9t210-3v72H0Z"/><g fill="#fff"><circle cx="42" cy="48" r="3"/><circle cx="103" cy="116" r="3"/><circle cx="215" cy="34" r="3"/><circle cx="315" cy="144" r="3"/><circle cx="385" cy="103" r="3"/></g>',
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="300" viewBox="0 0 420 300">${drawings[kind]}</svg>`;
  const src = `data:image/svg+xml;base64,${btoa(svg)}`;
  return { src, source, license, name: `${kind} / 自作の舞台遠景`, version: '1' };
}

function componentParts(): DesignElement[] {
  const group = (id: string) =>
    element(
      id,
      'group',
      settingGroups.find((item) => item.id === id)!.label,
      { x: 0, y: 0, width: 420, height: 300 },
      'none',
    );
  const day = background('day');
  // Native paint order: the house conceals the furniture until the interior candidate opens it.
  return [
    group('group-background'),
    part('sky', 'group-background', { x: 0, y: 0, width: 420, height: 300 }, '#d8eaf0', {
      strokeWidth: 0,
    }),
    element('background', 'image', '遠景', { x: 0, y: 0, width: 420, height: 300 }, 'none', {
      parentId: 'group-background',
      src: day.src,
      provenance: day,
      imageFit: 'fit',
    }),
    group('group-interior'),
    vector('furniture', 'group-interior', { x: 156, y: 175, width: 114, height: 85 }, '#95694d', [
      'M12 30H88V45H12Z',
      'M18 45H27V100H18Z',
      'M73 45H82V100H73Z',
      'M0 0H10V64H35V75H10V100H0Z',
      'M90 0H100V100H90V75H65V64H90Z',
    ]),
    group('group-building'),
    part('wall', 'group-building', { x: 108, y: 127, width: 204, height: 141 }, '#e1c8a7'),
    vector('roof', 'group-building', { x: 83, y: 74, width: 254, height: 78 }, '#9f6557', [
      'M0 100 17 72 50 0 83 72 100 100Z',
    ]),
    vector('windows', 'group-building', { x: 130, y: 163, width: 160, height: 57 }, '#a6c9d1', [
      'M0 0H30V43H0Z',
      'M0 57H30V100H0Z',
      'M38 0H50V43H38Z',
      'M38 57H50V100H38Z',
      'M64 0H76V43H64Z',
      'M64 57H76V100H64Z',
      'M84 0H100V43H84Z',
      'M84 57H100V100H84Z',
    ]),
    part('door', 'group-building', { x: 191, y: 188, width: 37, height: 80 }, '#86614c', {
      shape: 'rounded-rectangle',
      radius: 3,
    }),
  ];
}

export function createSettingDesign(name: string): DesignContent {
  const candidates = [
    { id: 'candidate-1', label: '全景・昼', kind: 'day' },
    { id: 'candidate-2', label: '全景・夜', kind: 'night' },
    { id: 'candidate-3', label: '室内', kind: 'interior' },
    { id: 'candidate-4', label: '冬', kind: 'winter' },
  ] as const;
  return {
    schemaVersion: 2,
    elements: candidates.flatMap((candidate, index) => {
      const x = 32 + index * 484;
      const provenance = background(candidate.kind);
      const overrides: NonNullable<DesignElement['overrides']> = {};
      if (candidate.kind !== 'day') overrides.background = { src: provenance.src, provenance };
      if (candidate.kind === 'night') {
        overrides.sky = { fill: '#172d49' };
        overrides.windows = { fill: '#ffe0a0' };
        overrides.wall = { fill: '#9e9c9d' };
      } else if (candidate.kind === 'interior') {
        overrides.sky = { fill: '#efe2cd' };
        for (const id of ['wall', 'roof', 'windows', 'door']) overrides[id] = { hidden: true };
        overrides.furniture = { bounds: { x: 92, y: 116, width: 236, height: 140 } };
      } else if (candidate.kind === 'winter') {
        overrides.sky = { fill: '#e1e9ed' };
        overrides.roof = { fill: '#edf1ed' };
      }
      return [
        element(
          candidate.id,
          'frame',
          `${name} / ${candidate.label}`,
          { x, y: 32, width: 452, height: 378 },
          '#fbf8f2',
          { stroke: '#d9d1c5', strokeWidth: 1, clipContent: true },
        ),
        element(
          `label-${candidate.id}`,
          'text',
          candidate.label,
          { x: x + 16, y: 48, width: 420, height: 30 },
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
          { x: x + 16, y: 88, width: 420, height: 300 },
          'none',
          {
            parentId: candidate.id,
            componentId: settingComponentId,
            ...(Object.keys(overrides).length ? { overrides } : {}),
          },
        ),
      ];
    }),
    components: [
      {
        id: settingComponentId,
        name: `${name} / 共有の舞台ラフ`,
        width: 420,
        height: 300,
        template: { type: 'group', text: '', fill: 'none' },
        elements: componentParts(),
      },
    ],
  };
}
