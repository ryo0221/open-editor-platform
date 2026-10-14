import type { DocumentBlock, DocumentContent } from '@editor-platform/document/model';

/** Independently authored native content: visible strings and table anchors are audit inputs. */
export function docxGoldenDocument(
  images: Record<'png' | 'jpeg' | 'gif' | 'webp', string>,
): DocumentContent {
  return {
    schemaVersion: 2,
    page: { size: 'A4', margin: 56 },
    blocks: [
      { id: 'D01-title', type: 'heading', level: 1, text: '受付改善の提案書' },
      {
        id: 'D01-body',
        type: 'paragraph',
        text: '来訪者の待ち時間を減らし、受付担当者と同じ資料を編集して改善します。',
      },
      {
        id: 'D02-rich',
        type: 'paragraph',
        text: 'STALE_RICH_TEXT',
        rich: [
          { text: '日本語 ABC 123、句読点。「引用」  二つの空白\tタブ\n明示改行。' },
          { text: '太字', bold: true },
          { text: ' italic', italic: true },
          { text: ' 下線', underline: true },
          { text: ' 取消', strike: true },
          { text: ' 色と背景', color: '#224488', highlight: '#fff2bb' },
          { text: ' 公式資料', link: 'https://example.com/guide?a=1&b=2' },
          { text: ' 内部リンクの文字', link: '#local' },
          { text: ' inline_code()', code: true },
        ],
      },
      ...Array.from(
        { length: 5 },
        (_, i): DocumentBlock => ({
          id: `D02-heading-${i + 2}`,
          type: 'heading',
          level: i + 2,
          text: `見出しレベル${i + 2}`,
        }),
      ),
      {
        id: 'D03-list',
        type: 'numbered-list',
        text: '',
        items: [
          {
            id: 'D03-first',
            rich: [{ text: '第一の確認事項' }],
            childLists: [
              {
                id: 'D03-bullets',
                type: 'bullet_list',
                items: [
                  {
                    id: 'D03-child',
                    rich: [{ text: '入れ子の箇条書き' }],
                    childrenType: 'ordered_list',
                    children: [{ id: 'D03-grandchild', rich: [{ text: '三段目の番号付き項目' }] }],
                  },
                ],
              },
            ],
          },
          { id: 'D03-second', rich: [{ text: '第二の確認事項' }] },
        ],
      },
      { id: 'D03-separator', type: 'paragraph', text: '次のリストは番号を一から開始します。' },
      { id: 'D03-restart', type: 'numbered-list', text: '新しい一番目\n新しい二番目' },
      {
        id: 'D03-check',
        type: 'check-list',
        text: '',
        items: [
          {
            id: 'D03-done',
            checked: true,
            rich: [{ text: '確認済み' }],
            children: [
              { id: 'D03-nested-check', checked: false, rich: [{ text: '子の未確認項目' }] },
            ],
          },
          { id: 'D03-todo', checked: false, rich: [{ text: '次の作業' }] },
        ],
      },
      {
        id: 'D04-horizontal',
        type: 'table',
        text: '',
        cells: [
          ['比較表の結合見出し', 'COVERED_HORIZONTAL', '判定'],
          ['現状', '待ち時間が長い', '要改善'],
          ['改善後', '入力時間を計測する', '確認'],
        ],
        merges: [{ row: 0, col: 0, rows: 1, cols: 2 }],
        columnWidths: [130, 280, 120],
        cellHeaders: [
          [true, true, true],
          [false, false, false],
          [false, false, false],
        ],
        cellParagraphs: [
          [[{ id: 'D04-h1', rich: [{ text: '比較表の結合見出し', bold: true }] }]],
          [
            null as never,
            [
              { id: 'D04-p1', rich: [{ text: '待ち時間が長い' }] },
              { id: 'D04-p2', rich: [{ text: '複数段落を保持', color: '#224488' }] },
            ],
          ],
        ],
      },
      {
        id: 'D04-rectangle',
        type: 'table',
        text: '',
        cells: [
          ['矩形結合の本文', 'COVERED_RECTANGLE_1', '右上'],
          ['COVERED_RECTANGLE_2', 'COVERED_RECTANGLE_3', '右下'],
          ['結合後', '別のセル', '終端'],
        ],
        merges: [{ row: 0, col: 0, rows: 2, cols: 2 }],
        columnWidths: [180, 180, 170],
        cellHeaders: [
          [false, false, false],
          [false, false, false],
          [false, false, false],
        ],
        cellRich: [[[{ text: '矩形結合の本文', bold: true }]]],
      },
      { id: 'D04-after', type: 'paragraph', text: '結合表の直後も文章が残ります。' },
      {
        id: 'D02-code',
        type: 'code',
        language: 'typescript',
        text: 'const value = "日本語";\n  if (value) {\n\tconsole.log(value);  // space\n  }',
      },
      ...(['png', 'jpeg', 'gif', 'webp'] as const).map(
        (format, i): DocumentBlock => ({
          id: `D07-${format}`,
          type: 'image',
          text: '',
          src: images[format],
          width: i === 0 ? 1000 : 160,
          alt: `${format}の四分割画像`,
          caption: `図${i + 1}：${format}の色と透明部分`,
        }),
      ),
      {
        id: 'D08-mermaid',
        type: 'mermaid',
        text: 'flowchart LR\n  A[受付] --> B[確認]\n  B --> C[完了]',
        caption: '受付から完了まで',
      },
      {
        id: 'D08-html',
        type: 'html',
        text: '<h2>原文保持</h2>\n<script>globalThis.EXPORT_EXECUTED=true</script>',
      },
      { id: 'D08-react', type: 'react-preview', text: 'export default () => <p>日本語の原文</p>;' },
      { id: 'D01-end', type: 'paragraph', text: '提案書の最終段落：以上です。' },
    ],
  };
}

