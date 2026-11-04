import { createArtifact, type Artifact } from '@editor-platform/artifact-core';
import {
  createDesign,
  insertElement,
  insertDesignPath,
  updateElement,
  type DesignContent,
} from '@editor-platform/design/model';
import { designDivisionCommand, type DesignDivisionNode } from '@editor-platform/design/division';
import { insertDesignPage, setDesignPagination } from '@editor-platform/design/pagination';
import { insertDesignSpeechBalloon } from '@editor-platform/design/page-artwork';

/** The accepted two-page/eight-panel script. Optional original illustrations are external assets.
 * The contact drawing and all dialogue remain editable native elements. No generated binary in Git. */
export function mangaWorkspaceFixture(
  images: Record<string, string> = {},
): Artifact<DesignContent> & { annotations: never[] } {
  let d = createDesign();
  const branch = (
    id: string,
    offset: number,
    a: DesignDivisionNode,
    b: DesignDivisionNode,
    nx = 0,
  ): DesignDivisionNode => ({
    dividerId: id,
    line: { nx, ny: Math.sqrt(1 - nx * nx), offset },
    gap: 16,
    a,
    b,
  });
  const vertical = (id: string, a: string, b: string): DesignDivisionNode => ({
    dividerId: id,
    line: { nx: 1, ny: 0, offset: 400 },
    gap: 16,
    a: { panelId: a },
    b: { panelId: b },
  });
  const page = (id: string, x: number, top: number, root: DesignDivisionNode, order: string[]) => {
    d = insertDesignPage({ x, y: 0, width: 800, height: 1180 }, id).apply(d);
    d = updateElement(id, { fill: '#ffffff', strokeWidth: 0, name: id }).apply(d);
    d = designDivisionCommand({
      type: 'startDivision',
      pageId: id,
      region: { x: 32, y: top, width: 736, height: 1134 - top },
      root,
    }).apply(d);
    d = setDesignPagination({
      ...d.pagination!,
      pages: d.pagination!.pages.map((p) => (p.frameId === id ? { ...p, panelIds: order } : p)),
    }).apply(d);
  };
  page(
    'page-1',
    860,
    114,
    branch(
      'p1-top',
      400,
      { panelId: 'harbor' },
      branch(
        'p1-action',
        700,
        vertical('p1-contact', 'contact', 'reaction'),
        { panelId: 'leap' },
        0.12,
      ),
    ),
    ['harbor', 'reaction', 'contact', 'leap'],
  );
  page(
    'page-2',
    0,
    104,
    branch(
      'p2-top',
      530,
      { panelId: 'chain' },
      branch('p2-bottom', 840, vertical('p2-middle', 'compass', 'friend'), {
        panelId: 'departure',
      }),
    ),
    ['chain', 'friend', 'compass', 'departure'],
  );
  const text = (
    id: string,
    parentId: string,
    value: string,
    x: number,
    y: number,
    width: number,
    height: number,
    size = 24,
  ) => {
    d = insertElement('text', { id, parentId, bounds: { x, y, width, height } }).apply(d);
    d = updateElement(id, {
      name: id,
      text: value,
      fill: '#111111',
      typography: {
        fontFamily: 'Noto Sans CJK JP',
        fontSize: size,
        bold: true,
        lineHeight: 1.2,
        padding: 0,
      },
    }).apply(d);
  };
  const imageMeta: NonNullable<DesignContent['pagination']>['images'] = [];
  for (const [id, asset, label] of [
    ['harbor', 'harbor', '港の門が閉じる'],
    ['reaction', 'resolve', '主人公がロープを取る'],
    ['contact', '', 'ロープが留め具に掛かる'],
    ['leap', 'hero', '主人公が跳ぶ'],
    ['chain', 'impact', '鎖が落下する'],
    ['friend', 'resolve', '仲間が気づく'],
    ['compass', 'compass', '羅針盤が上を指す'],
    ['departure', 'departure', '船が港を抜ける'],
  ]) {
    const panel = d.elements.find((e) => e.id === id)!;
    d = updateElement(id, { name: label, strokeWidth: 4 }).apply(d);
    if (images[asset]) {
      d = insertElement('image', {
        id: `art-${id}`,
        parentId: id,
        bounds: panel.bounds,
        src: images[asset],
      }).apply(d);
      imageMeta.push({
        elementId: `art-${id}`,
        source: `Original AI-generated adventure demonstration: ${asset}`,
        license: 'Generated for the original demonstration; no third-party stock image',
      });
    } else if (id !== 'contact')
      text(
        `rough-${id}`,
        id,
        label,
        panel.bounds.x + 30,
        panel.bounds.y + panel.bounds.height - 74,
        panel.bounds.width - 60,
        48,
        18,
      );
  }
  // Rope and cleat: native line/cubic geometry to inspect and directly edit.
  const points = [
    [0, 10],
    [70, 55],
    [110, 85],
    [170, 85],
    [145, 45],
    [110, 85],
    [170, 130],
    [240, 120],
  ];
  d = insertDesignPath(
    {
      frame: { x: 0, y: 0, width: 240, height: 140 },
      fillRule: 'nonzero',
      subpaths: [
        {
          id: 'rope',
          closed: false,
          anchors: points.map(([x, y], i) => ({ id: `rope-${i}`, x, y, mode: 'corner' as const })),
          segments: points.slice(1).map((_, i) => ({
            id: `rope-line-${i}`,
            type: 'line' as const,
            from: `rope-${i}`,
            to: `rope-${i + 1}`,
          })),
        },
      ],
    },
    { x: 910, y: 470, width: 300, height: 175 },
    'contact',
  ).apply(d);
  const rope = d.elements.at(-1)!;
  d = updateElement(rope.id, {
    name: '留め具とロープ（編集可能な線）',
    fill: 'none',
    stroke: '#111111',
    strokeWidth: 5,
  }).apply(d);
  text('contact-sfx', 'contact', 'カチッ', 1090, 439, 115, 40, 25);
  const balloon = (
    id: string,
    parentId: string,
    value: string,
    x: number,
    y: number,
    w: number,
    h: number,
    size = 23,
  ) => {
    const command = insertDesignSpeechBalloon(parentId, { x, y, width: w, height: h }, value);
    d = command.apply(d);
    d = updateElement(command.textId, {
      name: id,
      typography: {
        fontFamily: 'Noto Sans CJK JP',
        fontSize: size,
        bold: true,
        align: 'center',
        lineHeight: 1.15,
        padding: 0,
      },
    }).apply(d);
  };
  text('title', 'page-1', '潮鳴りの羅針盤', 892, 22, 720, 55, 38);
  text('subtitle', 'page-1', '閉ざされた海の、その先へ', 894, 77, 720, 27, 18);
  text('second-title', 'page-2', '潮鳴りの羅針盤 ／ 出航', 32, 36, 736, 42, 25);
  balloon('門の台詞', 'harbor', '門が\n閉まる！', 1400, 135, 200, 150);
  balloon('反応の台詞', 'reaction', 'あそこだ！', 1390, 422, 200, 130, 21);
  balloon('跳躍の台詞', 'leap', '行くぞ！', 920, 760, 185, 140, 28);
  balloon('鎖の台詞', 'chain', '道が、\n開いた！', 480, 130, 235, 155);
  balloon('仲間の台詞', 'friend', '見て、針が！', 510, 558, 225, 135, 21);
  balloon('羅針盤の台詞', 'compass', '空を指してる', 76, 550, 265, 130, 21);
  balloon('出航の台詞', 'departure', 'この海の、\nその先へ。', 500, 880, 230, 150);
  text('folio-1', 'page-1', '01', 1550, 1147, 70, 24, 16);
  text('folio-2', 'page-2', '02', 32, 1147, 70, 24, 16);
  d = setDesignPagination({ ...d.pagination!, images: imageMeta }).apply(d);
  return { ...createArtifact('design', '潮鳴りの羅針盤｜8コマの通読', d), annotations: [] };
}
