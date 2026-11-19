import { describe, expect, it } from 'vitest';
import {
  drawingProject,
  drawingSheetPaper,
  drawingStarter,
  type DrawingDocument,
  type DrawingMeshBody,
  type DrawingPartsInfo,
} from '@editor-platform/drawing-core';
import { EditorSession } from '@editor-platform/editor-core';
import { box, cylinder } from '../../drawing-core/src/test-shapes';
import { DrawingController } from './controller';
import { drawingDeriveKey, drawingProjectionJob, drawingViewState } from './derive';

// DW4b (Codex on #1232): part drawings tell apart parts of equal content by their version, and
// leave room on the paper for every candidate dimension. ST-709, TS-2427.

const moved = (b: DrawingMeshBody, d: [number, number, number], bodyId: string) => ({
  ...b,
  path: [],
  bodyId,
  positions: Array.from(b.positions, (v, i) => v + d[i % 3]!),
  edges: b.edges.map((e) => ({ ...e, points: Array.from(e.points, (v, i) => v + d[i % 3]!) })),
});
// A 180 × 60 × 15 plate with six Ø4 holes, each at its own place across and up.
const plate: DrawingMeshBody[] = [
  { ...box(180, 60, 15), bodyId: 'plate' },
  ...[0, 1, 2, 3, 4, 5].map((i) =>
    moved(cylinder(2, 15), [20 + i * 25, 8 + i * 8, 0], `hole-${i}`),
  ),
];
const asm: DrawingMeshBody[] = [
  { ...box(10, 10, 10), path: ['o-1'], bodyId: 'a' },
  { ...box(10, 10, 10, [20, 0, 0]), path: ['o-2'], bodyId: 'b' },
];
// Two saved parts (two Artifacts) of the same content.
const parts: DrawingPartsInfo = {
  rows: ['a', 'b'].map((k, i) => ({
    item: String(i + 1),
    partNumber: `P-${k}`,
    name: `Part ${k}`,
    description: '',
    quantity: 1,
    key: k,
    source: { artifactId: `art-${k}`, versionId: 'v1', contentHash: 'hp' },
  })),
  occurrences: [
    { path: ['o-1'], key: 'a' },
    { path: ['o-2'], key: 'b' },
  ],
};
const settled = () => new Promise((r) => setTimeout(r, 0));
function setup() {
  const session = new EditorSession<DrawingDocument>(drawingStarter());
  const bodiesOf = (hash: string) => (hash === 'ha' ? asm : plate);
  const controller = new DrawingController({
    session,
    canEdit: () => true,
    sources: {
      choices: () => [],
      prepare: async (c) => ({
        box:
          c.contentHash === 'ha'
            ? [
                [0, 0, 0],
                [30, 10, 10],
              ]
            : [
                [0, 0, 0],
                [180, 60, 15],
              ],
      }),
    },
    derive: {
      key: (doc, v) =>
        drawingDeriveKey(doc, v, doc.sources.find((s) => s.id === v.sourceId)!.contentHash),
      async run(doc, view) {
        const hash = doc.sources.find((s) => s.id === view.sourceId)!.contentHash;
        if (hash === 'hslow') return { status: 'failed', code: 'limit-time' };
        const job = drawingProjectionJob(doc, view, hash);
        if ('code' in job) return { status: 'failed', code: job.code };
        return drawingViewState(
          view,
          job,
          drawingProject(bodiesOf(hash), job.frame, job.options),
          undefined,
          hash === 'ha' ? parts : undefined,
        );
      },
    },
  });
  return controller;
}
const choice = (artifactId: string, contentHash: string) => ({
  key: `${artifactId}/v1`,
  kind: 'cad' as const,
  artifactId,
  versionId: 'v1',
  contentHash,
  name: artifactId,
  label: artifactId,
});

