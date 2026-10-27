import { bimStarter, type BimDocument, type BimOperation } from '@editor-platform/bim-core';
import { EditorSession } from '@editor-platform/editor-core';
import { describe, expect, it } from 'vitest';
import { BimController, bimDrawingKey } from './controller';
import { draftPart } from './drafting';
import type { BimEvaluation, BimKernel } from './evaluate';
import { bimViewBounds, bimViewSolids } from './view';
import type { BimPartReference, BimPartShape, BimPartSource } from './parts';

/** Part types read their shapes from the Host's CAD versions (R2c-3c-3b). */
const H = 'a'.repeat(64);
const source: BimPartReference = { artifactId: 'a-cad', versionId: 'v1', contentHash: H };
const shape: BimPartShape = {
  brep: new Uint8Array([1, 2, 3]),
  bounds: [
    [0, 0, 0],
    [100, 50, 10],
  ],
  kinds: ['solid'],
  looks: [{ color: '#f2efe6', opacity: 1 }],
  faces: [6],
};
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A kernel that records the assets of each run and never answers. */
function recording() {
  const runs: Map<string, Uint8Array>[] = [];
  const kernel: BimKernel = {
    run: (_g, _r, assets) => {
      runs.push(assets);
      return new Promise(() => {});
    },
  };
  return { kernel, runs };
}
function partSource(read: () => Promise<BimPartShape> = async () => shape) {
  const calls = { shape: 0, retain: [] as BimPartReference[] };
  const parts: BimPartSource = {
    list: async () => [
      {
        artifactId: 'a-cad',
        name: 'Plate',
        versions: [{ versionId: 'v1', label: 'v1', contentHash: H }],
      },
    ],
    shape: () => (calls.shape++, read()),
    retain: async (s) => void calls.retain.push(s),
  };
  return { parts, calls };
}

