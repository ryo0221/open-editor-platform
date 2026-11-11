import { describe, expect, it } from 'vitest';
import { readVtu, writeVtu, type FemMesh } from '@editor-platform/geometry-fem';
import type { StaticRunFields as RunFields } from './run';
import type { ShellStaticRunFields } from './run-shell';
import {
  autoDeformationScale,
  bondedBodies,
  readAt,
  resultColor,
  resultDisplay,
  resultVtu,
  runResult,
  scalarRange,
  vtuResult,
} from './results';

/** One tet4 whose tip (node 3) moves down by 0.5 mm. */
function tet(): RunFields {
  const mesh: FemMesh = {
    type: 'tet4',
    nodes: new Float64Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]),
    elements: new Uint32Array([0, 1, 2, 3]),
    shapeFaces: 4,
    shapeEdges: 0,
    boundary: {
      elements: new Uint32Array([0, 0, 0, 0]),
      localFaces: new Uint8Array([0, 1, 2, 3]),
      tags: new Uint32Array([0, 1, 2, 3]),
    },
    edges: { offsets: new Uint32Array([0]), nodes: new Uint32Array(0) },
  };
  const displacement = new Float64Array(12);
  displacement[3 * 3 + 2] = -0.5;
  return {
    mesh,
    displacement,
    stress: new Float64Array(24),
    vonMises: new Float64Array([1, 2, 3, 40]),
    reaction: new Float64Array(12),
  };
}
/** Two tets sharing the face 1-2-3: one inner face, six boundary faces. */
const twoTets = () =>
  writeVtu({
    mesh: {
      ...tet().mesh,
      nodes: new Float64Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10, 10, 10, 10]),
      elements: new Uint32Array([0, 1, 2, 3, 4, 3, 2, 1]),
      boundary: {
        elements: new Uint32Array(0),
        localFaces: new Uint8Array(0),
        tags: new Uint32Array(0),
      },
    },
    pointData: [
      { name: 'Displacement (mm)', components: 3, values: new Float64Array(15).fill(0.1) },
      { name: 'von Mises (MPa)', components: 1, values: new Float64Array([1, 2, 3, 4, 5]) },
    ],
  });

