import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers';
import {
  applyCadOperation,
  cadContentHash,
  f02Plate,
  cadToleranceSets,
  f02Volume,
  f03Revolve,
  f01Empty,
  f05Dependencies,
  f10Expressions,
  f11Area,
  f11Bracket,
  f11OnPlate,
  f11Region,
  f15Loft,
  f15Wing,
  f15Sweep,
  f16Reference,
  f16Sketch,
  f16Spline,
  f17Sheets,
  f17Surfaces,
  edgeRef,
  f17Boundaries,
  f17HyparArea,
  f17LoftReference,
  f18Hood,
  f18Seams,
  cadContinuity,
  continuityReport,
  f18HoodArea,
  f18Sheets,
  f18SkinVolume,
  f18WindowArea,
  r1Housing,
  f12References,
  f12Fillet,
  validateCad,
  f42Airliner,
  f41,
  f41Bridge,
  k5aBars,
  cadBuilder,
  f12Holes,
  f12SlotArgs,
  duplicateClosureOf,
  polylineFillet,
  sharedFaceName,
  edgeName,
  f14Patterns,
  faceRef,
  f13ShellDraft,
  type F12Slot,
  candidatesOf,
  elementName,
  formatFaceName,
  formatTopoName,
  resolveTopologyRef,
  selectFor,
  identityQuaternion,
  mm,
  position,
  type CadDocument,
  type CadTopoName,
  type CadBodyEvaluation,
  type CadEvaluation,
  cadCurvature,
  type CadCombSample,
} from '@editor-platform/cad-core';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { evaluateGeometry } from '@editor-platform/geometry-kernel-occt';
import { checkClosedMesh, stepReport, writeStl } from './formats';
import { CadEvaluationCancelled, evaluateCad, FeatureCache, PlacementCache } from './evaluator';
import { createKernelHost, kernelLoadMarks, loadVerifiedBuild } from './host';
import type { CadMesh, CadWorkerRequest, CadWorkerResponse } from './protocol';
import { cadKernelBuild, cadKernelPrevious } from '../../../scripts/cad-kernel/build.mjs';

/** A body evaluation read as a solid's (the tests check solids unless they say otherwise). */
const solid = (b: CadBodyEvaluation | undefined) => {
  if (b?.kind !== 'solid') throw new Error(`not a solid: ${JSON.stringify(b)}`);
  return b;
};

