import { describe, expect, it } from 'vitest';
import {
  boxMesh,
  edgeKey,
  editInput,
  faceVertices,
  loopCut,
  meshEdges,
  triangulateFace,
  MeshEditError,
  type EpmMesh,
} from '@editor-platform/geometry-mesh';
import {
  emptySelection,
  liveSelection,
  operationReason,
  overlayGeometry,
  pickElement,
  pickKnifePoint,
  runKnife,
  runMeshOperation,
  selectAll,
  selectLoop,
  selectedVertices,
  shapeMove,
  toggle,
  uvLayout,
  type Projected,
} from './mesh-edit';

/** A straight-down orthographic view: x → right, y → up the screen, depth = −z (top nearest). */
const topView = (positions: Float32Array): Projected[] => {
  const out: Projected[] = [];
  for (let i = 0; i < positions.length; i += 3)
    out.push([positions[i]! + 500, 500 - positions[i + 1]!, -positions[i + 2]! / 1000]);
  return out;
};

describe('mesh edit mode (TS-1223)', () => {
  const cube = boxMesh([200, 200, 200]);
  const input = editInput(cube);
  const screen = topView(cube.positions);
  it('picks the nearest vertex, the nearest edge and the nearest face under the point', () => {
    // Corner (100, 100, ±100): the top one (z = +100) is nearer.
    expect(pickElement(input, 'vertex', screen, 600, 400)).toBe(7);
    expect(pickElement(input, 'vertex', screen, 650, 400)).toBeUndefined();
    // The top edge along x at y = +100: vertices 6 and 7.
    expect(pickElement(input, 'edge', screen, 500, 402)).toBe(edgeKey(6, 7));
    // The middle of the view: the top face (1) is nearer than the bottom (0).
    expect(pickElement(input, 'face', screen, 500, 500)).toBe(1);
    expect(pickElement(input, 'face', screen, 900, 900)).toBeUndefined();
    // A point behind the camera is never picked.
    const behind = screen.map((p) => [p[0], p[1], 2] as Projected);
    expect(pickElement(input, 'vertex', behind, 600, 400)).toBeUndefined();
  });
  it('picks the face nearest at the clicked point, not by its mean depth', () => {
    // The top face is slanted toward the eye along the diagonal the view draws it with: its
    // depth there is 0.1, its mean 0.5. The bottom face is flat at 0.3. At the diagonal the top
    // one is in front.
    const tilted = screen.map((p) => [p[0], p[1], 0.3] as Projected);
    const top = [...Array(6).keys()].find((f) =>
      faceVertices(cube, input.topology, f).every((v) => cube.positions[3 * v + 2]! > 0),
    )!;
    const corners = faceVertices(cube, input.topology, top);
    const tris = triangulateFace(cube, input.topology.faceStart[top]!, 4);
    const diagonal = [0, 1, 2, 3].filter((k) => tris.filter((t) => t === k).length === 2);
    corners.forEach((v, k) => {
      tilted[v] = [tilted[v]![0], tilted[v]![1], diagonal.includes(k) ? 0.1 : 0.9];
    });
    const [ax, ay] = tilted[corners[diagonal[0]!]!]!,
      [cx, cy] = tilted[corners[diagonal[1]!]!]!;
    // Just off the drawn diagonal, inside the top face.
    expect(pickElement(input, 'face', tilted, (ax + cx) / 2 + 0.3, (ay + cy) / 2 + 0.1)).toBe(top);
  });
  it('picks the edge nearest at the clicked point when two overlap on screen', () => {
    // Edges 6–7 and 4–5 drawn over one another: one runs from near to far, one stays mid-way.
    const over = screen.map((p) => [p[0], p[1], 0] as Projected);
    over[6] = [400, 400, -0.9];
    over[7] = [600, 400, 0.9];
    over[4] = [400, 400, -0.2];
    over[5] = [600, 400, -0.2];
    // Near the first end the slanted edge is in front (−0.72 against −0.2) …
    expect(pickElement(input, 'edge', over, 420, 400)).toBe(edgeKey(6, 7));
    // … near the other end the flat one is.
    expect(pickElement(input, 'edge', over, 580, 400)).toBe(edgeKey(4, 5));
  });
  it('keeps a moved selection only while the move keeps every index', () => {
    const sel = { mode: 'vertex' as const, items: [5] };
    expect(
      runMeshOperation(input, sel, { kind: 'move', delta: [0, 0, 10] }, false).selection,
    ).toEqual(sel);
    // An unused vertex first: the move drops it, every index shifts, the selection is cleared.
    const padded: EpmMesh = {
      ...cube,
      positions: new Float32Array([0, 0, 0, ...cube.positions]),
      faceIndices: cube.faceIndices.map((v) => v + 1),
    };
    const out = runMeshOperation(
      editInput(padded),
      { mode: 'vertex', items: [6] },
      { kind: 'move', delta: [0, 0, 10] },
      false,
    );
    expect(out.mesh.positions.length).toBe(cube.positions.length);
    expect(out.selection.items).toEqual([]);
  });
  it('loop-cuts the mirrored ring when an unused vertex comes first (A2, TS-1244)', () => {
    // The first cut drops the unused vertex, renumbering the rest: the mirrored edge follows.
    const a = boxMesh([10, 10, 10], [-50, 0, 0]);
    const b = boxMesh([10, 10, 10], [50, 0, 0]);
    const two: EpmMesh = {
      positions: new Float32Array([999, 999, 999, ...a.positions, ...b.positions]),
      faceSizes: new Uint32Array(12).fill(4),
      faceIndices: new Uint32Array([
        ...[...a.faceIndices].map((v) => v + 1),
        ...[...b.faceIndices].map((v) => v + 9),
      ]),
      faceMaterials: new Uint16Array(12),
      boneIds: [],
      morphs: [],
    };
    const inp = editInput(two);
    const edge = meshEdges(two, inp.topology).find((k) => Math.floor(k / 2 ** 20) >= 9)!;
    const both = runMeshOperation(
      inp,
      { mode: 'edge', items: [edge] },
      { kind: 'loopCut', cuts: 1 },
      true,
    ).mesh;
    expect(both.positions.length / 3).toBe(24);
    expect([...Array(24).keys()].filter((v) => both.positions[3 * v]! < 0)).toHaveLength(12);
  });
  it('merges each side on its own when mirroring (A2, TS-1245)', () => {
    const box = editInput(boxMesh([200, 200, 200]));
    const pos = box.mesh.positions;
    const at = (x: number, z: number) =>
      [...Array(8).keys()].filter((v) => Math.sign(pos[3 * v]!) === x && pos[3 * v + 2]! === z);
    const out = runMeshOperation(
      box,
      { mode: 'vertex', items: at(1, 100) },
      { kind: 'merge' },
      true,
    ).mesh;
    // Two top vertices per side become one each: 6 vertices, the top an edge, not an apex.
    expect(out.positions.length / 3).toBe(6);
    const top = [...Array(6).keys()].filter((v) => out.positions[3 * v + 2] === 100);
    expect(top.map((v) => out.positions[3 * v]).sort()).toEqual([-100, 100]);
    // A selection that is its own image merges once, onto the plane.
    const sym = runMeshOperation(
      box,
      { mode: 'vertex', items: [...at(1, 100), ...at(-1, 100)] },
      { kind: 'merge' },
      true,
    ).mesh;
    expect(sym.positions.length / 3).toBe(5);
    // Partly its own image: refused.
    expect(() =>
      runMeshOperation(
        box,
        { mode: 'vertex', items: [...at(1, 100), at(-1, 100)[0]!] },
        { kind: 'merge' },
        true,
      ),
    ).toThrow(MeshEditError);
  });
  it('stitches two mirrored halves in one merge (A2, TS-1245)', () => {
    // Either side alone would leave the triangles touching at one vertex; both make one edge.
    const mesh: EpmMesh = {
      positions: new Float32Array([
        ...[-100, 0, 0, 100, 0, 0, 0, 100, 0],
        ...[100, 0, 100, -100, 0, 100, 0, -100, 0],
      ]),
      faceSizes: new Uint32Array([3, 3]),
      faceIndices: new Uint32Array([0, 1, 2, 3, 4, 5]),
      faceMaterials: new Uint16Array(2),
      boneIds: [],
      morphs: [],
    };
    const out = runMeshOperation(
      editInput(mesh),
      { mode: 'vertex', items: [0, 4] },
      { kind: 'merge' },
      true,
    ).mesh;
    expect(out.positions.length / 3).toBe(4);
    expect(meshEdges(out, editInput(out).topology)).toHaveLength(5);
  });
  it('picks a bent face by the triangles the view draws (A2, TS-1244)', () => {
    // A bent quad (corner depths 0.1, 0.9, 0.1, 0.9) and, over its middle, a flat quad at 0.3.
    const mesh: EpmMesh = {
      positions: new Float32Array([
        ...[-100, -100, -100, 100, -100, -900, 100, 100, -100, -100, 100, -900],
        ...[-20, -20, -300, 20, -20, -300, 20, 20, -300, -20, 20, -300],
      ]),
      faceSizes: new Uint32Array([4, 4]),
      faceIndices: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7]),
      faceMaterials: new Uint16Array(2),
      boneIds: [],
      morphs: [],
    };
    const inp = editInput(mesh);
    const tris = triangulateFace(mesh, 0, 4);
    // The drawn depth of the bent quad at its centre: its diagonal's two corners' mean.
    const diagonal = [0, 1, 2, 3].filter((k) => tris.filter((t) => t === k).length === 2);
    const centre = diagonal.reduce((s, k) => s - mesh.positions[3 * k + 2]! / 1000, 0) / 2;
    const picked = pickElement(inp, 'face', topView(mesh.positions), 500, 500);
    expect(picked).toBe(centre < 0.3 ? 0 : 1);
  });
  it('loop-cuts the mirrored ring too when it is another ring', () => {
    const a = boxMesh([10, 10, 10], [-50, 0, 0]);
    const b = boxMesh([10, 10, 10], [50, 0, 0]);
    const two: EpmMesh = {
      positions: new Float32Array([...a.positions, ...b.positions]),
      faceSizes: new Uint32Array(12).fill(4),
      faceIndices: new Uint32Array([...a.faceIndices, ...[...b.faceIndices].map((v) => v + 8)]),
      faceMaterials: new Uint16Array(12),
      boneIds: [],
      morphs: [],
    };
    const inp = editInput(two);
    const edge = meshEdges(two, inp.topology).find((k) => Math.floor(k / 2 ** 20) >= 8)!;
    const sel = { mode: 'edge' as const, items: [edge] };
    const one = runMeshOperation(inp, sel, { kind: 'loopCut', cuts: 1 }, false).mesh;
    const both = runMeshOperation(inp, sel, { kind: 'loopCut', cuts: 1 }, true).mesh;
    expect(one.positions.length / 3).toBe(20);
    // Both boxes cut: 4 new vertices on each side.
    expect(both.positions.length / 3).toBe(24);
    const left = [...Array(24).keys()].filter((v) => both.positions[3 * v]! < 0).length;
    expect(left).toBe(12);
    // A cube's own mirrored ring is the same ring: cut once.
    const cut = runMeshOperation(
      input,
      { mode: 'edge', items: [edgeKey(6, 7)] },
      { kind: 'loopCut', cuts: 1 },
      true,
    );
    expect(cut.mesh.positions.length / 3).toBe(12);
  });
  it('toggles with Shift, replaces without, and converts the selection to vertices', () => {
    let sel = toggle(emptySelection('face'), 1, false);
    sel = toggle(sel, 2, true);
    expect(sel.items).toEqual([1, 2]);
    expect(toggle(sel, 1, true).items).toEqual([2]);
    expect(toggle(sel, 3, false).items).toEqual([3]);
    expect(selectedVertices(input, { mode: 'face', items: [1] }).sort()).toEqual([4, 5, 6, 7]);
    expect(selectedVertices(input, { mode: 'edge', items: [edgeKey(4, 5)] }).sort()).toEqual([
      4, 5,
    ]);
    expect(selectAll(input, 'edge').items).toHaveLength(12);
  });
  it('keeps the extruded caps selected, so extruding again continues outward', () => {
    const one = runMeshOperation(
      input,
      { mode: 'face', items: [1] },
      { kind: 'extrude', distance: 50 },
      false,
    );
    expect(one.selection).toEqual({ mode: 'face', items: [5] });
    const again = runMeshOperation(
      editInput(one.mesh),
      one.selection,
      { kind: 'extrude', distance: 50 },
      false,
    );
    let top = -Infinity;
    for (let i = 2; i < again.mesh.positions.length; i += 3)
      top = Math.max(top, again.mesh.positions[i]!);
    expect(top).toBeCloseTo(200);
    // Inset keeps the inner faces selected.
    const inset = runMeshOperation(
      input,
      { mode: 'face', items: [1, 0] },
      { kind: 'inset', amount: 0.5 },
      false,
    );
    expect(inset.selection.items).toEqual([8, 13]);
    const inner = editInput(inset.mesh);
    for (const f of inset.selection.items) {
      const vs = [
        ...inset.mesh.faceIndices.subarray(
          inner.topology.faceStart[f]!,
          inner.topology.faceStart[f]! + 4,
        ),
      ];
      for (const v of vs) expect(Math.abs(inset.mesh.positions[3 * v]!)).toBeCloseTo(50);
    }
  });
  it('mirrors across x: a face and its image extrude apart, a move reflects', () => {
    const cut = editInput(loopCut(input, [0, 1], 1)); // a loop at x = 0
    const t = cut.topology;
    const plusX = [...Array(cut.mesh.faceSizes.length).keys()].find((f) =>
      [0, 1, 2, 3].every(
        (k) => cut.mesh.positions[3 * cut.mesh.faceIndices[t.faceStart[f]! + k]!]! > 99,
      ),
    )!;
    const out = runMeshOperation(
      cut,
      { mode: 'face', items: [plusX] },
      { kind: 'extrude', distance: 30 },
      true,
    );
    expect(out.selection.items).toHaveLength(2);
    let lo = Infinity,
      hi = -Infinity;
    for (let i = 0; i < out.mesh.positions.length; i += 3) {
      lo = Math.min(lo, out.mesh.positions[i]!);
      hi = Math.max(hi, out.mesh.positions[i]!);
    }
    expect([lo, hi]).toEqual([-130, 130]);
  });
  it('says why an operation does not fit the selection, and refuses it', () => {
    expect(operationReason(emptySelection('face'), 'extrude')).toBe('Select something first.');
    expect(operationReason({ mode: 'vertex', items: [1] }, 'extrude')).toBe('Select faces.');
    expect(operationReason({ mode: 'edge', items: [1, 2] }, 'loopCut')).toBe('Select one edge.');
    expect(operationReason({ mode: 'vertex', items: [1] }, 'merge')).toBe(
      'Select two vertices or more.',
    );
    expect(() =>
      runMeshOperation(
        input,
        { mode: 'vertex', items: [1] },
        { kind: 'extrude', distance: 1 },
        false,
      ),
    ).toThrow(MeshEditError);
  });
  it('selects an edge loop and drops a selection that no longer fits the cage', () => {
    const cut = editInput(loopCut(input, [0, 1], 1));
    const first = selectAll(cut, 'edge').items.find((k) => {
      const a = Math.floor(k / (1 << 20)),
        b = k % (1 << 20);
      return (
        Math.abs(cut.mesh.positions[3 * a]!) < 1e-6 && Math.abs(cut.mesh.positions[3 * b]!) < 1e-6
      );
    })!;
    expect(selectLoop(cut, { mode: 'edge', items: [first] }).items).toHaveLength(4);
    expect(liveSelection(cube, { mode: 'vertex', items: [3, 9] }).items).toEqual([3]);
    expect(liveSelection(cube, { mode: 'edge', items: [edgeKey(4, 7)] }, input).items).toEqual([]);
  });
  it('builds the overlay: every edge, the vertices, the selected face highlighted', () => {
    const g = overlayGeometry(input, { mode: 'face', items: [1] });
    expect(g.lines.length).toBe(12 * 6);
    expect(g.points.length).toBe(8 * 3);
    expect(g.selectedLines.length).toBe(4 * 6);
    expect(g.selectedTriangles.length).toBe(2 * 9);
  });
});

