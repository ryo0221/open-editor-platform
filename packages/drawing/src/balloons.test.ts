import { describe, expect, it } from 'vitest';
import {
  drawingBalloonRadius,
  drawingIsAssembly,
  drawingProject,
  drawingStarter,
  type DrawingDocument,
  type DrawingMeshBody,
  type DrawingPartsInfo,
} from '@editor-platform/drawing-core';
import { EditorSession } from '@editor-platform/editor-core';
import { box } from '../../drawing-core/src/test-shapes';
import { DrawingController } from './controller';
import { drawingDeriveKey, drawingProjectionJob, drawingViewState } from './derive';

// DW4a (Codex on #1228): automatic balloons stay outside a wide, shallow view when they crowd
// one side, and a detail balloons only the parts inside its circle; one part placed many times
// is an assembly. ST-708, TS-2423.

const placed = (b: DrawingMeshBody, path: string[], bodyId: string): DrawingMeshBody => ({
  ...b,
  path,
  bodyId,
});
// A 200 × 20 plate with three 4 mm blocks side by side on top, in the middle.
const bodies = [
  { ...box(200, 20, 10), bodyId: 'plate' },
  placed(box(4, 4, 4, [92, 8, 10]), ['o-1'], 'b1'),
  placed(box(4, 4, 4, [98, 8, 10]), ['o-2'], 'b2'),
  placed(box(4, 4, 4, [104, 8, 10]), ['o-3'], 'b3'),
];
const parts: DrawingPartsInfo = {
  rows: ['plate', 'b1', 'b2', 'b3'].map((key, i) => ({
    item: String(i + 1),
    partNumber: '',
    name: key,
    description: '',
    quantity: 1,
    key,
  })),
  occurrences: [
    { path: [], bodyId: 'plate', key: 'plate' },
    { path: ['o-1'], key: 'b1' },
    { path: ['o-2'], key: 'b2' },
    { path: ['o-3'], key: 'b3' },
  ],
};
const settled = () => new Promise((r) => setTimeout(r, 0));
function setup() {
  const session = new EditorSession<DrawingDocument>(drawingStarter());
  const controller = new DrawingController({
    session,
    canEdit: () => true,
    sources: {
      choices: () => [],
      prepare: async () => ({
        box: [
          [0, 0, 0],
          [200, 20, 14],
        ],
      }),
    },
    derive: {
      key: (doc, v) => drawingDeriveKey(doc, v, 'h'),
      async run(doc, view) {
        const job = drawingProjectionJob(doc, view, 'h');
        if ('code' in job) return { status: 'failed', code: job.code };
        return drawingViewState(
          view,
          job,
          drawingProject(bodies, job.frame, job.options),
          undefined,
          parts,
        );
      },
    },
  });
  return controller;
}
const choice = {
  key: 'a/v1',
  kind: 'cad' as const,
  artifactId: 'a',
  versionId: 'v1',
  contentHash: 'h',
  name: 'Asm',
  label: 'Asm · v1',
};

