import { describe, expect, it } from 'vitest';
import {
  drawingProject,
  drawingStarter,
  type DrawingDocument,
  type DrawingMeshBody,
} from '@editor-platform/drawing-core';
import { EditorSession } from '@editor-platform/editor-core';
import { DrawingController, type DrawingSourceChoice } from './controller';
import { drawingDeriveKey, drawingProjectionJob, drawingViewState } from './derive';
import { DrawingProjector } from './projector';

// DW2b: sections and details from the Surface's state, a newer version, the time limit. TS-2407.

/** A 60 × 40 × 20 mm box of 12 triangles and its 12 edges. */
function block(): DrawingMeshBody {
  const positions: number[] = [];
  const indices: number[] = [];
  const faces: number[] = [];
  const quads = [
    [
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
      [1, 0, 0],
    ],
    [
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ],
    [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
    ],
    [
      [0, 1, 0],
      [0, 1, 1],
      [1, 1, 1],
      [1, 1, 0],
    ],
    [
      [0, 0, 0],
      [0, 0, 1],
      [0, 1, 1],
      [0, 1, 0],
    ],
    [
      [1, 0, 0],
      [1, 1, 0],
      [1, 1, 1],
      [1, 0, 1],
    ],
  ];
  quads.forEach((q, f) => {
    const base = positions.length / 3;
    for (const p of q) positions.push(p[0]! * 60, p[1]! * 40, p[2]! * 20);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    faces.push(f, f);
  });
  const edges: DrawingMeshBody['edges'] = [];
  for (const [a, b] of [
    [
      [0, 0, 0],
      [60, 0, 0],
    ],
    [
      [0, 0, 20],
      [60, 0, 20],
    ],
    [
      [0, 0, 0],
      [0, 0, 20],
    ],
    [
      [60, 0, 0],
      [60, 0, 20],
    ],
  ])
    edges.push({ index: edges.length, points: [...a!, ...b!] });
  return { path: [], bodyId: 'block', positions, indices, faces, edges };
}

const choice = (v: number): DrawingSourceChoice => ({
  key: `part/v${v}`,
  kind: 'cad',
  artifactId: 'part',
  versionId: `v${v}`,
  contentHash: `h${v}`,
  name: 'Block',
  label: `Block · v${v}`,
});

function setup(versions = [choice(1)]) {
  const session = new EditorSession<DrawingDocument>(drawingStarter());
  const body = block();
  const controller = new DrawingController({
    session,
    canEdit: () => true,
    sources: {
      choices: () => versions,
      prepare: async () => ({
        box: [
          [0, 0, 0],
          [60, 40, 20],
        ],
      }),
    },
    derive: {
      key: (doc, v) =>
        drawingDeriveKey(doc, v, doc.sources.find((s) => s.id === v.sourceId)!.contentHash),
      async run(doc, view) {
        const job = drawingProjectionJob(doc, view, 'h');
        if ('code' in job) return { status: 'failed', code: job.code };
        return drawingViewState(view, job, drawingProject([body], job.frame, job.options));
      },
    },
  });
  return { session, controller };
}
const settled = () => new Promise((r) => setTimeout(r, 0));

describe('sections and details in the Surface (DW2b)', () => {
  it('adds a section in projection with its parent, and a detail of it', async () => {
    const { controller } = setup();
    expect(await controller.addCadViews(choice(1), 'front', '1:1')).toBeUndefined();
    const front = controller.state.content.views[0]!;
    expect(controller.addSection(front.id, 'right')).toBe('view-pending');
    await settled();
    expect(controller.addSection(front.id, 'right', 5)).toBeUndefined();
    const section = controller.state.content.views[1]!;
    if (section.kind !== 'cad-section') throw new Error(section.kind);
    expect(section.mark).toBe('A');
    expect(section.line[0][0]).toBe(35);
    // Seen to the right: third angle puts it on the left, at the parent's height.
    expect(section.at[0]).toBeLessThan(front.at[0]);
    expect(section.at[1]).toBe(front.at[1]);
    await settled();
    const state = controller.state.views.get(section.id);
    expect(state?.status).toBe('ready');
    expect(controller.sheetSvg()).toContain('class="hatch"');
    expect(controller.addDetail(section.id, [0, 0], 5)).toBeUndefined();
    const detail = controller.state.content.views[2]!;
    expect(detail).toMatchObject({ kind: 'cad-detail', mark: 'B', scale: '5:1', radius: 5 });
    await settled();
    expect(controller.state.views.get(detail.id)?.status).toBe('ready');
    // DW9 (TS-2459): measured from the model's origin instead (a shaft's axis), not the centre.
    expect(controller.addSection(front.id, 'right', 5, 'origin')).toBeUndefined();
    const fromOrigin = controller.state.content.views.at(-1)!;
    if (fromOrigin.kind !== 'cad-section') throw new Error(fromOrigin.kind);
    expect(fromOrigin.line[0][0]).toBe(5);
    expect(fromOrigin.mark).toBe('C');
    // A detail round a point given from the model's origin, at the scale asked for.
    expect(controller.addDetail(section.id, [3, -2], 4, '2:1', 'origin')).toBeUndefined();
    expect(controller.state.content.views.at(-1)).toMatchObject({
      kind: 'cad-detail',
      center: [3, -2],
      radius: 4,
      scale: '2:1',
    });
    // Deleting the front view takes the section and the detail with it.
    controller.select([front.id]);
    controller.deleteSelection();
    expect(controller.state.content.views).toEqual([]);
  });

  it('offers a newer version and switches every view to it as one edit', async () => {
    const versions = [choice(1)];
    const { controller, session } = setup(versions);
    await controller.addCadViews(choice(1), 'three', 'fit');
    const sourceId = controller.state.content.sources[0]!.id;
    expect(controller.newerVersion(sourceId)).toBeUndefined();
    versions.unshift(choice(2));
    expect(controller.newerVersion(sourceId)?.versionId).toBe('v2');
    expect(await controller.switchSource(sourceId, choice(2))).toBeUndefined();
    expect(controller.state.content.sources).toMatchObject([
      { versionId: 'v2', contentHash: 'h2' },
    ]);
    expect(controller.newerVersion(sourceId)).toBeUndefined();
    session.undo();
    controller.sync();
    expect(controller.state.content.sources).toMatchObject([{ versionId: 'v1' }]);
  });
});