describe('knife in the view (C3h, TS-1232)', () => {
  const cube = boxMesh([200, 200, 200]);
  const input = editInput(cube);
  const screen = topView(cube.positions);
  it('picks a corner when one is near, else a point inside an edge', () => {
    expect(pickKnifePoint(input, screen, 602, 401)?.point).toEqual({ vertex: 7 });
    const mid = pickKnifePoint(input, screen, 500, 402)!;
    expect('edge' in mid.point && mid.point.t).toBeCloseTo(0.5);
    // 4% of the way along the edge, outside a 5 px corner radius: the corner, not a sliver.
    expect(pickKnifePoint(input, screen, 408, 402, 5)!.point).toEqual({ vertex: 6 });
    expect('edge' in pickKnifePoint(input, screen, 412, 402, 5)!.point).toBe(true);
    expect(pickKnifePoint(input, screen, 500, 500)).toBeUndefined();
  });
  it('places a point on an edge where the click is under a perspective view', () => {
    // An eye 1000 mm above, looking down: nearer points spread out from the centre.
    const project = (q: readonly number[]): Projected => {
      const w = 1000 - q[2]!;
      return [500 + (1000 * q[0]!) / w, 500 - (1000 * q[1]!) / w, w / 2000];
    };
    const view: Projected[] = [];
    for (let i = 0; i < cube.positions.length; i += 3)
      view.push(project([...cube.positions.subarray(i, i + 3)]));
    // The upright edge at (100, 100): from z = −100 to z = +100.
    const p = cube.positions;
    const corner = (z: number) =>
      [...Array(8).keys()].find(
        (v) => p[3 * v]! > 0 && p[3 * v + 1]! > 0 && Math.sign(p[3 * v + 2]!) === z,
      )!;
    const [lo, hi] = [corner(-1), corner(1)];
    const [x, y] = [(view[lo]![0] + view[hi]![0]) / 2, (view[lo]![1] + view[hi]![1]) / 2];
    const pick = pickKnifePoint(input, view, x, y, 10, project)!;
    expect('edge' in pick.point).toBe(true);
    if (!('edge' in pick.point)) return;
    // Halfway on screen is z = +10 on the edge: 55% of the way up, not 50%.
    const t = pick.point.edge[0] === lo ? pick.point.t : 1 - pick.point.t;
    expect(t).toBeCloseTo(0.55, 4);
    // Without the projection, the screen's fraction.
    const flat = pickKnifePoint(input, view, x, y, 10)!;
    if ('edge' in flat.point)
      expect(flat.point.edge[0] === lo ? flat.point.t : 1 - flat.point.t).toBeCloseTo(0.5, 4);
  });
  it('cuts the face both points are on, nearest the camera, and refuses points on no common face', () => {
    const a = pickKnifePoint(input, screen, 500, 402)!;
    const b = pickKnifePoint(input, screen, 500, 598)!;
    const cut = runKnife(input, a, b, screen);
    expect(cut.faceSizes.length).toBe(7);
    expect(cut.positions.length / 3).toBe(10);
    // The new edge runs across the top (z = +100): both new vertices are up there.
    for (const v of [8, 9]) expect(cut.positions[3 * v + 2]).toBeCloseTo(100);
    // Opposite corners of the top face: one face in common, cut along its diagonal.
    const diag = runKnife(
      input,
      pickKnifePoint(input, screen, 400, 400)!,
      pickKnifePoint(input, screen, 600, 600)!,
      screen,
    );
    expect(diag.faceSizes.length).toBe(7);
    expect(diag.positions.length / 3).toBe(8);
    // A top corner and a bottom corner that share no face.
    const bottom = { point: { vertex: 0 }, at: screen[0]! };
    const far = [...Array(8).keys()].find(
      (v) =>
        cube.positions[3 * v + 2]! > 0 &&
        cube.positions[3 * v]! !== cube.positions[0] &&
        cube.positions[3 * v + 1]! !== cube.positions[1],
    )!;
    expect(() =>
      runKnife(input, bottom, { point: { vertex: far }, at: screen[far]! }, screen),
    ).toThrow(/not on one face/);
  });
});

