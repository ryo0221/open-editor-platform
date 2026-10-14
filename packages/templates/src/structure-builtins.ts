/** Additive authored recipes. Published legacy JSON and its hashes remain untouched. */
import { reuseHash } from '@editor-platform/reuse-core';
import type {
  TemplateDefinition,
  Domain,
  InputField,
  InputValue,
  NativeContent,
  RepeatBinding,
} from './types';
const field = (key: string, label: string, type: InputField['type'] = 'text'): InputField => ({
  key,
  label,
  type,
  description: label,
  required: true,
  maxLength: 180,
});
function recipe(domain: Domain, steps: boolean): TemplateDefinition {
  const title = steps ? '工程' : '比較対象',
    count = steps ? 3 : 2;
  const items: Record<string, InputValue>[] = Array.from({ length: count }, (_, i) => ({
    id: `item-${i + 1}`,
    title: `${title} ${i + 1}`,
    body: steps
      ? ['準備する', '試して確かめる', '振り返る'][i]
      : ['選択肢の特徴と判断材料', '別の選択肢と比較する観点'][i],
    image: '',
  })).map((item): Record<string, InputValue> =>
    domain === 'data'
      ? { id: item.id, title: item.title, type: 'text' }
      : domain === 'document'
        ? { id: item.id, title: item.title, body: item.body }
        : item,
  );
  const layout = {
    key: 'layout',
    label: '配置',
    description: '件数から自動配置。横・縦も選べます。収まらない場合は別配置を案内します。',
    type: 'enum' as const,
    options:
      domain === 'document' || domain === 'data'
        ? ['auto', 'vertical']
        : ['auto', 'horizontal', 'vertical'],
    default: 'auto',
  };
  const inputs: InputField[] = [
    layout,
    {
      key: 'items',
      label: title,
      description: '項目数はこの一覧から決まります。既存項目のIDは変えません。',
      type: 'list',
      required: true,
      min: 1,
      max: 6,
      default: items,
      item: {
        key: 'item',
        label: title,
        description: title,
        type: 'object',
        fields:
          domain === 'data'
            ? [
                { ...field('id', '安定ID'), maxLength: 40 },
                field('title', '列名'),
                {
                  key: 'type',
                  label: '列の型',
                  description: '型はデザイン設定とは独立です。',
                  type: 'enum',
                  required: true,
                  options: ['text', 'number', 'boolean'],
                  default: 'text',
                },
              ]
            : [
                { ...field('id', '安定ID'), maxLength: 40 },
                field('title', '見出し'),
                field('body', '説明'),
                {
                  key: 'image',
                  label: '画像',
                  description: '任意の埋め込み画像。直接編集後もnative素材を保持します。',
                  type: 'asset' as const,
                  default: '',
                },
              ].filter((f) => domain !== 'document' || f.key !== 'image'),
      },
    },
  ];
  const b = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
  let content: NativeContent,
    prototype: unknown[],
    path: RepeatBinding['path'],
    anchor: string | undefined;
  const labelRole = 'title';
  if (domain === 'slide') {
    content = {
      schemaVersion: 2,
      width: 960,
      height: 540,
      theme: { color: '#345c73', fontFamily: 'sans-serif' },
      slides: [
        {
          id: 'page',
          title: steps ? '手順' : '比較',
          background: '#ffffff',
          notes: '必要な項目を追加して、その場で編集できます。',
          objects: [
            {
              id: 'heading',
              type: 'text',
              text: steps ? '進め方を共有する' : '選択肢を比較する',
              fill: '#263c48',
              bounds: b(40, 30, 880, 50),
              typography: { fontSize: 30 },
            },
          ],
        },
      ],
    };
    prototype = [
      {
        id: 'card',
        type: 'shape',
        text: '',
        fill: '#e7eef3',
        radius: 12,
        bounds: b(40, 100, 280, 175),
      },
      {
        id: 'title',
        type: 'text',
        text: '見出し',
        fill: '#263c48',
        bounds: b(55, 112, 245, 40),
        typography: { fontSize: 24 },
      },
      {
        id: 'body',
        type: 'text',
        text: '説明',
        fill: '#263c48',
        bounds: b(55, 158, 245, 70),
        typography: { fontSize: 18 },
      },
      {
        id: 'image',
        type: 'image',
        text: '',
        fill: '#ffffff',
        src: '',
        bounds: b(55, 235, 70, 32),
      },
    ];
    path = ['slides', 0, 'objects'];
    anchor = 'page';
  } else if (domain === 'whiteboard') {
    content = {
      schemaVersion: 3,
      sections: [
        {
          id: 'section',
          title: steps ? '接続を含む手順' : '比較のセクション',
          bounds: b(0, 0, 940, 300),
          background: '#f4f7fa',
        },
      ],
      nodes: [],
      connectors: [],
    };
    prototype = [
      {
        id: 'card',
        kind: 'group',
        text: '',
        color: '#e7eef3',
        sectionId: 'section',
        bounds: b(30, 60, 260, 190),
      },
      {
        id: 'title',
        kind: 'text',
        text: '見出し',
        color: '#ffffff',
        groupId: 'card',
        bounds: b(45, 75, 225, 40),
        typography: { fontSize: 24 },
      },
      {
        id: 'body',
        kind: 'sticky',
        text: '説明',
        color: '#fff3c9',
        groupId: 'card',
        bounds: b(45, 120, 225, 100),
        typography: { fontSize: 18 },
      },
      {
        id: 'image',
        kind: 'image',
        text: '',
        color: '#ffffff',
        src: '',
        groupId: 'card',
        bounds: b(45, 222, 70, 24),
      },
    ];
    path = ['nodes'];
    anchor = 'section';
  } else if (domain === 'design') {
    content = {
      schemaVersion: 2,
      elements: [
        {
          id: 'frame',
          type: 'frame',
          name: '可変カード',
          text: '',
          fill: '#ffffff',
          bounds: b(0, 0, 940, 520),
        },
      ],
      components: [
        {
          id: 'cardComponent',
          name: '説明と画像のカード',
          width: 280,
          height: 180,
          template: { type: 'group', text: '', fill: '#e7eef3' },
          elements: [
            {
              id: 'cardTitle',
              type: 'text',
              name: '見出し',
              text: '見出し',
              fill: '#263c48',
              bounds: b(15, 15, 245, 40),
              typography: { fontSize: 24 },
            },
            {
              id: 'cardBody',
              type: 'text',
              name: '説明',
              text: '説明',
              fill: '#263c48',
              bounds: b(15, 60, 245, 80),
              typography: { fontSize: 18 },
            },
            {
              id: 'cardImage',
              type: 'image',
              name: '画像',
              text: '',
              fill: '#ffffff',
              src: '',
              bounds: b(15, 145, 70, 24),
            },
          ],
        },
      ],
    };
    prototype = [
      {
        id: 'title',
        type: 'instance',
        name: 'カード',
        text: '',
        fill: '#e7eef3',
        componentId: 'cardComponent',
        parentId: 'frame',
        bounds: b(30, 40, 280, 180),
        overrides: {
          cardTitle: { text: '見出し' },
          cardBody: { text: '説明' },
          cardImage: { src: '' },
        },
      },
    ];
    path = ['elements'];
    anchor = 'frame';
  } else if (domain === 'document') {
    content = {
      schemaVersion: 2,
      blocks: [
        { id: 'heading', type: 'heading', level: 1, text: steps ? '手順の資料' : '比較の資料' },
        {
          id: 'comparison',
          type: 'table',
          text: '',
          cells: [
            ['判断軸', '確認する内容'],
            ['目的', '実際の資料で比較する'],
          ],
          cellHeaders: [
            [true, true],
            [false, false],
          ],
        },
      ],
    };
    prototype = [
      { id: 'title', type: 'heading', level: 2, text: '見出し' },
      { id: 'body', type: 'paragraph', text: '説明' },
      {
        id: 'list',
        type: 'bulleted-list',
        text: '',
        items: [{ id: 'point', rich: [{ text: '確認事項をここで編集' }] }],
      },
    ];
    path = ['blocks'];
  } else {
    content = {
      schemaVersion: 2,
      columns: [
        { id: 'quantity', name: 'Quantity', type: 'number', defaultValue: 1 },
        { id: 'price', name: 'Price', type: 'number', defaultValue: 10 },
        { id: 'total', name: 'Total', type: 'formula', formula: '[quantity] * [price]' },
      ],
      rows: [],
    };
    prototype = [{ id: 'title', name: '追加項目', type: 'text', defaultValue: '' }];
    path = ['columns'];
  }
  const bindings =
    domain === 'design'
      ? [
          { slot: 'title', path: [0, 'name'], mode: 'text' as const },
          { slot: 'title', path: [0, 'overrides', 'cardTitle', 'text'], mode: 'text' as const },
          { slot: 'body', path: [0, 'overrides', 'cardBody', 'text'], mode: 'text' as const },
          {
            slot: 'image',
            path: [0, 'overrides', 'cardImage', 'src'],
            mode: 'asset' as const,
            optional: true,
          },
        ]
      : domain === 'data'
        ? [
            { slot: 'title', path: [0, 'name'], mode: 'text' as const },
            { slot: 'type', path: [0, 'type'], mode: 'value' as const },
          ]
        : [
            { slot: 'title', path: [domain === 'document' ? 0 : 1, 'text'], mode: 'text' as const },
            { slot: 'body', path: [domain === 'document' ? 1 : 2, 'text'], mode: 'text' as const },
            ...(domain === 'document'
              ? []
              : [{ slot: 'image', path: [3, 'src'], mode: 'asset' as const, optional: true }]),
          ];
  const unit = {
    slide: 'ページ',
    whiteboard: 'セクションと図解',
    design: '複合部品のフレーム',
    document: '見出し付き本文',
    data: '型付き列セット',
    review: '表示設定',
    file: '表示設定',
  }[domain];
  const unsigned: Omit<TemplateDefinition, 'hash'> = {
    schemaVersion: 1,
    templateId: `${domain}-variable-${steps ? 'steps' : 'comparison'}`,
    templateVersion: 1,
    name: `可変${steps ? '手順' : '比較'}・${unit}`,
    description: '追加後は成果物上で直接編集し、項目を追加・削除・並べ替えできます。',
    purpose: steps ? '工程を増やして進め方を共有' : '比較対象を増やして判断材料を整理',
    category: '可変構成',
    tags: [domain, unit, steps ? '手順' : '比較', '直接編集'],
    locales: ['ja', 'en'],
    domain,
    kind: 'fragment',
    artifactSchema: 2,
    capabilities: [
      'native-content',
      'typed-inputs',
      'repeat-layout',
      'checked-apply',
      'variable-composition',
    ],
    targets: [],
    content,
    inputs,
    sample: { layout: 'auto', items },
    bindings: [],
    repeats: [{ slot: 'items', path, prototype, bindings, append: true, stepX: 300, stepY: 190 }],
    assets: [],
    overflow: { policy: domain === 'slide' ? 'error' : 'expand', maxItems: 6, minFontSize: 12 },
    preview: { renderer: 'native', description: unit },
    structure: {
      schemaVersion: 1,
      unit,
      repeat: 0,
      itemId: 'id',
      labelRole,
      min: 1,
      max: 6,
      columns: 3,
      layoutSlot: 'layout',
      ...(['slide', 'whiteboard', 'design'].includes(domain)
        ? {
            appearance:
              domain === 'design'
                ? {
                    emphasis: 'title/cardTitle',
                    description: 'title/cardBody',
                    image: 'title/cardImage',
                  }
                : { emphasis: 'title', description: 'body', image: 'image' },
          }
        : {}),
      ...(anchor ? { anchor } : {}),
      ...(domain === 'whiteboard' && steps ? { flowRole: 'card' } : {}),
    },
  };
  unsigned.artifactSchema = content.schemaVersion;
  return { ...unsigned, hash: reuseHash(unsigned) };
}
export const structureTemplates = (
  ['slide', 'whiteboard', 'design', 'document', 'data'] as Domain[]
).flatMap((domain) => [recipe(domain, false), recipe(domain, true)]);