describe('result display, section, readout and VTU (R3e-4c, R3e-4d)', () => {
  it('colours the boundary over its range and moves it by the scale (TS-1342, ST-185#1)', () => {
    const r = runResult(tet());
    expect(r.triangles).toHaveLength(12);
    expect(r.scalars.map((s) => s.id)).toEqual([
      'von-mises',
      'max-principal',
      'min-principal',
      'displacement',
    ]);
    expect(Array.from(r.scalars[3]!.values)).toEqual([0, 0, 0, 0.5]);
    expect(scalarRange(r, r.scalars[0]!.values)).toEqual([1, 40]);
    // The largest movement becomes a tenth of the model's diagonal.
    expect(autoDeformationScale(r)).toBeCloseTo((0.1 * Math.hypot(10, 10, 10)) / 0.5);
    const d = resultDisplay(r, 'von-mises', 10, [1, 40]);
    expect(d.mesh.indices).toHaveLength(12);
    expect(d.values).toHaveLength(4);
    const tip = Array.from(d.values).indexOf(40);
    expect(d.mesh.positions[tip * 3 + 2]! + d.mesh.origin[2]).toBeCloseTo(10 - 5);
    expect(Array.from(d.colors.slice(tip * 3, tip * 3 + 3))).toEqual(
      resultColor(1).map((v) => Math.fround(v)),
    );
    const low = Array.from(d.values).indexOf(1);
    expect(Array.from(d.colors.slice(low * 3, low * 3 + 3))).toEqual(
      resultColor(0).map((v) => Math.fround(v)),
    );
    for (const n of d.mesh.normals) expect(Number.isFinite(n)).toBe(true);
    expect(resultColor(-1)).toEqual(resultColor(0));
    expect(resultColor(Number.NaN)).toEqual(resultColor(0));
    expect(resultColor(2)).toEqual(resultColor(1));
    const still = tet();
    still.displacement.fill(0);
    expect(autoDeformationScale(runResult(still))).toBe(0);
  });

  it('shows each mode as its own field and shape, and writes them to a VTU (TS-1383, ST-199#3)', () => {
    const { mesh } = tet();
    // Node 3 moves 2 mm in z in mode 1 and node 1 moves 3 mm in x in mode 2 (mass-normalised units).
    const shape = (n: number, k: number, v: number) => {
      const s = new Float64Array(12);
      s[n * 3 + k] = v;
      return s;
    };
    const fields = {
      kind: 'modal' as const,
      mesh,
      modes: [
        {
          frequency: 417.46,
          shape: shape(3, 2, 2),
          effectiveMass: [0, 0.6, 0] as [number, number, number],
        },
        {
          frequency: 12_345.6,
          shape: shape(1, 0, -3),
          effectiveMass: [0.8, 0, 0] as [number, number, number],
        },
      ],
    };
    const r = runResult(fields);
    expect(r.scalars.map((s) => [s.id, s.label])).toEqual([
      ['mode-1', 'Mode 1 at 417.5 Hz'],
      ['mode-2', 'Mode 2 at 1.235e4 Hz'],
    ]);
    // Each field's largest movement is 1 and moves the mesh by its own shape.
    expect(Array.from(r.scalars[0]!.values)).toEqual([0, 0, 0, 1]);
    const one = resultDisplay(r, 'mode-1', 5, [0, 1]);
    const two = resultDisplay(r, 'mode-2', 5, [0, 1]);
    const zOf = (d: typeof one, n: number) => d.mesh.positions[n * 3 + 2]! + d.mesh.origin[2]!;
    const xOf = (d: typeof one, n: number) => d.mesh.positions[n * 3]! + d.mesh.origin[0]!;
    // The display mesh's vertices are the boundary triangles' corners: find node 3 (0,0,10).
    const at = (d: typeof one, p: number[]) =>
      Array.from({ length: d.mesh.positions.length / 3 }, (_, v) => v).filter(
        (v) =>
          Math.abs(xOf(d, v) - p[0]!) < 6 &&
          Math.abs(d.mesh.positions[v * 3 + 1]! + d.mesh.origin[1]! - p[1]!) < 1e-6,
      );
    expect(at(one, [0, 0]).some((v) => Math.abs(zOf(one, v) - 15) < 1e-5)).toBe(true);
    expect(at(two, [10, 0]).some((v) => Math.abs(xOf(two, v) - 5) < 1e-5)).toBe(true);
    expect(autoDeformationScale(r)).toBeCloseTo((0.1 * Math.hypot(10, 10, 10)) / 1, 9);
    // The VTU carries both shapes; opened again each is a field with its own shape.
    const vtu = resultVtu(fields);
    expect(readVtu(vtu).pointData.map((d) => d.name)).toEqual([
      'Mode 1 (417.5 Hz)',
      'Mode 2 (1.235e4 Hz)',
    ]);
    const back = vtuResult(vtu, 'modes.vtu');
    expect(back.scalars.map((s) => s.id)).toEqual(['Mode 1 (417.5 Hz)', 'Mode 2 (1.235e4 Hz)']);
    // The frequency stays in the label; the amplitude has no unit, as in the run.
    expect(back.scalars.map((s) => [s.label, s.unit])).toEqual([
      ['Mode 1 at 417.5 Hz', ''],
      ['Mode 2 at 1.235e4 Hz', ''],
    ]);
    expect(Array.from(back.scalars[1]!.displacement!)).toEqual(Array.from(shape(1, 0, -1)));
    expect(Array.from(back.displacement!)).toEqual(Array.from(shape(3, 2, 1)));
  });

  it('shows a shell run on its midsurface and opens its VTU again (TS-1394, ST-205)', () => {
    // A 10 mm square of two triangles, 2 mm thick; node 3 lifts 0.5 mm and tilts 0.01 rad.
    const n = 4;
    const displacement = new Float64Array(6 * n);
    displacement[6 * 3 + 2] = 0.5;
    displacement[6 * 3 + 3] = 0.01;
    const stress = (k: number) => {
      const a = new Float64Array(6 * n);
      for (let p = 0; p < n; p++) a[6 * p] = k * (p + 1);
      return a;
    };
    const fields: ShellStaticRunFields = {
      kind: 'shell-static',
      mesh: {
        nodes: Float64Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0, 10, 10, 0]),
        triangles: Uint32Array.from([0, 1, 2, 1, 3, 2]),
        thickness: Float64Array.from([2, 2]),
        faces: Int32Array.from([0, 0]),
        shapeFaces: 1,
        shapeEdges: 0,
        edges: { offsets: new Uint32Array([0]), nodes: new Uint32Array(0) },
      },
      displacement,
      stress: { top: stress(10), middle: stress(0), bottom: stress(-10) },
      vonMises: {
        top: Float64Array.from([10, 20, 30, 40]),
        bottom: Float64Array.from([10, 20, 30, 40]),
        max: Float64Array.from([10, 20, 30, 40]),
      },
      reaction: new Float64Array(6 * n),
    };
    const r = runResult(fields);
    // No inside: the triangles are the surface shown, the sections have nothing to cut.
    expect(r.tets.length).toBe(0);
    expect(Array.from(r.triangles)).toEqual([0, 1, 2, 1, 3, 2]);
    expect(r.scalars.map((s) => s.id)).toEqual([
      'von-mises',
      'von-mises-top',
      'von-mises-bottom',
      'displacement',
    ]);
    expect(Array.from(r.displacement!.subarray(9))).toEqual([0, 0, 0.5]);
    // Its VTU opens again as triangles, with the same surface and fields.
    const back = vtuResult(resultVtu(fields), 'shell.vtu');
    expect(back.tets.length).toBe(0);
    expect(Array.from(back.triangles)).toEqual([0, 1, 2, 1, 3, 2]);
    expect(back.scalars.find((s) => s.id === 'von Mises top (MPa)')!.values[3]).toBe(40);
    expect(Array.from(back.displacement!.subarray(9))).toEqual([0, 0, 0.5]);
    const display = resultDisplay(back, 'von Mises top (MPa)', 1, [10, 40]);
    // R3i-5: both sides are drawn, the back on its own four vertices and wound the other way.
    expect(display.mesh.positions.length / 3).toBe(8);
    expect(display.mesh.indices.length).toBe(12);
    const [a, b, c] = Array.from(display.mesh.indices.subarray(0, 3));
    const [d, e, f] = Array.from(display.mesh.indices.subarray(6, 9));
    expect([d, e, f].every((v) => v >= 4)).toBe(true);
    const same = (v: number, w: number) =>
      [0, 1, 2].every(
        (k) => display.mesh.positions[v * 3 + k] === display.mesh.positions[w * 3 + k],
      );
    expect(same(a!, d!) && same(c!, e!) && same(b!, f!)).toBe(true);
  });

  it('opens a large shell VTU (64,800 triangles)', () => {
    const n = 181;
    const nodes = new Float64Array(n * n * 3);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) nodes.set([i, j, 0], (j * n + i) * 3);
    const elements = new Uint32Array(180 * 180 * 6);
    let k = 0;
    for (let j = 0; j < 180; j++)
      for (let i = 0; i < 180; i++) {
        const a = j * n + i;
        elements.set([a, a + 1, a + n, a + 1, a + n + 1, a + n], k);
        k += 6;
      }
    const vtu = writeVtu({ mesh: { type: 'tri3', nodes, elements } });
    expect(vtuResult(vtu, 'grid.vtu').triangles.length).toBe(elements.length);
  });

  it('shows a thermal run as temperature and heat flux, and writes them to a VTU (TS-1388, ST-201#3)', () => {
    const { mesh } = tet();
    const temperature = new Float64Array([300, 310, 320, 400]);
    const flux = new Float64Array(12);
    flux[11] = -5;
    const fields = {
      kind: 'thermal' as const,
      mesh,
      temperature,
      flux,
      fluxMagnitude: new Float64Array([0, 0, 0, 5]),
    };
    const r = runResult(fields);
    expect(r.displacement).toBeUndefined();
    expect(r.scalars.map((s) => [s.id, s.label, s.unit])).toEqual([
      ['temperature', 'Temperature', 'K'],
      ['heat-flux', 'Heat flux', 'kW/m²'],
    ]);
    expect(autoDeformationScale(r)).toBe(0);
    const d = resultDisplay(r, 'temperature', 0, [300, 400]);
    expect(Math.min(...d.values)).toBe(300);
    expect(Math.max(...d.values)).toBe(400);
    const vtu = resultVtu(fields);
    const back = vtuResult(vtu, 'heat.vtu');
    expect(back.scalars.map((s) => [s.label, s.unit])).toEqual([
      ['Temperature', 'K'],
      ['Heat flux', 'kW per m²'],
    ]);
    expect(Array.from(back.scalars[0]!.values)).toEqual(Array.from(temperature));
    expect(Array.from(back.scalars[1]!.values)).toEqual([0, 0, 0, 5]);
    expect(back.displacement).toBeUndefined();
  });

  it('exports every nodal field to a VTU that reads back (TS-1342, ST-185#2)', () => {
    const f = tet();
    const read = readVtu(resultVtu(f));
    expect(read.type).toBe('tet4');
    expect(Array.from(read.nodes)).toEqual(Array.from(f.mesh.nodes));
    expect(read.pointData.map((d) => [d.name, d.components])).toEqual([
      ['Displacement (mm)', 3],
      ['Stress (MPa)', 6],
      ['von Mises (MPa)', 1],
      ['Max principal stress (MPa)', 1],
      ['Min principal stress (MPa)', 1],
      ['Reaction (N)', 3],
    ]);
    expect(Array.from(read.pointData[2]!.values)).toEqual([1, 2, 3, 40]);
  });

  it('cuts the elements by an axis plane and colours the cut (TS-1344, ST-186#1)', () => {
    const r = runResult(tet());
    // z = 5: the tip is above and removed; the cut is a triangle at half the values.
    const d = resultDisplay(r, 'von-mises', 0, [1, 40], { axis: 2, offset: 5 });
    const z = (v: number) => d.mesh.positions[v * 3 + 2]! + d.mesh.origin[2];
    const cut = Array.from(d.values.keys()).filter((v) => Math.abs(z(v) - 5) < 1e-6);
    // The clipped boundary and the cut face meet on the plane, at half the values.
    expect([...new Set(cut.map((v) => d.values[v]))].sort((a, b) => a! - b!)).toEqual([
      20.5, 21, 21.5,
    ]);
    // Nothing is left above the plane.
    for (let v = 0; v < d.values.length; v++) expect(z(v)).toBeLessThanOrEqual(5 + 1e-6);
    // The cut triangle faces +z, toward the removed side.
    const tris = Array.from(d.mesh.indices);
    let found = false;
    for (let t = 0; t < tris.length; t += 3) {
      const [a, b, c] = tris.slice(t, t + 3) as [number, number, number];
      if (![a, b, c].every((v) => cut.includes(v))) continue;
      const p = (v: number, k: number) => d.mesh.positions[v * 3 + k]!;
      const nz =
        (p(b, 0) - p(a, 0)) * (p(c, 1) - p(a, 1)) - (p(b, 1) - p(a, 1)) * (p(c, 0) - p(a, 0));
      expect(nz).toBeGreaterThan(0);
      found = true;
    }
    expect(found).toBe(true);
    // A deformation turning the part over (x, y, z) → (x, −y, −z) turns the cap with it: its
    // winding comes from the undeformed plane, so it now faces −z.
    const flipped = tet();
    const n = flipped.mesh.nodes;
    flipped.displacement = new Float64Array(n.length);
    for (let v = 0; v < n.length / 3; v++) {
      flipped.displacement[v * 3 + 1] = -2 * n[v * 3 + 1]!;
      flipped.displacement[v * 3 + 2] = -2 * n[v * 3 + 2]!;
    }
    const turned = resultDisplay(runResult(flipped), 'von-mises', 1, [1, 40], {
      axis: 2,
      offset: 5,
    });
    const tz = (v: number) => turned.mesh.positions[v * 3 + 2]! + turned.mesh.origin[2];
    const capped = Array.from(turned.values.keys()).filter((v) => Math.abs(tz(v) + 5) < 1e-6);
    const ti = Array.from(turned.mesh.indices);
    let flippedCap = 0;
    for (let t = 0; t < ti.length; t += 3) {
      const [a, b, c] = ti.slice(t, t + 3) as [number, number, number];
      if (![a, b, c].every((v) => capped.includes(v))) continue;
      const p = (v: number, k: number) => turned.mesh.positions[v * 3 + k]!;
      const nz =
        (p(b, 0) - p(a, 0)) * (p(c, 1) - p(a, 1)) - (p(b, 1) - p(a, 1)) * (p(c, 0) - p(a, 0));
      expect(nz).toBeLessThan(0);
      flippedCap++;
    }
    expect(flippedCap).toBeGreaterThan(0);
    // Above everything: nothing is cut or removed.
    expect(
      resultDisplay(r, 'von-mises', 0, [1, 40], { axis: 2, offset: 20 }).mesh.indices,
    ).toHaveLength(12);
  });

  it('reads the value at the nearest shown vertex (TS-1344, ST-186#2)', () => {
    const d = resultDisplay(runResult(tet()), 'von-mises', 0, [1, 40]);
    expect(readAt(d, [0.4, 0.2, 9])).toEqual({ value: 40, at: [0, 0, 10] });
    expect(readAt(d, [9, 1, 0])!.value).toBe(2);
  });

  it('draws a tet10 face through its mid-edge nodes, near the model (TS-1342, ST-185#1)', () => {
    const f = tet();
    const c = [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10];
    const mid = (i: number, j: number) => [0, 1, 2].map((k) => (c[i * 3 + k]! + c[j * 3 + k]!) / 2);
    const far = 1e6;
    const nodes = [
      ...c,
      ...[
        [0, 1],
        [1, 2],
        [0, 2],
        [0, 3],
        [1, 3],
        [2, 3],
      ].flatMap(([i, j]) => mid(i!, j!)),
    ].map((v) => v + far);
    f.mesh = {
      ...f.mesh,
      type: 'tet10',
      nodes: new Float64Array(nodes),
      elements: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    };
    f.displacement = new Float64Array(30);
    f.stress = new Float64Array(60);
    f.reaction = new Float64Array(30);
    // The mid-edge node between corners 1 and 2 bulges out by 0.01 mm.
    f.displacement[5 * 3] = 0.01;
    f.vonMises = new Float64Array(10).fill(1);
    f.vonMises[5] = 99;
    const r = runResult(f);
    expect(r.triangles).toHaveLength(4 * 12);
    expect([...new Set(r.triangles)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(scalarRange(r, r.scalars[0]!.values)).toEqual([1, 99]);
    const d = resultDisplay(r, 'von-mises', 1, [1, 99]);
    expect(d.mesh.origin).toEqual([far + 5, far + 5, far + 5]);
    expect(d.mesh.indices).toHaveLength(48);
    // Kept relative to the origin, the 0.01 mm movement survives Float32.
    const v5 = Array.from(d.values).indexOf(99);
    expect(d.mesh.positions[v5 * 3]! + d.mesh.origin[0] - (far + 5.01)).toBeCloseTo(0, 4);
    // The readout takes and gives world coordinates.
    expect(readAt(d, [far + 5, far + 5, far])!.value).toBe(99);
    // A section cuts the eight sub-tets: corners at 0 and mid-edge nodes at 100, the cap shows the
    // mid-edge values and meets the clipped boundary, one value at each place on the plane.
    expect(r.tets).toHaveLength(8 * 4);
    const mids = runResult({
      ...f,
      vonMises: new Float64Array([0, 0, 0, 0, 100, 100, 100, 100, 100, 100]),
    });
    const cut = resultDisplay(mids, 'von-mises', 0, [0, 100], { axis: 2, offset: far + 2.5 });
    const onPlane = new Map<string, Set<number>>();
    for (let v = 0; v < cut.values.length; v++) {
      const p = [0, 1, 2].map((k) => cut.mesh.positions[v * 3 + k]! + cut.mesh.origin[k]!);
      if (Math.abs(p[2]! - (far + 2.5)) > 1e-3) continue;
      const key = p.map((x) => x.toFixed(2)).join();
      onPlane.set(key, (onPlane.get(key) ?? new Set()).add(Math.round(cut.values[v]!)));
    }
    expect(onPlane.size).toBeGreaterThan(0);
    for (const vals of onPlane.values()) expect(vals.size).toBe(1);
    expect(Math.max(...[...onPlane.values()].flatMap((x) => [...x]))).toBe(100);
    // A tet10 VTU's boundary is drawn the same way.
    const vtu = vtuResult(resultVtu(f), 'q.vtu');
    expect(vtu.triangles).toHaveLength(4 * 12);
  });

  it('ranges a section over the interior values it shows (TS-1344, ST-186#1)', () => {
    // An interior node at 100 with every boundary node at 0: four tets around node 4.
    const f = tet();
    const vtu = writeVtu({
      mesh: {
        ...f.mesh,
        nodes: new Float64Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10, 2, 2, 2]),
        elements: new Uint32Array([4, 1, 2, 3, 0, 4, 2, 3, 0, 1, 4, 3, 0, 1, 2, 4]),
      },
      pointData: [
        { name: 'von Mises (MPa)', components: 1, values: new Float64Array([0, 0, 0, 0, 100]) },
      ],
    });
    const r = vtuResult(vtu, 'inner.vtu');
    const values = r.scalars[0]!.values;
    expect(scalarRange(r, values)).toEqual([0, 0]);
    expect(scalarRange(r, values, true)).toEqual([0, 100]);
    const d = resultDisplay(r, r.scalars[0]!.id, 0, [0, 100], { axis: 2, offset: 2 });
    expect(Math.max(...d.values)).toBeCloseTo(100);
  });

  it('opens a VTU for display: its boundary, its fields, its displacement (TS-1344, ST-186#3)', () => {
    const r = vtuResult(twoTets(), 'two.vtu');
    expect(r.origin).toBe('two.vtu');
    expect(r.triangles).toHaveLength(6 * 3);
    // The shared face 1-2-3 is inside.
    for (let t = 0; t < r.triangles.length; t += 3)
      expect([...r.triangles.slice(t, t + 3)].sort().join()).not.toBe('1,2,3');
    expect(r.scalars.map((s) => [s.id, s.label, s.unit])).toEqual([
      ['Displacement (mm)', 'Displacement', 'mm'],
      ['von Mises (MPa)', 'von Mises', 'MPa'],
    ]);
    expect(r.displacement).toBeDefined();
    expect(r.scalars[0]!.values[0]).toBeCloseTo(Math.sqrt(3) * 0.1);
    // The display draws all six boundary faces.
    const d = resultDisplay(r, 'von Mises (MPa)', 0, [1, 5]);
    expect(d.mesh.indices).toHaveLength(18);
    expect(() => vtuResult('<VTKFile/>', 'bad.vtu')).toThrow('result-invalid');
  });
});

