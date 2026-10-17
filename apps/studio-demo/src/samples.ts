import type { SlideContent, SlideObject } from '@editor-platform/slide/model';
import type { WhiteboardContent } from '@editor-platform/whiteboard/model';
const ink = '#153b35',
  mint = '#dcebdd',
  paper = '#f7f8f4';
const text = (
  id: string,
  value: string,
  x: number,
  y: number,
  w: number,
  h: number,
  size = 26,
  color = ink,
  bold = false,
): SlideObject => ({
  id,
  type: 'text',
  text: value,
  fill: color,
  bounds: { x, y, width: w, height: h },
  typography: {
    fontFamily: 'sans-serif',
    fontSize: size,
    bold,
    padding: 0,
    verticalAlign: 'top',
    lineHeight: 1.35,
    overflow: 'fit',
  },
});
const box = (id: string, x: number, y: number, w: number, h: number, fill = mint): SlideObject => ({
  id,
  type: 'shape',
  text: '',
  fill,
  shape: 'rectangle',
  radius: 18,
  bounds: { x, y, width: w, height: h },
});
function page(id: string, title: string, objects: SlideObject[], dark = false) {
  return {
    id,
    title,
    background: dark ? ink : paper,
    objects,
    notes:
      'SORA Voiceの架空の企画サンプルです。顧客像・数値・料金は検討用の仮説です。自由に編集してください。',
  };
}
export function soraDeck(): SlideContent {
  const slides = [
    page(
      'sora-cover',
      '01 / SORA Voice — 企画書',
      [
        text('cover-kicker', 'SORA LAB  /  PRODUCT CONCEPT', 64, 48, 830, 35, 16, '#acc9bb'),
        text('cover-title', 'SORA Voice', 64, 122, 800, 100, 76, '#ffffff', true),
        text('cover-sub', '話す。整う。動き出す。', 68, 250, 800, 70, 37, '#ffffff'),
        text(
          'cover-body',
          '音声から、チームの次の一歩へ。\n会議・アイデア・日々のメモを、使える言葉に。',
          68,
          335,
          650,
          100,
          24,
          '#cce0d4',
        ),
        ...[42, 78, 120, 156, 114, 72, 46, 88, 138, 184, 136, 80].map((h, i) =>
          box('wave-' + i, 700 + i * 13, 290 - h / 2, 7, h, i % 2 ? '#95bc9d' : '#d1e4d3'),
        ),
        text('cover-foot', 'CONCEPT SAMPLE  ·  OCT 2026', 68, 483, 800, 30, 14, '#acc9bb'),
      ],
      true,
    ),
    page('sora-problem', '02 / 誰の、どんな課題か', [
      text('problem-k', '01  /  THE PROBLEM', 56, 40, 800, 32, 15),
      text('problem-h', '会話の価値は、会議のあとに消えている。', 56, 103, 850, 95, 38, ink, true),
      ...[
        ['記録に追われる', '発言を聞きながらメモ。\n考える時間が減ってしまう。'],
        ['探すのに時間がかかる', '決定事項が議事録に埋もれ、\nチームに届かない。'],
        ['行動につながらない', '担当と期限が曖昧なまま。\n次の一歩が止まってしまう。'],
      ].flatMap(([h, b], i) => [
        box('problem-card-' + i, 56 + i * 288, 232, 270, 226),
        text('problem-no-' + i, '0' + (i + 1), 76 + i * 288, 254, 200, 30, 16),
        text('problem-label-' + i, h, 76 + i * 288, 301, 232, 50, 26, ink, true),
        text('problem-body-' + i, b, 76 + i * 288, 366, 230, 80, 20),
      ]),
      text(
        'problem-foot',
        '想定顧客：少人数のプロダクトチーム、個人クリエイター。検証前の仮説。',
        56,
        487,
        860,
        32,
        14,
      ),
    ]),
    page('sora-solution', '03 / プロダクトの体験', [
      text('solution-k', '02  /  THE EXPERIENCE', 56, 40, 800, 32, 15),
      text('solution-h', '声を、使えるアウトプットに。', 56, 103, 850, 75, 42, ink, true),
      ...[
        ['01', '話す', 'ブラウザーで音声を取得'],
        ['02', '整える', '文字起こしを確認・編集'],
        ['03', '共有する', 'テキストを保存し、次の行動へ'],
      ].flatMap(([n, h, b], i) => [
        box('solution-card-' + i, 56 + i * 288, 225, 270, 202, i === 1 ? '#153b35' : mint),
        text('solution-no-' + i, n, 78 + i * 288, 251, 200, 30, 16, i === 1 ? '#cce0d4' : ink),
        text(
          'solution-label-' + i,
          h,
          78 + i * 288,
          300,
          220,
          54,
          38,
          i === 1 ? '#ffffff' : ink,
          true,
        ),
        text('solution-body-' + i, b, 78 + i * 288, 366, 225, 54, 18, i === 1 ? '#cce0d4' : ink),
      ]),
      text(
        'solution-note',
        'このデモのCodeタブで、音声認識ソフトの試作を操作できます。',
        56,
        474,
        850,
        42,
        18,
      ),
    ]),
    page('sora-business', '04 / ビジネスモデル', [
      text('business-k', '03  /  BUSINESS MODEL', 56, 40, 800, 32, 15),
      text('business-h', '日々の小さな時間を、チームの余白へ。', 56, 103, 850, 100, 38, ink, true),
      box('business-plan', 56, 225, 408, 227),
      text('business-free', 'Personal', 82, 251, 350, 46, 32, ink, true),
      text(
        'business-free-body',
        '個人向けの基本プラン\nまずは音声メモから価値を検証。\n料金・利用上限は未決定。',
        82,
        322,
        350,
        107,
        22,
      ),
      box('business-team', 488, 225, 408, 227, ink),
      text('business-team-title', 'Team', 514, 251, 350, 46, 32, '#ffffff', true),
      text(
        'business-team-body',
        'チーム単位の月額プランを検討\n共有・権限・連携を拡張。\n料金・機能は顧客検証後に決定。',
        514,
        322,
        350,
        107,
        22,
        '#cce0d4',
      ),
      text(
        'business-foot',
        'Whiteboardタブ：9つのブロックから事業の仮説を編集できます。',
        56,
        478,
        850,
        40,
        17,
      ),
    ]),
    page('sora-roadmap', '05 / 小さく作り、確かめる', [
      text('roadmap-k', '04  /  ROADMAP', 56, 40, 800, 32, 15),
      text('roadmap-h', '4週間で、最初の使い手へ。', 56, 103, 850, 70, 42, ink, true),
      ...[
        ['Week 1', '聞く', '顧客ヒアリング\n利用シーンの整理'],
        ['Week 2', '作る', '音声認識の試作\n編集体験の確認'],
        ['Week 3', '試す', 'ユーザーテスト\n認識失敗の改善'],
        ['Week 4', '届ける', '利用継続を検証\n次の優先順位へ'],
      ].flatMap(([n, h, b], i) => [
        box('roadmap-card-' + i, 56 + i * 219, 221, 204, 224),
        text('roadmap-no-' + i, n, 73 + i * 219, 245, 176, 34, 17),
        text('roadmap-label-' + i, h, 73 + i * 219, 298, 172, 52, 34, ink, true),
        text('roadmap-body-' + i, b, 73 + i * 219, 366, 174, 74, 18),
      ]),
      text(
        'roadmap-foot',
        'Kanbanタブ：この計画をカードとして動かせます。期間はサンプルです。',
        56,
        478,
        850,
        42,
        17,
      ),
    ]),
    page(
      'sora-next',
      '06 / 次の一歩',
      [
        text('next-k', '05  /  NEXT STEPS', 64, 48, 830, 35, 16, '#acc9bb'),
        text('next-title', 'いい会話を、\nいい仕事へ。', 64, 125, 800, 200, 68, '#ffffff', true),
        text(
          'next-body',
          '1. 顧客に会い、困りごとを確かめる\n2. Codeの試作を使い、体験を検証する\n3. Kanbanで実験と学びを積み重ねる',
          68,
          347,
          800,
          126,
          24,
          '#cce0d4',
        ),
        text(
          'next-foot',
          'SORA VOICE  /  ALL CONTENT IS EDITABLE',
          68,
          488,
          800,
          26,
          14,
          '#acc9bb',
        ),
      ],
      true,
    ),
  ];
  return {
    schemaVersion: 2,
    width: 960,
    height: 540,
    theme: { color: ink, fontFamily: 'sans-serif' },
    slides,
  };
}
export const canvasBlocks = [
  [
    'partners',
    '主要パートナー',
    '音声認識技術の提供者\nデザイン・開発パートナー\n初期ユーザーのコミュニティ',
    40,
    100,
    200,
    410,
  ],
  [
    'activities',
    '主要活動',
    '音声入力と編集体験の改善\n顧客ヒアリング\n認識失敗の検証',
    260,
    100,
    200,
    195,
  ],
  [
    'resources',
    '主要リソース',
    '音声認識の試作\n編集・共有のUI\nユーザーからの学び',
    260,
    315,
    200,
    195,
  ],
  [
    'value',
    '価値提案',
    '話した内容をすぐに使える言葉へ\n記録の手間を減らす\n決定事項と次の行動を残す',
    480,
    100,
    220,
    410,
  ],
  [
    'relationships',
    '顧客との関係',
    '使い始めを支えるガイド\nフィードバックの収集\nチームへの導入支援',
    720,
    100,
    200,
    195,
  ],
  [
    'channels',
    'チャネル',
    'プロダクト紹介サイト\nコミュニティでの紹介\n利用者からの口コミ',
    720,
    315,
    200,
    195,
  ],
  [
    'customers',
    '顧客セグメント',
    '小規模のプロダクトチーム\n個人クリエイター\n会話を仕事につなぐ人',
    940,
    100,
    200,
    410,
  ],
  [
    'costs',
    'コスト構造',
    '開発・運用コスト / 音声認識の利用費 / 顧客検証とサポート',
    40,
    530,
    540,
    180,
  ],
  [
    'revenue',
    '収益の流れ',
    '個人向け基本プラン / チーム向け月額プラン（価格・上限は検証後に決定）',
    600,
    530,
    540,
    180,
  ],
] as const;
export function soraCanvas(): WhiteboardContent {
  return {
    schemaVersion: 3,
    connectors: [],
    sections: canvasBlocks.map(([id, title, , x, y, width, height]) => ({
      id: 'section-' + id,
      title,
      bounds: { x, y, width, height },
      background: id === 'value' ? '#c8e0cb' : '#edf1e8',
    })),
    nodes: [
      {
        id: 'canvas-title',
        kind: 'text',
        bounds: { x: 40, y: 16, width: 1100, height: 60 },
        text: 'SORA Voice / ビジネスモデルキャンバス',
        color: ink,
        typography: { fontSize: 30, bold: true, padding: 0 },
      },
      ...canvasBlocks.map(([id, , body, x, y, width, height]) => ({
        id: 'note-' + id,
        kind: 'sticky' as const,
        sectionId: 'section-' + id,
        bounds: { x: x + 14, y: y + 55, width: width - 28, height: height - 72 },
        text: body,
        color: id === 'value' ? '#eff9dc' : '#fff5cf',
        typography: {
          fontSize: 18,
          padding: 12,
          verticalAlign: 'top' as const,
          lineHeight: 1.45,
          overflow: 'fit' as const,
        },
      })),
      {
        id: 'canvas-note',
        kind: 'text',
        bounds: { x: 40, y: 743, width: 1100, height: 40 },
        text: '検証前の仮説サンプル。付箋をダブルクリックして編集し、自由に動かせます。',
        color: '#64796c',
        typography: { fontSize: 16, padding: 0 },
      },
    ],
  };
}
export const columns = [
  { id: 'backlog', name: 'アイデア', caption: 'Explore' },
  { id: 'todo', name: 'これから', caption: 'Ready to start' },
  { id: 'doing', name: '進行中', caption: 'In progress' },
  { id: 'done', name: '完了', caption: 'Shipped' },
];
export function soraTasks() {
  return [
    {
      id: 'task-1',
      title: '最初の顧客5人に話を聞く',
      description: '会議・メモの記録で困る場面を聞き、仮説を更新する。',
      status: 'todo',
      tag: 'Discovery',
      owner: 'SORA Team',
      priority: '高',
    },
    {
      id: 'task-2',
      title: '音声認識の試作を触ってもらう',
      description: 'CodeタブのSORA Voiceを操作し、開始・停止・編集を観察する。',
      status: 'doing',
      tag: 'Prototype',
      owner: 'SORA Team',
      priority: '高',
    },
    {
      id: 'task-3',
      title: 'マイク許可と非対応ブラウザーの案内',
      description: '許可拒否時のメッセージとサンプル再生を確認する。',
      status: 'todo',
      tag: 'Engineering',
      owner: 'SORA Team',
      priority: '中',
    },
    {
      id: 'task-4',
      title: 'ビジネスモデルの仮説を並べる',
      description: 'Whiteboardに顧客・価値・収益の9ブロックを作る。',
      status: 'done',
      tag: 'Strategy',
      owner: 'SORA Team',
      priority: '中',
    },
    {
      id: 'task-5',
      title: 'SORAの企画書をレビューする',
      description: 'Slideの6ページを使い、プロダクトの狙いを議論する。',
      status: 'doing',
      tag: 'Strategy',
      owner: 'SORA Team',
      priority: '中',
    },
    {
      id: 'task-6',
      title: '文字起こしを外部ツールへつなぐ',
      description: 'どこへ届けると仕事につながるか、顧客に確認する。',
      status: 'backlog',
      tag: 'Integration',
      owner: 'SORA Team',
      priority: '低',
    },
    {
      id: 'task-7',
      title: 'チームプランの価値を検証する',
      description: '共有・権限・保存の価値と支払い意向をヒアリングする。',
      status: 'backlog',
      tag: 'Business',
      owner: 'SORA Team',
      priority: '中',
    },
  ];
}
export function validTasks(value: unknown): value is ReturnType<typeof soraTasks> {
  return (
    Array.isArray(value) &&
    value.length <= 300 &&
    new Set(value.map((t) => t?.id)).size === value.length &&
    value.every(
      (t) =>
        typeof t?.id === 'string' &&
        typeof t.title === 'string' &&
        t.title.length > 0 &&
        typeof t.description === 'string' &&
        columns.some((c) => c.id === t.status) &&
        ['tag', 'owner', 'priority'].every((k) => typeof t[k] === 'string'),
    )
  );
}