const zoomPreset: Omit<TemplateDefinition, 'hash'> = {
  schemaVersion: 1,
  templateId: 'file-authored-zoom',
  templateVersion: 1,
  name: '原本を倍率指定で表示',
  description: '表示倍率と注釈表示を指定し、原本と既存注釈を保持します。',
  purpose: '原本の細部を確認する',
  category: '表示設定',
  tags: ['file', '表示倍率', '表示設定'],
  locales: ['ja'],
  domain: 'file',
  kind: 'preset',
  artifactSchema: 2,
  capabilities: ['typed-inputs', 'checked-apply'],
  targets: ['view'],
  preset: { scope: 'view', fields: { fit: 'actual', zoom: 1, annotations: true } },
  inputs: [
    {
      key: 'zoom',
      label: '表示倍率',
      description: '1は100%。0.05〜4倍。原本bytesを変更しません。',
      type: 'number',
      required: true,
      min: 0.05,
      max: 4,
      default: 1,
    },
    {
      key: 'annotations',
      label: '注釈を表示',
      description: '既存注釈は保持します。',
      type: 'boolean',
      default: true,
    },
  ],
  sample: { zoom: 1, annotations: true },
  bindings: [
    { slot: 'zoom', path: ['fields', 'zoom'], mode: 'value' },
    { slot: 'annotations', path: ['fields', 'annotations'], mode: 'value' },
  ],
  repeats: [],
  assets: [],
  overflow: { policy: 'error', maxItems: 1, minFontSize: 12 },
  preview: { renderer: 'native', description: '個人の表示倍率' },
};
export const authoredViewTemplates: TemplateDefinition[] = [
  { ...zoomPreset, hash: reuseHash(zoomPreset) },
];