describe('automatic balloons (DW4a)', () => {
  it('keeps every circle outside a wide, shallow view', async () => {
    const c = setup();
    await c.addCadViews(choice, 'front', '1:1');
    await settled();
    const view = c.state.content.views[0]!;
    expect(c.addBalloons(view.id)).toBeUndefined();
    const st = c.state.views.get(view.id);
    if (st?.status !== 'ready') throw new Error('not ready');
    const [[x0, y0], [x1, y1]] = st.graphics.bounds;
    const r = drawingBalloonRadius(5);
    const balloons = c.state.content.annotations.filter((a) => a.kind === 'balloon');
    expect(balloons).toHaveLength(4);
    for (const b of balloons) {
      const [x, y] = [view.at[0] + b.at[0], view.at[1] + b.at[1]];
      const dx = Math.max(x0 - x, 0, x - x1);
      const dy = Math.max(y0 - y, 0, y - y1);
      expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(r);
    }
    // And clear of each other.
    for (const a of balloons)
      for (const b of balloons)
        if (a !== b)
          expect(Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1])).toBeGreaterThan(2 * r);
  });

  it('balloons only the parts inside a detail’s circle', async () => {
    const c = setup();
    await c.addCadViews(choice, 'front', '1:1');
    await settled();
    const front = c.state.content.views[0]!;
    // A detail round the plate's left end, far from the blocks.
    expect(c.addDetail(front.id, [-80, 0], 10, '2:1')).toBeUndefined();
    await settled();
    const detail = c.state.content.views[1]!;
    expect(c.addBalloons(detail.id)).toBeUndefined();
    const rows = c.state.content.annotations.flatMap((a) =>
      a.kind === 'balloon' ? [c.partRowOf(a.viewId, a.ref)?.key] : [],
    );
    expect(rows).toEqual(['plate']);
    // Its line ends inside the circle, on the part of the long edge the detail keeps.
    const b = c.state.content.annotations.find((a) => a.kind === 'balloon')!;
    const g = c.annotationGraphics(b);
    const line = g.items.find((i) => i.type === 'line');
    if (detail.kind !== 'cad-detail' || line?.type !== 'line') throw new Error('no line');
    const st = c.state.views.get(detail.id);
    if (st?.status !== 'ready') throw new Error('not ready');
    expect(Math.hypot(line.b[0] - detail.at[0], line.b[1] - detail.at[1])).toBeLessThanOrEqual(
      st.graphics.frame!.clipRadius!,
    );
  });

  it('puts many balloons of a small view on rings further out, none on another', async () => {
    const many: DrawingMeshBody[] = Array.from({ length: 12 }, (_, i) =>
      placed(box(10, 10, 10, [0, i * 12, 0]), [`s-${i}`], `s${i}`),
    );
    const info: DrawingPartsInfo = {
      rows: many.map((b, i) => ({
        item: String(i + 1),
        partNumber: '',
        name: b.bodyId,
        description: '',
        quantity: 1,
        key: b.bodyId,
      })),
      occurrences: many.map((b) => ({ path: b.path, key: b.bodyId })),
    };
    const session = new EditorSession<DrawingDocument>(drawingStarter());
    const c = new DrawingController({
      session,
      canEdit: () => true,
      sources: {
        choices: () => [],
        prepare: async () => ({
          box: [
            [0, 0, 0],
            [10, 142, 10],
          ],
        }),
      },
      derive: {
        key: (doc, v) => drawingDeriveKey(doc, v, 'h'),
        async run(doc, view) {
          const job = drawingProjectionJob(doc, view, 'h');
          if ('code' in job) return { status: 'failed', code: job.code };
          // Seen from the front, the stack lies in depth: every part on one small square.
          return drawingViewState(
            view,
            job,
            drawingProject(many, job.frame, job.options),
            undefined,
            info,
          );
        },
      },
    });
    await c.addCadViews(choice, 'front', '1:1');
    await settled();
    expect(c.addBalloons(c.state.content.views[0]!.id)).toBeUndefined();
    const at = c.state.content.annotations.flatMap((a) => (a.kind === 'balloon' ? [a.at] : []));
    expect(at).toHaveLength(12);
    const r = drawingBalloonRadius(5);
    for (const p of at)
      for (const q of at)
        if (p !== q) expect(Math.hypot(p[0] - q[0], p[1] - q[1])).toBeGreaterThan(2 * r);
  });

  it('takes one part placed many times for an assembly, not a lone part', () => {
    const one = { ...parts.rows[1]!, quantity: 3 };
    expect(
      drawingIsAssembly({
        rows: [one],
        occurrences: ['o-1', 'o-2', 'o-3'].map((p) => ({ path: [p], key: one.key })),
      }),
    ).toBe(true);
    expect(
      drawingIsAssembly({
        rows: [parts.rows[0]!],
        occurrences: [{ path: [], bodyId: 'plate', key: 'plate' }],
      }),
    ).toBe(false);
    expect(drawingIsAssembly(undefined)).toBe(false);
  });

  it('finds a long edge crossing a small detail between any samples (Codex on #1228)', async () => {
    const long: DrawingMeshBody[] = [{ ...box(1000, 10, 10), path: [], bodyId: 'bar' }];
    const one: DrawingPartsInfo = {
      rows: [
        { item: '1', partNumber: '', name: 'bar', description: '', quantity: 1, key: 'bar' },
        { item: '2', partNumber: '', name: 'none', description: '', quantity: 1, key: 'none' },
      ],
      occurrences: [{ path: [], bodyId: 'bar', key: 'bar' }],
    };
    const session = new EditorSession<DrawingDocument>(drawingStarter());
    const c = new DrawingController({
      session,
      canEdit: () => true,
      sources: {
        choices: () => [],
        prepare: async () => ({
          box: [
            [0, 0, 0],
            [1000, 10, 10],
          ],
        }),
      },
      derive: {
        key: (doc, v) => drawingDeriveKey(doc, v, 'h'),
        async run(doc, view) {
          const job = drawingProjectionJob(doc, view, 'h');
          if ('code' in job) return { status: 'failed', code: job.code };
          return drawingViewState(
            view,
            job,
            drawingProject(long, job.frame, job.options),
            undefined,
            one,
          );
        },
      },
    });
    await c.addCadViews(choice, 'front', '1:1');
    await settled();
    const front = c.state.content.views[0]!;
    // Round x = 110 on the bar (its centre is at 500).
    expect(c.addDetail(front.id, [-390, 0], 10, '2:1')).toBeUndefined();
    await settled();
    const detail = c.state.content.views[1]!;
    expect(c.addBalloons(detail.id)).toBeUndefined();
    const b = c.state.content.annotations.find((a) => a.kind === 'balloon')!;
    if (b.kind !== 'balloon') throw new Error(b.kind);
    expect(Math.abs(b.ref.model[0] - 110)).toBeLessThan(10);
  });
});
