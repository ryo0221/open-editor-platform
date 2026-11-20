import { describe, expect, it } from 'vitest';
import {
  assertDesignContent,
  createDesign,
  insertElement,
  updateElement,
  type DesignContent,
} from './model';
import { insertDesignPage, insertDesignPanel } from './pagination';
import { insertDesignSpeechBalloon } from './page-artwork';
import {
  isMangaBalloon,
  mangaBalloonOverlaps,
  mangaBalloonPlacement,
  moveMangaBalloonsOffKeepOut,
  setMangaKeepOut,
} from './manga-balloons';
import { checkPanelRedrawProposal, designPanelRedrawRequest } from './manga-redraw';
import type { DesignPageProposalRequest } from './page-proposals';

const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

function page(): DesignContent {
  let d = createDesign();
  d = insertDesignPage({ x: 0, y: 0, width: 600, height: 800 }, 'p1').apply(d);
  d = insertDesignPanel('p1', { x: 20, y: 20, width: 560, height: 360 }, 'k1').apply(d);
  d = insertDesignPanel('p1', { x: 20, y: 400, width: 560, height: 360 }, 'k2').apply(d);
  // A face in the top right of the first panel, where a right-to-left balloon would go first
  d = insertElement('rectangle', {
    id: 'face',
    parentId: 'k1',
    bounds: { x: 380, y: 30, width: 190, height: 160 },
  }).apply(d);
  d = updateElement('face', { name: 'Face' }).apply(d);
  return setMangaKeepOut('face', true).apply(d);
}

describe('#21 balloons keep off faces and figures', () => {
  it('stores the role, validates it and marks new speech balloons', () => {
    let d = page();
    expect(d.elements.find((e) => e.id === 'face')?.mangaRole).toBe('keep-out');
    const b = insertDesignSpeechBalloon('k1', { x: 400, y: 40, width: 150, height: 100 }, 'セリフ');
    d = b.apply(d);
    const group = d.elements.find((e) => e.id === b.elementId)!;
    expect(group.mangaRole).toBe('balloon');
    expect(isMangaBalloon(group)).toBe(true);
    expect(() => assertDesignContent(d)).not.toThrow();
    const bad = {
      ...d,
      elements: d.elements.map((e) => (e.id === 'face' ? { ...e, mangaRole: 'hero' } : e)),
    };
    expect(() => assertDesignContent(bad)).toThrow(/mangaRole/);
    // Older balloons are recognised by name
    expect(isMangaBalloon({ ...group, mangaRole: undefined })).toBe(true);
  });

  it('finds a balloon covering a face of its own panel only', () => {
    let d = page();
    const b = insertDesignSpeechBalloon('k1', { x: 400, y: 40, width: 150, height: 100 }, 'A');
    d = b.apply(d);
    const far = insertDesignSpeechBalloon(
      'k2',
      { x: 400, y: 40 + 400, width: 150, height: 100 },
      'B',
    );
    d = far.apply(d);
    const found = mangaBalloonOverlaps(d);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ balloonId: b.elementId, keepOutId: 'face', panelId: 'k1' });
    expect(found[0].share).toBeCloseTo((150 * 100) / (190 * 160));
  });

  it('places a new balloon near the reading start without covering the face', () => {
    const d = page();
    const at = mangaBalloonPlacement(d, 'k1', { width: 150, height: 100 })!;
    const face = d.elements.find((e) => e.id === 'face')!.bounds;
    expect(overlap(at, face)).toBe(false);
    // Right to left: high in the panel, as far right as the face allows
    expect(at.y).toBeLessThan(120);
    expect(at.x + at.width).toBeLessThanOrEqual(face.x);
    const ltr = mangaBalloonPlacement(
      { ...d, pagination: { ...d.pagination!, direction: 'ltr' } },
      'k1',
      { width: 150, height: 100 },
    )!;
    expect(ltr.x).toBeLessThan(60);
    expect(mangaBalloonPlacement(d, 'k1', { width: 900, height: 100 })).toBeUndefined();
  });

  it('moves covering balloons off and reports balloons with no room', () => {
    let d = page();
    const b = insertDesignSpeechBalloon('k1', { x: 400, y: 40, width: 150, height: 100 }, 'A');
    d = b.apply(d);
    const before = d.elements.filter((e) => e.parentId === b.elementId).map((e) => e.bounds);
    const { command, moved, stuck } = moveMangaBalloonsOffKeepOut(d);
    expect(moved).toEqual([b.elementId]);
    expect(stuck).toEqual([]);
    const after = command!.apply(d);
    expect(mangaBalloonOverlaps(after)).toEqual([]);
    // The outline and the dialogue move with the group
    const group = after.elements.find((e) => e.id === b.elementId)!.bounds;
    const children = after.elements.filter((e) => e.parentId === b.elementId).map((e) => e.bounds);
    expect(children[0].x - before[0].x).toBeCloseTo(group.x - 400);
    // A face filling the whole panel leaves no room
    const full = insertElement('rectangle', {
      id: 'crowd',
      parentId: 'k2',
      bounds: { x: 20, y: 400, width: 560, height: 360 },
    }).apply(after);
    const blocked = insertDesignSpeechBalloon(
      'k2',
      { x: 100, y: 450, width: 150, height: 100 },
      'C',
    );
    const crowded = blocked.apply(setMangaKeepOut('crowd', true).apply(full));
    expect(moveMangaBalloonsOffKeepOut(crowded).stuck).toEqual([blocked.elementId]);
  });
});

describe('#21 redraw one panel', () => {
  it('describes the panel and keeps the answer inside it', () => {
    let d = page();
    d = insertElement('image', {
      id: 'art',
      parentId: 'k1',
      bounds: { x: 20, y: 20, width: 560, height: 360 },
    }).apply(d);
    d = insertElement('image', {
      id: 'other',
      parentId: 'k2',
      bounds: { x: 20, y: 400, width: 560, height: 360 },
    }).apply(d);
    const ask = designPanelRedrawRequest(d, 'k1', '表情をもっと驚かせる');
    expect(ask).toMatchObject({
      pageId: 'p1',
      page: 1,
      panel: 1,
      imageIds: ['art'],
      notes: '表情をもっと驚かせる',
    });
    expect(ask.keepOut.map((k) => k.id)).toEqual(['face']);
    expect(() => designPanelRedrawRequest(d, 'nope', '')).toThrow(/reading order/);
    const proposal = (operations: DesignPageProposalRequest['units'][number]['operations']) =>
      ({
        units: [{ id: 'u', label: 'u', requires: [], operations }],
      }) as unknown as DesignPageProposalRequest;
    const src = { src: 'data:image/png;base64,AA==', source: 'host', license: 'own' };
    expect(() =>
      checkPanelRedrawProposal(d, ask, proposal([{ type: 'image', id: 'art', value: src }])),
    ).not.toThrow();
    expect(() =>
      checkPanelRedrawProposal(d, ask, proposal([{ type: 'image', id: 'other', value: src }])),
    ).toThrow(/only change elements in panel k1/);
    expect(() =>
      checkPanelRedrawProposal(
        d,
        ask,
        proposal([{ type: 'bounds', id: 'face', value: { x: 0, y: 0, width: 50, height: 50 } }]),
      ),
    ).toThrow(/outside panel/);
    expect(() =>
      checkPanelRedrawProposal(
        d,
        ask,
        proposal([{ type: 'pageOrder', before: ['p1'], after: ['p1'] }]),
      ),
    ).toThrow(/cannot change pageOrder/);
  });
});
