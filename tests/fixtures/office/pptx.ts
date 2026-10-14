import { createDeck, type SlideContent, type SlideObject } from '@editor-platform/slide/model';
import { shapeNames } from '@editor-platform/editor-core';

const family = 'Noto Sans CJK JP';
function text(
  id: string,
  value: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fontSize = 24,
): SlideObject {
  return {
    id,
    type: 'text',
    text: value,
    fill: '#253044',
    bounds: { x, y, width, height },
    typography: { fontFamily: family, fontSize, padding: 4 },
  };
}
function page(id: string, title: string, objects: SlideObject[]) {
  return {
    id,
    title,
    background: '#ffffff',
    objects: [text(`${id}-title`, title, 32, 20, 896, 48, 28), ...objects],
  };
}
/** Independent, readable cases; expected shape counts and placements are asserted separately. */
export function pptxGoldenDeck(
  images: Record<'png' | 'jpeg' | 'gif' | 'webp', string>,
): SlideContent {
  const deck = createDeck();
  deck.slides = [
    page('G02', '日本語・英数字・rich text', [
      text('jp', '日本語の資料：受付改善、費用と効果。「確認済み」です。', 40, 90, 870, 55, 28),
      {
        ...text('rich', '太字 Bold / italic / 下線 / 取消線', 40, 160, 860, 65, 26),
        runs: [
          { text: '太字 Bold', style: { bold: true, color: '#a12626' } },
          { text: ' / italic', style: { italic: true } },
          { text: ' / 下線', style: { underline: true } },
          { text: ' / 取消線', style: { strike: true } },
        ],
      },
      text(
        'breaks',
        '改行を保持します。\n第二行には ABC 123 と句読点。\n第三行：A&B <C> "引用"',
        40,
        250,
        840,
        150,
      ),
      text(
        'url',
        'https://example.test/reports/2026/very_long_identifier_1234567890?name=東京&value=6',
        40,
        420,
        840,
        90,
        21,
      ),
    ]),
    page('G03', '共有レイアウト：fit / expand / clip', [
      {
        ...text(
          'fit',
          '狭い領域でも表示する長文です。サイズ調整は画面と同じ計算を使います。ABC 1234567890',
          45,
          100,
          250,
          135,
          34,
        ),
        typography: {
          fontFamily: family,
          fontSize: 34,
          padding: 9,
          lineHeight: 1.25,
          overflow: 'fit',
        },
      },
      {
        ...text('expand', '行間と文字間隔\n二行目の表示\n三行目の表示', 345, 100, 270, 50, 24),
        typography: {
          fontFamily: family,
          fontSize: 24,
          padding: 8,
          lineHeight: 1.8,
          letterSpacing: 1.5,
          overflow: 'expand',
        },
      },
      {
        ...text(
          'clip',
          '可視領域だけを表示\nこの行は下側で切れます。\n後続の行です。',
          665,
          100,
          245,
          70,
          26,
        ),
        typography: { fontFamily: family, fontSize: 26, padding: 8, overflow: 'clip' },
      },
      {
        ...text('mixed', '大きい文字 と 小さい文字', 50, 350, 560, 110, 22),
        runs: [
          { text: '大きい文字', style: { fontSize: 38, bold: true } },
          { text: ' と ', style: { fontSize: 18 } },
          { text: '小さい文字', style: { fontSize: 22, underline: true, color: '#226644' } },
        ],
        typography: {
          fontFamily: family,
          fontSize: 22,
          padding: 10,
          align: 'center',
          verticalAlign: 'middle',
        },
      },
      { ...text('rotated', '回転と反転', 700, 360, 180, 65, 22), rotation: 15, flipX: true },
    ]),
    page(
      'G04',
      '25種類の図形：13 native / 12 PNG',
      shapeNames.flatMap((shape, i): SlideObject[] => {
        const x = 30 + (i % 5) * 186,
          y = 82 + Math.floor(i / 5) * 90;
        return [
          {
            id: `shape-${shape}`,
            type: 'shape',
            shape,
            text: '',
            fill: '#90b9d6',
            stroke: '#324a66',
            strokeWidth: 2,
            dash: i % 4 === 0 ? '6 3' : '',
            radius: 12,
            opacity: i % 3 === 0 ? 0.6 : 1,
            rotation: i % 3 === 1 ? 8 : 0,
            flipX: i % 3 === 2,
            bounds: { x: x + 30, y, width: 110, height: 52 },
          },
          text(`label-${shape}`, shape, x, y + 54, 180, 28, 13),
        ];
      }),
    ),
    page('G05', '重なり・world座標・nested group', [
      {
        id: 'child-red',
        groupId: 'inner',
        type: 'shape',
        shape: 'rectangle',
        text: '奥',
        fill: '#dd7777',
        bounds: { x: 120, y: 130, width: 250, height: 170 },
        typography: { fontFamily: family },
      },
      {
        id: 'outer',
        type: 'group',
        text: '',
        fill: 'none',
        bounds: { x: 120, y: 130, width: 500, height: 250 },
      },
      {
        id: 'inner',
        groupId: 'outer',
        type: 'group',
        text: '',
        fill: 'none',
        bounds: { x: 120, y: 130, width: 500, height: 250 },
      },
      {
        id: 'child-blue',
        groupId: 'inner',
        type: 'shape',
        shape: 'ellipse',
        text: '前',
        fill: '#7799dd',
        bounds: { x: 270, y: 220, width: 250, height: 160 },
        typography: { fontFamily: family },
      },
      {
        id: 'outside',
        type: 'shape',
        shape: 'triangle',
        text: '',
        fill: '#66aa77',
        bounds: { x: -30, y: 380, width: 150, height: 180 },
      },
      {
        id: 'hidden',
        type: 'shape',
        hidden: true,
        text: 'SHOULD_NOT_APPEAR',
        fill: 'red',
        bounds: { x: 700, y: 200, width: 180, height: 100 },
      },
      text('front', '前面の文字：移動は一度だけ', 280, 330, 600, 60, 26),
    ]),
    page(
      'G06',
      '画像の埋込み・切り抜き・回転',
      (['png', 'jpeg', 'gif', 'webp'] as const).flatMap((format, i): SlideObject[] => {
        const x = 40 + i * 230;
        return [
          text(`label-${format}`, format.toUpperCase(), x, 75, 200, 36, 18),
          {
            id: `${format}-fit`,
            type: 'image',
            text: '',
            fill: 'none',
            src: images[format],
            imageFit: 'fit',
            bounds: { x, y: 115, width: 185, height: 150 },
            alt: `${format} fit 日本語`,
          },
          {
            id: `${format}-crop`,
            type: 'image',
            text: '',
            fill: 'none',
            src: images[format],
            imageFit: 'fill',
            crop: { x: -18, y: -12, scale: 1.3 },
            rotation: i * 7,
            flipX: i % 2 === 1,
            flipY: i === 2,
            opacity: i === 3 ? 0.6 : 1,
            bounds: { x, y: 320, width: 185, height: 150 },
            alt: `${format} crop 日本語`,
          },
        ];
      }),
    ),
    page('G07', 'native table と結合表の明示PNG', [
      {
        id: 'simple',
        type: 'table',
        text: '',
        fill: '#ffffff',
        bounds: { x: 40, y: 90, width: 880, height: 195 },
        typography: { fontFamily: family, fontSize: 18, padding: 9 },
        table: {
          rows: [
            ['項目', '内容', '数値'],
            ['日本語の項目', '長いセルです。途中で折り返し、原文をすべて保持します。', '6'],
            ['英数字', 'ABC / 123 / A&B', '200'],
          ],
          columnWidths: [240, 490, 150],
          rowHeights: [50, 85, 60],
        },
      },
      {
        id: 'merged',
        type: 'table',
        text: '',
        fill: '#ffffff',
        bounds: { x: 40, y: 340, width: 540, height: 130 },
        typography: { fontFamily: family, fontSize: 18 },
        table: {
          rows: [
            ['結合した見出し', ''],
            ['項目', '内容'],
          ],
          merges: [{ row: 0, col: 0, rows: 1, cols: 2 }],
        },
      },
      {
        id: 'chart',
        type: 'chart',
        text: '',
        fill: '#3978c6',
        bounds: { x: 650, y: 330, width: 265, height: 170 },
        chart: {
          capturedAt: '2026-10-05T00:00:00.000Z',
          type: 'bar',
          labels: ['受付', '確認', '完了'],
          values: [12, 6, 18],
          label: '処理件数',
        },
      },
    ]),
  ];
  deck.slides[0].notes = '明示的に選択した時だけ出力するノート。A&B <sample>';
  deck.slides.push(
    page('G07-transform', '表の回転・反転・透明度', [
      {
        id: 'rotated-table',
        type: 'table',
        text: '',
        fill: '#fff',
        rotation: 15,
        bounds: { x: 50, y: 170, width: 360, height: 130 },
        typography: { fontFamily: family, fontSize: 18 },
        table: {
          rows: [
            ['項目', '値'],
            ['回転した表', '6'],
          ],
        },
      },
      {
        id: 'flipped-table',
        type: 'table',
        text: '',
        fill: '#fff',
        flipX: true,
        bounds: { x: 535, y: 170, width: 360, height: 130 },
        typography: { fontFamily: family, fontSize: 18 },
        table: {
          rows: [
            ['項目', '値'],
            ['反転した表', '6'],
          ],
        },
      },
      {
        id: 'opacity-table',
        type: 'table',
        text: '',
        fill: '#fff',
        opacity: 0.5,
        stroke: 'rgba(0,80,180,0.5)',
        bounds: { x: 210, y: 380, width: 540, height: 110 },
        typography: { fontFamily: family, fontSize: 18 },
        table: {
          rows: [
            ['透明度', 'stroke alpha'],
            ['保持します', '50%'],
          ],
        },
      },
    ]),
  );
  return deck;
}