describe('seams and unwrapping in edit mode (C4b, TS-1237)', () => {
  const input = editInput(boxMesh([200, 100, 50]));
  const all = selectAll(input, 'edge');
  it('marks seams, unwraps, keeps the selection, and shows the layout', () => {
    expect(uvLayout(input)).toBeUndefined();
    const out = runMeshOperation(input, all, { kind: 'markSeam' }, false);
    expect(out.selection).toBe(all);
    const cut = editInput(out.mesh);
    const layout = uvLayout(cut)!;
    expect(layout.islands).toBe(6);
    expect(layout.conformal).toBeLessThan(1.0001);
    expect(layout.outlines).toHaveLength(6);
    // The overlay draws every seam.
    expect(overlayGeometry(cut, emptySelection('edge')).seamLines.length).toBe(12 * 6);
    // Unwrapping again keeps the same seams.
    const again = runMeshOperation(cut, emptySelection('edge'), { kind: 'unwrap' }, false);
    expect(uvLayout(editInput(again.mesh))!.islands).toBe(6);
  });
  it('adds to the seams already there and clears seams one at a time', () => {
    // Every edge but one: the two faces on that edge stay one island.
    const [last, ...rest] = all.items;
    const some = runMeshOperation(
      input,
      { mode: 'edge', items: rest },
      { kind: 'markSeam' },
      false,
    );
    const five = editInput(some.mesh);
    expect(uvLayout(five)!.islands).toBe(5);
    // Marking the last edge keeps the earlier seams.
    const six = editInput(
      runMeshOperation(five, { mode: 'edge', items: [last!] }, { kind: 'markSeam' }, false).mesh,
    );
    expect(uvLayout(six)!.islands).toBe(6);
    const cleared = runMeshOperation(
      six,
      { mode: 'edge', items: [last!] },
      { kind: 'clearSeam' },
      false,
    );
    expect(uvLayout(editInput(cleared.mesh))!.islands).toBe(5);
  });
  it('counts the islands of a long strip without running out of stack', () => {
    const n = 15000;
    const positions = new Float32Array(6 * (n + 1));
    for (let i = 0; i <= n; i++) positions.set([i, 0, 0, i, 1, 0], 6 * i);
    const faceIndices = new Uint32Array(4 * n);
    const uvs = new Float32Array(8 * n);
    for (let i = 0; i < n; i++) {
      faceIndices.set([2 * i, 2 * i + 2, 2 * i + 3, 2 * i + 1], 4 * i);
      uvs.set([i / n, 0, (i + 1) / n, 0, (i + 1) / n, 1 / n, i / n, 1 / n], 8 * i);
    }
    const strip = editInput({
      positions,
      faceSizes: new Uint32Array(n).fill(4),
      faceIndices,
      faceMaterials: new Uint16Array(n),
      uvs,
      boneIds: [],
      morphs: [],
    });
    expect(uvLayout(strip)!.islands).toBe(1);
  });
  it('refuses to unwrap a closed cage with no seam', () => {
    expect(() =>
      runMeshOperation(input, emptySelection('edge'), { kind: 'unwrap' }, false),
    ).toThrow(/no seam/);
    const cut = editInput(runMeshOperation(input, all, { kind: 'markSeam' }, false).mesh);
    expect(() => runMeshOperation(cut, all, { kind: 'clearSeam' }, false)).toThrow(/no seam/);
    expect(operationReason(emptySelection('face'), 'markSeam')).toBe('Select something first.');
    expect(operationReason({ mode: 'face', items: [0] }, 'markSeam')).toBe('Select edges.');
    expect(operationReason(emptySelection('face'), 'unwrap')).toBeUndefined();
  });
});

