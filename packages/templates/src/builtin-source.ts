/** Authored version-1 native definitions. Build-time catalog materialization freezes their hashes. */
import type { SlideContent, Slide, SlideObject } from '@editor-platform/slide/model';
import type { WhiteboardContent, WhiteboardNode } from '@editor-platform/whiteboard/model';
import type { DesignContent, DesignElement } from '@editor-platform/design/model';
import type { DocumentContent, DocumentBlock } from '@editor-platform/document/model';
import type { StructuredData, Column } from '@editor-platform/structured-data/model';
import { defaultView } from '@editor-platform/structured-data/views';
import { sealDefinition } from './engine';
import { contentHash } from '@editor-platform/artifact-core';
import {
  type TemplateDefinition,
  type InputField,
  type Binding,
  type Domain,
  type InputValue,
} from './types';
type Draft = Omit<TemplateDefinition, 'hash'>;
const text = (key: string, label: string, example: string, maxLength = 120): InputField => ({
  key,
  label,
  description: `${label}を編集可能な本文へ展開します。`,
  type: 'text',
  required: true,
  example,
  default: example,
  maxLength,
});
const list = (key: string, label: string, example: string[], max = 12): InputField => ({
  key,
  label,
  description: `${label}の各項目。空の一覧も利用できます。`,
  type: 'list',
  min: 0,
  max,
  item: { ...text('item', '項目', '', 180), required: false },
  default: example,
  example,
});
const title = text('title', 'タイトル', '新しい取り組み', 64);
const summary = text('summary', '概要', '目的と判断材料を、読み手に伝わる形で整理します。', 220);
const image: InputField = {
  key: 'image',
  label: '画像（任意）',
  description: '画像を選択。省略すると画像枠を除去します。',
  type: 'asset',
  required: false,
  default: '',
  example: '',
};
const chart: InputField = {
  key: 'chart',
  label: '集計データ',
  description: 'ラベルと数値からnative chartを作ります。',
  type: 'chart',
  min: 1,
  max: 8,
  item: {
    key: 'point',
    label: '集計',
    description: '',
    type: 'object',
    fields: [
      text('label', 'ラベル', '', 14),
      {
        key: 'value',
        label: '値',
        description: '数値',
        type: 'number',
        required: true,
        min: 0,
        max: 10000,
      },
    ],
  },
  default: [
    { label: '導入前', value: 35 },
    { label: '試行', value: 62 },
    { label: '導入後', value: 84 },
  ],
};
function base(
  domain: Domain,
  id: string,
  name: string,
  purpose: string,
  inputs: InputField[],
  kind: TemplateDefinition['kind'] = 'whole',
): Draft {
  return {
    schemaVersion: 1,
    templateId: `${domain}-${id}`,
    templateVersion: 1,
    name,
    description: purpose,
    purpose,
    category:
      domain === 'data' ? '業務の整理' : domain === 'design' ? '画面設計' : '伝える・考える',
    tags: [id, domain],
    locales: ['ja', 'en'],
    domain,
    kind,
    artifactSchema: domain === 'whiteboard' ? 3 : 2,
    capabilities: ['native-content', 'typed-inputs', 'repeat-layout', 'checked-apply'],
    targets: [
      kind === 'whole' ? 'new-artifact' : kind === 'preset' ? 'selection' : 'insertion-anchor',
    ],
    inputs,
    sample: Object.fromEntries(
      inputs
        .filter((f) => f.example !== undefined || f.default !== undefined)
        .map((f) => [f.key, f.example ?? f.default!]),
    ),
    bindings: [],
    repeats: [],
    assets: [],
    overflow: {
      policy:
        domain === 'document'
          ? 'reflow'
          : domain === 'whiteboard' || domain === 'design'
            ? 'expand'
            : 'error',
      maxItems: 40,
      minFontSize: 16,
    },
    preview: { renderer: 'native', description: '実際の入力とnative contentから描画' },
  };
}
const binding = (
  slot: string,
  path: (string | number)[],
  mode: Binding['mode'] = 'text',
): Binding => ({ slot, path, mode });
const typography = { fontFamily: 'sans-serif', fontSize: 22, lineHeight: 1.3 };
function box(
  id: string,
  textValue: string,
  x: number,
  y: number,
  width: number,
  height: number,
  size = 22,
): SlideObject {
  return {
    id,
    type: 'text',
    bounds: { x, y, width, height },
    text: textValue,
    fill: '#1f3544',
    typography: { ...typography, fontSize: size },
  };
}
function page(id: string, name: string, objects: SlideObject[]): Slide {
  return { id, title: name, background: '#f8faf8', objects };
}
function cover(): Slide {
  return page('cover', '表紙', [
    box('headline', '', 64, 85, 830, 135, 40),
    box('intro', '', 68, 240, 810, 150, 24),
  ]);
}
function slideDefs(): Draft[] {
  const result: Draft[] = [];
  const names = [
    ['proposal', '企画提案', '課題・選択肢・次の一歩を3ページで提案'],
    ['progress', '進捗報告', '期間別の指標と完了・次の対応を報告'],
    ['product', '製品紹介', '製品の特長をページごとに紹介'],
    ['comparison', '選択肢比較', '左右の条件・利点を比較し結論を共有'],
    ['research', '調査結果報告', '集計グラフと観察結果を区別して報告'],
  ];
  for (const [id, name, purpose] of names) {
    const a = base('slide', id, name, purpose, [
      { ...title, default: name, example: name },
      summary,
    ]);
    const slides = [cover()];
    a.bindings = [
      binding('title', ['slides', 0, 'objects', 0, 'text']),
      binding('summary', ['slides', 0, 'objects', 1, 'text']),
    ];
    if (id === 'comparison' || id === 'proposal') {
      const left: InputField = {
        key: 'left',
        label: id === 'proposal' ? '現状' : '選択肢A',
        description: '左の比較欄',
        type: 'object',
        fields: [
          text('title', '見出し', id === 'proposal' ? '現在の課題' : '小さく試す', 32),
          list('items', '項目', ['準備期間が短い', '仮説を検証できる', '運用負担を抑える'], 4),
        ],
      };
      const right: InputField = {
        ...left,
        key: 'right',
        label: id === 'proposal' ? '提案' : '選択肢B',
        fields: [
          text('title', '見出し', id === 'proposal' ? '改善の提案' : '一括で導入', 32),
          list('items', '項目', ['広い範囲をカバー', '仕組みを統一する', '初期調整が必要'], 4),
        ],
      };
      a.inputs.push(
        left,
        right,
        text('conclusion', '結論', 'まず試行し、得られた結果から次の範囲を決めます。', 200),
      );
      slides.push(
        page('comparison', '左右比較', [
          box('left-title', '', 55, 45, 405, 75, 30),
          box('right-title', '', 505, 45, 405, 75, 30),
          box('left-items', '', 55, 145, 405, 330),
          box('right-items', '', 505, 145, 405, 330),
        ]),
      );
      slides.push(
        page('conclusion', '結論', [
          box('conclusion-heading', '次の一歩', 65, 60, 820, 80, 34),
          box('conclusion-body', '', 65, 190, 820, 240, 28),
        ]),
      );
      for (const [slot, idx] of [
        ['left.title', 0],
        ['right.title', 1],
        ['left.items', 2],
        ['right.items', 3],
      ] as const)
        a.bindings.push(binding(slot, ['slides', 1, 'objects', idx, 'text']));
      a.bindings.push(binding('conclusion', ['slides', 2, 'objects', 1, 'text']));
      a.sample.left = {
        title: '小さく試す',
        items: ['準備期間が短い', '仮説を検証できる', '運用負担を抑える'],
      };
      a.sample.right = {
        title: '一括で導入',
        items: ['広い範囲をカバー', '仕組みを統一する', '初期調整が必要'],
      };
    } else if (id === 'product') {
      a.inputs.push(
        image,
        list(
          'features',
          '特長',
          ['使い始めやすい', '情報を見つけやすい', 'チームで改善できる'],
          12,
        ),
      );
      slides[0].objects[1].bounds.width = 470;
      slides[0].objects.push({
        ...box('product-image', '', 575, 240, 310, 220),
        type: 'image',
        src: '',
        imageFit: 'fit',
      });
      a.bindings.push({
        ...binding('image', ['slides', 0, 'objects', 2, 'src'], 'asset'),
        optional: true,
      });
      a.repeats.push({
        slot: 'features',
        path: ['slides'],
        prototype: [
          page('feature', '製品の特長', [
            box('feature-label', 'FEATURE', 65, 70, 820, 80, 26),
            box('feature-copy', '', 65, 210, 820, 220, 32),
          ]),
        ],
        bindings: [binding('$', [0, 'objects', 1, 'text'])],
        append: true,
      });
      a.overflow.policy = 'paginate';
    } else {
      a.inputs.push(
        chart,
        list(
          'findings',
          id === 'progress' ? '対応と次の予定' : '観察と示唆',
          ['小規模の試行で改善を確認', '利用者の声を継続して集める', '次の検証で判断を更新する'],
          20,
        ),
      );
      slides.push(
        page('metrics', '指標', [
          box(
            'metrics-heading',
            id === 'progress' ? '進捗指標' : '調査データ',
            65,
            35,
            820,
            70,
            32,
          ),
          {
            ...box('metrics-chart', '', 65, 140, 820, 330),
            type: 'chart',
            chart: { label: '集計', labels: [], values: [], capturedAt: '2000-01-01T00:00:00Z' },
          },
        ]),
      );
      a.bindings.push(binding('chart', ['slides', 1, 'objects', 1, 'chart'], 'chart'));
      a.repeats.push({
        slot: 'findings',
        path: ['slides'],
        prototype: [
          page('findings', '次のアクション', [
            box(
              'findings-heading',
              id === 'progress' ? '次の予定' : '観察と示唆',
              65,
              55,
              820,
              80,
              32,
            ),
            box('findings-body', '', 65, 160, 820, 300, 24),
          ]),
        ],
        bindings: [binding('$', [0, 'objects', 1, 'text'])],
        chunkSize: 4,
        append: true,
      });
      a.overflow.policy = 'paginate';
    }
    for (const f of a.inputs)
      if (a.sample[f.key] === undefined && f.default !== undefined) a.sample[f.key] = f.default;
    a.content = {
      schemaVersion: 2,
      width: 960,
      height: 540,
      theme: { color: '#386652', fontFamily: 'sans-serif' },
      slides,
    } satisfies SlideContent;
    result.push(a);
  }
  return result;
}
function wbNode(
  id: string,
  textValue: string,
  x: number,
  y: number,
  sectionId: string,
  kind: WhiteboardNode['kind'] = 'sticky',
): WhiteboardNode {
  return {
    id,
    kind,
    bounds: { x, y, width: 300, height: 160 },
    text: textValue,
    color: kind === 'sticky' ? '#f5e5aa' : '#dcebe8',
    sectionId,
    typography: { ...typography, fontSize: 20 },
  };
}
function boardDefs(): Draft[] {
  const specs = [
    [
      'brainstorm',
      'ブレインストーミング',
      ['発想', 'まとめ', '試す'],
      '発散したアイデアを分類して小さな実験へ',
    ],
    ['kpt', 'KPT振り返り', ['Keep', 'Problem', 'Try'], '継続・課題・次の試行をSectionで分離'],
    [
      'journey',
      'カスタマージャーニー',
      ['見つける', '比較する', '試す', '使い続ける', '勧める'],
      '体験の段階を接続し、観察を付箋で記録',
    ],
    [
      'issues',
      '課題整理',
      ['観察した事実', '原因の仮説', '優先課題', '対応案'],
      '事実と仮説を区別して課題を整理',
    ],
    ['process', 'プロセス図', ['準備', '実行', '確認'], 'Sectionと接続で処理の順序を共有'],
  ] as const;
  return specs.map(([id, name, labels, purpose]) => {
    const fields = labels.map((label, i) =>
      list(`stage${i}`, label, [`${label}の観察`, `${label}の次の一手`], 12),
    );
    const a = base('whiteboard', id, name, purpose, fields);
    const content: WhiteboardContent = {
      schemaVersion: 3,
      sections: labels.map((label, i) => ({
        id: `section${i}`,
        title: label,
        bounds: { x: i * 420, y: 0, width: 390, height: 580 },
        background: ['#f5f1e7', '#eaf1ef', '#eef0f8', '#f8edef'][i % 4],
      })),
      nodes: [],
      connectors: [],
    };
    for (let i = 0; i < labels.length; i++)
      a.repeats.push({
        slot: `stage${i}`,
        path: ['nodes'],
        prototype: [wbNode(`item${i}`, '', 30 + i * 420, 80, `section${i}`)],
        bindings: [binding('$', [0, 'text'])],
        stepY: 185,
        append: true,
      });
    if (id === 'journey' || id === 'process') {
      content.nodes = labels.map((label, i) =>
        wbNode(`step${i}`, label, 30 + i * 420, 80, `section${i}`, 'rectangle'),
      );
      content.connectors = labels.slice(1).map((_, i) => ({
        id: `connector${i}`,
        from: `step${i}`,
        to: `step${i + 1}`,
        label: '次へ',
        routing: 'elbow',
        stroke: '#52675c',
        arrowhead: 'end',
      }));
      a.repeats.forEach((r) => {
        const n = r.prototype[0] as WhiteboardNode;
        n.bounds.y = 285;
      });
    }
    a.content = content;
    return a;
  });
}
function element(
  id: string,
  type: DesignElement['type'],
  textValue: string,
  x: number,
  y: number,
  width: number,
  height: number,
  parentId?: string,
): DesignElement {
  return {
    id,
    type,
    name: textValue || id,
    text: textValue,
    bounds: { x, y, width, height },
    fill: type === 'text' ? '#203746' : '#ffffff',
    ...(parentId ? { parentId } : {}),
    typography: { ...typography, fontSize: 20 },
  };
}
function designDefs(): Draft[] {
  const specs = [
    ['landing', 'ランディングページ', '導入文・特長・CTAを縦に読む画面'],
    ['dashboard', 'ダッシュボード', '指標カードと更新情報を一覧'],
    ['cards', 'カード一覧', '独立したカードをauto-layoutで反復'],
    ['form', '入力フォーム', '見出し・説明・入力欄・送信を配置'],
    ['detail', '製品詳細画面', '画像・仕様・購入前の判断材料を整理'],
  ] as const;
  return specs.map(([id, name, purpose]) => {
    const items =
      id === 'form'
        ? ['お名前', 'メールアドレス', 'お問い合わせ']
        : id === 'dashboard'
          ? ['今月の利用 128件', '満足度 92%', '対応完了 48件']
          : id === 'detail'
            ? ['寸法：120 × 80 mm', '重量：240 g', '素材：再生素材']
            : ['はじめやすい', '見つけやすい', '続けやすい'];
    const a = base('design', id, name, purpose, [
      { ...title, default: name, example: name },
      summary,
      list('items', id === 'form' ? '入力項目' : id === 'detail' ? '仕様' : '項目', items, 18),
      image,
    ]);
    const frame = element('frame', 'frame', '', 0, 0, 1000, 600);
    frame.name = name;
    frame.layout = { direction: 'column', gap: 24, padding: 36, align: 'start', sizing: 'hug' };
    const heading = element('heading', 'text', '', 36, 36, 928, 100, 'frame');
    heading.typography = { ...typography, fontSize: 32 };
    heading.sizing = 'fixed';
    const intro = element('intro', 'text', '', 36, 155, 928, 90, 'frame');
    intro.sizing = 'fixed';
    const content: DesignContent = {
      schemaVersion: 2,
      elements: [frame, heading, intro],
      components: [],
      styles: [{ id: 'accent-style', name: 'Accent', appearance: { fill: '#386652' } }],
    };
    a.bindings = [
      binding('title', ['elements', 1, 'text']),
      binding('summary', ['elements', 2, 'text']),
    ];
    if (id === 'landing' || id === 'detail') {
      const e = element('hero', 'image', '', 36, 265, 928, 320, 'frame');
      e.src = '';
      e.imageFit = 'fit';
      content.elements.push(e);
      a.bindings.push({ ...binding('image', ['elements', 3, 'src'], 'asset'), optional: true });
    }
    if (id === 'cards' || id === 'dashboard') {
      const row = element('cards-frame', 'frame', '', 36, 265, 928, 420, 'frame');
      row.layout = { direction: 'column', gap: 16, padding: 24, align: 'start', sizing: 'hug' };
      row.fill = '#eef3f2';
      content.elements.push(row);
      const card = element('card', 'frame', '', 60, 290, 880, 130, 'cards-frame');
      card.layout = { direction: 'column', gap: 12, padding: 24, align: 'start', sizing: 'hug' };
      card.fill = id === 'dashboard' ? '#e0ece6' : '#ffffff';
      card.radius = 12;
      const copy = element(
        'card-copy',
        'text',
        '',
        84,
        314,
        832,
        id === 'dashboard' ? 82 : 110,
        'card',
      );
      copy.typography = { ...typography, fontSize: id === 'dashboard' ? 30 : 22 };
      a.repeats.push({
        slot: 'items',
        path: ['elements'],
        prototype: [card, copy],
        bindings: [binding('$', [1, 'text'])],
        append: true,
      });
    } else {
      const row = element('item', 'text', '', 36, 265, 928, id === 'form' ? 85 : 100, 'frame');
      row.sizing = 'fixed';
      if (id === 'form') {
        row.stroke = '#8ea39b';
        row.strokeWidth = 1;
        row.radius = 8;
      }
      a.repeats.push({
        slot: 'items',
        path: ['elements'],
        prototype:
          id === 'form'
            ? [
                {
                  ...element('field', 'frame', '', 36, 265, 928, 160, 'frame'),
                  layout: {
                    direction: 'column',
                    gap: 12,
                    padding: 16,
                    align: 'start',
                    sizing: 'hug',
                  },
                },
                {
                  ...row,
                  id: 'field-label',
                  parentId: 'field',
                  bounds: { x: 52, y: 281, width: 896, height: 44 },
                  stroke: undefined,
                },
                {
                  ...element('field-input', 'rectangle', '', 52, 337, 896, 56, 'field'),
                  fill: '#f3f6f5',
                  stroke: '#8ea39b',
                  strokeWidth: 1,
                  radius: 8,
                },
              ]
            : [row],
        bindings: [binding('$', [id === 'form' ? 1 : 0, 'text'])],
        append: true,
      });
    }
    if (id === 'landing' || id === 'form') {
      content.components = [
        {
          id: 'button-component',
          name: '独立したCTA',
          width: 260,
          height: 64,
          template: {
            type: 'rectangle',
            text: id === 'form' ? '送信内容を確認' : '詳しく見る',
            fill: '#386652',
            typography: { ...typography, fontSize: 20, color: '#ffffff' },
            radius: 10,
          },
        },
      ];
      content.elements.push({
        ...element('cta', 'instance', '', 36, 480, 260, 64, 'frame'),
        componentId: 'button-component',
      });
    }
    if (id === 'landing' || id === 'form')
      a.repeats.forEach((r) => {
        r.beforeId = 'cta';
      });
    a.content = content;
    return a;
  });
}
function block(id: string, type: DocumentBlock['type'], textValue = ''): DocumentBlock {
  return { id, type, text: textValue, ...(type === 'heading' ? { level: 2 } : {}) };
}
function documentDefs(): Draft[] {
  const specs = [
    ['proposal', '企画書', ['背景', '提案内容', '期待する効果']],
    ['minutes', '議事録', ['議題', '決定事項', '次の対応']],
    ['research', '調査報告書', ['調査目的', '観察結果', '考察と制約']],
    ['procedure', '手順書', ['準備するもの', '実施手順', '確認すること']],
    ['evaluation', '比較評価書', ['評価基準', '比較結果', '推奨と根拠']],
  ] as const;
  return specs.map(([id, name, sections]) => {
    const inputs = [
      { ...title, default: name, example: name },
      summary,
      ...sections.map((s, i) =>
        list(`section${i}`, s, [`${s}を記述します。`, `${s}の根拠と具体例を共有します。`], 30),
      ),
    ];
    if (id === 'minutes')
      inputs.push({
        key: 'date',
        label: '開催日',
        description: '日付',
        type: 'date',
        default: '2026-10-01',
        example: '2026-10-01',
      });
    const a = base('document', id, name, `${sections.join('・')}をsemanticな文書で整理`, inputs);
    const blocks = [{ ...block('title', 'heading'), level: 1 }, block('summary', 'paragraph')];
    a.bindings = [
      binding('title', ['blocks', 0, 'text']),
      binding('summary', ['blocks', 1, 'text']),
    ];
    if (id === 'minutes') {
      blocks.push(block('date', 'paragraph'));
      a.bindings.push(binding('date', ['blocks', 2, 'text']));
    }
    sections.forEach((s, i) => {
      blocks.push(block(`heading${i}`, 'heading', s));
      const b = {
        ...block(`section${i}`, id === 'procedure' ? 'numbered-list' : 'bulleted-list'),
        items: [],
      };
      blocks.push(b);
      a.bindings.push(binding(`section${i}`, ['blocks', blocks.length - 1, 'items'], 'list'));
    });
    if (id === 'evaluation' || id === 'research') {
      const rows: InputField = {
        key: 'results',
        label: '比較・調査結果',
        description: '項目・観察・判断の3列',
        type: 'table',
        min: 1,
        max: 30,
        item: {
          key: 'row',
          label: '行',
          description: '3列',
          type: 'list',
          min: 3,
          max: 3,
          item: text('cell', 'セル', '', 180),
        },
        default: [
          ['項目', '観察', '判断'],
          ['試行A', '参加者8名中6名が完了', '次の試行で再確認'],
        ],
      };
      a.inputs.push(rows);
      a.sample.results = rows.default!;
      blocks.push({ ...block('comparison', 'table'), cells: [], columnWidths: [160, 260, 220] });
      a.bindings.push(binding('results', ['blocks', blocks.length - 1, 'cells'], 'table'));
    }
    if (id === 'procedure') {
      blocks.push({
        ...block('check', 'check-list'),
        items: [{ id: 'check-item', rich: [{ text: '完了後に内容を確認する' }], checked: false }],
      });
    }
    a.content = {
      schemaVersion: 2,
      page: { size: 'A4', margin: 48 },
      blocks,
    } satisfies DocumentContent;
    return a;
  });
}
function dataDefs(): Draft[] {
  const textCol = (id: string, name: string): Column => ({
    id,
    name,
    type: 'text',
    required: true,
    defaultValue: '新しい項目',
  });
  const numberCol = (id: string, name: string): Column => ({
    id,
    name,
    type: 'number',
    defaultValue: 0,
    decimals: 0,
  });
  const choice = (name: string, options: string[]): Column => ({
    id: 'category',
    name,
    type: 'select',
    options,
    defaultValue: options[0],
  });
  const specs: {
    id: string;
    name: string;
    purpose: string;
    columns: Column[];
    rows: Record<string, InputValue>[];
    projection: 'Kanban' | 'Chart' | 'Summary' | 'Roadmap';
  }[] = [
    {
      id: 'issues',
      name: '課題台帳',
      purpose: '影響と頻度から優先度を算出し、状態別に対応を整理',
      projection: 'Kanban',
      columns: [
        textCol('label', '課題'),
        choice('状態', ['未着手', '調査中', '対応済']),
        numberCol('impact', '影響度'),
        numberCol('frequency', '頻度'),
        { id: 'score', name: '優先スコア', type: 'formula', formula: '[impact] * [frequency]' },
        { id: 'due', name: '対応期限', type: 'date' },
      ],
      rows: [
        {
          label: '初回案内で迷いやすい',
          category: '調査中',
          impact: 4,
          frequency: 5,
          due: '2026-10-12',
        },
        {
          label: '資料を探す時間が長い',
          category: '未着手',
          impact: 3,
          frequency: 4,
          due: '2026-10-20',
        },
      ],
    },
    {
      id: 'comparison',
      name: '選択肢比較',
      purpose: '品質・導入容易性・月額費用を分けて比較し、評価点を計算',
      projection: 'Chart',
      columns: [
        textCol('label', '候補'),
        choice('導入方式', ['試行', '段階導入', '一括導入']),
        numberCol('quality', '品質点'),
        numberCol('ease', '導入容易性'),
        { ...numberCol('cost', '月額費用'), format: 'currency', currency: 'JPY' },
        {
          id: 'score',
          name: '評価点',
          type: 'formula',
          formula: '[quality] * 0.6 + [ease] * 0.4',
          format: 'decimal',
          decimals: 1,
        },
      ],
      rows: [
        { label: '案A 小規模試行', category: '試行', quality: 80, ease: 92, cost: 12000 },
        { label: '案B 統一導入', category: '一括導入', quality: 90, ease: 60, cost: 36000 },
      ],
    },
    {
      id: 'inventory',
      name: '備品・在庫台帳',
      purpose: '分類別の在庫数・発注点と在庫金額を把握',
      projection: 'Summary',
      columns: [
        textCol('label', '品名'),
        choice('分類', ['事務用品', '機器', '消耗品']),
        numberCol('amount', '数量'),
        { ...numberCol('weight', '単価'), format: 'currency', currency: 'JPY' },
        numberCol('threshold', '発注点'),
        {
          id: 'total',
          name: '在庫金額',
          type: 'formula',
          formula: '[amount] * [weight]',
          format: 'currency',
          currency: 'JPY',
          decimals: 0,
        },
        { id: 'checked', name: '棚卸済み', type: 'boolean', defaultValue: false },
      ],
      rows: [
        {
          label: 'A5再生紙ノート',
          category: '事務用品',
          amount: 24,
          weight: 320,
          threshold: 8,
          checked: true,
        },
        {
          label: 'USB-Cケーブル',
          category: '機器',
          amount: 10,
          weight: 1400,
          threshold: 5,
          checked: false,
        },
      ],
    },
    {
      id: 'research',
      name: '調査結果台帳',
      purpose: '方法・母数・該当数を記録し、割合を同じ正本データから算出',
      projection: 'Chart',
      columns: [
        textCol('label', '観察'),
        choice('調査方法', ['インタビュー', '操作観察', 'アンケート']),
        { ...numberCol('sample', '母数'), defaultValue: 1 },
        numberCol('matches', '該当数'),
        {
          id: 'rate',
          name: '該当率',
          type: 'formula',
          formula: '[matches] / [sample]',
          format: 'percent',
          decimals: 1,
        },
        { id: 'date', name: '調査日', type: 'date' },
      ],
      rows: [
        {
          label: '案内なしで完了できた',
          category: '操作観察',
          sample: 12,
          matches: 9,
          date: '2026-10-01',
        },
        {
          label: '保存先を説明できた',
          category: 'インタビュー',
          sample: 12,
          matches: 7,
          date: '2026-10-02',
        },
      ],
    },
    {
      id: 'roadmap',
      name: 'ロードマップ',
      purpose: '開始・終了・状態と見積工数で実行計画を共有',
      projection: 'Roadmap',
      columns: [
        textCol('label', '項目'),
        choice('状態', ['計画', '進行', '完了']),
        numberCol('days', '作業日数'),
        numberCol('people', '担当人数'),
        { id: 'effort', name: '見積人日', type: 'formula', formula: '[days] * [people]' },
        { id: 'start', name: '開始日', type: 'date' },
        { id: 'end', name: '終了日', type: 'date' },
      ],
      rows: [
        {
          label: '案内文の試作',
          category: '完了',
          days: 3,
          people: 2,
          start: '2026-10-01',
          end: '2026-10-05',
        },
        {
          label: '利用者テスト',
          category: '進行',
          days: 5,
          people: 2,
          start: '2026-10-06',
          end: '2026-10-13',
        },
        {
          label: '改善版の公開',
          category: '計画',
          days: 4,
          people: 3,
          start: '2026-10-14',
          end: '2026-10-20',
        },
      ],
    },
  ];
  return specs.map((spec) => {
    const fields: InputField[] = spec.columns
      .filter((c) => c.type !== 'formula')
      .map((c) => ({
        key: c.id,
        label: c.name,
        description: `${c.name}（${c.type}）`,
        type: c.type === 'select' ? 'enum' : (c.type as 'text' | 'number' | 'date' | 'boolean'),
        required: !!c.required || c.type === 'number',
        ...(c.defaultValue !== undefined ? { default: c.defaultValue } : {}),
        ...(c.type === 'text' ? { maxLength: 120 } : {}),
        ...(c.type === 'number' ? { min: c.id === 'sample' ? 1 : 0, max: 100000 } : {}),
        ...(c.options ? { options: c.options } : {}),
      }));
    const rows: InputField = {
      key: 'rows',
      label: '初期レコード',
      description: '作成時に初期レコードを含めるか選択できます。',
      type: 'table',
      min: 0,
      max: 40,
      item: { key: 'row', label: 'レコード', description: '列型に従う値', type: 'object', fields },
      default: spec.rows,
      example: spec.rows,
    };
    const d = base('data', spec.id, spec.name, spec.purpose, [rows]);
    const content: StructuredData = { schemaVersion: 2, columns: spec.columns, rows: [] };
    const grid = { ...defaultView(content), id: 'grid-view', name: '一覧' };
    const view = {
      ...defaultView(content),
      id: 'report-view',
      name:
        spec.projection === 'Roadmap'
          ? '実行計画'
          : spec.projection === 'Kanban'
            ? '状態別'
            : spec.projection === 'Summary'
              ? '在庫集計'
              : '比較グラフ',
      projection: spec.projection,
    };
    content.views = [grid, view];
    d.repeats = [
      {
        slot: 'rows',
        path: ['rows'],
        prototype: [
          {
            id: 'row',
            values: Object.fromEntries(
              fields.map((f) => [
                f.key,
                f.default ?? (f.type === 'number' ? 0 : f.type === 'boolean' ? false : ''),
              ]),
            ),
          },
        ],
        bindings: fields.map((f) => binding(f.key, [0, 'values', f.key], 'value')),
      },
    ];
    d.content = content;
    return d;
  });
}
/** Fictional finished examples; these are data, never executable instructions. */
async function completeSamples(definitions: Draft[]) {
  const samples: Record<string, Record<string, InputValue>> = {
    'slide-proposal': {
      title: '地域図書室の夜間開室を試す',
      summary: '仕事帰りにも本を受け取れるよう、木曜の開室を2時間延長する試行を提案します。',
      left: {
        title: '現在の課題',
        items: [
          '平日17時以降は受取できない',
          '予約本の取置き期限切れが月18件',
          '利用者12名から延長の希望',
        ],
      },
      right: {
        title: '4週間の試行',
        items: ['木曜のみ19時まで開室', '担当2名を交代で配置', '受取件数と負担を毎週記録'],
      },
      conclusion:
        '10月の4週間で試行。平均8件以上の受取と、無理のない担当体制を継続の判断基準にします。',
    },
    'slide-progress': {
      title: '学習スペース改善・10月前半',
      summary: '座席案内と予約導線の試行が完了。利用状況を確認し、次の2週間で案内を調整します。',
      chart: [
        { label: '案内整備', value: 100 },
        { label: '予約導線', value: 80 },
        { label: '利用者確認', value: 60 },
      ],
      findings: [
        '座席案内を3か所へ設置',
        '予約手順を5工程から3工程へ短縮',
        '12名に利用後アンケートを実施',
        '次週は初回利用者の迷いを観察',
      ],
    },
    'slide-product': {
      title: '持ち歩ける学習キット「NEST」',
      summary:
        'ノート・カード・ペンを一つにまとめ、自宅でも共有スペースでも学びを続ける架空の製品です。',
      features: [
        'A5サイズでバッグへ収まる',
        '3枚の仕切りでテーマを分ける',
        '再生紙のカードを補充して使える',
      ],
    },
    'slide-comparison': {
      title: '予約受付の改善案を比較',
      summary: '小規模な試行と一括導入を、準備期間・費用・運用負担から比較します。',
      left: {
        title: '案A：2週間の試行',
        items: ['準備は3日', '初期費用は12,000円', '窓口1か所で効果を測る'],
      },
      right: {
        title: '案B：一括導入',
        items: ['準備は3週間', '初期費用は90,000円', '全窓口の運用を統一'],
      },
      conclusion: '案Aで受付時間と問い合わせ件数を測定し、改善を確認してから対象を広げます。',
    },
    'slide-research': {
      title: '初回予約の操作観察・12名',
      summary: '架空の学習スペースで初回予約を観察。完了率と迷った箇所を分けて報告します。',
      chart: [
        { label: '説明なしで完了', value: 9 },
        { label: '保存先で迷う', value: 5 },
        { label: '確認画面を再読', value: 4 },
      ],
      findings: [
        '12名中9名が説明なしで予約を完了',
        '保存先の表示は5名が見落とした',
        '確認画面の見出しを明確にする',
        '小規模な観察のため母集団への一般化はしない',
      ],
    },
    'whiteboard-brainstorm': {
      stage0: ['雨の日も使える読書場所', '静かな作業席を増やす', '親子向けの短時間イベント'],
      stage1: ['場所と備品の工夫', '時間帯を変える工夫', '利用者同士の交流'],
      stage2: ['土曜朝に30分の読書会を試す', '窓際4席へ静音サインを置く'],
    },
    'whiteboard-kpt': {
      stage0: ['朝会を10分に区切れた', '相談先を一覧にできた'],
      stage1: ['確認待ちが週末に集中した', '変更理由が伝わらなかった'],
      stage2: ['水曜に確認時間を設ける', '変更時に理由を1行残す'],
    },
    'whiteboard-journey': {
      stage0: ['駅の案内で施設を知る', '開室時間を確かめたい'],
      stage1: ['席と設備の写真を見る', '静かに作業できるか不安'],
      stage2: ['1時間の利用を予約', '入口の案内があると安心'],
      stage3: ['週1回、同じ時間に使う', '混雑の見通しを知りたい'],
      stage4: ['友人へ空いている時間を伝える', '使い方の短い案内を共有'],
    },
    'whiteboard-issues': {
      stage0: ['予約の問い合わせが週18件', '初回の入力に平均6分'],
      stage1: ['必須項目が分かりにくい', '確定前に料金を確認できない'],
      stage2: ['必須・任意を区別する', '確定前に料金を表示する'],
      stage3: ['入力欄を2名でレビュー', '5名の操作観察で確かめる'],
    },
    'whiteboard-process': {
      stage0: ['申込内容を確認', '不足があれば申込者へ連絡'],
      stage1: ['空き時間を照合', '担当者を決定'],
      stage2: ['確定日時を案内', '当日のチェック項目を共有'],
    },
    'design-landing': {
      title: '学びを持ち歩こう。',
      summary:
        'NESTは、思いつきを書き留め、次の一歩へつなぐ学習キット。机の上でも外出先でも使えます。',
      items: [
        'A5サイズのコンパクトなケース',
        'テーマを分ける3つの仕切り',
        '補充できる再生紙カード',
      ],
    },
    'design-dashboard': {
      title: '学習スペースの利用状況',
      summary: '2026年10月1日〜15日。受付記録をもとにした架空の集計です。',
      items: ['利用者数 128名', '平均滞在 82分', '再訪率 64%'],
    },
    'design-cards': {
      title: '今週の学びを選ぶ',
      summary: '空いた30分から始められる3つのワークショップ。興味に合わせて内容を確認できます。',
      items: [
        '観察ノート｜身近な変化を記録する',
        '図で考える｜関係を並べて整理する',
        '伝える練習｜短い説明を組み立てる',
      ],
    },
    'design-form': {
      title: '見学を予約する',
      summary: '希望する日時と連絡先を入力してください。担当者が空き状況を確認して連絡します。',
      items: ['お名前', '連絡用メールアドレス', '見学の希望日時', '確認したいこと（任意）'],
    },
    'design-detail': {
      title: 'NEST 学習キット',
      summary: '再生紙カードとノートをまとめて携帯。毎日の観察を自分の言葉で残せます。',
      items: [
        '価格：2,400円（税込）',
        '寸法：220 × 160 × 25 mm',
        '内容：ノート1冊・カード30枚・仕切り3枚',
        '素材：再生紙・綿混の外装',
      ],
    },
    'document-proposal': {
      title: '図書室の夜間開室・試行企画書',
      summary: '仕事帰りの予約本受取を支援するため、木曜の開室延長を4週間試行します。',
      section0: ['予約本の期限切れが月18件ある', '利用者12名から夕方以降の受取希望があった'],
      section1: ['木曜は17時から19時まで延長する', '担当2名を交代で配置し、受取件数を記録する'],
      section2: [
        '平均8件以上の受取を継続判断の目安とする',
        '担当者の負担を週1回確認し、運用を調整する',
      ],
    },
    'document-minutes': {
      title: '学習スペース改善ミーティング',
      summary: '参加：受付担当・運営担当・利用者代表の計4名。案内表示の試行結果を確認しました。',
      date: '2026-10-02',
      section0: ['座席案内の試行結果', '初回予約で迷う箇所の整理'],
      section1: ['料金を確認画面の上部に表示する', '必須項目へ共通の表示を付ける'],
      section2: ['運営担当が10月8日までに画面案を作成', '受付担当が5名の操作観察を手配'],
    },
    'document-research': {
      title: '初回予約の操作観察報告',
      summary:
        '12名の協力者が予約を行う様子を観察しました。架空の小規模調査であり、傾向を探るための資料です。',
      section0: ['案内なしで予約を完了できるか確認する', '迷いやすい入力・確認箇所を記録する'],
      section1: ['12名中9名が説明なしで完了した', '5名が保存先の表示を見落とした'],
      section2: [
        '保存先を確認画面の上部へ移す案を試す',
        '少人数の観察のため、改善後も継続して確認する',
      ],
      results: [
        ['観察項目', '結果', '次の確認'],
        ['予約完了', '9/12名', '初回利用者で再観察'],
        ['保存先の見落とし', '5/12名', '表示位置を変更'],
      ],
    },
    'document-procedure': {
      title: '読書会の会場準備手順',
      summary: '開始30分前から準備し、参加者が安全に移動できる配置を整えます。',
      section0: ['参加者名簿と案内札を用意する', '机・椅子・筆記具の数を確認する'],
      section1: [
        '通路幅を確保して机を配置する',
        '入口に案内札と受付表を置く',
        '担当者と避難経路を確認する',
      ],
      section2: ['配布物を参加人数分そろえる', '退出時の片付け担当を確認する'],
    },
    'document-evaluation': {
      title: '予約受付改善案の比較評価',
      summary: '準備期間・費用・検証のしやすさを基準に、2つの改善案を比較しました。',
      section0: ['初回利用者の予約完了時間を短縮できること', '受付担当の負担を急に増やさないこと'],
      section1: ['案Aは2週間で試行でき、修正しやすい', '案Bは運用を統一できるが準備期間が長い'],
      section2: [
        '案Aで効果と負担を測ってから対象を広げる',
        '評価は架空の前提に基づき、費用を再確認する',
      ],
      results: [
        ['基準', '案A：試行', '案B：一括導入'],
        ['準備期間', '3日', '3週間'],
        ['初期費用', '12,000円', '90,000円'],
        ['検証範囲', '窓口1か所', '全窓口'],
      ],
    },
  };
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="520" viewBox="0 0 800 520"><rect width="800" height="520" fill="#eaf1ec"/><rect x="140" y="85" width="490" height="330" rx="24" fill="#386652"/><rect x="170" y="115" width="220" height="270" rx="8" fill="#fffdf4"/><path d="M200 180h150m-150 40h150m-150 40h120" stroke="#9cafa3" stroke-width="5"/><rect x="420" y="150" width="160" height="120" rx="8" fill="#efc97c"/><rect x="430" y="300" width="140" height="18" rx="9" fill="#d7dfd9"/><text x="430" y="220" font-family="sans-serif" font-size="32" fill="#20372c">NEST</text><text x="180" y="458" font-family="sans-serif" font-size="24" fill="#20372c">A small place for your next idea.</text></svg>';
  const data = 'data:image/svg+xml;base64,' + btoa(svg),
    hash = await contentHash(data);
  for (const d of definitions) {
    if (samples[d.templateId]) d.sample = { ...d.sample, ...samples[d.templateId] };
    if (d.domain === 'design' && !['design-landing', 'design-detail'].includes(d.templateId)) {
      d.inputs = d.inputs.filter((f) => f.key !== 'image');
      delete d.sample.image;
    }
    if (['slide-product', 'design-landing', 'design-detail'].includes(d.templateId)) {
      d.assets = [{ id: 'nest-kit', data, hash, mime: 'image/svg+xml' }];
      d.sample.image = 'asset://nest-kit';
    }
  }
}