// Opt-in: the development kernel (scripts/cad-kernel) built outside the repository.
const dist = process.env.CAD_OCCT_DIST;
/** F07 STEP corpus written by a native OCCT 8.0 (scripts/cad-kernel/f07-corpus.py). */
const corpusFile = (name: string) => new URL(`../fixtures/f07/${name}`, import.meta.url);
describe.skipIf(!dist)('OCCT kernel host with the development build', () => {
  let buildHash = '';
  const posted: CadWorkerResponse[] = [];
  let handle: (m: CadWorkerRequest) => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let oc: any;
  const pinned = (doc: CadDocument): CadDocument => ({
    ...doc,
    kernelProfile: { ...doc.kernelProfile, buildHash },
  });
  const evaluate = async (requestId: string, doc: CadDocument, deflectionMm?: number) => {
    const document = pinned(doc);
    await handle({
      type: 'evaluate',
      requestId,
      generation: 1,
      baseHash: '',
      candidateHash: cadContentHash(document),
      document,
      ...(deflectionMm === undefined ? {} : { deflectionMm }),
    });
    // Progress messages come first; the job ends with its result or cancellation.
    return posted.find(
      (m) => 'requestId' in m && m.requestId === requestId && m.type !== 'progress',
    )!;
  };
  const sphere = (id: string, radius: number, x: number): CadDocument =>
    applyCadOperation(f01Empty(), {
      type: 'insertFeatures',
      parameters: [],
      profiles: [],
      features: [
        {
          id,
          name: id,
          type: 'sphere',
          inputFeatureIds: [],
          args: {
            radius: mm(radius),
            origin: position(x, 0, 0),
            orientation: identityQuaternion(),
          },
        },
      ],
      bodies: [
        {
          id: `${id}-body`,
          name: id,
          sourceFeatureId: id,
          placementFeatureId: `${id}-placement`,
          appearance: { color: '#9aa4b1', opacity: 1 },
        },
      ],
    });
  beforeAll(async () => {
    const wasm = readFileSync(`${dist}/${cadKernelBuild.wasm}`);
    const sha = createHash('sha256').update(wasm).digest('hex');
    if (sha !== cadKernelBuild.wasmSha256)
      throw new Error(`kernel Wasm ${sha} is not the pinned build`);
    buildHash = `sha256:${sha}`;
    // The Emscripten loader expects CommonJS globals under Node.
    globalThis.require ??= createRequire(import.meta.url);
    handle = createKernelHost({
      // The module factory with the verified bytes (loadVerifiedBuild compiles them first).
      load: async () => {
        const { default: factory } = await import(
          pathToFileURL(`${dist}/${cadKernelBuild.js}`).href
        );
        return (oc = await factory({ wasmBinary: wasm }));
      },
      post: (m) => void posted.push(m),
      yieldTask: () => new Promise((resolve) => setImmediate(resolve)),
    });
    await handle({ type: 'init', build: { buildHash, moduleUrl: '', wasmUrl: '' } });
  }, 300_000);

  it('writes the active bodies as one BRep that the geometry kernel reads back (R2c-3c-3b)', async () => {
    const doc = pinned(f02Plate());
    await handle({
      type: 'evaluate',
      requestId: 'f02-brep',
      generation: 1,
      baseHash: '',
      candidateHash: cadContentHash(doc),
      document: doc,
      brep: true,
    });
    const written = posted.find(
      (m) => 'requestId' in m && m.requestId === 'f02-brep' && m.type !== 'progress',
    )!;
    if (written.type !== 'result' || !written.brep) throw new Error(JSON.stringify(written));
    const { bytes, bounds, kinds, appearances, faces } = written.brep;
    expect(kinds).toEqual(['solid']);
    expect(bounds[1][0]).toBeCloseTo(80, 6);
    // OH-U1: each body's appearance and face count travel with the shape.
    expect(appearances).toEqual([{ color: '#9aa4b1', opacity: 1 }]);
    // The building's kernel reads it as a `brep` asset: the same volume.
    const read = await evaluateGeometry(
      oc,
      { nodes: { part: { op: 'brep', asset: 'h' } } },
      [{ node: 'part', measure: true, mesh: { deflectionMm: 0.5, angularDeflectionRad: 0.1 } }],
      { assets: new Map([['h', bytes]]) },
    );
    const result = read.status === 'ok' ? read.results[0] : undefined;
    if (result?.status !== 'ok' || !result.measure || !result.mesh)
      throw new Error(JSON.stringify(read));
    // The read-back mesh counts the same faces, so face indices map to bodies.
    expect(faces).toEqual([Math.max(...result.mesh.faceIndices) + 1]);
    expect(Math.abs(result.measure.volumeMm3 - f02Volume(80))).toBeLessThanOrEqual(
      1e-7 * f02Volume(80),
    );
    // An empty document has nothing to place.
    const empty = pinned(f01Empty());
    await handle({
      type: 'evaluate',
      requestId: 'f01-brep',
      generation: 1,
      baseHash: '',
      candidateHash: cadContentHash(empty),
      document: empty,
      brep: true,
    });
    const refused = posted.find(
      (m) => 'requestId' in m && m.requestId === 'f01-brep' && m.type !== 'progress',
    )!;
    expect(refused.type === 'result' && refused.evaluation).toMatchObject({
      status: 'error',
      code: 'brep-empty',
    });
  });

  it('evaluates F02 after a dimension change with metrics and a consistent mesh', async () => {
    expect(posted[0]).toEqual({ type: 'ready', buildHash });
    const doc = applyCadOperation(f02Plate(), {
      type: 'setParameter',
      parameterId: 'W',
      value: 100,
    });
    const result = await evaluate('f02', doc);
    if (result.type !== 'result' || result.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(result));
    const plate = result.evaluation.bodies.plate;
    expect(Math.abs(solid(plate).volumeMm3 - f02Volume(100))).toBeLessThanOrEqual(
      1e-7 * f02Volume(100),
    );
    expect(plate.bounds[1][0]).toBeCloseTo(100, 6);
    expect(Object.keys(result.evaluation.bodies)).toEqual(['plate']);
    const [mesh] = result.meshes;
    expect(mesh.bodyId).toBe('plate');
    expect(mesh.indices.length % 3).toBe(0);
    expect(Math.max(...mesh.indices)).toBeLessThan(mesh.positions.length / 3);
    expect(mesh.faceIds.length).toBe(mesh.indices.length / 3);
    expect(mesh.normals.length).toBe(mesh.positions.length);
    // Signed volume of the closed, outward-wound mesh approximates the exact volume.
    let signed = 0;
    const p = mesh.positions;
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const [a, b, c] = [mesh.indices[i] * 3, mesh.indices[i + 1] * 3, mesh.indices[i + 2] * 3];
      signed +=
        (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
          p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
          p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) /
        6;
    }
    expect(signed / solid(plate).volumeMm3).toBeGreaterThan(0.99);
    expect(signed / solid(plate).volumeMm3).toBeLessThan(1.01);
    // B-rep vertices, each once, read from the kernel: the eight corners exactly, and the hole's
    // seam vertices on its rim (radius 5 about x = 50, y = 25), for distance snapping.
    const vertices: number[][] = [];
    for (let i = 0; i < mesh.vertices.length; i += 3)
      vertices.push([...mesh.vertices.subarray(i, i + 3)]);
    expect(new Set(vertices.map((v) => v.join())).size).toBe(vertices.length);
    const corners = vertices.filter(([x, y]) => (x === 0 || x === 100) && (y === 0 || y === 50));
    expect(corners.map((v) => v.join()).sort()).toEqual(
      [0, 100].flatMap((x) => [0, 50].flatMap((y) => [0, 5].map((z) => [x, y, z].join()))).sort(),
    );
    const rim = vertices.filter((v) => !corners.includes(v));
    expect(rim.length).toBeGreaterThan(0);
    for (const [x, y] of rim) expect(Math.hypot(x! - 50, y! - 25)).toBeCloseTo(5, 9);
  });

  it('evaluates schema 2 expressions to the literal shape (F10)', async () => {
    const literal = applyCadOperation(f02Plate(), {
      type: 'setParameter',
      parameterId: 'W',
      value: 100,
    });
    const results = [];
    for (const [id, doc] of [
      ['f10-literal', literal],
      ['f10', f10Expressions()],
    ] as const) {
      const r = await evaluate(id, doc);
      if (r.type !== 'result' || r.evaluation.status !== 'ok') throw new Error(JSON.stringify(r));
      results.push(r.evaluation.bodies.plate);
    }
    // F10's thickness T = W / 20 = 5 and hole x = W / 2 give F02's shape at W = 100.
    expect(results[1]).toEqual(results[0]);
    expect(Math.abs(solid(results[1]).volumeMm3 - f02Volume(100))).toBeLessThanOrEqual(
      1e-7 * f02Volume(100),
    );
  });

  it('builds the D1 parts with their analytic geometry (ST-27#1–#4)', async () => {
    const ok = async (id: string, doc: CadDocument) => {
      const r = await evaluate(id, doc);
      if (r.type !== 'result' || r.evaluation.status !== 'ok') throw new Error(JSON.stringify(r));
      return { bodies: r.evaluation.bodies, meshes: r.meshes };
    };
    const near = (actual: number, expected: number) =>
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-7 * expected);
    // #1/#2: the hole centre read from the mesh (the rim vertices on the plate faces).
    const holeCentre = (r: Awaited<ReturnType<typeof ok>>, width: number) => {
      const { positions: p, origin } = r.meshes[0];
      const rim: [number, number][] = [];
      for (let i = 0; i < p.length; i += 3) {
        const [x, y] = [p[i] + origin[0], p[i + 1] + origin[1]];
        if (x > 1 && x < width - 1 && y > 1 && y < 49) rim.push([x, y]);
      }
      // Mesh vertices lie on the surface: fit x² + y² = 2·cx·x + 2·cy·y + c exactly.
      const m = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ];
      const v = [0, 0, 0];
      for (const [x, y] of rim) {
        const row = [2 * x, 2 * y, 1];
        for (let i = 0; i < 3; i++) {
          v[i] += row[i] * (x * x + y * y);
          for (let j = 0; j < 3; j++) m[i][j] += row[i] * row[j];
        }
      }
      const det = (a: number[][]) =>
        a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
        a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
        a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
      const solve = (k: number) =>
        det(m.map((row, i) => row.map((x, j) => (j === k ? v[i] : x)))) / det(m);
      const [cx, cy, c] = [solve(0), solve(1), solve(2)];
      expect(cy).toBeCloseTo(25, 4);
      expect(Math.sqrt(c + cx * cx + cy * cy)).toBeCloseTo(5, 4);
      return cx;
    };
    const at80 = await ok('d1-80', f02Plate());
    near(solid(at80.bodies.plate).volumeMm3, 20_000 - 125 * Math.PI);
    expect(holeCentre(at80, 80)).toBeCloseTo(40, 4);
    const w100 = (mode: 'center' | 'edge' | 'literal') =>
      applyCadOperation(f02Plate(mode), { type: 'setParameter', parameterId: 'W', value: 100 });
    const at100 = await ok('d1-100', w100('center'));
    near(solid(at100.bodies.plate).volumeMm3, 25_000 - 125 * Math.PI);
    expect(holeCentre(at100, 100)).toBeCloseTo(50, 4);
    expect(holeCentre(await ok('d1-edge', w100('edge')), 100)).toBeCloseTo(90, 4);
    expect(holeCentre(await ok('d1-literal', w100('literal')), 100)).toBeCloseTo(40, 4);
    // #3: a ring revolved about z (radii 10–15, height 20).
    near(solid((await ok('d1-ring', f03Revolve())).bodies.ring).volumeMm3, 2_500 * Math.PI);
    // #4: two cylinders of radius 10 whose axes are 10 apart (heights 10 and 5).
    const posts = (bx: number) => {
      const doc = structuredClone(f05Dependencies(0));
      doc.profiles.find((p) => p.id === 'profile-b')!.plane.origin = position(bx, 0, 0);
      return doc;
    };
    const lens = 200 * Math.acos(0.5) - 5 * Math.sqrt(300);
    const expected = {
      cut: 1_000 * Math.PI - 5 * lens,
      union: 1_500 * Math.PI - 5 * lens,
      common: 5 * lens,
    };
    for (const mode of ['cut', 'union', 'common'] as const) {
      const doc = applyCadOperation(posts(10), {
        type: 'booleanBodies',
        targetId: 'a',
        toolId: 'b',
        mode,
        booleanFeatureId: 'op',
        placementFeatureId: 'op-placement',
      });
      const r = await ok(`d1-${mode}`, doc);
      // The target keeps its ID; the tool is consumed and gives no shape of its own.
      expect(Object.keys(r.bodies), mode).toEqual(['a']);
      near(solid(r.bodies.a).volumeMm3, expected[mode]);
    }
  });

  /** A successful evaluation's meshes. */
  const meshesOf = async (id: string, doc: CadDocument) => {
    const result = await evaluate(id, doc);
    if (result.type !== 'result' || result.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(result.type === 'result' ? result.evaluation : result));
    return result.meshes;
  };
  const faceNames = (mesh: CadMesh) =>
    mesh.topology.faces.map((f) => (f.name ? formatFaceName(f.name) : null));
  const edgeNames = (mesh: CadMesh) =>
    mesh.topology.edges.map((_, i) => {
      const name = elementName(mesh.topology, 'edge', i);
      return name ? formatTopoName(name) : null;
    });
  const sortedNames = (names: (string | null)[]) => [...names].sort();

  it('names faces by their recipe and carries them through placement and Booleans (R1b, CAD30)', async () => {
    const [plate] = await meshesOf('r1b-names-f02', f02Plate());
    // The plate is the extruded rectangle; the hole wall comes from the tool body's placement.
    expect(sortedNames(faceNames(plate))).toEqual(
      [
        'end',
        'side:+u',
        'side:+v',
        'side:-u',
        'side:-v',
        'start',
        'tool:hole-placement/side',
      ].sort(),
    );
    const [ring] = await meshesOf('r1b-names-f03', f03Revolve());
    // A full turn has no start or end face.
    expect(sortedNames(faceNames(ring))).toEqual(['side:+u', 'side:+v', 'side:-u', 'side:-v']);
    const [ball] = await meshesOf('r1b-names-sphere', sphere('ball', 3, 0));
    expect(faceNames(ball)).toEqual(['surface']);
    // Every face and edge of a D1 recipe is named, and edges by two faces.
    const [block] = await meshesOf('r1b-names-f12', f12References());
    expect(faceNames(block).every(Boolean)).toBe(true);
    expect(edgeNames(block).every(Boolean)).toBe(true);
    expect(faceNames(block)).toContain('+z');
    expect(faceNames(block)).toContain('tool:a-placement/side');
    expect(faceNames(block)).toContain('tool:b-placement/side');
    // Two equal holes: their rims are told apart by the tool's feature ID.
    const rim = (tool: string): CadTopoName => [['+z'], [`tool:${tool}-placement`, 'side']];
    for (const tool of ['a', 'b'])
      expect(
        resolveTopologyRef(block.topology, {
          kind: 'edge',
          name: rim(tool),
          hint: { centroid: [0, 0, 0], size: 1 },
        }).status,
      ).toBe('resolved');
  }, 120_000);

  it('names the sides of a small polyline far from the origin one by one (R1b, CAD30)', async () => {
    const plate0 = f02Plate();
    const far = applyCadOperation(f01Empty(), {
      type: 'insertFeatures',
      profiles: [
        {
          ...plate0.profiles[0]!,
          shape: {
            type: 'polyline',
            vertices: [
              [900000, 900000],
              [900000.0011, 900000],
              [900000.0011, 900000.0011],
              [900000, 900000.0011],
            ].map(([u, v], i) => ({ id: `v${i}`, u: mm(u!), v: mm(v!) })),
          },
        },
      ],
      features: [
        {
          id: 'plate-extrude',
          name: 'Plate',
          type: 'extrude',
          inputFeatureIds: [],
          args: { profileId: 'plate-profile', distance: mm(5), direction: 1 },
        },
      ],
      bodies: [
        {
          id: 'plate',
          name: 'plate',
          sourceFeatureId: 'plate-extrude',
          placementFeatureId: 'plate-placement',
          appearance: plate0.bodies[0]!.appearance,
        },
      ],
    });
    const [plate] = await meshesOf('r1b-names-far', far);
    expect(sortedNames(faceNames(plate))).toEqual([
      'end',
      'side:v:v0',
      'side:v:v1',
      'side:v:v2',
      'side:v:v3',
      'start',
    ]);
  }, 120_000);

  it('keeps the names when a dimension changes and across evaluations (R1b, CAD30)', async () => {
    const [first] = await meshesOf('r1b-stable-1', f12References());
    const [again] = await meshesOf('r1b-stable-2', f12References());
    expect(again.topology).toEqual(first.topology);
    const taller = applyCadOperation(f12References(), {
      type: 'setParameter',
      parameterId: 'H',
      value: 35,
    });
    const [changed] = await meshesOf('r1b-stable-3', taller);
    expect(sortedNames(faceNames(changed))).toEqual(sortedNames(faceNames(first)));
    expect(sortedNames(edgeNames(changed))).toEqual(sortedNames(edgeNames(first)));
    // The top +y edge is one edge, so a reference made on it resolves after the change.
    const edge: CadTopoName = [['+y'], ['+z']];
    const ref = {
      kind: 'edge' as const,
      name: edge,
      hint: { centroid: [50, 60, 20] as [number, number, number], size: 100 },
    };
    expect(resolveTopologyRef(changed.topology, ref)).toMatchObject({ status: 'resolved' });
    const hit = resolveTopologyRef(changed.topology, ref);
    if (hit.status !== 'resolved') throw new Error('unresolved');
    expect(changed.topology.edges[hit.index]!.centroid[2]).toBeCloseTo(35, 9);
    // A face that no longer exists is missing, never replaced by a nearby one.
    expect(
      resolveTopologyRef(changed.topology, {
        kind: 'face',
        name: [['tool:gone-placement', 'side']],
        hint: { centroid: [30, 30, 10], size: 1 },
      }),
    ).toEqual({ status: 'missing' });
  }, 120_000);

  it('splits an edge into two of one name and selects one by its neighbours (R1b, CAD30)', async () => {
    const [cut] = await meshesOf('r1b-split', f12References({ slot: true }));
    const edge: CadTopoName = [['+y'], ['+z']];
    const halves = candidatesOf(cut.topology, 'edge', edge);
    expect(halves).toHaveLength(2);
    // Nearest the hint first: the hint lies on the left half (x < 45).
    const left = {
      kind: 'edge' as const,
      name: edge,
      hint: { centroid: [20, 60, 20] as [number, number, number], size: 45 },
    };
    const ambiguous = resolveTopologyRef(cut.topology, left);
    if (ambiguous.status !== 'ambiguous') throw new Error(ambiguous.status);
    const chosen = ambiguous.candidates[0]!;
    expect(cut.topology.edges[chosen]!.centroid[0]).toBeCloseTo(22.5, 6);
    const select = selectFor(cut.topology, 'edge', chosen)!;
    expect(select.adjacent.length).toBeGreaterThan(0);
    expect(resolveTopologyRef(cut.topology, { ...left, select })).toEqual({
      status: 'resolved',
      index: chosen,
    });
    // The selection is names only: a taller block evaluates to other indices, same edge.
    const taller = applyCadOperation(f12References({ slot: true }), {
      type: 'setParameter',
      parameterId: 'H',
      value: 35,
    });
    const [changed] = await meshesOf('r1b-split-taller', taller);
    const again = resolveTopologyRef(changed.topology, { ...left, select });
    if (again.status !== 'resolved') throw new Error(again.status);
    expect(changed.topology.edges[again.index]!.centroid[0]).toBeCloseTo(22.5, 6);
  }, 120_000);

  it('fills the pick table: face and edge ids per body, edge polylines on the mesh (R1b, CAD31)', async () => {
    const two = applyCadOperation(f12References(), {
      type: 'insertFeatures',
      features: [
        {
          id: 'extra',
          name: 'extra',
          type: 'box',
          inputFeatureIds: [],
          args: {
            size: [mm(5), mm(5), mm(5)],
            origin: position(200, 0, 0),
            orientation: identityQuaternion(),
          },
        },
      ],
      bodies: [
        {
          id: 'extra-body',
          name: 'extra',
          sourceFeatureId: 'extra',
          placementFeatureId: 'extra-placement',
          appearance: { color: '#9aa4b1', opacity: 1 },
        },
      ],
    });
    const meshes = await meshesOf('r1b-pick', two);
    let faces = 0;
    let edges = 0;
    for (const m of meshes) {
      expect(m.faceBase).toBe(faces);
      expect(m.edgeBase).toBe(edges);
      const faceCount = m.topology.faces.length;
      const edgeCount = m.topology.edges.length;
      for (const id of m.faceIds) expect(id > faces && id <= faces + faceCount).toBe(true);
      expect(m.edges.length).toBe(m.edgeIds.length * 6);
      expect(new Set(m.edgeIds).size).toBe(edgeCount);
      for (const id of m.edgeIds) expect(id > edges && id <= edges + edgeCount).toBe(true);
      faces += faceCount;
      edges += edgeCount;
    }
    // A box: 6 named faces, 12 edges of two faces each, 8 vertices.
    const box = meshes.find((m) => m.bodyId === 'extra-body')!;
    expect(sortedNames(faceNames(box))).toEqual(['+x', '+y', '+z', '-x', '-y', '-z']);
    expect(box.topology.edges).toHaveLength(12);
    expect(box.topology.edges.every((e) => e.faces.length === 2 && e.vertices.length === 2)).toBe(
      true,
    );
    // Edge points lie on the box (relative to the mesh origin).
    for (let i = 0; i < box.edges.length; i += 3) {
      const x = box.edges[i]! + box.origin[0];
      expect(x).toBeGreaterThanOrEqual(200 - 1e-4);
      expect(x).toBeLessThanOrEqual(205 + 1e-4);
    }
  }, 120_000);

  /** The error evaluation of a document that must fail. */
  const failureOf = async (id: string, doc: CadDocument) => {
    const result = await evaluate(id, doc);
    if (result.type !== 'result' || result.evaluation.status !== 'error')
      throw new Error(JSON.stringify(result.type === 'result' ? result.evaluation : result));
    return result.evaluation;
  };
  const volumeOf = async (id: string, doc: CadDocument, bodyId = 'part') => {
    const result = await evaluate(id, doc);
    if (result.type !== 'result' || result.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(result.type === 'result' ? result.evaluation : result));
    return solid(result.evaluation.bodies[bodyId]!).volumeMm3;
  };
  /**
   * The block's volume with the four top edges blended: `edge` is the cross-section one edge
   * removes, `corner` what two blends meeting at a top corner remove twice.
   */
  const blendedBlock = (w: number, h: number, edge: number, corner: number) =>
    w * 60 * h - edge * (2 * w + 120) + 4 * corner;
  // R3: the spandrel (1 − π/4)R² per edge; at a corner the two blends overlap in
  // ∫₀ᴿ (R − √(R² − u²))² du = R³(5/3 − π/2).
  const r3 = { edge: (1 - Math.PI / 4) * 9, corner: 27 * (5 / 3 - Math.PI / 2) };
  const slotNotch = 10 * 10 * 5;
  const withSlot = (doc: CadDocument, slot: F12Slot) =>
    applyCadOperation(doc, { type: 'updateFeature', featureId: 'slot', args: f12SlotArgs(slot) });

  it('fillets the four top edges by reference and names the blends (R1c, CAD30, CAD32)', async () => {
    const doc = f12Fillet();
    const volume = await volumeOf('r1c-fillet', doc);
    expect(volume).toBeCloseTo(blendedBlock(100, 20, r3.edge, r3.corner) - slotNotch, 3);
    const [part] = await meshesOf('r1c-fillet-names', doc);
    const blends = faceNames(part).filter((n) => n?.startsWith('blend:'));
    expect(blends.sort()).toEqual(
      ['+x | +z', '+z | -x', '+y | +z', '+z | -y'].map((e) => `blend:(${e})`).sort(),
    );
    // The faces the fillet trims keep their names.
    expect(faceNames(part)).toContain('+z');
    expect(faceNames(part)).toContain('tool:s-placement/-y');
    // Again and with a taller block: the same names, and the references still resolve.
    const [again] = await meshesOf('r1c-fillet-again', doc);
    expect(again.topology).toEqual(part.topology);
    const taller = applyCadOperation(doc, { type: 'setParameter', parameterId: 'H', value: 30 });
    expect(await volumeOf('r1c-fillet-taller', taller)).toBeCloseTo(
      blendedBlock(100, 30, r3.edge, r3.corner) - slotNotch,
      3,
    );
  }, 120_000);

  it('refuses a fillet the kernel cannot build, naming its edges (R1c, CAD32)', async () => {
    const doc = f12Fillet();
    const fillet = doc.features.find((f) => f.id === 'fillet')!;
    const big = applyCadOperation(doc, {
      type: 'updateFeature',
      featureId: 'fillet',
      args: { ...(fillet.args as object), radius: mm(40) } as never,
    });
    const failure = await failureOf('r1c-fillet-big', big);
    expect(failure).toMatchObject({ code: 'fillet-failed', featureId: 'fillet' });
    expect(failure.failedPaths?.length).toBeGreaterThan(0);
    for (const path of failure.failedPaths!) expect(path[0]).toBe('edges');
  }, 120_000);

  it('shows the bodies outside a failure and the failed body before it (CM-2, U4)', async () => {
    const doc = f12Fillet();
    const fillet = doc.features.find((f) => f.id === 'fillet')!;
    let big = applyCadOperation(doc, {
      type: 'updateFeature',
      featureId: 'fillet',
      args: { ...(fillet.args as object), radius: mm(40) } as never,
    });
    const ball = sphere('ball', 10, 300);
    big = applyCadOperation(big, {
      type: 'insertFeatures',
      features: ball.features.filter((f) => f.id === 'ball'),
      bodies: [
        {
          id: 'ball-body',
          name: 'ball',
          sourceFeatureId: 'ball',
          placementFeatureId: 'ball-placement',
          appearance: { color: '#9aa4b1', opacity: 1 },
        },
      ],
    });
    const result = await evaluate('cm2-partial', big);
    if (result.type !== 'result' || result.evaluation.status !== 'error')
      throw new Error(JSON.stringify(result));
    // The same failure as before, first in evaluation order.
    expect(result.evaluation).toMatchObject({ code: 'fillet-failed', featureId: 'fillet' });
    // The sphere is evaluated as in an ok result; the failed part has no measurement.
    expect(Object.keys(result.evaluation.partial!)).toEqual(['ball-body']);
    expect(solid(result.evaluation.partial!['ball-body']!).volumeMm3).toBeCloseTo(
      (4 / 3) * Math.PI * 1000,
      0,
    );
    const [ballMesh, before] = [
      result.meshes.find((m) => m.bodyId === 'ball-body')!,
      result.meshes.find((m) => m.bodyId === 'part')!,
    ];
    expect(ballMesh.beforeFailure).toBeUndefined();
    expect(ballMesh.faceIds.length).toBeGreaterThan(0);
    // The part before the fillet: triangles only, no pick table.
    // Named by the body's own failed feature.
    expect(before.beforeFailure).toBe('fillet');
    expect(before.indices.length).toBeGreaterThan(0);
    expect(before.faceIds.length).toBe(0);
    expect(before.topology.faces).toEqual([]);
    expect(result.meshes).toHaveLength(2);
    // An export triangulation shows nothing of a failed document.
    const exported = await evaluate('cm2-partial-export', big, 0.1);
    if (exported.type !== 'result') throw new Error(exported.type);
    expect(exported.evaluation).toMatchObject({ status: 'error', code: 'fillet-failed' });
    expect('partial' in exported.evaluation).toBe(false);
    expect(exported.meshes).toEqual([]);
    // A substitute build's reference display gives no measurement, not even outside a failure.
    const document = pinned(big);
    await handle({
      type: 'evaluate',
      requestId: 'cm2-partial-reference',
      generation: 1,
      baseHash: '',
      candidateHash: cadContentHash(document),
      document,
      reference: true,
    });
    const referenced = posted.find(
      (m) => 'requestId' in m && m.requestId === 'cm2-partial-reference' && m.type !== 'progress',
    )!;
    if (referenced.type !== 'result') throw new Error(referenced.type);
    expect(referenced.evaluation).toMatchObject({ status: 'error', code: 'fillet-failed' });
    expect('partial' in referenced.evaluation).toBe(false);
    expect(referenced.meshes).toEqual([]);
  }, 120_000);

  it('fails an upstream edit that splits or removes a referenced edge, listing candidates (R1c, CAD30)', async () => {
    const split = await failureOf('r1c-split', withSlot(f12Fillet(), 'split'));
    expect(split).toMatchObject({ code: 'reference-ambiguous', featureId: 'fillet' });
    expect(split.references).toHaveLength(1);
    const [problem] = split.references!;
    expect(problem).toMatchObject({ featureId: 'fillet', path: ['edges', 2], status: 'ambiguous' });
    // Two halves, nearest the stored hint (the edge's middle, x = 50) first; each one can be
    // picked by its neighbours' names.
    expect(problem!.candidates).toHaveLength(2);
    for (const c of problem!.candidates) expect(c.ref?.select?.adjacent.length).toBeGreaterThan(0);
    const removed = await failureOf('r1c-remove', withSlot(f12Fillet(), 'remove'));
    expect(removed).toMatchObject({ code: 'reference-missing', featureId: 'fillet' });
    expect(removed.references).toEqual([
      { featureId: 'fillet', path: ['edges', 2], status: 'missing', candidates: [] },
    ]);
  }, 120_000);

  it('adopts a split edge chosen again with the upstream edit, and keeps it (R1c, CAD30)', async () => {
    const split = withSlot(f12Fillet(), 'split');
    const failure = await failureOf('r1c-rebind-fail', split);
    const left = failure.references![0]!.candidates.find((c) => c.hint.centroid[0] < 45)!;
    const rebound = applyCadOperation(f12Fillet(), {
      type: 'rebindReferences',
      edit: { type: 'updateFeature', featureId: 'slot', args: f12SlotArgs('split') },
      bindings: [{ featureId: 'fillet', path: ['edges', 2], ref: left.ref! }],
    });
    const volume = await volumeOf('r1c-rebind', rebound);
    // Only the left half of the +y top edge is blended: (1 − π/4)R² × 45, one corner shared.
    const notch = 10 * 10 * 10;
    const halfEdge = r3.edge * (100 - 45);
    expect(volume).toBeCloseTo(
      blendedBlock(100, 20, r3.edge, r3.corner) + halfEdge - r3.corner - notch,
      0,
    );
    // Names only: a taller block, a JSON round trip, the same edge.
    const taller = applyCadOperation(JSON.parse(JSON.stringify(rebound)), {
      type: 'setParameter',
      parameterId: 'H',
      value: 30,
    });
    expect(await volumeOf('r1c-rebind-taller', taller)).toBeGreaterThan(0);
    const [part] = await meshesOf('r1c-rebind-names', taller);
    expect(faceNames(part).filter((n) => n === 'blend:(+y | +z)')).toHaveLength(1);
  }, 120_000);

  it('fillets one of two equal holes cut by one Boolean, whatever the tool order (R1c, CAD30)', async () => {
    const block = 100 * 60 * 20 - 2 * Math.PI * 36 * 20;
    const volume = await volumeOf('r1c-holes', f12Holes());
    // Pappus: the R1 spandrel (1 − π/4) swept round the hole at its centroid's radius.
    const spandrel = (1 - Math.PI / 4) * 1;
    const centroid = 6 + (10 - 3 * Math.PI) / (3 * (4 - Math.PI));
    expect(volume).toBeCloseTo(block - 2 * Math.PI * centroid * spandrel, 2);
    const [part] = await meshesOf('r1c-holes-names', f12Holes());
    expect(faceNames(part)).toContain('blend:(+z | tool:a-placement/side)');
    expect(faceNames(part)).toContain('tool:b-placement/side');
    // The tools in the other order: the same result and names.
    const [swapped] = await meshesOf('r1c-holes-swapped', f12Holes(['b', 'a']));
    expect(sortedNames(faceNames(swapped))).toEqual(sortedNames(faceNames(part)));
    expect(await volumeOf('r1c-holes-swapped-v', f12Holes(['b', 'a']))).toBeCloseTo(volume, 6);
    // Tool b taken out (it is a body again), the fillet still finds the rim of hole a.
    const one = applyCadOperation(f12Holes(), {
      type: 'setBooleanTools',
      featureId: 'holes',
      toolIds: ['a'],
    });
    expect(await volumeOf('r1c-holes-one', one)).toBeCloseTo(volume + Math.PI * 36 * 20, 2);
    expect(await volumeOf('r1c-holes-one-b', one, 'b')).toBeCloseTo(Math.PI * 36 * 22, 2);
  }, 120_000);

  it('names a face two tools share by both, whatever their order or IDs (R1c, CAD30)', async () => {
    // Both tools cut the same hole: its wall is an image of both tools' sides, and the fillet
    // rounds its rim by that shared name.
    const wall = sharedFaceName([
      ['tool:a-placement', 'side'],
      ['tool:b-placement', 'side'],
    ]);
    const same = (tools: ('a' | 'b')[]) => {
      const doc = f12Holes(tools);
      for (const f of doc.features) {
        if (f.id === 'cyl-b' && f.type === 'cylinder') f.args.origin = [mm(30), mm(30), mm(-1)];
        if (f.type === 'fillet') f.args.edges[0]!.name = edgeName(['+z'], wall);
      }
      return doc;
    };
    const [ab] = await meshesOf('r1c-shared-ab', same(['a', 'b']));
    const [ba] = await meshesOf('r1c-shared-ba', same(['b', 'a']));
    expect(sortedNames(faceNames(ba))).toEqual(sortedNames(faceNames(ab)));
    expect(faceNames(ab)).toContain('shared:(tool:a-placement/side | tool:b-placement/side)');
    // New IDs that sort the other way round still name the copied wall as its reference does.
    const doc = same(['a', 'b']);
    const { ids } = duplicateClosureOf(doc, ['part']);
    const fresh: Record<string, string> = { 'a-placement': 'z-copy', 'b-placement': 'a-copy' };
    const idMap = Object.fromEntries(ids.map((id) => [id, fresh[id] ?? `copy-${id}`]));
    const copy = applyCadOperation(doc, { type: 'duplicateClosure', bodyIds: ['part'], idMap });
    expect(await volumeOf('r1c-shared-copy', copy, 'copy-part')).toBeCloseTo(
      await volumeOf('r1c-shared-original', doc),
      6,
    );
  }, 120_000);

  it('evaluates a duplicated polyline body with its fillet (R1c, CAD30)', async () => {
    const doc = polylineFillet();
    const { ids } = duplicateClosureOf(doc, ['slab']);
    const idMap = Object.fromEntries(ids.map((id) => [id, `copy-${id}`]));
    const copy = applyCadOperation(doc, { type: 'duplicateClosure', bodyIds: ['slab'], idMap });
    const result = await evaluate('r1c-duplicate', copy);
    if (result.type !== 'result' || result.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(result.type === 'result' ? result.evaluation : result));
    const { slab, 'copy-slab': twin } = result.evaluation.bodies;
    expect(solid(twin!).volumeMm3).toBeCloseTo(solid(slab!).volumeMm3, 9);
    expect(solid(slab!).volumeMm3).toBeLessThan(6000);
  }, 120_000);

  const withParameter = (doc: CadDocument, parameterId: string, value: number) =>
    applyCadOperation(doc, { type: 'setParameter', parameterId, value });

  it('patterns a hole along a row and around a circle, named by copy (R1c, CAD32)', async () => {
    const linear = f14Patterns('linear');
    expect(await volumeOf('r1c-row', linear)).toBeCloseTo(24_000 - 6 * Math.PI * 16 * 5, 3);
    const [row] = await meshesOf('r1c-row-names', linear);
    expect(sortedNames(faceNames(row!))).toEqual(
      sortedNames([
        ...['+x', '+y', '+z', '-x', '-y', '-z'],
        ...[0, 1, 2, 3, 4, 5].map((i) => `copy:row:${i}/side`),
      ]),
    );
    // The count and the spacing follow their parameters: four holes, (120 − 20) / 3 apart.
    expect(await volumeOf('r1c-row-4', withParameter(linear, 'n', 4))).toBeCloseTo(
      24_000 - 4 * Math.PI * 16 * 5,
      3,
    );
    const circular = f14Patterns('circular');
    expect(await volumeOf('r1c-circle', circular)).toBeCloseTo(50_000 - 8 * Math.PI * 9 * 5, 3);
    const [ring] = await meshesOf('r1c-circle-names', circular);
    expect(faceNames(ring!).filter((n) => n?.startsWith('copy:'))).toHaveLength(8);
    // A full-turn step puts both copies in one place: they share the hole's wall (`shared:`),
    // and each still cuts, so the pattern is one hole and no copy is refused.
    const twin = structuredClone(circular);
    const step = twin.features.find((f) => f.id === 'row')!;
    if (step.type !== 'pattern' || step.args.layout.type !== 'circular') throw new Error('fixture');
    step.args.layout.count = { literal: 2 };
    step.args.layout.angle = { literalRad: 2 * Math.PI };
    expect(await volumeOf('r1c-circle-twin', twin)).toBeCloseTo(50_000 - Math.PI * 9 * 5, 3);
  }, 120_000);

  it('keeps a reference to one copy of a later pattern through edits of the earlier (R1c, CAD30)', async () => {
    const twice = f14Patterns('twice');
    const unfilleted = 24_000 - 9 * Math.PI * 16 * 5;
    // Pappus: the R1 spandrel (1 − π/4) at 4 + R(10 − 3π) / (3(4 − π)) from the hole axis.
    const rim = 2 * Math.PI * (4 + (10 - 3 * Math.PI) / (3 * (4 - Math.PI))) * (1 - Math.PI / 4);
    expect(await volumeOf('r1c-twice', twice)).toBeCloseTo(unfilleted - rim, 3);
    // Fewer holes in the first row leave the second row's copy 1 and its fillet as they are.
    expect(await volumeOf('r1c-twice-n', withParameter(twice, 'n', 3))).toBeCloseTo(
      24_000 - 6 * Math.PI * 16 * 5 - rim,
      3,
    );
    // Two copies in the second row still have copy 1; one copy has no copy 1 left to round.
    expect(await volumeOf('r1c-twice-n2', withParameter(twice, 'n2', 2))).toBeCloseTo(
      24_000 - 8 * Math.PI * 16 * 5 - rim,
      3,
    );
    const gone = await failureOf('r1c-twice-gone', withParameter(twice, 'n2', 1));
    expect(gone).toMatchObject({ code: 'reference-missing', featureId: 'rim' });
    // A copy past the plate cuts nothing, which the pattern refuses like a Boolean (F04).
    const past = await failureOf('r1c-twice-past', withParameter(twice, 'n2', 4));
    expect(past).toMatchObject({ code: 'pattern-no-overlap', featureId: 'row-2' });
    // A duplicate names its copies by its own pattern IDs, as its copied reference does.
    const { ids } = duplicateClosureOf(twice, ['part']);
    const idMap = Object.fromEntries(ids.map((id) => [id, `copy-${id}`]));
    const copy = applyCadOperation(twice, { type: 'duplicateClosure', bodyIds: ['part'], idMap });
    expect(await volumeOf('r1c-twice-copy', copy, 'copy-part')).toBeCloseTo(unfilleted - rim, 3);
  }, 120_000);

  it('mirrors a block twice into one body, naming the mirrored faces (R1c, CAD32)', async () => {
    const doc = f14Patterns('mirror');
    expect(await volumeOf('r1c-mirror', doc)).toBeCloseTo(4 * 40 * 30 * 10, 3);
    const [first] = await meshesOf('r1c-mirror-names', doc);
    const [again] = await meshesOf('r1c-mirror-again', doc);
    const names = faceNames(first!);
    expect(names).not.toContain(null);
    expect(names).toEqual(expect.arrayContaining(['+x', 'mirror:m1/+x', 'mirror:m2/mirror:m1/+x']));
    expect(faceNames(again!)).toEqual(names);
    // About a face of the block: its +x face, so the union is twice as long.
    const about = structuredClone(doc);
    const m1 = about.features.find((f) => f.id === 'm1')!;
    if (m1.type !== 'mirror') throw new Error('fixture');
    m1.args.plane = { face: faceRef('part-placement', ['+x'], [40, 15, 5], 300) };
    expect(await volumeOf('r1c-mirror-face', about)).toBeCloseTo(4 * 40 * 30 * 10, 3);
    const [faced] = await meshesOf('r1c-mirror-face-names', about);
    expect(faceNames(faced!)).toContain('mirror:m1/-x');
    expect(faceNames(faced!)).not.toContain('+x');
    // A curved face has no plane to mirror about.
    let round = applyCadOperation(f01Empty(), {
      type: 'insertFeatures',
      features: [
        {
          id: 'rod',
          name: 'Rod',
          type: 'cylinder',
          inputFeatureIds: [],
          args: {
            radius: mm(5),
            height: mm(10),
            origin: position(0, 0, 0),
            orientation: identityQuaternion(),
          },
        },
      ],
      bodies: [
        {
          id: 'part',
          name: 'part',
          sourceFeatureId: 'rod',
          placementFeatureId: 'rod-placement',
          appearance: { color: '#9aa4b1', opacity: 1 },
        },
      ],
    });
    round = applyCadOperation(round, {
      type: 'detailBody',
      bodyId: 'part',
      placementFeatureId: 'flip-placement',
      feature: {
        id: 'flip',
        name: 'Flip',
        type: 'mirror',
        inputFeatureIds: ['rod-placement'],
        args: {
          plane: { face: faceRef('rod-placement', ['side'], [0, 0, 5], 100 * Math.PI) },
          union: true,
        },
      },
    });
    // A cylinder's cap is planar though it has one vertex: the rod mirrored about its bottom.
    const capped = structuredClone(round);
    const flip = capped.features.find((f) => f.id === 'flip')!;
    if (flip.type !== 'mirror') throw new Error('fixture');
    flip.args.plane = { face: faceRef('rod-placement', ['bottom'], [0, 0, 0], 25 * Math.PI) };
    expect(await volumeOf('r1c-mirror-cap', capped)).toBeCloseTo(2 * Math.PI * 25 * 10, 3);
    expect(await failureOf('r1c-mirror-curved', round)).toMatchObject({
      code: 'mirror-face-not-planar',
      featureId: 'flip',
      failedPaths: [['plane', 'face']],
    });
  }, 120_000);

  it('chamfers edges by one distance, or two from a face (R1c, CAD32)', async () => {
    const base = f12Fillet();
    const fillet = base.features.find((f) => f.id === 'fillet')!;
    const edges = (fillet.args as { edges: unknown[] }).edges;
    const chamfer = (args: object) => {
      const doc = structuredClone(base);
      const i = doc.features.findIndex((f) => f.id === 'fillet');
      doc.features[i] = { ...doc.features[i]!, type: 'chamfer', args } as never;
      return doc;
    };
    const one = await volumeOf('r1c-chamfer', chamfer({ edges, distance: mm(2) }));
    // d²/2 per edge; two chamfers meeting at a corner overlap in d³/3.
    expect(one).toBeCloseTo(blendedBlock(100, 20, 2, 8 / 3) - slotNotch, 3);
    const top = {
      kind: 'face',
      featureId: 'cut-s-placement',
      name: [['+z']],
      hint: { centroid: [50, 30, 20], size: 6000 },
    };
    const two = await volumeOf(
      'r1c-chamfer-two',
      chamfer({ edges, distance: mm(2), distance2: mm(4), face: top }),
    );
    // d along the top face and d₂ down the sides: d·d₂/2 per edge, d²·d₂/3 per corner.
    expect(two).toBeCloseTo(blendedBlock(100, 20, 4, 16 / 3) - slotNotch, 3);
    const side = { ...top, name: [['-x']], hint: { centroid: [0, 30, 10], size: 1200 } };
    const apart = await failureOf(
      'r1c-chamfer-apart',
      chamfer({ edges, distance: mm(2), distance2: mm(4), face: side }),
    );
    expect(apart).toMatchObject({ code: 'chamfer-face-not-adjacent', featureId: 'fillet' });
    expect(apart.failedPaths).toEqual([
      ['edges', 0],
      ['edges', 2],
      ['edges', 3],
    ]);
  }, 120_000);

  it('shells a block to a 2 mm wall with the top open, drafted or not (R1c, CAD32)', async () => {
    const plain = f13ShellDraft({ draft: false });
    expect(await volumeOf('r1c-shell', plain)).toBeCloseTo(100 * 60 * 20 - 96 * 56 * 18, 6);
    const [part] = await meshesOf('r1c-shell-names', plain);
    // Each wall's inner face is named by the outer face it is offset from; the open top is gone
    // except its rim, which keeps the top's name.
    expect(sortedNames(faceNames(part))).toEqual(
      [
        '+x',
        '-x',
        '+y',
        '-y',
        '+z',
        '-z',
        'inner/+x',
        'inner/-x',
        'inner/+y',
        'inner/-y',
        'inner/-z',
      ].sort(),
    );
    // A thicker wall follows the parameter.
    const thick = applyCadOperation(plain, { type: 'setParameter', parameterId: 'T', value: 5 });
    expect(await volumeOf('r1c-shell-thick', thick)).toBeCloseTo(100 * 60 * 20 - 90 * 50 * 15, 6);
    // Drafted 3° from the bottom: each side leans in by z·tan 3°; the wall is 2 mm thick across
    // the leaning faces, so the cavity is inset 2 / cos 3° along the floor.
    const k = Math.tan((3 * Math.PI) / 180);
    const inset = 2 / Math.cos((3 * Math.PI) / 180);
    const section = (z: number, w: number, d: number) => (w - 2 * k * z) * (d - 2 * k * z);
    // Simpson's rule is exact on a quadratic section.
    const integral = (f: (z: number) => number, a: number, b: number) =>
      ((b - a) / 6) * (f(a) + 4 * f((a + b) / 2) + f(b));
    const outer = integral((z) => section(z, 100, 60), 0, 20);
    // The draft alone: the body's result moved back to the draft's placement.
    const draftOnly = f13ShellDraft();
    draftOnly.features = draftOnly.features.filter(
      (f) => !['shell', 'shell-placement'].includes(f.id),
    );
    draftOnly.bodies[0]!.resultFeatureId = 'draft-placement';
    expect(await volumeOf('r1c-draft', draftOnly)).toBeCloseTo(outer, 6);
    const cavity = integral((z) => section(z, 100 - 2 * inset, 60 - 2 * inset), 2, 20);
    expect(await volumeOf('r1c-shell-draft', f13ShellDraft())).toBeCloseTo(outer - cavity, 3);
  }, 120_000);

  it('refuses a draft about a face off its neutral plane, and a shell too thick (R1c, CAD32)', async () => {
    const tilted = f13ShellDraft();
    const draft = tilted.features.find((f) => f.id === 'draft')!;
    if (draft.type !== 'draft') throw new Error('fixture');
    // The +x side is not normal to the pull direction +z.
    draft.args.neutral = { ...draft.args.neutral, name: [['+x']] };
    expect(await failureOf('r1c-draft-neutral', tilted)).toMatchObject({
      code: 'draft-neutral-plane',
      featureId: 'draft',
      failedPaths: [['neutral']],
    });
    const thick = applyCadOperation(f13ShellDraft({ draft: false }), {
      type: 'setParameter',
      parameterId: 'T',
      value: 40,
    });
    expect(await failureOf('r1c-shell-too-thick', thick)).toMatchObject({ featureId: 'shell' });
    // A cap's one vertex lies in any plane through it; its surface does not.
    const cap = rodDraft([0, 1, 0]);
    expect(await failureOf('r1c-draft-cap', cap)).toMatchObject({
      code: 'draft-neutral-plane',
      failedPaths: [['neutral']],
    });
  }, 120_000);

  /** A r10 × 20 rod whose side is drafted 3° about its bottom cap, pulled along `direction`. */
  const rodDraft = (direction: [number, number, number]) =>
    applyCadOperation(
      applyCadOperation(f01Empty(), {
        type: 'insertFeatures',
        features: [
          {
            id: 'rod',
            name: 'Rod',
            type: 'cylinder',
            inputFeatureIds: [],
            args: {
              radius: mm(10),
              height: mm(20),
              origin: position(0, 0, 0),
              orientation: identityQuaternion(),
            },
          },
        ],
        bodies: [
          {
            id: 'part',
            name: 'part',
            sourceFeatureId: 'rod',
            placementFeatureId: 'rod-placement',
            appearance: { color: '#9aa4b1', opacity: 1 },
          },
        ],
      }),
      {
        type: 'detailBody',
        bodyId: 'part',
        placementFeatureId: 'taper-placement',
        feature: {
          id: 'taper',
          name: 'Taper',
          type: 'draft',
          inputFeatureIds: ['rod-placement'],
          args: {
            faces: [faceRef('rod-placement', ['side'], [0, 0, 10], 400 * Math.PI)],
            neutral: faceRef('rod-placement', ['bottom'], [0, 0, 0], 100 * Math.PI),
            angle: { literalRad: (3 * Math.PI) / 180 },
            direction,
          },
        },
      },
    );

  it('drafts a rod about its cap, and shells a block with no face open (R1c, CAD32)', async () => {
    // A frustum: the side leans in by 20 · tan 3° over the height.
    const top = 10 - 20 * Math.tan((3 * Math.PI) / 180);
    expect(await volumeOf('r1c-draft-rod', rodDraft([0, 0, 1]))).toBeCloseTo(
      ((Math.PI * 20) / 3) * (100 + 10 * top + top * top),
      3,
    );
    // Closed: the outside stays, an enclosed cavity 2 mm in (or the body becomes the cavity).
    const closed = (side: 'inside' | 'outside') => {
      const doc = f13ShellDraft({ draft: false });
      const shell = doc.features.find((f) => f.id === 'shell')!;
      if (shell.type !== 'shell') throw new Error('fixture');
      shell.args.openFaces = [];
      shell.args.side = side;
      return doc;
    };
    expect(await volumeOf('r1c-shell-closed', closed('inside'))).toBeCloseTo(
      100 * 60 * 20 - 96 * 56 * 16,
      6,
    );
    const [hollow] = await meshesOf('r1c-shell-closed-names', closed('inside'));
    expect(sortedNames(faceNames(hollow!))).toEqual(
      ['+x', '-x', '+y', '-y', '+z', '-z'].flatMap((n) => [n, `inner/${n}`]).sort(),
    );
    // Open at the top and outside: the wall grows out of the sides and the bottom.
    const out = f13ShellDraft({ draft: false });
    const shell = out.features.find((f) => f.id === 'shell')!;
    if (shell.type !== 'shell') throw new Error('fixture');
    shell.args.side = 'outside';
    expect(await volumeOf('r1c-shell-out', out)).toBeCloseTo(104 * 64 * 22 - 100 * 60 * 20, 3);
    expect(await volumeOf('r1c-shell-closed-out', closed('outside'))).toBeCloseTo(
      104 * 64 * 24 - 100 * 60 * 20,
      3,
    );
  }, 120_000);

  it('extrudes the F11 sketch region with its holes, either way round (R1d, CAD33)', async () => {
    const result = await evaluate('r1d-f11', f11Bracket());
    if (result.type !== 'result' || result.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(result));
    const { bracket } = result.evaluation.bodies;
    // The L with its inner arc, less two 4 mm holes, 10 mm deep (D).
    expect(Math.abs(solid(bracket!).volumeMm3 - f11Area() * 10)).toBeLessThanOrEqual(
      1e-7 * f11Area() * 10,
    );
    expect(bracket!.bounds[0].map((x) => Math.round(x * 1e6) / 1e6 + 0)).toEqual([0, 0, 0]);
    expect(bracket!.bounds[1].map((x) => Math.round(x * 1e6) / 1e6)).toEqual([100, 80, 10]);
    const [mesh] = result.meshes;
    // Every side is named by its sketch element; element IDs are the sketch's own.
    expect(sortedNames(faceNames(mesh!))).toEqual(
      [
        'end',
        'start',
        ...['l0', 'l1', 'l2', 'a0', 'l3', 'l4', 'l5', 'h1', 'h2'].map((e) => `side:e:${e}`),
      ].sort(),
    );
    expect(edgeNames(mesh!).every(Boolean)).toBe(true);
    // The outer loop listed clockwise and a hole counter-clockwise give the same solid.
    const turned = structuredClone(f11Bracket());
    const args = turned.features[0]!.args as { region: ReturnType<typeof f11Region> };
    args.region = { outer: [...f11Region().outer].reverse(), holes: f11Region().holes };
    const again = await evaluate('r1d-f11-turned', turned);
    if (again.type !== 'result' || again.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(again));
    expect(solid(again.evaluation.bodies.bracket!).volumeMm3).toBeCloseTo(
      solid(bracket!).volumeMm3,
      6,
    );
    // A wider bracket after a parameter change: the stored coordinates are solved again.
    const wide = await evaluate(
      'r1d-f11-wide',
      applyCadOperation(f11Bracket(), { type: 'setParameter', parameterId: 'W', value: 120 }),
    );
    if (wide.type !== 'result' || wide.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(wide));
    expect(solid(wide.evaluation.bodies.bracket!).volumeMm3).toBeCloseTo(f11Area(120) * 10, 4);
  }, 120_000);

  it('revolves a sketch region about an axis beside it (R1d, CAD33)', async () => {
    const doc = structuredClone(f11Bracket());
    const f = doc.features[0]!;
    // A quarter turn about the line u = −10: its start and end faces and every side are named.
    Object.assign(f, {
      type: 'revolve',
      args: {
        sketchId: 'bracket-sketch',
        region: f11Region(),
        axisOrigin: [mm(-10), mm(0)],
        axisDirection: [0, 1],
        angle: { literalRad: Math.PI / 2 },
      },
    });
    const result = await evaluate('r1d-revolve', doc);
    if (result.type !== 'result' || result.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(result));
    const [mesh] = result.meshes;
    expect(sortedNames(faceNames(mesh!))).toEqual(
      [
        'end',
        'start',
        ...['l0', 'l1', 'l2', 'a0', 'l3', 'l4', 'l5', 'h1', 'h2'].map((e) => `side:e:${e}`),
      ].sort(),
    );
  }, 120_000);

  it('attaches a sketch to a face of a plate and follows the face (R1d, CAD33)', async () => {
    const top = await evaluate('r1d-on-plate', f11OnPlate('+z'));
    if (top.type !== 'result' || top.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(top));
    const round = (v: number[]) => v.map((x) => Math.round(x * 1e6) / 1e6 + 0);
    // On the +z face (z = 10) the sketch's u, v are the world X, Y; the bracket rises from it.
    expect(round(top.evaluation.bodies.bracket!.bounds[0])).toEqual([0, 0, 10]);
    expect(round(top.evaluation.bodies.bracket!.bounds[1])).toEqual([100, 80, 20]);
    // A thicker plate moves the face, and the sketch with it.
    const thick = await evaluate(
      'r1d-on-plate-thick',
      applyCadOperation(f11OnPlate('+z'), { type: 'setParameter', parameterId: 'P', value: 15 }),
    );
    if (thick.type !== 'result' || thick.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(thick));
    expect(round(thick.evaluation.bodies.bracket!.bounds[0])).toEqual([0, 0, 15]);
    // An offset lifts it off the face.
    const lifted = structuredClone(f11OnPlate('+z'));
    (lifted.sketches[0]!.plane as { offset: unknown }).offset = mm(2);
    const off = await evaluate('r1d-on-plate-offset', lifted);
    if (off.type !== 'result' || off.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(off));
    expect(round(off.evaluation.bodies.bracket!.bounds[0])).toEqual([0, 0, 12]);
    // On the +y side face, seen from outside: u along −X, v up Z, extruded outward (+y).
    const side = await evaluate('r1d-on-plate-side', f11OnPlate('+y'));
    if (side.type !== 'result' || side.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(side));
    expect(round(side.evaluation.bodies.bracket!.bounds[0])).toEqual([-100, 120, 0]);
    expect(round(side.evaluation.bodies.bracket!.bounds[1])).toEqual([0, 130, 80]);
    expect(solid(side.evaluation.bodies.bracket!).volumeMm3).toBeCloseTo(f11Area() * 10, 4);
  }, 120_000);

  it('refuses an attachment whose face is missing or not planar, by the sketch (R1d, CAD33)', async () => {
    const missing = structuredClone(f11OnPlate('+z'));
    (missing.sketches[0]!.plane as { face: { name: unknown } }).face.name = [['+w']];
    const a = await evaluate('r1d-attach-missing', missing);
    if (a.type !== 'result') throw new Error(JSON.stringify(a));
    expect(a.evaluation).toMatchObject({
      status: 'error',
      code: 'reference-missing',
      featureId: 'bracket-sketch',
      references: [{ featureId: 'bracket-sketch', path: ['plane', 'face'], status: 'missing' }],
    });
    const round = applyCadOperation(f01Empty(), {
      type: 'insertFeatures',
      parameters: [],
      features: [
        {
          id: 'rod',
          name: 'Rod',
          type: 'cylinder',
          inputFeatureIds: [],
          args: {
            radius: mm(20),
            height: mm(10),
            origin: position(0, 0, 0),
            orientation: identityQuaternion(),
          },
        },
      ],
      bodies: [
        {
          id: 'rod-body',
          name: 'Rod',
          sourceFeatureId: 'rod',
          placementFeatureId: 'rod-placement',
          appearance: { color: '#9aa4b1', opacity: 1 },
        },
      ],
    });
    const curved = structuredClone(f11Bracket());
    curved.parameters.push(...round.parameters);
    curved.features.push(...round.features);
    curved.bodies.push(...round.bodies);
    curved.sketches[0]!.plane = {
      face: faceRef('rod-placement', ['side'], [0, 0, 5], 400 * Math.PI),
      offset: mm(0),
    };
    const b = await evaluate('r1d-attach-curved', curved);
    if (b.type !== 'result') throw new Error(JSON.stringify(b));
    expect(b.evaluation).toMatchObject({
      status: 'error',
      code: 'sketch-face-not-planar',
      featureId: 'bracket-sketch',
      failedPaths: [['plane', 'face']],
    });
  }, 120_000);

  /** The evaluation of `doc`, which must succeed. */
  const evaluated = async (id: string, doc: CadDocument) => {
    const result = await evaluate(id, doc);
    if (result.type !== 'result' || result.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(result));
    return { evaluation: result.evaluation, mesh: result.meshes[0]! };
  };
  const rounded = (v: readonly number[]) => v.map((x) => Math.round(x * 1e6) / 1e6 + 0);

  it('lofts five closed spline sections whose wire matching OCCT refuses (ST-89)', async () => {
    // OCCT's matching throws SameNumberByPolarMethod for these five; each has one edge, so the
    // loft is built without it: ruled, it is the two halves exactly.
    const five = await evaluated('st89-wing-five', f15Wing('five'));
    const half = await evaluated('st89-wing-half', f15Wing('half'));
    const volume = solid(five.evaluation.bodies.wing!).volumeMm3;
    expect(volume / (2 * solid(half.evaluation.bodies.wing!).volumeMm3)).toBeCloseTo(1, 6);
    // Side faces keep the first section's element name.
    expect(new Set(five.mesh.topology.faces.map((f) => JSON.stringify(f.name)))).toContain(
      JSON.stringify(['side:e:s']),
    );
  });

  it('lofts F15 from a square to a smaller square or a circle (R1e, CAD35)', async () => {
    // Ruled between squares: a frustum of 50/3 × (1600 + 400 + 800) mm³.
    const frustum = await evaluated('r1e-loft-square', f15Loft('square'));
    expect(solid(frustum.evaluation.bodies.loft!).volumeMm3).toBeCloseTo((50 / 3) * 2800, 4);
    expect(sortedNames(faceNames(frustum.mesh))).toEqual(
      ['end', 'start', ...['l0', 'l1', 'l2', 'l3'].map((e) => `side:e:${e}`)].sort(),
    );
    expect(edgeNames(frustum.mesh).every(Boolean)).toBe(true);
    // Smooth from the square to the circle: between the circle's and the square's prisms, every
    // face named by the first section (one square side meets the circle's seam and is split).
    const circle = await evaluated('r1e-loft-circle', f15Loft());
    const body = circle.evaluation.bodies.loft!;
    expect(solid(body).volumeMm3).toBeGreaterThan(Math.PI * 225 * 50);
    expect(solid(body).volumeMm3).toBeLessThan(1600 * 50);
    expect(rounded(body.bounds[1])).toEqual([20, 20, 50]);
    expect(new Set(faceNames(circle.mesh))).toEqual(
      new Set(['start', 'end', ...['l0', 'l1', 'l2', 'l3'].map((e) => `side:e:${e}`)]),
    );
    expect(edgeNames(circle.mesh).every(Boolean)).toBe(true);
    // Two sections in one plane enclose nothing.
    const flat = structuredClone(f15Loft('square'));
    flat.sketches[1]!.plane = { origin: position(0, 0, 0), orientation: identityQuaternion() };
    const failed = await evaluate('r1e-loft-flat', flat);
    expect(failed.type === 'result' && failed.evaluation).toMatchObject({
      status: 'error',
      code: 'loft-failed',
      featureId: 'loft-feature',
    });
  }, 120_000);

  it('sweeps the F15 circle along a line and an arc, and refuses a path tighter than it (R1e, CAD35)', async () => {
    const pipe = await evaluated('r1e-sweep', f15Sweep());
    const body = pipe.evaluation.bodies.pipe!;
    // Pappus: the circle's area along the path's length.
    expect(solid(body).volumeMm3).toBeCloseTo(25 * Math.PI * (50 + 15 * Math.PI), 2);
    expect(rounded(body.bounds[0])).toEqual([0, -5, -5]);
    expect(rounded(body.bounds[1])).toEqual([85, 30, 5]);
    // The side along each path element is a face of its own.
    expect(sortedNames(faceNames(pipe.mesh))).toEqual(
      ['end', 'start', 'side:e:c0/path:e:a0', 'side:e:c0/path:e:l0'].sort(),
    );
    expect(edgeNames(pipe.mesh).every(Boolean)).toBe(true);
    // A fixed orientation keeps the circle parallel to YZ along the turn.
    const fixed = await evaluated('r1e-sweep-fixed', f15Sweep('fixed'));
    expect(rounded(fixed.evaluation.bodies.pipe!.bounds[1])).toEqual([80, 35, 5]);
    // An arc of r3 under a circle of r5 folds the pipe into itself.
    const tight = structuredClone(f15Sweep());
    Object.assign(tight.sketches[1]!.solved, { c: [50, 3], p2: [53, 3] });
    const failed = await evaluate('r1e-sweep-tight', tight);
    expect(failed.type === 'result' && failed.evaluation).toMatchObject({
      status: 'error',
      code: 'sweep-failed',
      featureId: 'pipe-sweep',
    });
  }, 120_000);

  it('builds the R1 housing, and its fillet and shell follow the width (R1 acceptance, CAD37)', async () => {
    // A w × d × h block with R blends on its four top edges (as `blendedBlock`, any depth).
    const blended = (w: number, d: number, h: number, r: number) =>
      w * d * h - (1 - Math.PI / 4) * r * r * (2 * w + 2 * d) + 4 * r ** 3 * (5 / 3 - Math.PI / 2);
    // The wall T = W / 50 inside: the cavity is the block offset by T, its blends R3 − T.
    const housing = (w: number) => {
      const t = w / 50;
      return blended(w, 60, 20, 3) - blended(w - 2 * t, 60 - 2 * t, 20 - t, 3 - t);
    };
    const doc = r1Housing();
    const first = await evaluated('r1-housing', doc);
    expect(solid(first.evaluation.bodies.part!).volumeMm3 / housing(100)).toBeCloseTo(1, 6);
    const wider = applyCadOperation(doc, { type: 'setParameter', parameterId: 'W', value: 120 });
    const second = await evaluated('r1-housing-wider', wider);
    expect(solid(second.evaluation.bodies.part!).volumeMm3 / housing(120)).toBeCloseTo(1, 6);
    expect(rounded(second.evaluation.bodies.part!.bounds[1])).toEqual([120, 60, 20]);
    // The same blends on the wider block: the fillet and the shell kept their faces and edges.
    const blends = (m: CadMesh) =>
      faceNames(m)
        .filter((n) => n?.startsWith('blend:'))
        .sort();
    expect(blends(second.mesh)).toEqual(blends(first.mesh));
    expect(blends(first.mesh)).toHaveLength(4);
  });

  it('builds F16 spline edges: length, area, names and dimension changes (R2a-2, CAD40)', async () => {
    const sheet = (b: CadBodyEvaluation | undefined) => {
      if (b?.kind !== 'sheet') throw new Error(`not a sheet: ${JSON.stringify(b)}`);
      return b;
    };
    for (const reach of [20, 30]) {
      const doc =
        reach === 20
          ? f16Spline()
          : applyCadOperation(f16Spline(), {
              type: 'setParameter',
              parameterId: 'L',
              value: reach,
            });
      const result = await evaluate(`r2a-spline-${reach}`, doc);
      if (result.type !== 'result' || result.evaluation.status !== 'ok')
        throw new Error(JSON.stringify(result));
      const { length, area } = f16Reference(reach);
      const { hump, ribbon } = result.evaluation.bodies;
      // The solid the spline closes with the base line, 10 mm deep (the exact area by Green).
      expect(solid(hump).volumeMm3 / (area * 10)).toBeCloseTo(1, 6);
      // The spline carried up 20 mm: its length × 20 (OCCT's area on a B-spline face is within
      // 5 × 10⁻⁴, src/metrics.ts), and open edges 2L + 2 × 20.
      const r = sheet(ribbon);
      expect(Math.abs(r.areaMm2 / (length * 20) - 1)).toBeLessThan(5e-4);
      expect(r).toMatchObject({ freeEdges: 4 });
      expect(r.freeEdgeLengthMm / (2 * length + 40)).toBeCloseTo(1, 6);
      // Level ends: the curve stays within its control points' hull, here 0 ≤ v ≤ 15.
      expect(rounded(r.bounds[0])).toEqual([0, 0, 0]);
      expect(r.bounds[1][1]).toBeLessThan(30);
      const names = (id: string) =>
        new Set(
          result.meshes
            .find((m) => m.bodyId === id)!
            .topology.faces.map((f) => (f.name ? formatFaceName(f.name) : null)),
        );
      expect(names('ribbon')).toEqual(new Set(['side:e:sp']));
      expect(names('hump')).toEqual(new Set(['side:e:sp', 'side:e:base', 'start', 'end']));
    }
    // Written as STEP for the independent reader (docs/verification/cad-r2a-2a): the curve's
    // length and end tangents there.
    const document = pinned(f16Spline());
    await handle({
      type: 'evaluate',
      requestId: 'r2a-spline-step',
      generation: 1,
      baseHash: '',
      candidateHash: cadContentHash(document),
      document,
      step: true,
    });
    const written = posted.find(
      (m) => 'requestId' in m && m.requestId === 'r2a-spline-step' && m.type !== 'progress',
    )!;
    if (written.type !== 'result' || !written.step) throw new Error(JSON.stringify(written));
    expect(new TextDecoder().decode(written.step)).toMatch(/B_SPLINE_CURVE_WITH_KNOTS/);
    const dir = process.env.CAD_R2A_STEP_DIR ?? '/tmp/cad-r2a-step';
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/f16.step`, written.step);
    // The kernel refuses a crossing spline too (validation names its element first).
    const crossing = structuredClone(f16Spline());
    crossing.sketches[0] = f16Sketch('crossing');
    const refused = await evaluate('r2a-spline-crossing', crossing);
    expect(refused.type === 'result' && refused.evaluation).toMatchObject({
      status: 'error',
      code: 'sketch-self-intersection',
      featureId: 'hump-extrude',
    });
  });

  it('evaluates sheets: area, free edges, names and refusals (R2a-1, CAD39)', async () => {
    const sheet = (b: CadBodyEvaluation | undefined) => {
      if (b?.kind !== 'sheet') throw new Error(`not a sheet: ${JSON.stringify(b)}`);
      return b;
    };
    // An open line and quarter arc carried up H = 30: (40 + 10π) × 30, six open edges.
    const wall = await evaluated('r2a-wall', f17Sheets('extrude'));
    const w = sheet(wall.evaluation.bodies.surface);
    expect(w.areaMm2 / ((40 + 10 * Math.PI) * 30)).toBeCloseTo(1, 6);
    expect(w).toMatchObject({ freeEdges: 6 });
    expect(w.freeEdgeLengthMm / (2 * (40 + 10 * Math.PI) + 2 * 30)).toBeCloseTo(1, 6);
    expect(w.bounds[1].map((x) => Math.round(x * 1e6) / 1e6)).toEqual([60, 20, 30]);
    expect(new Set(wall.mesh.topology.faces.map((f) => JSON.stringify(f.name)))).toEqual(
      new Set([JSON.stringify(['side:e:l0']), JSON.stringify(['side:e:a0'])]),
    );
    // H follows the parameter.
    const taller = await evaluated(
      'r2a-wall-40',
      applyCadOperation(f17Sheets('extrude'), {
        type: 'setParameter',
        parameterId: 'H',
        value: 40,
      }),
    );
    expect(
      sheet(taller.evaluation.bodies.surface).areaMm2 / ((40 + 10 * Math.PI) * 40),
    ).toBeCloseTo(1, 6);
    // A closed square: an open-ended tube, 4 × 40 × 20 mm², eight open edges.
    const tube = sheet(
      (await evaluated('r2a-tube', f17Sheets('closed'))).evaluation.bodies.surface,
    );
    expect(tube.areaMm2).toBeCloseTo(3200, 6);
    expect(tube).toMatchObject({ freeEdges: 8 });
    // A cylinder with a hemispherical cap, a full turn: the seams are not open edges.
    const dome = sheet(
      (await evaluated('r2a-dome', f17Sheets('revolve'))).evaluation.bodies.surface,
    );
    expect(dome.areaMm2 / (800 * Math.PI)).toBeCloseTo(1, 6);
    expect(dome).toMatchObject({ freeEdges: 1 });
    expect(dome.freeEdgeLengthMm / (20 * Math.PI)).toBeCloseTo(1, 6);
    // A sheet moved alone stays a sheet; reflected alone (no union) too.
    const mirrored = applyCadOperation(f17Sheets('closed'), {
      type: 'detailBody',
      bodyId: 'surface',
      placementFeatureId: 'm-placement',
      feature: {
        id: 'm',
        name: 'Mirror',
        type: 'mirror',
        inputFeatureIds: ['surface-placement'],
        args: { plane: { origin: position(-10, 0, 0), normal: [1, 0, 0] }, union: false },
      },
    });
    const m = sheet((await evaluated('r2a-mirror', mirrored)).evaluation.bodies.surface);
    expect(m.areaMm2).toBeCloseTo(3200, 6);
    expect(m.bounds[0][0]).toBeCloseTo(-60, 6);
  });

  it('lofts and sweeps sheets through chains: areas, free edges and their names (R2a-2b, CAD41)', async () => {
    const sheet = (b: CadBodyEvaluation | undefined) => {
      if (b?.kind !== 'sheet') throw new Error(`not a sheet: ${JSON.stringify(b)}`);
      return b;
    };
    const free = (mesh: CadMesh) =>
      sortedNames(edgeNames(mesh).filter((_, i) => mesh.topology.edges[i]!.boundary));
    // Through the F16 spline and a lower hump H = 40 mm above: the reference integral (the
    // build integrates a B-spline face's area to about 5e-5, docs/verification/cad-r2a-2a).
    const loft = await evaluated('r2a-loft', f17Surfaces('loft'));
    const l = sheet(loft.evaluation.bodies.surface);
    const ref = f17LoftReference(40);
    expect(Math.abs(l.areaMm2 / ref.area - 1)).toBeLessThan(1e-4);
    // Four open edges: the two curves and the two 40 mm lines between their ends.
    expect(l).toMatchObject({ freeEdges: 4 });
    expect(l.freeEdgeLengthMm / (ref.lengths[0] + ref.lengths[1] + 80)).toBeCloseTo(1, 6);
    expect(faceNames(loft.mesh)).toEqual(['side:e:sp']);
    const loftEdges = [
      'edge:end:e:sp | side:e:sp',
      'edge:start:e:sp | side:e:sp',
      'end | side:e:sp',
      'side:e:sp | start',
    ];
    expect(free(loft.mesh)).toEqual(loftEdges);
    // H moves the upper chain: the same names, each on one edge, and the new area.
    const lower = await evaluated(
      'r2a-loft-30',
      applyCadOperation(f17Surfaces('loft'), { type: 'setParameter', parameterId: 'H', value: 30 }),
    );
    expect(
      Math.abs(sheet(lower.evaluation.bodies.surface).areaMm2 / f17LoftReference(30).area - 1),
    ).toBeLessThan(1e-4);
    expect(free(lower.mesh)).toEqual(loftEdges);
    // Written as STEP for the independent reader (docs/verification/cad-r2a-2b): its area there.
    const document = pinned(f17Surfaces('loft'));
    await handle({
      type: 'evaluate',
      requestId: 'r2a-loft-step',
      generation: 1,
      baseHash: '',
      candidateHash: cadContentHash(document),
      document,
      step: true,
    });
    const written = posted.find(
      (m) => 'requestId' in m && m.requestId === 'r2a-loft-step' && m.type !== 'progress',
    )!;
    if (written.type !== 'result' || !written.step) throw new Error(JSON.stringify(written));
    expect(new TextDecoder().decode(written.step)).toMatch(/SHELL_BASED_SURFACE_MODEL/);
    const dir = process.env.CAD_R2A_STEP_DIR ?? '/tmp/cad-r2a-step';
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/f17-loft.step`, written.step);
    for (const mesh of [loft.mesh, lower.mesh])
      for (const [i, e] of mesh.topology.edges.entries())
        if (e.boundary)
          expect(
            resolveTopologyRef(mesh.topology, {
              kind: 'edge',
              name: elementName(mesh.topology, 'edge', i)!,
              hint: { centroid: [0, 0, 0], size: 0 },
            }),
          ).toEqual({ status: 'resolved', index: i });
    // Ruled between two closed squares: four trapezoids, 120√1000 mm², eight open edges, each
    // named by its side and the chain it starts or ends on.
    const funnel = await evaluated('r2a-loft-closed', f17Surfaces('closed'));
    const c = sheet(funnel.evaluation.bodies.surface);
    expect(c.areaMm2 / (120 * Math.sqrt(1000))).toBeCloseTo(1, 9);
    expect(c).toMatchObject({ freeEdges: 8, freeEdgeLengthMm: expect.closeTo(240, 6) });
    expect(free(funnel.mesh)).toEqual(
      ['l0', 'l1', 'l2', 'l3']
        .flatMap((e) => [`end | side:e:a-${e}`, `side:e:a-${e} | start`])
        .sort(),
    );
    // A two-line chain a quarter turn along r = 50 mm: 500π + 275π mm², faces named by the
    // profile element and the path element; the chain's ends sweep the two arcs.
    const gutter = await evaluated('r2a-sweep', f17Surfaces('sweep'));
    const g = sheet(gutter.evaluation.bodies.surface);
    expect(g.areaMm2 / (775 * Math.PI)).toBeCloseTo(1, 9);
    expect(g).toMatchObject({ freeEdges: 6 });
    expect(g.freeEdgeLengthMm / (60 + 55 * Math.PI)).toBeCloseTo(1, 9);
    expect(sortedNames(faceNames(gutter.mesh))).toEqual([
      'side:e:l0/path:e:turn',
      'side:e:l1/path:e:turn',
    ]);
    expect(free(gutter.mesh)).toEqual([
      'edge:end:e:l1 | side:e:l1/path:e:turn',
      'edge:start:e:l0 | side:e:l0/path:e:turn',
      'end | side:e:l0/path:e:turn',
      'end | side:e:l1/path:e:turn',
      'side:e:l0/path:e:turn | start',
      'side:e:l1/path:e:turn | start',
    ]);
    // R2a-1's sheets name their open edges the same way; a full turn's seam and pole stay unnamed.
    const wall = await evaluated('r2a-names-extrude', f17Sheets('extrude'));
    expect(free(wall.mesh)).toEqual([
      'edge:end:e:a0 | side:e:a0',
      'edge:start:e:l0 | side:e:l0',
      'end | side:e:a0',
      'end | side:e:l0',
      'side:e:a0 | start',
      'side:e:l0 | start',
    ]);
    const dome = await evaluated('r2a-names-revolve', f17Sheets('revolve'));
    expect(free(dome.mesh)).toEqual(['edge:start:e:l0 | side:e:l0']);
    // Reflected alone, the boundaries carry the mirror's prefix with their faces.
    const mirrored = applyCadOperation(f17Surfaces('sweep'), {
      type: 'detailBody',
      bodyId: 'surface',
      placementFeatureId: 'm-placement',
      feature: {
        id: 'm',
        name: 'Mirror',
        type: 'mirror',
        inputFeatureIds: ['surface-placement'],
        args: { plane: { origin: position(0, 0, 0), normal: [1, 0, 0] }, union: false },
      },
    });
    const m = await evaluated('r2a-sweep-mirror', mirrored);
    expect(free(m.mesh)).toContain('mirror:m/edge:start:e:l0 | mirror:m/side:e:l0/path:e:turn');
    expect(free(m.mesh)).toHaveLength(6);
  });

  it('spans boundary surfaces and fills and lofts from edges: areas and names by source (R2a-2c, CAD41)', async () => {
    const sheet = (b: CadBodyEvaluation | undefined) => {
      if (b?.kind !== 'sheet') throw new Error(`not a sheet: ${JSON.stringify(b)}`);
      return b;
    };
    const run = async (id: string, doc: CadDocument, bodyId: string) => {
      const result = await evaluate(id, doc);
      if (result.type !== 'result' || result.evaluation.status !== 'ok')
        throw new Error(JSON.stringify(result));
      const mesh = result.meshes.find((m) => m.bodyId === bodyId)!;
      return { body: sheet(result.evaluation.bodies[bodyId]), mesh };
    };
    const free = (mesh: CadMesh) =>
      sortedNames(edgeNames(mesh).filter((_, i) => mesh.topology.edges[i]!.boundary));
    const resolvesEach = (mesh: CadMesh) => {
      for (const [i, e] of mesh.topology.edges.entries())
        if (e.boundary)
          expect(
            resolveTopologyRef(mesh.topology, {
              kind: 'edge',
              name: elementName(mesh.topology, 'edge', i)!,
              hint: { centroid: [0, 0, 0], size: 0 },
            }),
          ).toEqual({ status: 'resolved', index: i });
    };
    const curvesOf = (doc: CadDocument) => {
      const f = doc.features.find((x) => x.id === 'sheet')!;
      if (f.type !== 'boundarySurface') throw new Error('fixture');
      return f.args.curves;
    };
    // Four lines of three sketches by a Coons patch: z = xy / 40 (a B-spline face's area to
    // 5e-4, docs/verification/cad-r2a-2a), each side named by the sketch element it came from.
    const hypar = await run('r2a-hypar', f17Boundaries('hypar'), 'surface');
    expect(Math.abs(hypar.body.areaMm2 / f17HyparArea() - 1)).toBeLessThan(5e-4);
    expect(hypar.body).toMatchObject({ freeEdges: 4 });
    expect(hypar.body.freeEdgeLengthMm / (80 + 80 * Math.SQRT2)).toBeCloseTo(1, 9);
    expect(faceNames(hypar.mesh)).toEqual(['surface']);
    const hyparEdges = [
      'sketch:east/boundary:e:bc | surface',
      'sketch:floor/boundary:e:ab | surface',
      'sketch:floor/boundary:e:da | surface',
      'sketch:north/boundary:e:cd | surface',
    ];
    expect(free(hypar.mesh)).toEqual(hyparEdges);
    resolvesEach(hypar.mesh);
    // The same curves turned round and reversed: the same names, each still on one edge.
    for (const order of ['rotate', 'reverse'] as const) {
      const doc = f17Boundaries('hypar');
      const curves = curvesOf(doc);
      if (order === 'rotate') curves.push(curves.shift()!);
      else curves.reverse();
      const again = await run(`r2a-hypar-${order}`, doc, 'surface');
      expect(free(again.mesh)).toEqual(hyparEdges);
      resolvesEach(again.mesh);
    }
    // The saddle's own sides are B-spline edges: a boundary surface takes only lines and arcs
    // as referenced edges (a fill takes any), so it refuses the first with its place.
    const again = applyCadOperation(f17Boundaries('hypar'), {
      type: 'insertFeatures',
      features: [
        {
          id: 'again',
          name: 'Again',
          type: 'boundarySurface',
          inputFeatureIds: [],
          args: {
            curves: [
              ['floor', 'ab'],
              ['east', 'bc'],
              ['north', 'cd'],
              ['floor', 'da'],
            ].map(([sketch, element]) => ({
              edge: edgeRef(
                'surface-placement',
                ['surface'],
                [`sketch:${sketch}`, `boundary:e:${element}`],
                [0, 0, 0],
                40,
              ),
            })),
          },
        },
      ],
      bodies: [
        {
          id: 'again-body',
          name: 'Again',
          sourceFeatureId: 'again',
          placementFeatureId: 'again-placement',
          appearance: { color: '#9aa4b1', opacity: 1 },
        },
      ],
    });
    expect(await evaluate('r2a-hypar-again', again)).toMatchObject({
      evaluation: {
        status: 'error',
        code: 'boundary-curve-unsupported',
        featureId: 'again',
        failedPaths: [['curves', 0]],
      },
    });
    // Three curves (a line, a quarter arc of r = 40, a line): 400π mm², the arc's side as long as
    // the arc (an arc becomes cubic pieces for the patch, the radius within 1e-9 of itself).
    const quarter = await run('r2a-quarter', f17Boundaries('quarter'), 'surface');
    expect(Math.abs(quarter.body.areaMm2 / (400 * Math.PI) - 1)).toBeLessThan(5e-4);
    expect(quarter.body).toMatchObject({ freeEdges: 3 });
    expect(quarter.body.freeEdgeLengthMm / (80 + 20 * Math.PI)).toBeCloseTo(1, 8);
    expect(free(quarter.mesh)).toEqual(
      ['ab', 'bo', 'oa'].map((e) => `sketch:floor/boundary:e:${e} | surface`),
    );
    // A fill of a 40 mm square of lines: flat, 1,600 mm².
    const fill = await run('r2a-fill', f17Boundaries('fill'), 'surface');
    expect(fill.body.areaMm2 / 1600).toBeCloseTo(1, 9);
    expect(free(fill.mesh)).toEqual(
      ['ab', 'bc', 'cd', 'da'].map((e) => `sketch:floor/boundary:e:${e} | surface`),
    );
    // The tube's top opening filled from its four edges: a 40 mm square at z = 20, each side
    // named by the edge it came from; a taller tube moves it and keeps the names.
    const capEdges = [0, 1, 2, 3].map(
      (i) => `from:surface-placement/boundary:(end | side:e:l${i}) | surface`,
    );
    const cap = await run('r2a-cap', f17Boundaries('cap'), 'cap-body');
    expect(cap.body.areaMm2 / 1600).toBeCloseTo(1, 9);
    expect(cap.body.bounds[0][2]).toBeCloseTo(20, 6);
    expect(free(cap.mesh)).toEqual(capEdges);
    resolvesEach(cap.mesh);
    const taller = f17Boundaries('cap');
    const tube = taller.features.find((x) => x.id === 'sheet')!;
    if (tube.type !== 'extrudeSurface') throw new Error('fixture');
    tube.args.distance = { literalMm: 30 };
    const raised = await run('r2a-cap-30', taller, 'cap-body');
    expect(raised.body.bounds[0][2]).toBeCloseTo(30, 6);
    expect(free(raised.mesh)).toEqual(capEdges);
    // G1 to the tube's walls asks the plate to turn a right angle: refused on its G1 sides, not
    // kept with a crease.
    const square = f17Boundaries('cap');
    const fillOf = (doc: CadDocument) => {
      const f = doc.features.find((x) => x.id === 'cap')!;
      if (f.type !== 'fill') throw new Error('fixture');
      return f;
    };
    fillOf(square).args.boundary.forEach((b) => (b.continuity = 'G1'));
    expect(await evaluate('r2a-cap-g1', square)).toMatchObject({
      evaluation: {
        status: 'error',
        code: 'fill-g1-unreached',
        featureId: 'cap',
        failedPaths: [0, 1, 2, 3].map((i) => ['boundary', i, 'continuity']),
      },
    });
    // A G1 dome on a ruled cone of four arcs (45°): it rises above the r = 10 opening, larger
    // than the flat disc, and the G0 fill of the same edges is the flat disc.
    const dome = await run('r2a-fill-dome', f17Boundaries('dome'), 'cap-body');
    const cone = sheet(
      (await evaluated('r2a-cone', f17Boundaries('dome'))).evaluation.bodies.surface,
    );
    expect(cone.areaMm2 / (30 * Math.PI * Math.sqrt(200))).toBeCloseTo(1, 9);
    expect(dome.body.bounds[1][2]).toBeGreaterThan(12);
    expect(dome.body.areaMm2).toBeGreaterThan(110 * Math.PI);
    expect(dome.body.freeEdgeLengthMm / (20 * Math.PI)).toBeCloseTo(1, 8);
    expect(free(dome.mesh)).toEqual(
      [0, 1, 2, 3].map((i) => `from:cone/boundary:(end | side:e:a${i}) | surface`),
    );
    const flat = f17Boundaries('dome');
    fillOf(flat).args.boundary.forEach((b) => (b.continuity = 'G0'));
    const disc = await run('r2a-fill-disc', flat, 'cap-body');
    expect(disc.body.areaMm2 / (100 * Math.PI)).toBeCloseTo(1, 5);
    // A ruled loft from the tube's top edges to a 20 mm square 30 mm above: four trapezoids,
    // 120√1000 mm², faces named by the edges they start from.
    const funnel = await run('r2a-edge-loft', f17Boundaries('edgeLoft'), 'cap-body');
    expect(funnel.body.areaMm2 / (120 * Math.sqrt(1000))).toBeCloseTo(1, 9);
    const sides = [0, 1, 2, 3].map((i) => `from:surface-placement/side:(end | side:e:l${i})`);
    expect(sortedNames(faceNames(funnel.mesh))).toEqual(sides);
    expect(free(funnel.mesh)).toEqual(
      sides.flatMap((side) => [`${side} | start`, `end | ${side}`]).sort(),
    );
  }, 60000);

  it('sews, trims and thickens the F18 hood: areas, volume and names that keep (R2a-3, CAD42)', async () => {
    const run = async (id: string, doc: CadDocument, bodyId: string) => {
      const result = await evaluate(id, doc);
      if (result.type !== 'result' || result.evaluation.status !== 'ok')
        throw new Error(JSON.stringify(result));
      const mesh = result.meshes.find((m) => m.bodyId === bodyId)!;
      return { body: result.evaluation.bodies[bodyId]!, mesh };
    };
    const asSheet = (b: CadBodyEvaluation) => {
      if (b.kind !== 'sheet') throw new Error(`not a sheet: ${JSON.stringify(b)}`);
      return b;
    };
    const free = (mesh: CadMesh) =>
      sortedNames(edgeNames(mesh).filter((_, i) => mesh.topology.edges[i]!.boundary));
    // Three sheets of the cylinder r = 100, sewn at 0.0001 mm: the strip's r × π/3 × 80 mm² (the
    // fill a plate, to 1e-5), eight free edges round it, each face named by the sheet it was.
    const panels = ['left-placement', 'crown-placement', 'right-placement'];
    const sewnNames = panels.map((p) => `sew:${p}/surface`).sort();
    const sewn = await run('r2a3-hood-sew', f18Hood('sew'), 'left');
    expect(Math.abs(asSheet(sewn.body).areaMm2 / f18HoodArea - 1)).toBeLessThan(1e-5);
    expect(sewn.body).toMatchObject({ freeEdges: 8 });
    expect(sortedNames(faceNames(sewn.mesh))).toEqual(sewnNames);
    // The inputs in another order, or another body carrying the result: the same names. A sew of
    // two of them names those two as the three do.
    const sheets = f18Hood('sheets');
    const sewOf = (targetId: string, toolIds: string[]) =>
      applyCadOperation(sheets, {
        type: 'sewBodies',
        targetId,
        toolIds,
        toleranceMm: 0.0001,
        solid: false,
        sewFeatureId: 'sew',
        placementFeatureId: 'sew-placement',
      });
    const turned = await run('r2a3-hood-sew-turned', sewOf('crown', ['right', 'left']), 'crown');
    expect(sortedNames(faceNames(turned.mesh))).toEqual(sewnNames);
    expect(free(turned.mesh)).toEqual(free(sewn.mesh));
    const two = await run('r2a3-hood-sew-two', sewOf('left', ['crown']), 'left');
    expect(sortedNames(faceNames(two.mesh))).toEqual(sewnNames.slice(0, 2));
    // The window cut along Z keeps the outside: the strip less 2 r asin(0.15) × 30 mm², the
    // pieces `trim:<ID>:outside/…` and the four cut edges named by the window's lines.
    const trimmed = await run('r2a3-hood-trim', f18Hood('trim'), 'left');
    expect(
      Math.abs(asSheet(trimmed.body).areaMm2 / (f18HoodArea - f18WindowArea) - 1),
    ).toBeLessThan(1e-5);
    expect(trimmed.body).toMatchObject({ freeEdges: 12 });
    const kept = sewnNames.map((n) => `trim:window-cut:outside/${n}`);
    expect(sortedNames(faceNames(trimmed.mesh))).toEqual(kept);
    const crown = 'trim:window-cut:outside/sew:crown-placement/surface';
    const cuts = [0, 1, 2, 3].map((i) => `sketch:window/cut:e:e${i} | ${crown}`);
    expect(free(trimmed.mesh).filter((n) => n!.startsWith('sketch:window'))).toEqual(cuts);
    // The window moved 5 mm along X crosses into the right panel: the outside is still kept,
    // now less r (asin(0.2) + asin(0.1)) × 30 mm², never the window's piece.
    const moved = f18Hood('trim');
    const window = moved.sketches.find((s) => s.id === 'window')!;
    for (const p of Object.values(window.solved)) p[0] += 5;
    const shifted = await run('r2a3-hood-trim-moved', moved, 'left');
    const across = 100 * (Math.asin(0.2) + Math.asin(0.1)) * 30;
    expect(Math.abs(asSheet(shifted.body).areaMm2 / (f18HoodArea - across) - 1)).toBeLessThan(1e-5);
    expect(sortedNames(faceNames(shifted.mesh))).toEqual(kept);
    // A 1.5 mm skin towards the normal (which faces the axis): the wall inside r = 100 less the
    // window, every face named: the sheet's side `inner/…`, the offset side as the sheet was,
    // and a side along each free edge `side:(<the edge's name>)`.
    const skin = await run('r2a3-hood-skin', f18Hood('thicken'), 'left');
    expect(skin.body.kind).toBe('solid');
    expect(Math.abs(solid(skin.body).volumeMm3 / f18SkinVolume - 1)).toBeLessThan(1e-5);
    const skinNames = faceNames(skin.mesh);
    expect(skinNames).not.toContain(null);
    expect(sortedNames(skinNames)).toEqual(
      [
        ...kept,
        ...kept.map((n) => `inner/${n}`),
        ...free(trimmed.mesh).map((edge) => `side:(${edge})`),
      ].sort(),
    );
    // The face the sheet was stays at r = 100; the offset one lies 1.5 mm inside it.
    const radius = (name: string) => {
      const i = skinNames.indexOf(name);
      const [x, , z] = skin.mesh.topology.faces[i]!.centroid;
      return Math.hypot(x, z);
    };
    expect(radius(`inner/${crown}`)).toBeGreaterThan(radius(crown) + 1.4);
  }, 60000);

  it('refuses sew gaps, open boxes, trims that cut nothing or across, creased thickens (R2a-3, CAD42)', async () => {
    const free = (mesh: CadMesh) =>
      sortedNames(edgeNames(mesh).filter((_, i) => mesh.topology.edges[i]!.boundary));
    const ok = async (id: string, doc: CadDocument, bodyId = 'surface') => {
      const result = await evaluate(id, doc);
      if (result.type !== 'result' || result.evaluation.status !== 'ok')
        throw new Error(JSON.stringify(result));
      return {
        body: result.evaluation.bodies[bodyId]!,
        mesh: result.meshes.find((m) => m.bodyId === bodyId)!,
      };
    };
    const refused = async (id: string, doc: CadDocument) => {
      const result = await evaluate(id, doc);
      if (result.type !== 'result' || result.evaluation.status !== 'error')
        throw new Error(JSON.stringify(result));
      return result.evaluation;
    };
    // Two walls end to end with a gap of exactly the tolerance join (the distance has the model's
    // 0.000001 mm of slack); past it they are refused by the two edges left apart. A gap the
    // tolerance joins but whose edges then exceed the result tolerance (0.0001 mm) is refused as
    // any result is; walls 10 mm apart are not one sheet.
    const joined = await ok(
      'r2a3-gap-joined',
      f18Sheets({ kind: 'gap', gap: 0.00005, toleranceMm: 0.00005 }),
      'a',
    );
    expect(joined.body).toMatchObject({ kind: 'sheet', freeEdges: 6 });
    expect(sortedNames(faceNames(joined.mesh))).toEqual([
      'sew:a-placement/side:e:l',
      'sew:b-placement/side:e:l',
    ]);
    expect(
      await refused('r2a3-gap', f18Sheets({ kind: 'gap', gap: 0.000052, toleranceMm: 0.00005 })),
    ).toMatchObject({
      code: 'sew-gap',
      featureId: 'sew',
      edges: [
        { featureId: 'a-placement', name: [['edge:end:e:l'], ['side:e:l']] },
        { featureId: 'b-placement', name: [['edge:start:e:l'], ['side:e:l']] },
      ],
    });
    expect(
      await refused('r2a3-gap-loose', f18Sheets({ kind: 'gap', gap: 0.0001, toleranceMm: 0.0001 })),
    ).toMatchObject({ code: 'result-tolerance', featureId: 'sew' });
    expect(
      await refused('r2a3-apart', f18Sheets({ kind: 'gap', gap: 10, toleranceMm: 0.0001 })),
    ).toMatchObject({ code: 'sew-disconnected', featureId: 'sew' });
    // The tube and its two end fills close: a 40 × 40 × 20 solid. Without the floor it is open.
    const box = await ok('r2a3-box', f18Sheets({ kind: 'box' }));
    expect(solid(box.body).volumeMm3 / 32000).toBeCloseTo(1, 9);
    expect(sortedNames(faceNames(box.mesh))).toEqual([
      'sew:cap-body-placement/surface',
      'sew:floor-body-placement/surface',
      ...[0, 1, 2, 3].map((i) => `sew:surface-placement/side:e:l${i}`),
    ]);
    expect(await refused('r2a3-box-open', f18Sheets({ kind: 'box', open: true }))).toMatchObject({
      code: 'sew-not-closed',
      featureId: 'sew',
    });
    // The 40 mm plate cut by a circle of r = 10, a plane and a wall: each side kept by its rule.
    const trim = (tool: Parameters<typeof f18Sheets>[0] & { kind: 'trim' }) =>
      ok(`r2a3-trim-${tool.tool}-${tool.keep}`, f18Sheets(tool));
    const inside = await trim({ kind: 'trim', tool: 'circle', keep: 'inside' });
    expect(inside.body.areaMm2 / (100 * Math.PI)).toBeCloseTo(1, 5);
    expect(sortedNames(faceNames(inside.mesh))).toEqual(['trim:cut:inside/surface']);
    // The splitter may break one cut into several edges; they share its name (R1: a reference
    // to it is then ambiguous and is chosen again).
    expect([...new Set(free(inside.mesh))]).toEqual(
      ['a0', 'a1'].map((e) => `sketch:hole/cut:e:${e} | trim:cut:inside/surface`),
    );
    const outside = await trim({ kind: 'trim', tool: 'circle', keep: 'outside' });
    expect(outside.body.areaMm2 / (1600 - 100 * Math.PI)).toBeCloseTo(1, 5);
    const front = await trim({ kind: 'trim', tool: 'plane', keep: 'front' });
    expect(front.body.areaMm2 / 800).toBeCloseTo(1, 9);
    expect(front.body.bounds[0][0]).toBeCloseTo(20, 6);
    expect(free(front.mesh)).toContain('cut:plane | trim:cut:front/surface');
    const back = await trim({ kind: 'trim', tool: 'plane', keep: 'back' });
    expect(back.body.bounds[1][0]).toBeCloseTo(20, 6);
    // The plane moved to x = 30: the front is still the side its normal faces.
    const further = f18Sheets({ kind: 'trim', tool: 'plane', keep: 'front' });
    const cut = further.features.find((f) => f.id === 'cut')!;
    if (cut.type !== 'trim' || !('plane' in cut.args.tool)) throw new Error('fixture');
    cut.args.tool.plane.origin = position(30, 0, 0);
    const narrower = await ok('r2a3-trim-plane-30', further);
    expect(narrower.body.areaMm2 / 400).toBeCloseTo(1, 9);
    expect(narrower.body.bounds[0][0]).toBeCloseTo(30, 6);
    // A wall across the plate: front and back are its two halves, the cut named by its face.
    const wallFront = await trim({ kind: 'trim', tool: 'wall', keep: 'front' });
    const wallBack = await trim({ kind: 'trim', tool: 'wall', keep: 'back' });
    expect(wallFront.body.areaMm2 / 800).toBeCloseTo(1, 9);
    expect(wallBack.body.areaMm2 / 800).toBeCloseTo(1, 9);
    expect(wallFront.body.bounds[1][0] + wallBack.body.bounds[1][0]).toBeCloseTo(60, 6);
    expect(free(wallFront.mesh)).toContain(
      'from:blade-placement/cut:(side:e:l) | trim:cut:front/surface',
    );
    // A wall half across leaves a piece on both sides; a plane past the plate cuts nothing.
    expect(
      await refused(
        'r2a3-trim-partial',
        f18Sheets({ kind: 'trim', tool: 'partial', keep: 'front' }),
      ),
    ).toMatchObject({ code: 'trim-side-undetermined', featureId: 'cut', failedPaths: [['tool']] });
    expect(
      await refused('r2a3-trim-miss', f18Sheets({ kind: 'trim', tool: 'miss', keep: 'front' })),
    ).toMatchObject({ code: 'trim-no-cut', featureId: 'cut', failedPaths: [['tool']] });
    // The plate 1.5 mm thick each way: 2,400 mm³; `surface` is the face on the normal's side.
    for (const [side, [low, high]] of [
      ['front', [0, 1.5]],
      ['back', [-1.5, 0]],
      ['both', [-0.75, 0.75]],
    ] as const) {
      const thick = await ok(
        `r2a3-thicken-${side}`,
        f18Sheets({ kind: 'thicken', sheet: 'plate', side }),
      );
      expect(solid(thick.body).volumeMm3 / 2400).toBeCloseTo(1, 9);
      expect(thick.body.bounds[0][2]).toBeCloseTo(low, 6);
      expect(thick.body.bounds[1][2]).toBeCloseTo(high, 6);
      const names = faceNames(thick.mesh);
      const z = (name: string) => thick.mesh.topology.faces[names.indexOf(name)]!.centroid[2];
      expect(z('surface')).toBeCloseTo(high, 6);
      expect(z('inner/surface')).toBeCloseTo(low, 6);
      expect(sortedNames(names)).toEqual(
        [
          'inner/surface',
          'surface',
          ...['ab', 'bc', 'cd', 'da'].map((e) => `side:(sketch:floor/boundary:e:${e} | surface)`),
        ].sort(),
      );
    }
    // The tube's walls meet at right angles: the simple offset leaves them apart.
    expect(
      await refused(
        'r2a3-thicken-tube',
        f18Sheets({ kind: 'thicken', sheet: 'tube', side: 'front' }),
      ),
    ).toMatchObject({ code: 'thicken-failed', featureId: 'skin' });
  }, 60000);

  /** One edge's continuity samples, the edge picked by its readable name in body `bodyId`. */
  const continuityOf = async (id: string, doc: CadDocument, bodyId: string, edge: string) => {
    const meshes = await meshesOf(`${id}-mesh`, doc);
    const mesh = meshes.find((m) => m.bodyId === bodyId)!;
    const index = edgeNames(mesh).indexOf(edge);
    if (index < 0) throw new Error(`${edge} not in ${JSON.stringify(edgeNames(mesh))}`);
    return continuityAt(id, doc, bodyId, index);
  };
  const continuityEvaluations = new Map<string, CadEvaluation>();
  /** The same by the edge's index in the pick table. */
  const continuityAt = async (id: string, doc: CadDocument, bodyId: string, index: number) => {
    const document = pinned(doc);
    await handle({
      type: 'evaluate',
      requestId: id,
      generation: 1,
      baseHash: '',
      candidateHash: cadContentHash(document),
      document,
      continuity: { bodyId, edge: index },
    });
    const result = posted.find(
      (m) => 'requestId' in m && m.requestId === id && m.type !== 'progress',
    )!;
    if (result.type !== 'result' || !result.continuity) throw new Error(JSON.stringify(result));
    continuityEvaluations.set(id, result.evaluation);
    return result.continuity;
  };

  it('samples an edge’s continuity on the exact faces: G0, G1, G2 at 65 points (R2a-4, CAD43)', async () => {
    const report = async (id: string, doc: CadDocument, bodyId: string, edge: string) => {
      const r = await continuityOf(id, doc, bodyId, edge);
      if (!('samples' in r)) throw new Error(JSON.stringify(r));
      // Every sample lies on the edge, both ends included.
      expect(r.samples).toHaveLength(cadContinuity.samples);
      return continuityReport(r.samples);
    };
    const seam = 'side:e:l0 | side:e:l1';
    // Two planes bent by exactly the G1 tolerance pass it; twice that does not. Flat: G2 holds.
    const exact = await report(
      'r2a4-bend',
      f18Seams({ kind: 'bend', angleDeg: 0.1 }),
      'surface',
      seam,
    );
    expect(exact.g1.max).toBeCloseTo(0.1, 12);
    expect(exact).toMatchObject({ level: 'G2', g0: { max: 0, pass: true }, g1: { pass: true } });
    const over = await report(
      'r2a4-bend-2',
      f18Seams({ kind: 'bend', angleDeg: 0.2 }),
      'surface',
      seam,
    );
    expect(over.g1.max).toBeCloseTo(0.2, 12);
    expect(over).toMatchObject({ level: 'G0', g1: { pass: false }, g2: { pass: true } });
    expect(over.g1.at).toEqual([40, 0, 0]);
    // A plane continued by a cylinder of r = 20: tangent, but the curvature jumps 0 → 1/20.
    const tangent = await report(
      'r2a4-tangent',
      f18Seams({ kind: 'tangent' }),
      'surface',
      'side:e:a1 | side:e:l0',
    );
    expect(tangent).toMatchObject({ level: 'G1', g2: { max: 1, pass: false } });
    expect(tangent.g1.max).toBeLessThan(1e-9);
    expect(tangent.g2.difference).toBeCloseTo(1 / 20, 12);
    // Two quarters of one cylinder: the same curvature on both sides.
    const smooth = await report(
      'r2a4-smooth',
      f18Seams({ kind: 'smooth' }),
      'surface',
      'side:e:a0 | side:e:a1',
    );
    expect(smooth).toMatchObject({ level: 'G2', g2: { pass: true } });
    expect(smooth.g2.difference).toBeLessThan(1e-12);
    // The hood's sewn seams: the fill meets both panels G1 (0.1°), and not G2 (it is a plate,
    // flatter than the cylinder by about 1.5%; the design leaves an N-sided fill's G2 out).
    const hood = f18Hood('sew');
    for (const panel of ['left', 'right']) {
      const r = await report(
        `r2a4-hood-${panel}`,
        hood,
        'left',
        sortedNames([`sew:crown-placement/surface`, `sew:${panel}-placement/surface`]).join(' | '),
      );
      expect(r).toMatchObject({ level: 'G1', g0: { pass: true }, g1: { pass: true } });
      expect(r.g0.max).toBeLessThan(cadContinuity.g0Mm);
      expect(r.g1.max).toBeLessThan(0.01);
      expect(r.g2.max).toBeGreaterThan(cadContinuity.g2Relative);
      expect(r.g2.max).toBeLessThan(0.02);
    }
    // A box's edge is a crease: only G0.
    const [box] = await meshesOf('r2a4-box-mesh', f02Plate());
    const crease = edgeNames(box).find((n) => n === 'side:+u | side:+v')!;
    const creased = await report('r2a4-box', f02Plate(), box.bodyId, crease);
    expect(creased).toMatchObject({ level: 'G0', g1: { max: 90 } });
    // Each face's curvature is taken across the edge in its own plane: both flat, not 0/0.
    expect(creased.g2).toMatchObject({ max: 0, difference: 0, pass: true });
    // No two faces: a free edge, a seam inside one face, or an index past the table.
    expect(
      await continuityOf('r2a4-free', f18Seams({ kind: 'smooth' }), 'surface', 'side:e:a0 | start'),
    ).toEqual({ code: 'continuity-free-edge' });
    const tube = sphere('ball', 10, 0);
    const [ball] = await meshesOf('r2a4-ball-mesh', tube);
    // The sphere's edges: its seam and its two poles.
    const codes = await Promise.all(
      ball.topology.edges.map(async (_, i) => continuityAt(`r2a4-ball-${i}`, tube, ball.bodyId, i)),
    );
    expect(codes.map((c) => ('code' in c ? c.code : 'samples')).sort()).toEqual([
      'continuity-degenerate',
      'continuity-degenerate',
      'continuity-seam',
    ]);
    expect(await continuityAt('r2a4-missing', tube, ball.bodyId, 999)).toEqual({
      code: 'continuity-edge-missing',
    });
    expect(await continuityAt('r2a4-no-body', tube, 'ghost', 0)).toEqual({
      code: 'continuity-edge-missing',
    });
    // Display only: the evaluation is the one without the request.
    const plain = await evaluate('r2a4-plain', f18Seams({ kind: 'tangent' }));
    if (plain.type !== 'result') throw new Error('result');
    expect(continuityEvaluations.get('r2a4-tangent')).toEqual(plain.evaluation);
  }, 120000);

  /** An evaluation with an analysis request (curvature or comb), its result message. */
  const analysed = async (
    id: string,
    doc: CadDocument,
    extra: { curvature?: true; comb?: { bodyId: string; edge: number } },
  ) => {
    const document = pinned(doc);
    await handle({
      type: 'evaluate',
      requestId: id,
      generation: 1,
      baseHash: '',
      candidateHash: cadContentHash(document),
      document,
      ...extra,
    });
    const result = posted.find(
      (m) => 'requestId' in m && m.requestId === id && m.type !== 'progress',
    )!;
    if (result.type !== 'result' || result.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(result));
    return result;
  };
  const combOf = async (id: string, doc: CadDocument, bodyId: string, edge: string) => {
    const [mesh] = (await meshesOf(`${id}-mesh`, doc)).filter((m) => m.bodyId === bodyId);
    const index = edgeNames(mesh!).indexOf(edge);
    if (index < 0) throw new Error(`${edge} not in ${JSON.stringify(edgeNames(mesh!))}`);
    return (await analysed(id, doc, { comb: { bodyId, edge: index } })).comb!;
  };

  it('gives each mesh node its curvature and an edge its comb from the exact geometry (R2a-4, CAD43)', async () => {
    // A sphere: mean 1/r (convex, positive) and Gauss 1/r² at every node but the poles.
    const ball = sphere('ball', 10, 0);
    const plainBall = await evaluate('r2a4b-ball-plain', ball);
    const curved = await analysed('r2a4b-ball', ball, { curvature: true });
    if (plainBall.type !== 'result') throw new Error('result');
    // Display only: the evaluation and the meshes' nodes are those without the request.
    expect(curved.evaluation).toEqual(plainBall.evaluation);
    const [m] = curved.meshes;
    expect(m!.positions).toEqual(plainBall.meshes[0]!.positions);
    const { mean, gauss } = m!.curvature!;
    expect(mean).toHaveLength(m!.positions.length / 3);
    const finite = [...mean.keys()].filter((i) => Number.isFinite(mean[i]!));
    expect(finite.length).toBeGreaterThan(0.9 * mean.length);
    for (const i of finite) {
      expect(mean[i]).toBeCloseTo(0.1, 6);
      expect(gauss[i]).toBeCloseTo(0.01, 7);
    }
    // NaN only at the poles (z = ±r), where the surface has no tangent plane.
    for (let i = 0; i < mean.length; i++)
      if (!Number.isFinite(mean[i]!))
        expect(Math.abs(Math.abs(m!.positions[3 * i + 2]!) - 10)).toBeLessThan(1e-4);
    // Two planes are flat everywhere; two cylinder sheets of radius 20 have mean 1/40, Gauss 0.
    const box = await analysed('r2a4b-planes', f18Seams({ kind: 'bend', angleDeg: 10 }), {
      curvature: true,
    });
    for (const mesh of box.meshes)
      for (const v of [...mesh.curvature!.mean, ...mesh.curvature!.gauss]) expect(v).toBe(0);
    const tube = await analysed('r2a4b-tube', f18Seams({ kind: 'smooth' }), { curvature: true });
    for (const v of tube.meshes[0]!.curvature!.mean) expect(Math.abs(v)).toBeCloseTo(1 / 40, 9);
    for (const v of tube.meshes[0]!.curvature!.gauss) expect(Math.abs(v)).toBeLessThan(1e-12);
    // Not asked: no curvature.
    expect(plainBall.meshes[0]!.curvature).toBeUndefined();

    // The comb of a line is flat; of an arc of radius 20 centred at (40, 20), 1/20 toward the
    // centre at every sample.
    const seam = f18Seams({ kind: 'tangent' });
    const line = await combOf('r2a4b-line', seam, 'surface', 'side:e:l0 | start');
    if (!('samples' in line)) throw new Error(JSON.stringify(line));
    expect(line.samples).toHaveLength(cadCurvature.combSamples);
    for (const s of line.samples) expect(s).toMatchObject({ curvature: 0, normal: [0, 0, 0] });
    const arc = await combOf('r2a4b-arc', seam, 'surface', 'side:e:a1 | start');
    if (!('samples' in arc)) throw new Error(JSON.stringify(arc));
    expect(arc.samples).toHaveLength(cadCurvature.combSamples);
    for (const s of arc.samples) {
      expect(s.curvature).toBeCloseTo(0.05, 9);
      const centre = s.at.map((x, i) => x + s.normal[i]! / s.curvature);
      expect(centre[0]).toBeCloseTo(40, 6);
      expect(centre[1]).toBeCloseTo(20, 6);
      expect(centre[2]).toBeCloseTo(s.at[2], 9);
    }
    // The sphere's poles are points; its seam is a meridian of radius 10.
    const [sm] = plainBall.meshes;
    const combs = await Promise.all(
      sm!.topology.edges.map(
        async (_, i) =>
          (await analysed(`r2a4b-ball-comb-${i}`, ball, { comb: { bodyId: sm!.bodyId, edge: i } }))
            .comb!,
      ),
    );
    expect(combs.filter((c) => 'code' in c)).toEqual([
      { code: 'curvature-degenerate' },
      { code: 'curvature-degenerate' },
    ]);
    const meridian = combs.find((c) => 'samples' in c) as { samples: CadCombSample[] };
    for (const s of meridian.samples) expect(s.curvature).toBeCloseTo(0.1, 9);
    expect(
      (await analysed('r2a4b-missing', ball, { comb: { bodyId: sm!.bodyId, edge: 99 } })).comb,
    ).toEqual({
      code: 'curvature-edge-missing',
    });
    expect(
      (await analysed('r2a4b-ghost', ball, { comb: { bodyId: 'ghost', edge: 0 } })).comb,
    ).toEqual({
      code: 'curvature-edge-missing',
    });
  }, 120000);

  it('keeps a mirror whose union leaves two solids as one body of two (K1, CM-5)', async () => {
    const apart = f14Patterns('mirror');
    const m1 = apart.features.find((f) => f.id === 'm1')!;
    if (m1.type !== 'mirror') throw new Error('fixture');
    m1.args.plane = { origin: position(-5, 0, 0), normal: [1, 0, 0] };
    const result = await evaluate('r1-mirror-apart', apart);
    if (result.type !== 'result' || result.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(result));
    const [body] = Object.values(result.evaluation.bodies);
    expect(body).toMatchObject({ kind: 'solid', solids: 2 });
    // STEP writes each solid of the body as its own manifold_solid_brep (as for several bodies).
    const document = pinned(apart);
    await handle({
      type: 'evaluate',
      requestId: 'k1-step',
      generation: 1,
      baseHash: '',
      candidateHash: cadContentHash(document),
      document,
      step: true,
    });
    const written = posted.find(
      (m) => 'requestId' in m && m.requestId === 'k1-step' && m.type !== 'progress',
    )!;
    if (written.type !== 'result' || !written.step) throw new Error(written.type);
    const text = new TextDecoder().decode(written.step);
    expect(text.match(/MANIFOLD_SOLID_BREP\(/g)).toHaveLength(2);
    // A shell offsets one solid: a body of two is refused before its faces are read.
    const shelled = applyCadOperation(apart, {
      type: 'detailBody',
      bodyId: 'part',
      placementFeatureId: 'sh-placement',
      feature: {
        id: 'sh',
        name: 'Shell',
        type: 'shell',
        inputFeatureIds: ['m2-placement'],
        args: {
          openFaces: [faceRef('m2-placement', ['+z'], [20, 0, 10], 1200)],
          thickness: mm(2),
          side: 'inside',
        },
      },
    });
    expect(await evaluate('k1-shell', shelled)).toMatchObject({
      evaluation: { status: 'error', code: 'shell-multiple-solids', featureId: 'sh' },
    });
  });

  it('accepts the airliner wing mirrored and the bridge arches unbraced (K1, CM-5)', async () => {
    const kernel = { id: cadKernelBuild.id, buildHash };
    const solidsOf = async (id: string, doc: CadDocument) => {
      const result = await evaluate(id, doc);
      if (result.type !== 'result' || result.evaluation.status !== 'ok')
        throw new Error(JSON.stringify(result.type === 'result' ? result.evaluation : result));
      return Object.fromEntries(
        Object.entries(result.evaluation.bodies).flatMap(([b, e]) =>
          e.kind === 'solid' && e.solids ? [[b, e.solids]] : [],
        ),
      );
    };
    // The half wing's root inside the fuselage: the wing and its mirror image are apart.
    expect(await solidsOf('k1-f42', f42Airliner(kernel, { mirrored: true }))).toEqual({ wing: 2 });
    // Without the bracing the two arches (each with its hangers) no longer meet.
    expect(await solidsOf('k1-f41', f41Bridge(kernel, { braced: false }))).toEqual({ arches: 2 });
    // Hangers patterned apart: one body of 25 solids, its volume their total.
    const b = cadBuilder(kernel);
    const hanger = b.cylinder('Hanger', { radius: 90, height: 8000, origin: [0, 0, 0] });
    const copy = b.cylinder('Hanger copy', { radius: 90, height: 8000, origin: [5000, 0, 0] });
    b.pattern(
      hanger,
      copy,
      { type: 'linear', direction: [1, 0, 0], count: 24, spacing: 5000 },
      'union',
      'Hangers',
    );
    expect(await solidsOf('k1-hangers', b.document)).toEqual({ hanger: 25 });
  }, 300_000);

  it('joins the airliner wings to the fuselage with the large tolerance set only (K2, CM-6)', async () => {
    const kernel = { id: cadKernelBuild.id, buildHash };
    const joined = f42Airliner(kernel, { mirrored: true, joined: true });
    // The standard set refuses the union: its result's tolerance is above 0.0001 mm.
    expect(await evaluate('k2-standard', joined)).toMatchObject({
      evaluation: { status: 'error', code: 'result-tolerance' },
    });
    const large = f42Airliner(kernel, { mirrored: true, joined: true, tolerance: 'large' });
    const document = pinned(large);
    await handle({
      type: 'evaluate',
      requestId: 'k2-large',
      generation: 1,
      baseHash: '',
      candidateHash: cadContentHash(document),
      document,
      step: true,
    });
    const result = posted.find(
      (m) => 'requestId' in m && m.requestId === 'k2-large' && m.type !== 'progress',
    )!;
    if (result.type !== 'result' || result.evaluation.status !== 'ok' || !result.step)
      throw new Error(JSON.stringify(result.type === 'result' ? result.evaluation : result));
    // The wings are part of the airframe now: one body of one solid.
    expect(result.evaluation.bodies.airframe).toMatchObject({ kind: 'solid' });
    expect(result.evaluation.bodies.airframe).not.toHaveProperty('solids');
    expect(result.evaluation.bodies.wing).toBeUndefined();
    // The STEP header notes the set and the largest tolerance written; the report reads it.
    const report = stepReport(result.step, 7, { sourceContentHash: '', buildHash });
    expect(report.toleranceSet).toBe('large');
    expect(report.maxToleranceMm).toBeGreaterThan(
      cadToleranceSets.standard.maxResultLinearToleranceMm,
    );
    expect(report.maxToleranceMm).toBeLessThanOrEqual(
      cadToleranceSets.large.maxResultLinearToleranceMm,
    );
    expect(report.losses.join(' ')).toContain('tolerance set (large)');
  }, 300_000);

  it('the large set leaves representative models as the standard one makes them (K2, CM-6)', async () => {
    // Validity, solids, volume and bounds: what the preview of a set change compares.
    const kernel = { id: cadKernelBuild.id, buildHash };
    const models: [string, CadDocument][] = [
      ['f02', f02Plate()],
      ['f12', f12Fillet()],
      ['f13', f13ShellDraft({ draft: true })],
      ['f14', f14Patterns('mirror')],
      ['f15', f15Wing()],
      ['f17', f17Sheets('extrude')],
      ['f18', f18Hood()],
      ['r1', r1Housing()],
      ['f42', f42Airliner(kernel, { mirrored: true })],
    ];
    for (const [name, doc] of models) {
      const large = applyCadOperation(pinned(doc), { type: 'setToleranceSet', set: 'large' });
      const a = await evaluate(`k2-${name}-standard`, doc);
      const b = await evaluate(`k2-${name}-large`, large);
      if (a.type !== 'result' || a.evaluation.status !== 'ok') throw new Error(`${name} standard`);
      if (b.type !== 'result' || b.evaluation.status !== 'ok') throw new Error(`${name} large`);
      const before = a.evaluation.bodies;
      const after = b.evaluation.bodies;
      expect(Object.keys(after), name).toEqual(Object.keys(before));
      for (const [id, x] of Object.entries(before)) {
        const y = after[id]!;
        expect(y.kind, `${name} ${id}`).toBe(x.kind);
        if (x.kind === 'solid' && y.kind === 'solid') {
          expect(y.solids, `${name} ${id}`).toBe(x.solids);
          expect(Math.abs(y.volumeMm3 - x.volumeMm3) / x.volumeMm3, `${name} ${id}`).toBeLessThan(
            1e-6,
          );
        }
        x.bounds
          .flat()
          .forEach((v, i) =>
            expect(Math.abs(y.bounds.flat()[i]! - v), `${name} ${id}`).toBeLessThan(0.01),
          );
      }
    }
  }, 300_000);

  it('lofts to sections derived from a sketch section, following parameters (K6, CM-7a)', async () => {
    const okBody = async (id: string, doc: CadDocument, body: string) => {
      const result = await evaluate(id, doc);
      if (result.type !== 'result' || result.evaluation.status !== 'ok')
        throw new Error(JSON.stringify(result.type === 'result' ? result.evaluation : result));
      const e = result.evaluation.bodies[body]!;
      if (e.kind !== 'solid') throw new Error(e.kind);
      return e;
    };
    // F15's square base to its top half the size, 50 mm up: drawn, and derived from the base.
    const drawn = await okBody('k6-drawn', f15Loft('square'), 'loft');
    const derivedLoft = (offset: [number, number, number], scale: number, angle: number) => {
      const doc = structuredClone(f15Loft('square'));
      const args = doc.features[0]!.args as { sections: unknown[] };
      args.sections = [
        args.sections[0],
        {
          derivedFrom: 0,
          offset: offset.map((v) => ({ literalMm: v })),
          scale: { literal: scale },
          angle: { literalRad: angle },
        },
      ];
      return doc;
    };
    const same = await okBody('k6-same', derivedLoft([0, 0, 50], 0.5, 0), 'loft');
    expect(same.volumeMm3).toBeCloseTo(drawn.volumeMm3, 3);
    expect(same.volumeMm3).toBeCloseTo((50 / 3) * (1600 + 400 + 800), 3);
    // Moved 30 mm along u: the top's far side reaches 30 + 10.
    const moved = await okBody('k6-moved', derivedLoft([30, 0, 50], 0.5, 0), 'loft');
    expect(moved.bounds[1][0]).toBeCloseTo(40, 4);
    expect(moved.volumeMm3).toBeCloseTo(same.volumeMm3, 3);
    // Turned 45° at full size: its corners reach the half diagonal.
    const turned = await okBody('k6-turned', derivedLoft([0, 0, 50], 1, Math.PI / 4), 'loft');
    expect(turned.bounds[1][0]).toBeCloseTo(20 * Math.SQRT2, 4);
    // The airliner wing: its tip derived from its root follows `Half span`.
    const kernel = { id: cadKernelBuild.id, buildHash };
    const wing = await okBody('k6-f42', f42Airliner(kernel, { derived: true }), 'wing');
    expect(wing.solids).toBe(2);
    expect(wing.bounds[1][1]).toBeCloseTo(17_000, 3);
    const shorter = applyCadOperation(f42Airliner(kernel, { derived: true }), {
      type: 'setParameter',
      parameterId: 'half-span',
      value: 15_000,
    });
    const short = await okBody('k6-f42-short', shorter, 'wing');
    expect(short.bounds[0][1]).toBeCloseTo(-15_000, 3);
    expect(short.bounds[1][1]).toBeCloseTo(15_000, 3);
  }, 300_000);

  it('patterns copies along a sketch path, turned with it or not (K5a, CM-7b)', async () => {
    const okBody = async (id: string, doc: CadDocument, body: string) => {
      const result = await evaluate(id, doc);
      if (result.type !== 'result' || result.evaluation.status !== 'ok')
        throw new Error(JSON.stringify(result.type === 'result' ? result.evaluation : result));
      const e = result.evaluation.bodies[body]!;
      if (e.kind !== 'solid') throw new Error(e.kind);
      return e;
    };
    const kernel = { id: cadKernelBuild.id, buildHash };
    const bars = (align: boolean) => k5aBars(kernel, align);
    // Three bars: at the start, halfway along (on the line) and at the end, each 160 mm³.
    const plate = 160 * 70 * 4;
    const turned = await okBody('k5a-turned', bars(true), 'plate');
    expect(turned.volumeMm3).toBeCloseTo(plate + 3 * 160, 3);
    // At the end the path runs along +y: the turned bar spans y 45..55, x 148..152.
    expect(turned.bounds[1][0]).toBeCloseTo(152, 4);
    expect(turned.bounds[1][1]).toBeCloseTo(55, 4);
    const kept = await okBody('k5a-kept', bars(false), 'plate');
    expect(kept.bounds[1][0]).toBeCloseTo(155, 4);
    expect(kept.bounds[1][1]).toBeCloseTo(52, 4);
    // F41's lamps along the arch, 3° in from its feet: the middle one at the crown on the outer
    // face, turned from the first by a quarter turn less the first one's angle.
    const arches = await okBody('k5a-f41', f41Bridge(kernel, { lamps: true }), 'arches');
    const rise = f41.crown - f41.springing;
    const R = f41.span ** 2 / 8 / rise + rise / 2;
    const [cz, ro] = [f41.crown - R, R + 600];
    const first =
      Math.atan2(f41.springing - cz, Math.sqrt(ro ** 2 - (f41.springing - cz) ** 2)) +
      (3 * Math.PI) / 180;
    const turn = Math.PI / 2 - first;
    expect(arches.bounds[1][2]).toBeCloseTo(
      f41.crown + 600 + 400 * (Math.abs(Math.cos(turn)) + Math.abs(Math.sin(turn))),
      2,
    );
  }, 300_000);

  it('refuses a body of more than 1,024 solids (K1, CM-5)', async () => {
    const b = cadBuilder({ id: cadKernelBuild.id, buildHash });
    const studs = b.box('Studs', { size: [1, 1, 1], origin: [0, 0, 0] });
    const row = (y: number, count: number, name: string) =>
      b.pattern(
        studs,
        b.box(`${name} stud`, { size: [1, 1, 1], origin: [2, y, 0] }),
        { type: 'linear', direction: [1, 0, 0], count, spacing: 2 },
        'union',
        name,
      );
    row(0, 1000, 'Row 1');
    row(2, 23, 'Row 2');
    // 1 + 1,000 + 23: exactly the limit.
    const full = b.document;
    const atLimit = await evaluate('k1-1024', full);
    if (atLimit.type !== 'result' || atLimit.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(atLimit));
    expect(atLimit.evaluation.bodies.studs).toMatchObject({ solids: 1024 });
    const row3 = row(4, 1, 'Row 3');
    expect(await evaluate('k1-1025', b.document)).toMatchObject({
      evaluation: { status: 'error', code: 'multiple-solids', featureId: row3 },
    });
  }, 300_000);

  it('reports feature errors, a foreign build and cancellation without results', async () => {
    const disjoint = applyCadOperation(f05Dependencies(0), {
      type: 'booleanBodies',
      targetId: 'a',
      toolId: 'b',
      mode: 'union',
      booleanFeatureId: 'u',
      placementFeatureId: 'u-placement',
    });
    // K1: two posts apart are one body of two solids, measured as their total.
    const apart = await evaluate('split', disjoint);
    const posts = await evaluate('split-posts', f05Dependencies(0));
    if (apart.type !== 'result' || apart.evaluation.status !== 'ok') throw new Error(apart.type);
    if (posts.type !== 'result' || posts.evaluation.status !== 'ok') throw new Error(posts.type);
    const total = Object.values(posts.evaluation.bodies).reduce(
      (n, b) => n + (b.kind === 'solid' ? b.volumeMm3 : 0),
      0,
    );
    expect(apart.evaluation.bodies.a).toMatchObject({ kind: 'solid', solids: 2 });
    expect((apart.evaluation.bodies.a as { volumeMm3: number }).volumeMm3).toBeCloseTo(total, 6);
    // Posts whose sides only touch along a line: a degenerate Boolean in every mode (ST-28#1).
    const touching = structuredClone(f05Dependencies(0));
    touching.profiles.find((p) => p.id === 'profile-b')!.plane.origin = position(20, 0, 0);
    const codes = { union: 'solids-touching', cut: 'boolean-no-overlap', common: 'empty-result' };
    for (const mode of ['union', 'cut', 'common'] as const) {
      const doc = applyCadOperation(touching, {
        type: 'booleanBodies',
        targetId: 'a',
        toolId: 'b',
        mode,
        booleanFeatureId: 't',
        placementFeatureId: 't-placement',
      });
      expect(await evaluate(`touch-${mode}`, doc), mode).toMatchObject({
        evaluation: { status: 'error', code: codes[mode], featureId: 't' },
      });
    }
    // A genuine cut is not refused for being small next to the target: 0.5 mm post into the
    // rim of a 1000 mm one removes ~2 mm³ of ~3.1e9 mm³ (ST-28#1).
    const small = structuredClone(f05Dependencies(0));
    small.parameters[0].value = 1000;
    const tool = small.profiles.find((p) => p.id === 'profile-b')!;
    tool.plane.origin = position(999.8, 0, 0);
    tool.shape = { type: 'circle', radius: mm(0.5) };
    const smallCut = applyCadOperation(small, {
      type: 'booleanBodies',
      targetId: 'a',
      toolId: 'b',
      mode: 'cut',
      booleanFeatureId: 't',
      placementFeatureId: 't-placement',
    });
    expect(await evaluate('small-cut', smallCut)).toMatchObject({ evaluation: { status: 'ok' } });
    const foreign = f03Revolve();
    await handle({
      type: 'evaluate',
      requestId: 'foreign',
      generation: 1,
      baseHash: '',
      candidateHash: cadContentHash(foreign),
      document: foreign,
    });
    expect(posted.at(-1)).toMatchObject({ evaluation: { code: 'kernel-build-unavailable' } });
    const job = evaluate('cancel-me', f02Plate());
    await handle({ type: 'cancel', requestId: 'cancel-me' });
    expect(await job).toEqual({ type: 'cancelled', requestId: 'cancel-me' });
    // The same instance continues after cancel.
    expect(await evaluate('after', f03Revolve())).toMatchObject({ evaluation: { status: 'ok' } });
  });

  it('keeps small bodies far from the origin distinct in the Float32 mesh', async () => {
    const far = 999_990;
    const doc = applyCadOperation(f01Empty(), {
      type: 'insertFeatures',
      parameters: [],
      profiles: [],
      features: [
        {
          id: 'tiny',
          name: 'Tiny',
          type: 'box',
          inputFeatureIds: [],
          args: {
            size: [mm(0.01), mm(0.01), mm(0.01)],
            origin: position(far, far, far),
            orientation: identityQuaternion(),
          },
        },
      ],
      bodies: [
        {
          id: 'tiny-body',
          name: 'Tiny',
          sourceFeatureId: 'tiny',
          placementFeatureId: 'tiny-placement',
          appearance: { color: '#9aa4b1', opacity: 1 },
        },
      ],
    });
    const result = await evaluate('far', doc);
    if (result.type !== 'result' || result.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(result));
    const [mesh] = result.meshes;
    const [min, max] = result.evaluation.bodies['tiny-body'].bounds;
    for (let i = 0; i < mesh.positions.length; i += 3)
      for (let j = 0; j < 3; j++) {
        const world = mesh.origin[j] + mesh.positions[i + j];
        expect(world).toBeGreaterThanOrEqual(min[j] - 1e-6);
        expect(world).toBeLessThanOrEqual(max[j] + 1e-6);
      }
    // No triangle collapses: every normal is a unit vector.
    for (let i = 0; i < mesh.normals.length; i += 3)
      expect(Math.hypot(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2])).toBeCloseTo(
        1,
        5,
      );
  });

  it("shows an earlier build's document only as a declared reference (CAD17)", async () => {
    const document = f02Plate();
    document.kernelProfile.buildHash = `sha256:${'e'.repeat(64)}`;
    const send = async (requestId: string, reference?: true) => {
      await handle({
        type: 'evaluate',
        requestId,
        generation: 1,
        baseHash: '',
        candidateHash: cadContentHash(document),
        document,
        ...(reference ? { reference } : {}),
      });
      return posted.find(
        (m) => 'requestId' in m && m.requestId === requestId && m.type !== 'progress',
      )!;
    };
    expect(await send('exact-only')).toMatchObject({
      evaluation: { status: 'error', code: 'kernel-build-unavailable' },
    });
    const shown = await send('reference', true);
    if (shown.type !== 'result') throw new Error(shown.type);
    // The result names the build that ran, never the document's own.
    expect(shown.evaluation).toMatchObject({ status: 'ok', buildHash, reference: true });
    expect(shown.meshes.length).toBe(1);
  });

  it('writes STEP from the exact shapes that an independent reader reads back (CAD11)', async () => {
    for (const [name, doc] of [
      ['f02', f02Plate()],
      ['f03', f03Revolve()],
      // Two active bodies: one root solid each in the same AP214 file (ST-88).
      ['f05', f05Dependencies()],
    ] as const) {
      const document = pinned(doc);
      await handle({
        type: 'evaluate',
        requestId: `step-${name}`,
        generation: 1,
        baseHash: '',
        candidateHash: cadContentHash(document),
        document,
        step: true,
      });
      const result = posted.find(
        (m) => 'requestId' in m && m.requestId === `step-${name}` && m.type !== 'progress',
      )!;
      if (result.type !== 'result' || result.evaluation.status !== 'ok' || !result.step)
        throw new Error(JSON.stringify(result));
      const text = new TextDecoder().decode(result.step);
      expect(text.startsWith('ISO-10303-21;')).toBe(true);
      expect(text).toMatch(/AUTOMOTIVE_DESIGN/);
      expect(text).toMatch(/SI_UNIT\(\.MILLI\.,\.METRE\.\)/);
      // Read back with OCCT's STEP reader (a separate code path from the writer).
      const path = `/readback-${name}.step`;
      oc.FS.writeFile(path, result.step);
      const reader = new oc.STEPControl_Reader_1();
      expect(reader.ReadFile(path)).toBe(oc.IFSelect_ReturnStatus.IFSelect_RetDone);
      reader.TransferRoots(new oc.Message_ProgressRange_1());
      const shape = reader.OneShape();
      let solids = 0;
      const ex = new oc.TopExp_Explorer_2(
        shape,
        oc.TopAbs_ShapeEnum.TopAbs_SOLID,
        oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
      );
      for (; ex.More(); ex.Next()) solids++;
      const props = new oc.GProp_GProps_1();
      oc.BRepGProp.VolumeProperties_1(shape, props, false, false, false);
      const exact = Object.values(result.evaluation.bodies).reduce(
        (v, b) => v + solid(b).volumeMm3,
        0,
      );
      expect(solids).toBe(Object.keys(result.evaluation.bodies).length);
      expect(Math.abs(props.Mass() / exact - 1)).toBeLessThan(1e-6);
      oc.FS.unlink(path);
      for (const x of [props, ex, shape, reader]) x.delete();
    }
  });

  const importFile = async (requestId: string, bytes: Uint8Array) => {
    await handle({ type: 'import-step', requestId, bytes });
    const message = posted.find((m) => 'requestId' in m && m.requestId === requestId);
    if (message?.type !== 'import-result') throw new Error(JSON.stringify(message));
    return message.result;
  };
  const corpus = (name: string) => new Uint8Array(readFileSync(corpusFile(name)));
  /** Volume and bounds read by the native OCCT 8.0 reader (f07-corpus.py), in mm. */
  const reference: Record<string, [string, number, number[]]> = {
    'normal-mm-plate.step': ['mm', 19607.300918, [0, 0, 0, 80, 50, 5]],
    'normal-ap203.step': ['mm', 19607.300918, [0, 0, 0, 80, 50, 5]],
    'normal-colour.step': ['mm', 19607.300918, [0, 0, 0, 80, 50, 5]],
    'normal-inch-block.step': ['in', 16387.064, [0, 0, 0, 50.8, 25.4, 12.7]],
    'normal-m-cone.step': ['m', 16493361.43134, [-200, -200, 0, 200, 200, 300]],
    'normal-analytic.step': ['mm', 60431.434744, [-40, -40, -12, 42, 40, 12]],
  };

  it('imports the normal F07 files as one solid in mm, as an independent reader measures (CAD11)', async () => {
    for (const [name, [unit, volume, bounds]] of Object.entries(reference)) {
      const result = await importFile(`f07-${name}`, corpus(name));
      if (result.status !== 'ok') throw new Error(`${name}: ${JSON.stringify(result)}`);
      const { report } = result;
      expect(report.sourceUnit, name).toBe(unit);
      expect(Math.abs(solid(report.body).volumeMm3 / volume - 1), name).toBeLessThan(1e-6);
      // Bounding boxes of curved faces are padded a little; planes are exact.
      report.body.bounds.flat().forEach((v, i) => expect(v, name).toBeCloseTo(bounds[i], 2));
      expect(report.maxToleranceMm, name).toBeLessThanOrEqual(1e-4);
      expect(report.source.byteLength).toBe(corpus(name).byteLength);
      expect(report.brep.byteLength).toBe(result.brep.byteLength);
      expect(new TextDecoder().decode(result.brep.subarray(0, 64))).toMatch(/CASCADE Topology/);
    }
    const losses = async (name: string) => {
      const r = await importFile(`loss-${name}`, corpus(name));
      return r.status === 'ok' ? r.report.losses : [];
    };
    expect(await losses('normal-colour.step')).toContain('appearance');
  });

  it('refuses the F07 files outside the D2 subset with their reason', async () => {
    const expected: Record<string, string> = {
      'reject-ap242.step': 'step-schema-unsupported',
      'reject-assembly.step': 'step-assembly',
      'reject-pmi-dimension.step': 'step-pmi',
      'reject-external-reference.step': 'step-external-reference',
      'reject-not-step.step': 'step-unreadable',
      'reject-truncated.step': 'step-unreadable',
      'reject-two-shells.step': 'step-multiple-shells',
      'reject-two-solids.step': 'step-multiple-solids',
      'reject-free-face.step': 'step-not-single-solid',
      'reject-tolerance-gap.step': 'step-tolerance-unsupported',
      'reject-unit-mile.step': 'step-unit-unknown',
    };
    for (const [name, code] of Object.entries(expected))
      expect(await importFile(`f07-${name}`, corpus(name)), name).toMatchObject({
        status: 'rejected',
        code,
      });
    // The kernel's own reading of a widened tolerance, not a fixed message.
    const gap = await importFile('gap', corpus('reject-tolerance-gap.step'));
    expect(gap.status === 'rejected' && Number(gap.detail)).toBeGreaterThan(1e-4);
  });

  it('evaluates an imported body from its BRep and round-trips it through STEP (CAD11, ST-29#1)', async () => {
    const step = corpus('normal-inch-block.step');
    const read = await importFile('round-1', step);
    if (read.status !== 'ok') throw new Error(JSON.stringify(read));
    const { report, brep } = read;
    const doc = pinned(
      applyCadOperation(f01Empty(), {
        type: 'insertImportedBody',
        assets: [
          { id: 's', kind: 'source-step', ...report.source, mediaType: 'model/step' },
          { id: 'b', kind: 'normalized-brep', ...report.brep, mediaType: 'model/x-occt-brep' },
        ].map(({ id, kind, sha256, byteLength, mediaType }) => ({
          id,
          kind: kind as 'source-step' | 'normalized-brep',
          sha256,
          byteLength,
          mediaType,
        })),
        feature: {
          id: 'imp',
          name: 'block',
          type: 'imported',
          inputFeatureIds: [],
          args: {
            kind: report.body.kind,
            sourceAssetId: 's',
            brepAssetId: 'b',
            importer: { id: 'dev', buildHash },
            sourceUnit: report.sourceUnit,
            scaleToMm: report.scaleToMm,
          },
        },
        body: {
          id: 'block',
          name: 'block',
          sourceFeatureId: 'imp',
          placementFeatureId: 'imp-placement',
          appearance: { color: '#8899aa', opacity: 1 },
        },
      }),
    );
    const run = async (requestId: string, assets: Record<string, Uint8Array>, step?: true) => {
      await handle({
        type: 'evaluate',
        requestId,
        generation: 1,
        baseHash: '',
        candidateHash: cadContentHash(doc),
        document: doc,
        assets,
        ...(step ? { step } : {}),
      });
      return posted.find(
        (m) => 'requestId' in m && m.requestId === requestId && m.type !== 'progress',
      )!;
    };
    const evaluated = await run('round-2', { [report.brep.sha256]: brep }, true);
    if (evaluated.type !== 'result' || evaluated.evaluation.status !== 'ok' || !evaluated.step)
      throw new Error(JSON.stringify(evaluated));
    // The stored BRep gives exactly the shape the reader produced.
    expect(evaluated.evaluation.bodies.block).toEqual(report.body);
    // Written back as STEP (mm) and read again: same solid, volume and bounds.
    const again = await importFile('round-3', evaluated.step);
    if (again.status !== 'ok') throw new Error(JSON.stringify(again));
    expect(again.report.sourceUnit).toBe('mm');
    expect(
      Math.abs(solid(again.report.body).volumeMm3 / solid(report.body).volumeMm3 - 1),
    ).toBeLessThan(1e-9);
    again.report.body.bounds
      .flat()
      .forEach((v, i) => expect(v).toBeCloseTo(report.body.bounds.flat()[i], 6));
    // A display evaluation keeps the imported shape for placement-only changes (CAD25); the
    // kept shape does not excuse the bytes: missing or altered bytes never evaluate.
    expect(await run('round-3b', { [report.brep.sha256]: brep })).toMatchObject({
      evaluation: { status: 'ok' },
    });
    expect(await run('round-4', {})).toMatchObject({
      evaluation: { status: 'error', code: 'asset-missing', featureId: 'imp' },
    });
    const altered = brep.slice();
    altered[altered.length - 2] ^= 1;
    expect(await run('round-5', { [report.brep.sha256]: altered })).toMatchObject({
      evaluation: { status: 'error', code: 'asset-hash-mismatch' },
    });
    // The same feature and asset IDs naming other bytes (CM-3): the Worker's feature cache
    // builds the new shape, never the one it kept for the first bytes.
    const other = await importFile('round-6', corpus('normal-mm-plate.step'));
    if (other.status !== 'ok') throw new Error(JSON.stringify(other));
    const swapped = pinned({
      ...doc,
      assets: doc.assets.map((a) =>
        a.id === 'b'
          ? { ...a, sha256: other.report.brep.sha256, byteLength: other.report.brep.byteLength }
          : a,
      ),
    });
    await handle({
      type: 'evaluate',
      requestId: 'round-7',
      generation: 1,
      baseHash: '',
      candidateHash: cadContentHash(swapped),
      document: swapped,
      assets: { [other.report.brep.sha256]: other.brep },
    });
    const replaced = posted.find(
      (m) => 'requestId' in m && m.requestId === 'round-7' && m.type !== 'progress',
    )!;
    if (replaced.type !== 'result' || replaced.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(replaced));
    const uncached = await evaluateCad(oc, swapped, cadContentHash(swapped), {
      assets: new Map([[other.report.brep.sha256, other.brep]]),
    });
    expect(replaced.evaluation).toEqual(uncached.evaluation);
    expect(solid(replaced.evaluation.bodies.block).volumeMm3).not.toBeCloseTo(
      solid(report.body).volumeMm3,
      0,
    );
  });

  it('imports a shell without a solid as a sheet and round-trips sheets through STEP (R2a-1, CAD39)', async () => {
    const sheetOf = (b: CadBodyEvaluation) => {
      if (b.kind !== 'sheet') throw new Error(`not a sheet: ${JSON.stringify(b)}`);
      return b;
    };
    const stepOf = async (
      requestId: string,
      doc: CadDocument,
      assets?: Record<string, Uint8Array>,
    ) => {
      const document = pinned(doc);
      await handle({
        type: 'evaluate',
        requestId,
        generation: 1,
        baseHash: '',
        candidateHash: cadContentHash(document),
        document,
        ...(assets ? { assets } : {}),
        step: true,
      });
      const result = posted.find(
        (m) => 'requestId' in m && m.requestId === requestId && m.type !== 'progress',
      )!;
      if (result.type !== 'result' || result.evaluation.status !== 'ok' || !result.step)
        throw new Error(JSON.stringify(result));
      return { evaluation: result.evaluation, step: result.step };
    };
    // Written for the independent reader (docs/verification/cad-r2a-1).
    const dir = process.env.CAD_R2A_STEP_DIR ?? '/tmp/cad-r2a-step';
    mkdirSync(dir, { recursive: true });
    // An open box (five faces) and a closed one (six faces, no solid): both stay sheets.
    for (const [name, area, free] of [
      ['sheet-open-box.step', 500, 4],
      ['sheet-closed-box.step', 600, 0],
    ] as const) {
      const read = await importFile(`sheet-${name}`, corpus(name));
      if (read.status !== 'ok') throw new Error(`${name}: ${JSON.stringify(read)}`);
      const body = sheetOf(read.report.body);
      expect(body.areaMm2, name).toBeCloseTo(area, 6);
      expect(body.freeEdges, name).toBe(free);
      expect(body.freeEdgeLengthMm, name).toBeCloseTo(free * 10, 6);
      const { report, brep } = read;
      const doc = applyCadOperation(f01Empty(), {
        type: 'insertImportedBody',
        assets: [
          { id: 's', kind: 'source-step' as const, ...report.source, mediaType: 'model/step' },
          {
            id: 'b',
            kind: 'normalized-brep' as const,
            ...report.brep,
            mediaType: 'model/x-occt-brep',
          },
        ].map(({ id, kind, sha256, byteLength, mediaType }) => ({
          id,
          kind,
          sha256,
          byteLength,
          mediaType,
        })),
        feature: {
          id: 'imp',
          name: 'sheet',
          type: 'imported',
          inputFeatureIds: [],
          args: {
            kind: 'sheet',
            sourceAssetId: 's',
            brepAssetId: 'b',
            importer: { id: 'dev', buildHash },
            sourceUnit: report.sourceUnit,
            scaleToMm: report.scaleToMm,
          },
        },
        body: {
          id: 'sheet',
          name: 'sheet',
          sourceFeatureId: 'imp',
          placementFeatureId: 'imp-placement',
          appearance: { color: '#8899aa', opacity: 1 },
        },
      });
      expect(doc.bodies[0]!.kind).toBe('sheet');
      const out = await stepOf(`sheet-out-${name}`, doc, { [report.brep.sha256]: brep });
      expect(out.evaluation.bodies.sheet).toEqual(report.body);
      const again = await importFile(`sheet-again-${name}`, out.step);
      if (again.status !== 'ok') throw new Error(JSON.stringify(again));
      expect(sheetOf(again.report.body)).toMatchObject({ freeEdges: free });
      expect(again.report.body.areaMm2).toBeCloseTo(area, 6);
    }
    // Sheets made here: a sheet is written as a shell_based_surface_model, never as a solid.
    for (const variant of ['extrude', 'closed', 'revolve'] as const) {
      const { evaluation, step } = await stepOf(`sheet-f17-${variant}`, f17Sheets(variant));
      const text = new TextDecoder().decode(step);
      expect(text, variant).toMatch(/SHELL_BASED_SURFACE_MODEL/);
      expect(text, variant).not.toMatch(/MANIFOLD_SOLID_BREP/);
      writeFileSync(`${dir}/f17-${variant}.step`, step);
      const read = await importFile(`sheet-f17-back-${variant}`, step);
      if (read.status !== 'ok') throw new Error(`${variant}: ${JSON.stringify(read)}`);
      const [made, back] = [sheetOf(evaluation.bodies.surface!), sheetOf(read.report.body)];
      expect(back.freeEdges, variant).toBe(made.freeEdges);
      expect(back.areaMm2 / made.areaMm2, variant).toBeCloseTo(1, 9);
    }
  });

  it('exports closed STL meshes of F02 and F03 at both export triangulations (CAD12)', async () => {
    for (const [name, doc, body] of [
      ['f02', f02Plate(), 'plate'],
      ['f03', f03Revolve(), 'ring'],
    ] as const) {
      const counts: number[] = [];
      for (const deflectionMm of [0.05, 0.01]) {
        const result = await evaluate(`${name}-${deflectionMm}`, doc, deflectionMm);
        if (result.type !== 'result' || result.evaluation.status !== 'ok')
          throw new Error(JSON.stringify(result));
        const exact = solid(Object.values(result.evaluation.bodies)[0]).volumeMm3;
        const bodies = result.meshes.map((mesh) => ({
          name: body,
          kind: 'solid' as const,
          appearance: { color: '#8aa1b8', opacity: 1 },
          mesh,
        }));
        expect(() => checkClosedMesh(bodies)).not.toThrow();
        const { bytes, report } = writeStl(bodies, {
          sourceContentHash: result.evaluation.contentHash,
          buildHash,
          deflectionMm,
        });
        // Signed volume from the file's own float32 facets, in millimetres.
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const triangles = view.getUint32(80, true);
        expect(triangles).toBe(report.triangles);
        let signed = 0;
        for (let t = 0; t < triangles; t++) {
          const v = Array.from({ length: 9 }, (_, k) =>
            view.getFloat32(84 + t * 50 + 12 + k * 4, true),
          );
          signed +=
            (v[0] * (v[4] * v[8] - v[5] * v[7]) -
              v[1] * (v[3] * v[8] - v[5] * v[6]) +
              v[2] * (v[3] * v[7] - v[4] * v[6])) /
            6;
        }
        expect(Math.abs(signed / exact - 1)).toBeLessThan(0.01);
        counts.push(triangles);
      }
      // The finer export triangulation is not coarser than the standard one.
      expect(counts[1]).toBeGreaterThanOrEqual(counts[0]);
    }
  });

  it('meshes a 3.6 m sphere like a 3.6 mm one: deflection follows the body size (#372)', async () => {
    const triangles = async (radius: number) => {
      const started = performance.now();
      const result = await evaluate(`sphere-${radius}`, sphere('hub', radius, 0));
      const ms = performance.now() - started;
      if (result.type !== 'result' || result.evaluation.status !== 'ok')
        throw new Error(JSON.stringify(result));
      const { volumeMm3, bounds } = solid(result.evaluation.bodies['hub-body']);
      expect(volumeMm3 / ((4 / 3) * Math.PI * radius ** 3)).toBeCloseTo(1, 6);
      expect(bounds[1][0]).toBeCloseTo(radius, 3);
      return { count: result.meshes[0].indices.length / 3, ms };
    };
    const small = await triangles(3.6);
    const large = await triangles(3600);
    expect(large.count).toBe(small.count);
    expect(large.count).toBeLessThan(10_000);
    // The fixed 0.05 mm deflection ran for 93 s before output-limit; the job limit is 30 s.
    expect(large.ms).toBeLessThan(5_000);
    // Progress names each feature, then each body before its mesh.
    expect(
      posted
        .filter((m) => m.type === 'progress' && m.requestId === 'sphere-3600')
        .map((m) => (m as { elementId: string }).elementId),
    ).toEqual(['hub', 'hub-placement', 'hub-body']);
  });

  it('the opt-in timing callback reports each feature and body without changing the result', async () => {
    const doc = pinned(f02Plate());
    const hash = cadContentHash(doc);
    const plain = await evaluateCad(oc, doc, hash);
    const timed: [string, string, number][] = [];
    const withTiming = await evaluateCad(oc, doc, hash, {
      timing: (phase, id, ms) => timed.push([phase, id, ms]),
    });
    expect(withTiming.evaluation).toEqual(plain.evaluation);
    expect(plain.evaluation.status).toBe('ok');
    // Each feature once, in evaluation order.
    const features = timed.filter(([phase]) => phase === 'feature').map(([, id]) => id);
    expect([...features].sort()).toEqual(doc.features.map((f) => f.id).sort());
    expect(timed.filter(([phase]) => phase === 'mesh').map(([, id]) => id)).toEqual(['plate']);
    expect(timed.every(([, , ms]) => ms >= 0)).toBe(true);
  });

  it('moves a body from its kept shape exactly as the full graph does, and falls back outside the path (CAD25)', async () => {
    // F02 plus a sphere: two active bodies with literal placements.
    const base = applyCadOperation(f02Plate(), {
      type: 'insertFeatures',
      parameters: [],
      profiles: [],
      features: [
        {
          id: 'ball',
          name: 'ball',
          type: 'sphere',
          inputFeatureIds: [],
          args: { radius: mm(8), origin: position(120, 25, 8), orientation: identityQuaternion() },
        },
      ],
      bodies: [
        {
          id: 'ball-body',
          name: 'ball',
          sourceFeatureId: 'ball',
          placementFeatureId: 'ball-placement',
          appearance: { color: '#9aa4b1', opacity: 1 },
        },
      ],
    });
    const move = (
      doc: CadDocument,
      x: number,
      y: number,
      z: number,
      rotation = identityQuaternion(),
    ) =>
      applyCadOperation(doc, {
        type: 'transformBody',
        bodyId: 'plate',
        translation: position(x, y, z),
        rotation,
      });
    const run = async (doc: CadDocument, placement?: PlacementCache, deflectionMm?: number) => {
      const document = pinned(doc);
      let built = 0;
      const result = await evaluateCad(oc, document, cadContentHash(document), {
        ...(placement ? { placement } : {}),
        ...(deflectionMm === undefined ? {} : { deflectionMm }),
        timing: (phase) => void (phase === 'feature' && built++),
      });
      if (result.evaluation.status !== 'ok') throw new Error(JSON.stringify(result.evaluation));
      return { ...result, built };
    };
    /** The full graph with no kept shapes: the reference every fast result must equal. */
    const full = (doc: CadDocument) => run(doc);
    const same = async (fast: Awaited<ReturnType<typeof run>>, doc: CadDocument) => {
      const reference = await full(doc);
      // Same metrics, bounds and mesh bytes (the digest covers every position, index and face):
      // pick and PNG read only these.
      expect(fast.evaluation).toEqual(reference.evaluation);
      expect(fast.meshes).toEqual(reference.meshes);
    };
    const cache = new PlacementCache();
    try {
      const first = await run(base, cache);
      expect(first.built).toBe(base.features.length);
      expect(cache.bodies.size).toBe(2);

      // A translation: no feature is built again, and each body is placed and meshed once.
      const moved = move(base, 30, -20, 7);
      const fast = await run(moved, cache);
      expect(fast.built).toBe(0);
      await same(fast, moved);
      // A quarter turn keeps the bounding-box diagonal, so the display deflection too.
      const turned = move(base, 10, 0, 0, [0, 0, Math.SQRT1_2, Math.SQRT1_2]);
      const quarter = await run(turned, cache);
      expect(quarter.built).toBe(0);
      await same(quarter, turned);
      // The kept shapes were never changed: moving back reproduces the first result exactly.
      const back = await run(base, cache);
      expect(back.built).toBe(0);
      expect(back.evaluation).toEqual(first.evaluation);
      expect(back.meshes).toEqual(first.meshes);

      // Outside the path, the full graph: a pose that changes the display deflection, a
      // parameter, and an export triangulation (which neither uses nor refreshes the cache).
      const tilted = move(base, 0, 0, 0, [0, 0, Math.sin(Math.PI / 12), Math.cos(Math.PI / 12)]);
      const tilt = await run(tilted, cache);
      expect(tilt.built).toBe(base.features.length);
      await same(tilt, tilted);
      const exported = await run(moved, cache, 0.01);
      expect(exported.built).toBe(base.features.length);
      const afterExport = await run(
        move(tilted, 5, 5, 5, [0, 0, Math.sin(Math.PI / 12), Math.cos(Math.PI / 12)]),
        cache,
      );
      expect(afterExport.built).toBe(0);
      const wider = applyCadOperation(moved, {
        type: 'setParameter',
        parameterId: 'W',
        value: 100,
      });
      const widened = await run(wider, cache);
      expect(widened.built).toBe(base.features.length);
      await same(widened, wider);
      // A placement bound to a parameter is evaluated through the graph, never moved directly.
      const bound = applyCadOperation(wider, {
        type: 'transformBody',
        bodyId: 'plate',
        translation: [{ affine: { parameterId: 'W', scale: 0.1, offsetMm: 0 } }, mm(0), mm(0)],
        rotation: identityQuaternion(),
        unbind: true,
      });
      expect((await run(bound, cache)).built).toBe(base.features.length);
      const boundWider = applyCadOperation(bound, {
        type: 'setParameter',
        parameterId: 'W',
        value: 90,
      });
      const rebuilt = await run(boundWider, cache);
      expect(rebuilt.built).toBe(base.features.length);
      await same(rebuilt, boundWider);
    } finally {
      cache.release();
    }
  });

  it('keeps a sheet’s boundary names on the literal-placement path (CAD25, CAD41)', async () => {
    const run = async (doc: CadDocument, placement?: PlacementCache) => {
      const document = pinned(doc);
      let built = 0;
      const result = await evaluateCad(oc, document, cadContentHash(document), {
        ...(placement ? { placement } : {}),
        timing: (phase) => void (phase === 'feature' && built++),
      });
      if (result.evaluation.status !== 'ok') throw new Error(JSON.stringify(result.evaluation));
      return { ...result, built };
    };
    const tube = f17Sheets('closed');
    const moved = applyCadOperation(tube, {
      type: 'transformBody',
      bodyId: 'surface',
      translation: position(30, -20, 7),
      rotation: identityQuaternion(),
    });
    const cache = new PlacementCache();
    try {
      await run(tube, cache);
      const fast = await run(moved, cache);
      expect(fast.built).toBe(0);
      // The eight open edges keep their names: the same table as the full graph's.
      const reference = await run(moved);
      expect(fast.meshes).toEqual(reference.meshes);
      expect(fast.meshes[0]!.topology.edges.filter((e) => e.boundary)).toHaveLength(8);
    } finally {
      cache.release();
    }
  });

  it('evaluates bodies that share a feature through the full graph every time (CAD25)', async () => {
    // One cylinder placed twice. The tilted body has the larger box, so the coarser mesh; the
    // upright body, meshed after it, refines the faces both share.
    const shared = applyCadOperation(
      applyCadOperation(f01Empty(), {
        type: 'insertFeatures',
        parameters: [],
        profiles: [],
        features: [
          {
            id: 'rod',
            name: 'rod',
            type: 'cylinder',
            inputFeatureIds: [],
            args: {
              radius: mm(5),
              height: mm(60),
              origin: position(0, 0, 0),
              orientation: identityQuaternion(),
            },
          },
        ],
        bodies: ['tilted', 'upright'].map((id) => ({
          id,
          name: id,
          sourceFeatureId: 'rod',
          placementFeatureId: `${id}-placement`,
          appearance: { color: '#9aa4b1', opacity: 1 },
        })),
      }),
      {
        type: 'transformBody',
        bodyId: 'tilted',
        translation: position(40, 0, 0),
        rotation: [Math.sin(Math.PI / 6), 0, 0, Math.cos(Math.PI / 6)],
      },
    );
    const doc = pinned(shared);
    const run = async (placement?: PlacementCache) => {
      let built = 0;
      const result = await evaluateCad(oc, doc, cadContentHash(doc), {
        ...(placement ? { placement } : {}),
        timing: (phase) => void (phase === 'feature' && built++),
      });
      if (result.evaluation.status !== 'ok') throw new Error(JSON.stringify(result.evaluation));
      return { ...result, built };
    };
    const reference = await run();
    const cache = new PlacementCache();
    try {
      for (let round = 0; round < 2; round++) {
        const again = await run(cache);
        expect(again.built).toBe(doc.features.length);
        expect(again.evaluation).toEqual(reference.evaluation);
        expect(again.meshes).toEqual(reference.meshes);
      }
      expect(cache.bodies.size).toBe(0);
    } finally {
      cache.release();
    }
  });

  it('builds only the edited features and those downstream, as the full graph does (CM-3, P1・P2)', async () => {
    // F12 plus a ball: two active bodies, a Boolean, a fillet and two parameters.
    const ball = sphere('ball', 10, 300);
    const base = applyCadOperation(f12Fillet(), {
      type: 'insertFeatures',
      features: ball.features.filter((f) => f.id === 'ball'),
      bodies: [
        {
          id: 'ball-body',
          name: 'ball',
          sourceFeatureId: 'ball',
          placementFeatureId: 'ball-placement',
          appearance: { color: '#9aa4b1', opacity: 1 },
        },
      ],
    });
    const run = async (doc: CadDocument, features?: FeatureCache) => {
      const document = pinned(doc);
      const built: string[] = [];
      const result = await evaluateCad(oc, document, cadContentHash(document), {
        ...(features ? { features } : {}),
        timing: (phase, id) => void (phase === 'feature' && built.push(id)),
      });
      return { ...result, built: built.sort() };
    };
    /** The full graph with no cache: what every cached result must equal. */
    const same = async (cached: Awaited<ReturnType<typeof run>>, doc: CadDocument) => {
      const reference = await run(doc);
      expect(reference.built).toHaveLength(doc.features.length);
      // Same measurements, digest and mesh bytes (positions, indices, pick table, names).
      expect(cached.evaluation).toEqual(reference.evaluation);
      expect(cached.meshes).toEqual(reference.meshes);
    };
    const fillet = (doc: CadDocument, radius: number) =>
      applyCadOperation(doc, {
        type: 'updateFeature',
        featureId: 'fillet',
        args: {
          ...(doc.features.find((f) => f.id === 'fillet')!.args as object),
          radius: mm(radius),
        } as never,
      });
    const cache = new FeatureCache();
    try {
      const first = await run(base, cache);
      expect(first.evaluation.status).toBe('ok');
      expect(first.built).toHaveLength(base.features.length);
      expect(cache.entries.size).toBe(base.features.length);

      // The fillet: it and its placement, nothing upstream, not the ball.
      const rounder = fillet(base, 4);
      const edited = await run(rounder, cache);
      expect(edited.built).toEqual(['fillet', 'fillet-placement']);
      await same(edited, rounder);
      // Back to the first document: nothing is built, and the result is the first one.
      const back = await run(base, cache);
      expect(back.built).toEqual([]);
      expect(back.evaluation).toEqual(first.evaluation);
      expect(back.meshes).toEqual(first.meshes);

      // A parameter: the block that reads it and everything downstream of the block.
      const taller = applyCadOperation(base, { type: 'setParameter', parameterId: 'H', value: 30 });
      const tall = await run(taller, cache);
      expect(tall.built).toEqual(
        [
          'block',
          'part-placement',
          'cut-s',
          'cut-s-placement',
          'fillet',
          'fillet-placement',
        ].sort(),
      );
      await same(tall, taller);
      // A placement only (P2): that body's placement, its own shape is not built again.
      const moved = applyCadOperation(base, {
        type: 'transformBody',
        bodyId: 'part',
        translation: position(5, -10, 2),
        rotation: identityQuaternion(),
      });
      const move = await run(moved, cache);
      expect(move.built).toEqual(['fillet-placement']);
      await same(move, moved);
      // Renaming a feature or a body builds nothing: no shape reads a name.
      let renamed = applyCadOperation(base, { type: 'rename', targetId: 'fillet', name: 'Round' });
      renamed = applyCadOperation(renamed, {
        type: 'rename',
        targetId: 'ball-body',
        name: 'Sphere',
      });
      expect((await run(renamed, cache)).built).toEqual([]);

      // A failed fillet (U4): the shapes before it stay; fixing it builds only the fillet again.
      const failing = fillet(base, 40);
      const failed = await run(failing, cache);
      expect(failed.evaluation).toMatchObject({ status: 'error', featureId: 'fillet' });
      expect(failed.built).toEqual([]);
      const fixed = await run(fillet(base, 5), cache);
      expect(fixed.built).toEqual(['fillet', 'fillet-placement']);
      await same(fixed, fillet(base, 5));

      // A cancel keeps what was built before it: the next evaluation builds only the rest.
      const cancelled = fillet(base, 6);
      const document = pinned(cancelled);
      await expect(
        evaluateCad(oc, document, cadContentHash(document), {
          features: cache,
          checkpoint: async (id) => {
            if (id === 'fillet-placement') throw new CadEvaluationCancelled();
          },
        }),
      ).rejects.toBeInstanceOf(CadEvaluationCancelled);
      expect((await run(cancelled, cache)).built).toEqual(['fillet-placement']);
    } finally {
      cache.release();
    }
  }, 120_000);

  it('keeps the latest evaluation past the budget and drops older shapes first (CM-3, U6)', async () => {
    const doc = f12Fillet();
    const run = async (d: CadDocument, features: FeatureCache) => {
      const document = pinned(d);
      const built: string[] = [];
      const result = await evaluateCad(oc, document, cadContentHash(document), {
        features,
        timing: (phase, id) => void (phase === 'feature' && built.push(id)),
      });
      expect(result.evaluation.status).toBe('ok');
      return built.sort();
    };
    const fillet = (radius: number) =>
      applyCadOperation(doc, {
        type: 'updateFeature',
        featureId: 'fillet',
        args: {
          ...(doc.features.find((f) => f.id === 'fillet')!.args as object),
          radius: mm(radius),
        } as never,
      });
    // No budget: only the latest evaluation's shapes are kept.
    const none = new FeatureCache(0);
    try {
      await run(doc, none);
      expect(none.entries.size).toBe(doc.features.length);
      await run(fillet(4), none);
      expect(none.entries.size).toBe(doc.features.length);
      // The first fillet was dropped: going back builds it again.
      expect(await run(doc, none)).toEqual(['fillet', 'fillet-placement']);
    } finally {
      none.release();
    }
    // Within the budget, both fillets stay.
    const roomy = new FeatureCache();
    try {
      await run(doc, roomy);
      await run(fillet(4), roomy);
      expect(roomy.entries.size).toBe(doc.features.length + 2);
      expect(roomy.bytes).toBeLessThanOrEqual(roomy.budgetBytes);
      expect(await run(doc, roomy)).toEqual([]);
    } finally {
      roomy.release();
    }
  }, 120_000);

  it('a feature that changes its input in place leaves the kept input as it was (CM-3)', async () => {
    // Shelling a block changes the block's tolerances in place; drafting the same block later
    // must read the block as built, as a new evaluation does.
    const cache = new FeatureCache();
    try {
      const draftOnly = f13ShellDraft();
      draftOnly.features = draftOnly.features.filter(
        (f) => !['shell', 'shell-placement'].includes(f.id),
      );
      draftOnly.bodies[0]!.resultFeatureId = 'draft-placement';
      for (const [id, doc] of [
        ['shell', f13ShellDraft({ draft: false })],
        ['shell and draft', f13ShellDraft()],
        ['draft', draftOnly],
      ] as const) {
        const document = pinned(doc);
        const cached = await evaluateCad(oc, document, cadContentHash(document), {
          features: cache,
        });
        const full = await evaluateCad(oc, document, cadContentHash(document));
        expect(cached.evaluation, id).toEqual(full.evaluation);
        expect(cached.meshes, id).toEqual(full.meshes);
      }
    } finally {
      cache.release();
    }
  }, 120_000);

  it('a profile with an ID like `toString` invalidates what reads it (CM-3)', async () => {
    // F02's plate profile renamed to an ID the prototype of an object also has.
    const doc = pinned(
      JSON.parse(JSON.stringify(f02Plate()).replaceAll('"plate-profile"', '"toString"')),
    );
    expect(validateCad(doc).filter((d) => d.severity === 'error')).toEqual([]);
    const run = async (d: CadDocument, features: FeatureCache) => {
      const built: string[] = [];
      const result = await evaluateCad(oc, d, cadContentHash(d), {
        features,
        timing: (phase, id) => void (phase === 'feature' && built.push(id)),
      });
      expect(result.evaluation.status).toBe('ok');
      return { ...result, built };
    };
    const cache = new FeatureCache();
    try {
      await run(doc, cache);
      // H is read only by the profile: the extrude that reads the profile is built again.
      expect(JSON.stringify(doc.features)).not.toContain('"parameterId":"H"');
      const edited = applyCadOperation(doc, { type: 'setParameter', parameterId: 'H', value: 70 });
      const again = await run(edited, cache);
      expect(again.built).toContain('plate-extrude');
      const full = await evaluateCad(oc, edited, cadContentHash(edited));
      expect(again.evaluation).toEqual(full.evaluation);
    } finally {
      cache.release();
    }
  }, 120_000);

  it('a new kernel module starts with no kept shapes (CM-3)', async () => {
    const first = await evaluate('cm3-before-init', f12Fillet());
    // The same build loaded again: shapes kept from the old module are never read by the new one.
    await handle({ type: 'init', build: { buildHash, moduleUrl: '', wasmUrl: '' } });
    const after = await evaluate('cm3-after-init', f12Fillet());
    if (first.type !== 'result' || after.type !== 'result') throw new Error(after.type);
    expect(after.evaluation).toEqual(first.evaluation);
    expect(after.meshes).toEqual(first.meshes);
  }, 300_000);

  it('the airliner (F42) built again from the cache equals the full graph after a span change (CM-3)', async () => {
    const doc = pinned(f42Airliner({ id: cadKernelBuild.id, buildHash }));
    const span = doc.parameters.find((p) => p.name === 'Half span')!;
    const shorter = applyCadOperation(doc, {
      type: 'setParameter',
      parameterId: span.id,
      value: (span as { value: number }).value * 0.9,
    });
    const run = async (d: CadDocument, features?: FeatureCache) => {
      const built: string[] = [];
      const result = await evaluateCad(oc, d, cadContentHash(d), {
        ...(features ? { features } : {}),
        timing: (phase, id) => void (phase === 'feature' && built.push(id)),
      });
      expect(result.evaluation.status).toBe('ok');
      return { ...result, built };
    };
    const cache = new FeatureCache();
    try {
      expect((await run(doc, cache)).built).toHaveLength(doc.features.length);
      const cached = await run(shorter, cache);
      // Only the wing sections the span reads and what is built from them.
      expect(cached.built.length).toBeGreaterThan(0);
      expect(cached.built.length).toBeLessThan(doc.features.length / 2);
      const full = await run(shorter);
      expect(cached.evaluation).toEqual(full.evaluation);
      expect(cached.meshes).toEqual(full.meshes);
    } finally {
      cache.release();
    }
  }, 300_000);

  it('the airliner (F42) paused into short jobs equals one job, each feature built once (CM-4, P3)', async () => {
    const doc = pinned(f42Airliner({ id: cadKernelBuild.id, buildHash }));
    const hash = cadContentHash(doc);
    const full = await evaluateCad(oc, doc, hash);
    expect(full.evaluation.status).toBe('ok');
    // A clock one millisecond on per reading: each job pauses after a few steps.
    let clock = 0;
    const built: string[] = [];
    const pauses: [number, number][] = [];
    const features = new FeatureCache();
    const result = await evaluateCad(oc, doc, hash, {
      features,
      slice: {
        ms: 3,
        now: () => clock++,
        pause: async (done, total) => void pauses.push([done, total]),
      },
      timing: (phase, id) => void (phase === 'feature' && built.push(id)),
    });
    features.release();
    expect(result.evaluation).toEqual(full.evaluation);
    expect(result.meshes).toEqual(full.meshes);
    expect(pauses.length).toBeGreaterThan(3);
    // In order, of one total (the graph's nodes and the meshed bodies), each after the last.
    const total =
      doc.features.length +
      doc.sketches.length +
      doc.bodies.filter((b) => b.state === 'active').length;
    expect(pauses.every(([, t]) => t === total)).toBe(true);
    expect(pauses.slice(1).every(([d], i) => d > pauses[i]![0])).toBe(true);
    // Nothing was built twice: a job goes on with what the previous one built.
    expect(new Set(built).size).toBe(built.length);
    expect(built).toHaveLength(doc.features.length);
  }, 300_000);

  it('the browser loader compiles, instantiates and marks each start-up phase', async () => {
    const wasm = readFileSync(`${dist}/${cadKernelBuild.wasm}`);
    vi.stubGlobal('fetch', async () => new Response(wasm));
    performance.clearMarks();
    try {
      const loaded = await loadVerifiedBuild({
        buildHash,
        moduleUrl: pathToFileURL(`${dist}/${cadKernelBuild.js}`).href,
        wasmUrl: '/kernel.wasm',
      });
      const doc = pinned(f02Plate());
      const { evaluation } = await evaluateCad(loaded, doc, cadContentHash(doc));
      expect(evaluation.status).toBe('ok');
      const marks = performance.getEntriesByType('mark').map((m) => m.name);
      expect(marks).toEqual(Object.values(kernelLoadMarks));
      await expect(
        loadVerifiedBuild({ buildHash: `sha256:${'0'.repeat(64)}`, moduleUrl: '', wasmUrl: '' }),
      ).rejects.toThrow('kernel-build-hash');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// Opt-in: an earlier build from build.mjs (CAD_OCCT_RETAINED), served for exact evaluation.
const retainedDir = process.env.CAD_OCCT_RETAINED?.split(',')[0];
describe.skipIf(!retainedDir)('OCCT kernel host with a retained earlier build', () => {
  it('evaluates exactly but refuses STEP with a migration diagnostic when the build has no writer', async () => {
    const posted: CadWorkerResponse[] = [];
    // Earlier builds share file names: the one in the directory is the one whose hash matches.
    const hashOf = (file: string) =>
      existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : '';
    const spec = cadKernelPrevious.find(
      (p) => hashOf(`${retainedDir}/${p.wasm}`) === p.wasmSha256,
    )!;
    expect(spec).toBeDefined();
    const wasm = readFileSync(`${retainedDir}/${spec.wasm}`);
    const buildHash = `sha256:${spec.wasmSha256}`;
    globalThis.require ??= createRequire(import.meta.url);
    const handle = createKernelHost({
      load: async () => {
        const { default: factory } = await import(pathToFileURL(`${retainedDir}/${spec.js}`).href);
        return factory({ wasmBinary: wasm });
      },
      post: (m) => void posted.push(m),
      yieldTask: () => new Promise((resolve) => setImmediate(resolve)),
    });
    await handle({ type: 'init', build: { buildHash, moduleUrl: '', wasmUrl: '' } });
    const doc = f02Plate();
    const document = { ...doc, kernelProfile: { ...doc.kernelProfile, buildHash } };
    for (const step of [false, true])
      await handle({
        type: 'evaluate',
        requestId: `retained-${step}`,
        generation: 1,
        baseHash: '',
        candidateHash: cadContentHash(document),
        document,
        ...(step ? { step } : {}),
      });
    const result = (id: string) =>
      posted.find((m) => 'requestId' in m && m.requestId === id && m.type !== 'progress');
    expect(result('retained-false')).toMatchObject({ evaluation: { status: 'ok' } });
    // A build before R1 has no shape maps or history: the same faces, without names or edges.
    const [mesh] = (result('retained-false') as { meshes: CadMesh[] }).meshes;
    expect(mesh!.topology.faces).toHaveLength(7);
    expect(mesh!.topology.faces.every((f) => f.name === null)).toBe(true);
    expect(mesh!.topology.edges).toEqual([]);
    expect(mesh!.edgeIds).toHaveLength(0);
    // The build before the STEP bindings cannot write STEP; no earlier build can import it.
    if (spec.wasmSha256.startsWith('abd9d7b5'))
      expect(result('retained-true')).toMatchObject({
        evaluation: { status: 'error', code: 'step-unsupported-build', retryable: false },
      });
    await handle({
      type: 'import-step',
      requestId: 'retained-import',
      bytes: new Uint8Array(readFileSync(corpusFile('normal-mm-plate.step'))),
    });
    expect(result('retained-import')).toEqual({
      type: 'import-result',
      requestId: 'retained-import',
      result: { status: 'rejected', code: 'step-import-unsupported-build' },
    });
  }, 300_000);
});