export function docxLongTable(): DocumentContent {
  const cells = [
    ['確認番号', '継続する本文'],
    ...Array.from({ length: 64 }, (_, i) => [
      `項目${String(i + 1).padStart(2, '0')}`,
      `本文${String(i + 1).padStart(2, '0')}：受付担当者と利用者が内容を確認します。\n次の行も切り捨てません。`,
    ]),
  ];
  cells[31][1] = Array.from(
    { length: 35 },
    (_, i) => `長文行${String(i + 1).padStart(2, '0')}：ページをまたぐセルも内容を維持。`,
  ).join('\n');
  for (let r = 18; r < 22; r++) cells[r][0] = 'COVERED_VERTICAL_' + r;
  cells[17][0] = '縦結合の確認';
  cells[10][0] = 'ページ境界の縦結合';
  for (let r = 11; r < 15; r++) cells[r][0] = 'COVERED_PAGE_MERGE_' + r;
  return {
    schemaVersion: 2,
    page: { size: 'A4', margin: 56 },
    blocks: [
      { id: 'D05-heading', type: 'heading', level: 1, text: '長い結合表の連続性' },
      {
        id: 'D05-table',
        type: 'table',
        text: '',
        cells,
        columnWidths: [130, 530],
        cellHeaders: cells.map((_, r) => [r === 0, r === 0]),
        merges: [
          { row: 10, col: 0, rows: 5, cols: 1 },
          { row: 17, col: 0, rows: 5, cols: 1 },
        ],
      },
      {
        id: 'D05-after',
        type: 'paragraph',
        text: '長い表の後の最終段落：この文が必ず表示されます。',
      },
    ],
  };
}

export function docxPageCase(size: 'A4' | 'Letter', landscape: boolean): DocumentContent {
  return {
    schemaVersion: 1,
    page: { size, landscape, margin: 80 },
    blocks: [
      {
        id: 'D06-heading',
        type: 'heading',
        level: 1,
        text: `${size} ${landscape ? '横' : '縦'}向きの文書`,
      },
      ...Array.from(
        { length: 16 },
        (_, i): DocumentBlock => ({
          id: `D06-p-${i}`,
          type: i === 13 ? 'heading' : 'paragraph',
          ...(i === 13 ? { level: 2 } : {}),
          text:
            i === 13
              ? '末尾付近の見出し'
              : `段落${i + 1}：` +
                '本文はOfficeの組版に従って流れます。原文を削除せず、見出しと次の段落をつなぎます。'.repeat(
                  3,
                ),
        }),
      ),
      { id: 'D06-old-list', type: 'bulleted-list', text: '旧schemaの第一項目\n旧schemaの第二項目' },
      { id: 'D06-end', type: 'paragraph', text: 'ページ設定資料の最終段落。' },
    ],
  };
}