/** TS-1467 (ST-238#1): a bonded run's bodies, together and one by one. */
describe('the bodies of a bonded run (R3j-6c)', () => {
  const shell = (): ShellStaticRunFields => ({
    kind: 'shell-static',
    mesh: {
      nodes: Float64Array.from([20, 0, 0, 30, 0, 0, 20, 10, 0]),
      triangles: Uint32Array.from([0, 1, 2]),
      thickness: Float64Array.from([1.5]),
      faces: Int32Array.from([0]),
      shapeFaces: 1,
      shapeEdges: 0,
      edges: { offsets: new Uint32Array([0]), nodes: new Uint32Array(0) },
    },
    displacement: Float64Array.from([0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    stress: {
      top: new Float64Array(18),
      middle: new Float64Array(18),
      bottom: new Float64Array(18),
    },
    vonMises: {
      top: Float64Array.from([5, 6, 7]),
      bottom: Float64Array.from([5, 6, 7]),
      max: Float64Array.from([5, 6, 7]),
    },
    reaction: new Float64Array(18),
  });
  const bonded = {
    kind: 'bonded-static' as const,
    bodies: [
      { bodyId: 'mount', fields: tet() },
      { bodyId: 'roof', fields: shell() },
    ],
  };
  it('joins every body’s mesh and the fields they all have', () => {
    const r = runResult(bonded);
    expect(r.nodes.length).toBe(3 * 7);
    // The solid's four boundary faces, then the shell's triangle after the solid's four nodes.
    expect(Array.from(r.triangles.subarray(12))).toEqual([4, 5, 6]);
    // Only the shell's triangle is seen from both sides.
    expect(Array.from(r.twoSided!)).toEqual([0, 0, 0, 0, 1]);
    const shown = resultDisplay(r, 'von-mises', 0, [0, 40]);
    expect(shown.mesh.indices.length).toBe(3 * (4 + 2));
    expect(r.tets.length).toBe(4);
    expect(r.scalars.map((x) => x.id)).toEqual(['von-mises', 'displacement']);
    expect(Array.from(r.scalars[0]!.values)).toEqual([1, 2, 3, 40, 5, 6, 7]);
    expect(Array.from(r.displacement!)).toEqual([
      ...[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -0.5],
      ...[0, 0, 0, 0, 0, 2, 0, 0, 0],
    ]);
  });
  it('shows one body, writes its VTU, and says how each was solved', () => {
    const roof = runResult(bonded, 'roof');
    expect(roof.scalars.map((x) => x.id)).toContain('von-mises-top');
    expect(roof.nodes.length).toBe(9);
    expect(readVtu(resultVtu(bonded, 'roof')).type).toBe('tri3');
    expect(readVtu(resultVtu(bonded)).type).toBe('tet4');
    expect(bondedBodies(bonded)).toEqual([
      { bodyId: 'mount', kind: 'solid' },
      { bodyId: 'roof', kind: 'shell', thickness: [1.5, 1.5] },
    ]);
    expect(bondedBodies(tet())).toBeUndefined();
  });
  it('scales a mode over all bodies together', () => {
    const modal = {
      kind: 'bonded-modal' as const,
      bodies: [
        {
          bodyId: 'mount',
          fields: {
            kind: 'modal' as const,
            mesh: tet().mesh,
            modes: [
              {
                frequency: 50,
                shape: Float64Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
                effectiveMass: [0, 0, 0] as [number, number, number],
              },
            ],
          },
        },
        {
          bodyId: 'roof',
          fields: {
            kind: 'shell-modal' as const,
            mesh: shell().mesh,
            modes: [
              {
                frequency: 50,
                shape: Float64Array.from([0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
                effectiveMass: [0, 0, 0] as [number, number, number],
              },
            ],
          },
        },
      ],
    };
    const r = runResult(modal);
    expect(r.scalars.map((x) => x.label)).toEqual(['Mode 1 at 50.00 Hz']);
    // The roof's corner moves the most: 1 there, 0.25 at the mount's tip.
    expect(r.scalars[0]!.values[3]).toBeCloseTo(0.25);
    expect(r.scalars[0]!.values[4]).toBeCloseTo(1);
  });
});