// DW3a (TS-2410): dimensions and leaders from the Surface's state.
describe('dimensions and leaders in the Surface (DW3a)', () => {
  it('snaps to a corner, adds a measured dimension and a leader, one edit each', async () => {
    const { controller, session } = setup();
    await controller.addCadViews(choice(1), 'front', '1:1');
    const front = controller.state.content.views[0]!;
    await settled();
    // The front view's lower corners: model (0,0,0) and (60,0,0), 60 mm apart at 1:1.
    const a = controller.snap([front.at[0] - 30, front.at[1] - 10], 'point', 2);
    const b = controller.snap([front.at[0] + 30, front.at[1] - 10], 'point', 2);
    expect(a?.ref.model).toEqual([0, 0, 0]);
    expect(b?.ref.model).toEqual([60, 0, 0]);
    expect(controller.snap([front.at[0], front.at[1]], 'point', 2)).toBeUndefined();
    expect(
      controller.addDimension(front.id, 'horizontal', [a!.ref, b!.ref], [front.at[0], 20]),
    ).toBeUndefined();
    const dim = controller.state.content.annotations[0]!;
    expect(controller.state.selection).toEqual([dim.id]);
    expect(controller.annotationGraphics(dim)).toMatchObject({ status: 'ok', value: 60 });
    expect(controller.sheetSvg()).toContain('>60<');
    // A diameter needs one edge: two refs are refused, and the document stays.
    expect(controller.addDimension(front.id, 'diameter', [a!.ref, b!.ref], [front.at[0], 20])).toBe(
      'dimension-refs',
    );
    expect(controller.addLeader({ viewId: front.id, ref: a!.ref }, [20, 20])).toBeUndefined();
    expect(controller.addLeader([200, 200], [210, 210], 'NOTE')).toBeUndefined();
    expect(controller.state.content.annotations.map((x) => x.kind)).toEqual([
      'dimension',
      'leader',
      'leader',
    ]);
    // Deleting the view takes its dimension and its leader, not the free leader.
    controller.select([front.id]);
    controller.deleteSelection();
    expect(controller.state.content.annotations.map((x) => x.kind)).toEqual(['leader']);
    session.undo();
    controller.sync();
    expect(controller.state.content.annotations).toHaveLength(3);
  });
});

describe('projection time limit (DW-U9)', () => {
  it('refuses a projection that runs too long and starts a fresh Worker for the next', async () => {
    let terminated = 0;
    let spawned = 0;
    const projector = new DrawingProjector(() => {
      spawned++;
      return {
        onmessage: null,
        onerror: null,
        postMessage() {},
        terminate: () => void terminated++,
      };
    }, 10);
    const r = await projector.project([], 'front', { step: 1, hidden: true, centers: true });
    expect(r).toEqual({ code: 'limit-time' });
    expect(terminated).toBe(1);
    void projector.project([], 'front', { step: 1, hidden: true, centers: true });
    await settled();
    expect(spawned).toBe(2);
    projector.dispose();
  });

  it('ends the running request and the queued ones on dispose (Codex on #1207)', async () => {
    let spawned = 0;
    const projector = new DrawingProjector(() => {
      spawned++;
      return { onmessage: null, onerror: null, postMessage() {}, terminate() {} };
    }, 20);
    const opts = { step: 1, hidden: true, centers: true };
    const all = [1, 2, 3].map(() => projector.project([], 'front', opts));
    await settled();
    projector.dispose();
    expect(await Promise.all(all)).toEqual([
      { code: 'aborted' },
      { code: 'aborted' },
      { code: 'aborted' },
    ]);
    await new Promise((r) => setTimeout(r, 40));
    expect(spawned).toBe(1);
  });
});