describe('bim part types (R2c-3c-3b)', () => {
  it('reads the shape, keeps the version, then adds the type with its bounds as one edit', async () => {
    const { kernel, runs } = recording();
    const { parts, calls } = partSource();
    const session = new EditorSession<BimDocument>(bimStarter());
    const saved: BimDocument[] = [];
    const c = new BimController({
      session,
      kernel,
      parts,
      canEdit: () => true,
      onApplied: (d) => saved.push(d),
    });
    expect(c.partsOffered).toBe(true);
    expect(await c.listParts()).toHaveLength(1);
    expect(await c.addPartType(source, 'Plate')).toBeUndefined();
    expect(calls.retain).toEqual([source]);
    expect(saved).toHaveLength(1);
    const type = c.state.content.types.find((t) => t.kind === 'part')!;
    expect(type).toMatchObject({
      kind: 'part',
      name: 'Plate',
      source,
      hintBounds: { min: [0, 0, 0], max: [100, 50, 10] },
    });
    expect(c.state.parts.get(H)).toEqual({
      status: 'available',
      kinds: ['solid'],
      bounds: shape.bounds,
      looks: shape.looks,
      faces: shape.faces,
    });
    // A placed part evaluates with the shape's bytes under the version's hash.
    expect(
      c.apply(draftPart(c.state.content, 'l-1f', { point: { xy: [0, 0] } } as never, type.id)),
    ).toBeUndefined();
    expect(runs.at(-1)!.get(H)).toBe(shape.brep);
    // The shape was read once.
    expect(calls.shape).toBe(1);
  });

  it('adds nothing when the shape cannot be read, and refuses without authority', async () => {
    const { kernel } = recording();
    const { parts, calls } = partSource(async () => {
      throw new Error('part-build-mismatch');
    });
    let editable = true;
    const c = new BimController({
      session: new EditorSession<BimDocument>(bimStarter()),
      kernel,
      parts,
      canEdit: () => editable,
    });
    expect(await c.addPartType(source, 'Plate')).toBe('part-build-mismatch');
    expect(c.state.notice).toMatchObject({ code: 'part-build-mismatch' });
    expect(calls.retain).toEqual([]);
    expect(c.state.content.types.some((t) => t.kind === 'part')).toBe(false);
    editable = false;
    expect(await c.addPartType(source, 'Plate')).toBe('permission-denied');
    expect(calls.shape).toBe(1);
  });

  it('changes the drawing key when a part shape arrives after a drawing was made', async () => {
    const doc = bimStarter();
    doc.types.push({
      id: 'pt-1',
      kind: 'part',
      name: 'Plate',
      source,
      hintBounds: { min: [0, 0, 0], max: [100, 50, 10] },
    });
    let arrive!: (s: BimPartShape) => void;
    const { parts } = partSource(() => new Promise((r) => (arrive = r)));
    const c = new BimController({
      session: new EditorSession(doc),
      kernel: recording().kernel,
      parts,
      canEdit: () => true,
    });
    const before = bimDrawingKey(c.state);
    arrive(shape);
    await flush();
    // Same content, a new shape to draw with: the open drawing is made again.
    expect(c.state.hash).toBe(before.split('\u0000')[0]);
    expect(bimDrawingKey(c.state)).not.toBe(before);
    expect(bimDrawingKey(c.state)).toBe(`${c.state.hash}\u0000${H}`);
  });

  it('reads the shapes of the types a building already has, and names one it cannot read', async () => {
    const doc = bimStarter();
    doc.types.push({
      id: 'pt-1',
      kind: 'part',
      name: 'Plate',
      source,
      hintBounds: { min: [0, 0, 0], max: [100, 50, 10] },
    });
    doc.elements.push(
      (
        draftPart(doc, 'l-1f', { point: { xy: [0, 0] } } as never, 'pt-1') as Extract<
          BimOperation,
          { type: 'insert' }
        >
      ).entities.elements![0]!,
    );
    const { kernel, runs } = recording();
    let fail = true;
    const { parts } = partSource(async () => {
      if (fail) throw new Error('part-source-missing');
      return shape;
    });
    const c = new BimController({
      session: new EditorSession(doc),
      kernel,
      parts,
      canEdit: () => true,
    });
    expect(c.state.parts.get(H)).toEqual({ status: 'loading' });
    await flush();
    expect(c.state.parts.get(H)).toEqual({
      status: 'unavailable',
      code: 'part-source-missing',
    });
    // Another building reads it again; a read shape evaluates again with its bytes.
    fail = false;
    const again = new BimController({
      session: new EditorSession(doc),
      kernel,
      parts,
      canEdit: () => true,
    });
    await flush();
    expect(again.state.parts.get(H)).toEqual({
      status: 'available',
      kinds: ['solid'],
      bounds: shape.bounds,
      looks: shape.looks,
      faces: shape.faces,
    });
    expect(runs.at(-1)!.get(H)).toBe(shape.brep);
    // Without a Host source, the type is named unavailable at once.
    const none = new BimController({
      session: new EditorSession(doc),
      kernel,
      canEdit: () => true,
    });
    expect(none.partsOffered).toBe(false);
    expect(none.state.parts.get(H)).toEqual({
      status: 'unavailable',
      code: 'part-source-unavailable',
    });
    expect(await none.addPartType(source, 'Plate')).toBe('part-source-unavailable');
  });

  it('draws a sheet part from both sides, and frames a part shown as its bounds', () => {
    const doc = bimStarter();
    doc.types.push({
      id: 'pt-1',
      kind: 'part',
      name: 'Panel',
      source,
      hintBounds: { min: [0, 0, 0], max: [100, 50, 10] },
    });
    const insert = (id: string, x: number) =>
      (
        draftPart(doc, 'l-1f', { point: { xy: [x, 0] } } as never, 'pt-1') as Extract<
          BimOperation,
          { type: 'insert' }
        >
      ).entities.elements![0]!;
    doc.elements.push({ ...insert('p-1', 0), id: 'p-1' }, { ...insert('p-2', 0), id: 'p-2' });
    const placement = (x: number) => ({
      rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      translation: [x, 0, 0],
    });
    const mesh = {
      positions: new Float32Array(9),
      normals: new Float32Array(9),
      indices: new Uint32Array([0, 1, 2]),
    };
    const evaluation = {
      status: 'ok',
      elements: new Map([
        [
          'p-1',
          {
            status: 'ok',
            solid: 's',
            placement: placement(0),
            mesh,
            measure: {
              bounds: [
                [0, 0, 0],
                [100, 50, 10],
              ],
            },
          },
        ],
        ['p-2', { status: 'error', code: 'asset-missing', placement: placement(5000) }],
      ]),
      kernelQuantities: new Map(),
      sent: { solids: 1, nodes: 1 },
    } as unknown as Extract<BimEvaluation, { status: 'ok' }>;
    const sheet = (kinds: ('solid' | 'sheet')[]) =>
      bimViewSolids(doc, evaluation, {
        selection: new Set(),
        parts: new Map([[H, { status: 'available', kinds }]]),
      }).find((v) => v.meshes)!.meshes![0]!.sheet;
    expect(sheet(['sheet'])).toBe(true);
    expect(sheet(['solid', 'sheet'])).toBe(true);
    expect(sheet(['solid'])).toBe(false);
    // The box of the part whose shape is not read is in the framing.
    expect(bimViewBounds(evaluation, doc)![1][0]).toBe(5100);
    expect(bimViewBounds(evaluation)![1][0]).toBe(100);
  });

  it('colours a part body by body from its CAD looks, and keeps the part colour without them (OH-U1)', () => {
    const doc = bimStarter();
    doc.types.push({
      id: 'pt-1',
      kind: 'part',
      name: 'Shell',
      source,
      hintBounds: { min: [0, 0, 0], max: [100, 50, 10] },
    });
    const el = (
      draftPart(doc, 'l-1f', { point: { xy: [0, 0] } } as never, 'pt-1') as Extract<
        BimOperation,
        { type: 'insert' }
      >
    ).entities.elements![0]!;
    doc.elements.push({ ...el, id: 'p-1' });
    // Three triangles on faces 0, 1 and 2: face 0 is the first body's, faces 1–2 the second's.
    const mesh = {
      positions: new Float32Array(27),
      normals: new Float32Array(27),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]),
      faceIndices: new Uint32Array([0, 1, 2]),
    };
    const evaluation = {
      status: 'ok',
      elements: new Map([
        [
          'p-1',
          {
            status: 'ok',
            solid: 's',
            placement: { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0] },
            mesh,
            measure: {
              bounds: [
                [0, 0, 0],
                [100, 50, 10],
              ],
            },
          },
        ],
      ]),
      kernelQuantities: new Map(),
      sent: { solids: 1, nodes: 1 },
    } as unknown as Extract<BimEvaluation, { status: 'ok' }>;
    const meshes = (status: Record<string, unknown>) =>
      bimViewSolids(doc, evaluation, {
        selection: new Set(),
        parts: new Map([[H, { status: 'available', kinds: ['solid', 'sheet'], ...status }]]),
      })[0]!.meshes!.map((m) => ({
        color: m.color,
        opacity: m.opacity,
        sheet: m.sheet,
        indices: [...m.mesh.indices],
      }));
    const tile = { color: '#f2efe6', opacity: 1 };
    const glass = { color: '#38bdf8', opacity: 0.4 };
    expect(meshes({ looks: [tile, glass], faces: [1, 2] })).toEqual([
      { ...tile, sheet: false, indices: [0, 1, 2] },
      { ...glass, sheet: true, indices: [3, 4, 5, 6, 7, 8] },
    ]);
    // Bodies that look alike are one mesh; the whole mesh when they are all alike.
    const same = meshes({ looks: [tile, tile], faces: [1, 2] });
    expect(same.map((m) => m.color)).toEqual([tile.color, tile.color]);
    const solids = bimViewSolids(doc, evaluation, {
      selection: new Set(),
      parts: new Map([
        [H, { status: 'available', kinds: ['solid', 'solid'], looks: [tile, tile], faces: [1, 2] }],
      ]),
    })[0]!.meshes!;
    expect(solids).toHaveLength(1);
    expect(solids[0]!.mesh.indices).toHaveLength(9);
    // Without looks, or when the faces do not add up, the part colour as before.
    expect(meshes({})).toEqual([
      { color: '#a78bfa', opacity: 1, sheet: true, indices: [0, 1, 2, 3, 4, 5, 6, 7, 8] },
    ]);
    expect(meshes({ looks: [tile, glass], faces: [1, 1] })[0]!.color).toBe('#a78bfa');
  });

  it("draws a sheet part's cut as a line through the controller", async () => {
    const tube = new Float64Array([
      0, 0, 1200, 100, 0, 1200, 100, 50, 1200, 0, 50, 1200, 0, 0, 1200,
    ]);
    const kernel: BimKernel = {
      run: async (_g, requests) =>
        ({
          status: 'ok',
          results: requests.map((r) =>
            r.section
              ? {
                  node: r.node,
                  status: 'ok' as const,
                  section: r.node.startsWith('p-') ? [tube] : [],
                }
              : r.measure && !r.mesh && r.node.includes('draw')
                ? { node: r.node, status: 'error' as const, code: 'empty-result' }
                : {
                    node: r.node,
                    status: 'ok' as const,
                    measure: {
                      volumeMm3: 0,
                      areaMm2: 0,
                      bounds: [
                        [0, 0, 0],
                        [0, 0, 0],
                      ],
                    },
                  },
          ),
        }) as never,
    };
    // A tube 3 m tall: the plan's cut at 1,200 mm crosses it.
    const { parts } = partSource(async () => ({
      ...shape,
      bounds: [
        [0, 0, 0],
        [100, 50, 3000],
      ],
      kinds: ['sheet'],
    }));
    const c = new BimController({
      session: new EditorSession<BimDocument>(bimStarter()),
      kernel,
      parts,
      canEdit: () => true,
    });
    expect(await c.addPartType(source, 'Tube')).toBeUndefined();
    const type = c.state.content.types.find((t) => t.kind === 'part')!;
    c.apply(draftPart(c.state.content, 'l-1f', { point: { xy: [0, 0] } } as never, type.id));
    await flush();
    const view = {
      id: 'v',
      kind: 'plan',
      name: 'p',
      level: 'l-1f',
      cutHeightMm: 1200,
      depthMm: 1200,
      scale: 100,
    } as const;
    const r = await c.draw(view);
    if (r.status !== 'ok') throw new Error(r.code);
    const cut = r.drawing.items.find((i) => i.type === 'polygon');
    expect(cut).toMatchObject({ loops: [] });
    expect(cut?.type === 'polygon' && cut.open).toHaveLength(1);
  });
});