describe('morph shape moves keep every vertex (C6b, TS-1266)', () => {
  const cube = boxMesh([200, 200, 200]);
  // An unused vertex first: a cage move drops it, a shape move must not.
  const padded: EpmMesh = {
    ...cube,
    positions: new Float32Array([7, 8, 9, ...cube.positions]),
    faceIndices: cube.faceIndices.map((v) => v + 1),
  };
  const input = editInput(padded);
  it('moves the selected vertices and keeps the unused one in place', () => {
    const out = shapeMove(input, { mode: 'vertex', items: [6] }, [0, 0, 10], false);
    expect(out.length).toBe(padded.positions.length);
    expect([...out.slice(0, 3)]).toEqual([7, 8, 9]);
    for (let i = 0; i < out.length; i++) {
      const moved = i === 3 * 6 + 2 ? 10 : 0;
      expect(out[i]).toBeCloseTo(padded.positions[i]! + moved, 4);
    }
  });
  it('reflects the move onto the mirror image with symmetry', () => {
    const v = [...Array(padded.positions.length / 3).keys()].find(
      (i) => padded.positions[3 * i]! > 50,
    )!;
    const out = shapeMove(input, { mode: 'vertex', items: [v] }, [5, 0, 0], true);
    expect(out.length).toBe(padded.positions.length);
    const changed = [...out].filter((x, i) => x !== padded.positions[i]).length;
    expect(changed).toBe(2);
  });
  it('refuses an empty selection or a non-finite delta', () => {
    expect(() => shapeMove(input, emptySelection('vertex'), [0, 0, 1], false)).toThrow(
      MeshEditError,
    );
    expect(() => shapeMove(input, { mode: 'vertex', items: [1] }, [NaN, 0, 0], false)).toThrow(
      MeshEditError,
    );
  });
});