describe('part drawings (DW4b)', () => {
  it('draws each of two parts of equal content, and each once', async () => {
    const c = setup();
    await c.addCadViews(choice('asm', 'ha'), 'front', '1:1');
    await settled();
    const view = c.state.content.views[0]!;
    expect(await c.addPartDrawings(view.id)).toBeUndefined();
    expect(c.state.content.sheets.map((s) => s.name)).toEqual(['Sheet 1', '1 Part a', '2 Part b']);
    expect(c.state.content.sources.map((s) => s.artifactId).sort()).toEqual(
      ['art-a', 'art-b', 'asm'].sort(),
    );
    expect(await c.addPartDrawings(view.id)).toBe('part-drawn');
  });

  it('leaves room for the whole dimension stack on the paper', async () => {
    const c = setup();
    // The plate placed as the assembly's only row is no assembly: drawn through a one-row list.
    await c.addCadViews(choice('asm', 'ha'), 'front', '1:1');
    await settled();
    const view = c.state.content.views[0]!;
    // Part a's version is the plate here.
    parts.rows[0]!.source = { artifactId: 'art-a', versionId: 'v1', contentHash: 'hplate' };
    parts.rows[1]!.source = { artifactId: 'art-b', versionId: 'v1', contentHash: 'hplate2' };
    expect(await c.addPartDrawings(view.id)).toBeUndefined();
    const doc = c.state.content;
    const sheet = doc.sheets[1]!;
    const [w, h] = drawingSheetPaper(sheet);
    const dims = doc.annotations.filter((a) => a.sheetId === sheet.id && a.kind === 'dimension');
    // Six places across and up, Ø4 once, the width, the height and the depth.
    expect(dims.length).toBeGreaterThanOrEqual(15);
    for (const a of dims) {
      const g = c.annotationGraphics(a);
      expect(g.status).toBe('ok');
      const [[x0, y0], [x1, y1]] = g.bounds!;
      expect(x0).toBeGreaterThanOrEqual(0);
      expect(y0).toBeGreaterThanOrEqual(0);
      expect(x1).toBeLessThanOrEqual(w);
      expect(y1).toBeLessThanOrEqual(h);
    }
  });

  it('fits long CAD names to the drawing, and takes no part view for an assembly', async () => {
    const c = setup();
    await c.addCadViews(choice('asm', 'ha'), 'front', '1:1');
    await settled();
    const view = c.state.content.views[0]!;
    const long = 'N'.repeat(256);
    parts.rows[0]!.name = long;
    parts.rows[0]!.partNumber = long;
    parts.rows[0]!.source = { artifactId: 'art-a', versionId: 'v1', contentHash: 'hp' };
    parts.rows[1]!.source = { artifactId: 'art-b', versionId: 'v1', contentHash: 'hp' };
    expect(await c.addPartDrawings(view.id)).toBeUndefined();
    const sheet = c.state.content.sheets[1]!;
    expect([...sheet.title.title]).toHaveLength(200);
    expect([...sheet.title.drawingNumber]).toHaveLength(200);
    // A view of one part alone (the assembly's view narrowed to one placement) makes none.
    const lone = c.state.content.views.find((v) => v.id === view.id)!;
    if (lone.kind !== 'cad-projection') throw new Error(lone.kind);
    c.updateView({ ...lone, only: ['o-1'] });
    await settled();
    expect(c.state.views.get(lone.id)?.status).toBe('ready');
    expect(await c.addPartDrawings(lone.id)).toBe('part-none');
  });

  it('leaves out a part whose views cannot be drawn, and makes it later (Codex on #1232)', async () => {
    const c = setup();
    await c.addCadViews(choice('asm', 'ha'), 'front', '1:1');
    await settled();
    const view = c.state.content.views[0]!;
    parts.rows[0]!.name = 'Part a';
    parts.rows[0]!.source = { artifactId: 'art-a', versionId: 'v1', contentHash: 'hp' };
    parts.rows[1]!.source = { artifactId: 'art-b', versionId: 'v1', contentHash: 'hslow' };
    expect(await c.addPartDrawings(view.id)).toBeUndefined();
    expect(c.state.content.sheets.map((s) => s.name)).toEqual(['Sheet 1', '1 Part a']);
    expect(c.state.notice).toEqual({ code: 'part-drawing-skipped', path: '2' });
    // Drawable now: made on the next run.
    parts.rows[1]!.source = { artifactId: 'art-b', versionId: 'v1', contentHash: 'hp2' };
    expect(await c.addPartDrawings(view.id)).toBeUndefined();
    expect(c.state.content.sheets.map((s) => s.name)).toEqual(['Sheet 1', '1 Part a', '2 Part b']);
  });
});
