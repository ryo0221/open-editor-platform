import { describe, expect, it } from 'vitest';
import {
  assertDesignContent,
  createDesign,
  insertElement,
  updateElement,
  type DesignContent,
} from './model';
import { designDivisionCommand } from './division';
import { insertDesignPage, insertDesignPanel } from './pagination';
import { insertDesignSpeechBalloon } from './page-artwork';
import {
  isMangaBalloon,
  mangaBalloonOverlaps,
  mangaBalloonPlacement,
  moveMangaBalloonsOffKeepOut,
  setMangaKeepOut,
} from './manga-balloons';
import {
  checkPanelRedrawProposal,
  checkPanelRedrawSelection,
  designPanelRedrawRequest,
} from './manga-redraw';
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

  it('sees a turned face where it is drawn (Codex on #28)', () => {
    let d = page();
    // 200 × 20 turned a quarter: drawn as 20 wide and 200 tall around the same centre.
    d = insertElement('rectangle', {
      id: 'arm',
      parentId: 'k1',
      bounds: { x: 100, y: 120, width: 200, height: 20 },
    }).apply(d);
    d = setMangaKeepOut('arm', true).apply(updateElement('arm', { rotation: 90 }).apply(d));
    const b = insertDesignSpeechBalloon('k1', { x: 190, y: 40, width: 20, height: 40 }, 'A');
    d = b.apply(d);
    expect(mangaBalloonOverlaps(d).map((o) => o.keepOutId)).toEqual(['arm']);
    const at = mangaBalloonPlacement(d, 'k1', { width: 60, height: 60 }, [b.elementId])!;
    expect(overlap(at, { x: 190, y: 30, width: 20, height: 200 })).toBe(false);
  });

  it('sees a face turned by a shared style where it is drawn (Codex on #28)', () => {
    let d = page();
    d = insertElement('rectangle', {
      id: 'arm',
      parentId: 'k1',
      bounds: { x: 100, y: 120, width: 200, height: 20 },
    }).apply(d);
    d = setMangaKeepOut('arm', true).apply(d);
    d = {
      ...d,
      styles: [{ id: 'turned', name: 'Turned', appearance: { rotation: 90 } }],
      elements: d.elements.map((e) => (e.id === 'arm' ? { ...e, styleId: 'turned' } : e)),
    };
    const b = insertDesignSpeechBalloon('k1', { x: 190, y: 40, width: 20, height: 40 }, 'A');
    d = b.apply(d);
    expect(mangaBalloonOverlaps(d).map((o) => o.keepOutId)).toEqual(['arm']);
  });

  it('keeps a balloon in place when a layout inside it grows as it moves (Codex on #28)', () => {
    let d = page();
    const b = insertDesignSpeechBalloon('k1', { x: 400, y: 40, width: 150, height: 100 }, 'A');
    d = b.apply(d);
    d = insertElement('frame', {
      id: 'column',
      parentId: b.elementId,
      bounds: { x: 410, y: 50, width: 100, height: 60 },
    }).apply(d);
    d = updateElement('column', {
      layout: { direction: 'column', gap: 0, padding: 0, align: 'start', sizing: 'hug' },
    }).apply(d);
    d = insertElement('text', {
      id: 'long',
      parentId: 'column',
      bounds: { x: 410, y: 50, width: 100, height: 60 },
    }).apply(d);
    d = updateElement('long', { text: 'ながいセリフ'.repeat(30), sizing: 'hug' }).apply(d);
    // Moved off the face, the hug-sized column lays its text out and grows past what was searched.
    const { moved, stuck, command } = moveMangaBalloonsOffKeepOut(d);
    expect(moved).toEqual([]);
    expect(stuck).toEqual([b.elementId]);
    expect(command).toBeUndefined();
  });

  it('leaves a locked balloon in place, says so, and still moves the others (Codex on #28)', () => {
    let d = page();
    const a = insertDesignSpeechBalloon('k1', { x: 400, y: 40, width: 80, height: 60 }, 'A');
    d = a.apply(d);
    const b = insertDesignSpeechBalloon('k1', { x: 450, y: 100, width: 80, height: 60 }, 'B');
    d = b.apply(d);
    d = updateElement(a.elementId, { locked: true }).apply(d);
    const { command, moved, locked } = moveMangaBalloonsOffKeepOut(d);
    expect(locked).toEqual([a.elementId]);
    expect(moved).toEqual([b.elementId]);
    const after = command!.apply(d);
    expect(mangaBalloonOverlaps(after).map((o) => o.balloonId)).toEqual([a.elementId]);
  });

  it('reports a balloon a layout holds over the face, and does not count it moved (Codex on #28)', () => {
    let d = page();
    d = insertElement('group', {
      id: 'holder',
      parentId: 'k1',
      bounds: { x: 400, y: 40, width: 150, height: 100 },
    }).apply(d);
    d = updateElement('holder', {
      layout: { direction: 'row', gap: 0, padding: 0, align: 'start', sizing: 'fixed' },
    }).apply(d);
    const b = insertDesignSpeechBalloon('k1', { x: 400, y: 40, width: 150, height: 100 }, 'A');
    d = updateElement(b.elementId, { parentId: 'holder' }).apply(b.apply(d));
    expect(mangaBalloonOverlaps(d).map((o) => o.balloonId)).toEqual([b.elementId]);
    const { command, moved, stuck } = moveMangaBalloonsOffKeepOut(d);
    expect(moved).toEqual([]);
    expect(stuck).toEqual([b.elementId]);
    expect(command).toBeUndefined();
  });

  it('does not take a move that carries another balloon onto it (Codex on #28)', () => {
    let d = page();
    d = insertElement('group', {
      id: 'holder',
      parentId: 'k1',
      bounds: { x: 230, y: 28, width: 150, height: 100 },
    }).apply(d);
    d = updateElement('holder', {
      layout: { direction: 'row', gap: 0, padding: 0, align: 'start', sizing: 'fixed' },
    }).apply(d);
    const b = insertDesignSpeechBalloon('k1', { x: 230, y: 28, width: 150, height: 100 }, 'B');
    d = updateElement(b.elementId, { parentId: 'holder' }).apply(b.apply(d));
    const a = insertDesignSpeechBalloon('k1', { x: 400, y: 40, width: 150, height: 100 }, 'A');
    d = a.apply(d);
    // B's stored place is stale (lower left); its row puts it back at (230, 28) on the next edit,
    // which is the free place the search finds for A.
    const inB = (id: string) =>
      id === b.elementId || d.elements.find((e) => e.id === id)?.parentId === b.elementId;
    d = {
      ...d,
      elements: d.elements.map((e) =>
        inB(e.id) ? { ...e, bounds: { ...e.bounds, x: e.bounds.x - 200, y: e.bounds.y + 220 } } : e,
      ),
    };
    const { command, moved, stuck } = moveMangaBalloonsOffKeepOut(d);
    expect(moved).toEqual([]);
    expect(stuck).toEqual([a.elementId]);
    expect(command).toBeUndefined();
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
    // A group moved to the panel edge carries a part that reaches past the group (Codex on #28).
    d = insertElement('group', {
      id: 'g',
      parentId: 'k1',
      bounds: { x: 100, y: 100, width: 100, height: 100 },
    }).apply(d);
    d = insertElement('rectangle', {
      id: 'tail',
      parentId: 'g',
      bounds: { x: 100, y: 100, width: 160, height: 100 },
    }).apply(d);
    const asked = designPanelRedrawRequest(d, 'k1', '');
    expect(() =>
      checkPanelRedrawProposal(
        d,
        asked,
        proposal([{ type: 'bounds', id: 'g', value: { x: 470, y: 100, width: 100, height: 100 } }]),
      ),
    ).toThrow(/tail would move outside panel k1/);
    expect(() =>
      checkPanelRedrawProposal(
        d,
        asked,
        proposal([{ type: 'bounds', id: 'g', value: { x: 300, y: 100, width: 100, height: 100 } }]),
      ),
    ).not.toThrow();
    // A moves the group to the edge (its tail out), B (needing A) brings the tail back: the whole
    // answer stays in, A alone does not, so selecting A alone is refused (Codex on #28).
    const parts = {
      units: [
        {
          id: 'a',
          label: 'a',
          requires: [],
          operations: [
            { type: 'bounds', id: 'g', value: { x: 470, y: 100, width: 100, height: 100 } },
          ],
        },
        {
          id: 'b',
          label: 'b',
          requires: ['a'],
          operations: [
            { type: 'bounds', id: 'tail', value: { x: 410, y: 100, width: 160, height: 100 } },
          ],
        },
      ],
    } as unknown as DesignPageProposalRequest;
    expect(() => checkPanelRedrawProposal(d, asked, parts)).not.toThrow();
    expect(() => checkPanelRedrawSelection(d, asked, parts, ['a', 'b'])).not.toThrow();
    expect(() => checkPanelRedrawSelection(d, asked, parts, ['a'])).toThrow(
      /tail would move outside panel k1/,
    );
  });

  it('plays text changes too, so text that grows past the panel is refused (Codex on #28)', () => {
    let d = page();
    d = insertElement('group', {
      id: 'row',
      parentId: 'k1',
      bounds: { x: 40, y: 220, width: 100, height: 40 },
    }).apply(d);
    d = updateElement('row', {
      layout: { direction: 'row', gap: 0, padding: 0, align: 'start', sizing: 'hug' },
    }).apply(d);
    d = insertElement('text', {
      id: 'line',
      parentId: 'row',
      bounds: { x: 40, y: 220, width: 100, height: 40 },
    }).apply(d);
    d = updateElement('line', { text: 'あ', sizing: 'hug' }).apply(d);
    const asked = designPanelRedrawRequest(d, 'k1', '');
    const answer = {
      units: [
        {
          id: 'u',
          label: 'u',
          requires: [],
          operations: [
            { type: 'text', id: 'line', value: 'あ'.repeat(200) },
            { type: 'bounds', id: 'face', value: { x: 390, y: 30, width: 180, height: 160 } },
          ],
        },
      ],
    } as unknown as DesignPageProposalRequest;
    expect(() => checkPanelRedrawProposal(d, asked, answer)).toThrow(/would move outside panel k1/);
  });

  it('checks where changed text paints when it expands past its box (Codex on #28)', () => {
    let d = page();
    d = insertElement('text', {
      id: 'words',
      parentId: 'k1',
      bounds: { x: 50, y: 320, width: 150, height: 40 },
    }).apply(d);
    d = updateElement('words', { text: 'あ', typography: { overflow: 'expand' } }).apply(d);
    const asked = designPanelRedrawRequest(d, 'k1', '');
    const answer = (value: string) =>
      ({
        units: [
          { id: 'u', label: 'u', requires: [], operations: [{ type: 'text', id: 'words', value }] },
        ],
      }) as unknown as DesignPageProposalRequest;
    expect(() => checkPanelRedrawProposal(d, asked, answer('い'))).not.toThrow();
    expect(() =>
      checkPanelRedrawProposal(d, asked, answer(Array(10).fill('セリフ').join('\n'))),
    ).toThrow(/would move outside panel k1/);
  });

  it('keeps a redraw inside a slanted panel, not just its bounds (Codex on #28)', () => {
    let d = insertDesignPage({ x: 0, y: 0, width: 600, height: 800 }, 'p1').apply(createDesign());
    // One region cut along its diagonal: panel a is the top-left triangle.
    const n = Math.SQRT1_2;
    d = designDivisionCommand({
      type: 'startDivision',
      pageId: 'p1',
      region: { x: 0, y: 0, width: 600, height: 600 },
      root: {
        dividerId: 'cut',
        line: { nx: n, ny: n, offset: 300 * Math.SQRT2 },
        gap: 0,
        a: { panelId: 'a' },
        b: { panelId: 'b' },
      },
    }).apply(d);
    d = insertElement('rectangle', {
      id: 'art',
      parentId: 'a',
      bounds: { x: 20, y: 20, width: 50, height: 50 },
    }).apply(d);
    const asked = designPanelRedrawRequest(d, 'a', '');
    expect(asked.region).toEqual({ x: 0, y: 0, width: 600, height: 600 });
    expect(asked.polygon).toHaveLength(3);
    const move = (value: { x: number; y: number; width: number; height: number }) =>
      ({
        units: [
          { id: 'u', label: 'u', requires: [], operations: [{ type: 'bounds', id: 'art', value }] },
        ],
      }) as unknown as DesignPageProposalRequest;
    // Inside the bounds, in the corner the diagonal cuts off
    expect(() =>
      checkPanelRedrawProposal(d, asked, move({ x: 450, y: 450, width: 50, height: 50 })),
    ).toThrow(/art would move outside panel a/);
    expect(() =>
      checkPanelRedrawProposal(d, asked, move({ x: 40, y: 40, width: 50, height: 50 })),
    ).not.toThrow();
  });

  it('refuses a redraw whose layout moves the panel or what lies outside it (Codex on #28)', () => {
    let d = page();
    d = updateElement('k1', {
      layout: { direction: 'row', gap: 0, padding: 20, align: 'start', sizing: 'hug' },
    }).apply(d);
    d = insertElement('text', {
      id: 'line',
      parentId: 'k1',
      bounds: { x: 40, y: 40, width: 400, height: 40 },
    }).apply(d);
    d = updateElement('line', { text: 'あ'.repeat(10), sizing: 'hug' }).apply(d);
    const asked = designPanelRedrawRequest(d, 'k1', '');
    const answer = {
      units: [
        {
          id: 'u',
          label: 'u',
          requires: [],
          operations: [
            { type: 'text', id: 'line', value: 'あ' },
            { type: 'bounds', id: 'face', value: { x: 390, y: 30, width: 180, height: 160 } },
          ],
        },
      ],
    } as unknown as DesignPageProposalRequest;
    expect(() => checkPanelRedrawProposal(d, asked, answer)).toThrow(
      /cannot move or resize k1, which is not inside panel k1/,
    );
  });

  it('sees a balloon by all of its parts, for warnings and moves (Codex on #28)', () => {
    let d = page();
    const b = insertDesignSpeechBalloon('k1', { x: 200, y: 40, width: 150, height: 100 }, 'A');
    d = b.apply(d);
    const outline = d.elements.find((e) => e.parentId === b.elementId && e.type !== 'text')!;
    d = updateElement(outline.id, {
      bounds: { ...outline.bounds, width: 300 },
    }).apply(d);
    expect(mangaBalloonOverlaps(d).map((o) => o.balloonId)).toEqual([b.elementId]);
    const { command, moved } = moveMangaBalloonsOffKeepOut(d);
    expect(moved).toEqual([b.elementId]);
    const after = command!.apply(d);
    expect(mangaBalloonOverlaps(after)).toEqual([]);
    const widened = after.elements.find((e) => e.id === outline.id)!;
    expect(widened.bounds.x + widened.bounds.width).toBeLessThanOrEqual(380 + 1e-9);
  });

  it('moves a turned balloon by where it is drawn (Codex on #28)', () => {
    let d = page();
    const b = insertDesignSpeechBalloon('k1', { x: 400, y: 40, width: 100, height: 150 }, 'A');
    d = b.apply(d);
    d = updateElement(b.elementId, { rotation: 90 }).apply(d);
    const { command, moved } = moveMangaBalloonsOffKeepOut(d);
    expect(moved).toEqual([b.elementId]);
    const after = command!.apply(d);
    const group = after.elements.find((e) => e.id === b.elementId)!;
    expect(group.rotation).toBe(90);
    expect(group.bounds).toMatchObject({ width: 100, height: 150 });
    expect(mangaBalloonOverlaps(after)).toEqual([]);
    // Drawn 150 wide and 100 tall around the same centre: clear of the face at x = 380.
    const cx = group.bounds.x + 50;
    expect(cx + 75).toBeLessThanOrEqual(380 + 1e-9);
  });

  it('finds a gap just wide enough between two figures (Codex on #28)', () => {
    let d = page();
    d = setMangaKeepOut('face', false).apply(d);
    for (const [id, x, width] of [
      ['left', 20, 180],
      ['right', 425, 155],
    ] as const) {
      d = insertElement('rectangle', {
        id,
        parentId: 'k1',
        bounds: { x, y: 20, width, height: 360 },
      }).apply(d);
      d = setMangaKeepOut(id, true).apply(d);
    }
    const at = mangaBalloonPlacement(d, 'k1', { width: 224, height: 144 })!;
    expect(at).toBeDefined();
    expect(at.x).toBeGreaterThanOrEqual(200 - 1e-9);
    expect(at.x + at.width).toBeLessThanOrEqual(425 + 1e-9);
  });

  it('sees a marked group by all of its parts, for warnings and placement (Codex on #28)', () => {
    let d = page();
    d = setMangaKeepOut('face', false).apply(d);
    d = insertElement('group', {
      id: 'figure',
      parentId: 'k1',
      bounds: { x: 380, y: 30, width: 190, height: 160 },
    }).apply(d);
    d = insertElement('rectangle', {
      id: 'arm',
      parentId: 'figure',
      bounds: { x: 200, y: 30, width: 370, height: 160 },
    }).apply(d);
    d = setMangaKeepOut('figure', true).apply(d);
    const at = mangaBalloonPlacement(d, 'k1', { width: 150, height: 100 })!;
    expect(overlap(at, { x: 200, y: 30, width: 370, height: 160 })).toBe(false);
    const b = insertDesignSpeechBalloon('k1', { x: 230, y: 40, width: 150, height: 100 }, 'A');
    expect(mangaBalloonOverlaps(b.apply(d)).map((o) => o.keepOutId)).toEqual(['figure']);
  });
});