export async function authoredCatalog(): Promise<TemplateDefinition[]> {
  const whole = [...slideDefs(), ...boardDefs(), ...designDefs(), ...documentDefs(), ...dataDefs()];
  await completeSamples(whole);
  const fragments: Draft[] = [];
  const choose = (domain: Domain, id: string, name: string, source: string) => {
    const s = structuredClone(whole.find((d) => d.templateId === `${domain}-${source}`)!);
    s.templateId = `${domain}-${id}`;
    s.name = name;
    s.kind = 'fragment';
    s.targets = ['insertion-anchor'];
    return s;
  };
  const compare = choose('slide', 'comparison-page', '左右比較ページ', 'comparison');
  const deck = compare.content as SlideContent;
  deck.slides = [deck.slides[1]];
  compare.inputs = compare.inputs.filter((f) => ['left', 'right'].includes(f.key));
  compare.sample = { left: compare.sample.left, right: compare.sample.right };
  compare.bindings = compare.bindings
    .filter((b) => b.path[1] === 1)
    .map((b) => ({ ...b, path: [b.path[0], 0, ...b.path.slice(2)] }));
  fragments.push(compare);
  const graph = choose('slide', 'chart-page', 'データグラフページ', 'research');
  (graph.content as SlideContent).slides = [(graph.content as SlideContent).slides[1]];
  graph.inputs = [chart];
  graph.sample = { chart: chart.default! };
  graph.repeats = [];
  graph.bindings = [binding('chart', ['slides', 0, 'objects', 1, 'chart'], 'chart')];
  fragments.push(graph);
  const agenda = choose('whiteboard', 'agenda-section', '議題Section', 'brainstorm');
  const board = agenda.content as WhiteboardContent;
  board.sections = board.sections!.slice(0, 1);
  agenda.inputs = agenda.inputs.slice(0, 1);
  agenda.sample = { stage0: agenda.sample.stage0 };
  agenda.repeats = agenda.repeats.slice(0, 1);
  fragments.push(agenda, choose('whiteboard', 'process-fragment', '接続付きプロセス図', 'process'));
  fragments.push(
    choose('design', 'card-group', 'カード群', 'cards'),
    choose('design', 'field-group', '入力field群', 'form'),
  );
  const doc = choose('document', 'summary-section', '要約・結論section', 'proposal');
  (doc.content as DocumentContent).blocks = (doc.content as DocumentContent).blocks.slice(0, 4);
  doc.inputs = doc.inputs.slice(0, 3);
  doc.sample = Object.fromEntries(
    Object.entries(doc.sample).filter(([k]) => doc.inputs.some((f) => f.key === k)),
  );
  doc.bindings = doc.bindings.filter((b) => Number(b.path[1]) < 4);
  fragments.push(doc);
  const table = base(
    'document',
    'comparison-table',
    '比較table',
    '条件と評価を表で比較',
    [
      {
        key: 'rows',
        label: '比較行',
        description: '比較項目・A・Bの3列',
        type: 'table',
        min: 1,
        max: 30,
        item: {
          key: 'row',
          label: '行',
          description: '3つの文字列',
          type: 'list',
          min: 3,
          max: 3,
          item: text('cell', 'セル', '', 120),
        },
        default: [
          ['項目', 'A', 'B'],
          ['費用', '小', '中'],
          ['準備期間', '短', '長'],
        ],
      },
    ],
    'fragment',
  );
  table.content = { schemaVersion: 2, blocks: [{ ...block('table', 'table'), cells: [] }] };
  table.bindings = [binding('rows', ['blocks', 0, 'cells'], 'table')];
  fragments.push(table);
  const fields = base(
    'data',
    'common-fields',
    '共通field set',
    '新しいfield IDで優先度と見積を追加',
    [],
    'fragment',
  );
  fields.content = {
    schemaVersion: 2,
    columns: [
      {
        id: 'priority',
        name: '優先度',
        type: 'select',
        options: ['低', '中', '高'],
        defaultValue: '中',
      },
      { id: 'estimate', name: '見積', type: 'number', defaultValue: 0 },
    ],
    rows: [],
    views: [],
  };
  fragments.push(fields);
  const views = base(
    'data',
    'chart-view',
    '互換fieldへのchart view',
    '明示したfield mappingから集計viewを追加',
    [],
    'fragment',
  );
  const vc: StructuredData = {
    schemaVersion: 2,
    columns: [
      { id: 'label', name: '分類', type: 'text' },
      { id: 'amount', name: '値', type: 'number' },
    ],
    rows: [],
  };
  vc.views = [
    { ...defaultView(vc), id: 'chart-view', name: 'テンプレート集計', projection: 'Chart' },
  ];
  views.content = vc;
  views.targets = ['field-mapping'];
  fragments.push(views);
  const presets: Draft[] = domainsForPresets.map((domain) => {
    const a = base(
      domain,
      'readable-style',
      domain === 'review'
        ? '読みやすい差分表示'
        : domain === 'file'
          ? 'ページに合わせて表示'
          : '落ち着いた色・読みやすい設定',
      '指定したstyle / 表示設定のみを変更',
      [],
      'preset',
    );
    const fields: Record<string, InputValue> =
      domain === 'slide'
        ? { fill: '#245c50', fontSize: 24 }
        : domain === 'design'
          ? { fill: '#245c50', fontSize: 20 }
          : domain === 'whiteboard'
            ? { color: '#e2edd1', stroke: '#496452' }
            : domain === 'document'
              ? { color: '#245c50', margin: 56 }
              : domain === 'data'
                ? { format: 'decimal', decimals: 1, chartType: 'bar' }
                : domain === 'review'
                  ? { split: true, wrap: true, annotations: true }
                  : { fit: 'page', annotations: true };
    a.preset = { fields, scope: domain === 'review' || domain === 'file' ? 'view' : 'selection' };
    a.inputs = Object.entries(fields).map(
      ([key, value]): InputField => ({
        key,
        label:
          (
            {
              fill: '文字・図形の色',
              fontSize: '文字サイズ',
              color: '色',
              stroke: '線の色',
              margin: 'ページ余白',
              format: '数値の表示形式',
              decimals: '小数点以下の桁数',
              chartType: 'グラフの種類',
              split: '左右に分けて表示',
              wrap: '長い行を折り返す',
              annotations: '注釈を表示',
              fit: '表示倍率の基準',
            } as Record<string, string>
          )[key] ?? key,
        description: '指定した範囲だけに適用します。',
        type:
          typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'enum',
        default: value,
        example: value,
        ...(typeof value === 'number'
          ? {
              min: key === 'fontSize' ? 16 : key === 'margin' ? 16 : 0,
              max: key === 'fontSize' ? 48 : key === 'margin' ? 96 : 6,
            }
          : {}),
        ...(typeof value === 'string'
          ? {
              options:
                key === 'format'
                  ? ['decimal', 'currency', 'percent']
                  : key === 'chartType'
                    ? ['bar', 'line', 'pie']
                    : key === 'fit'
                      ? ['page', 'width']
                      : [value, '#253044', '#5269a6'],
            }
          : {}),
      }),
    );
    a.sample = Object.fromEntries(a.inputs.map((f) => [f.key, f.default!]));
    a.bindings = a.inputs.map((f) => binding(f.key, ['fields', f.key], 'value'));
    return a;
  });
  return Promise.all([...whole, ...fragments, ...presets].map(sealDefinition));
}
const domainsForPresets: Domain[] = [
  'slide',
  'whiteboard',
  'design',
  'document',
  'data',
  'review',
  'file',
];
