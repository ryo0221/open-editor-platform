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
  f15Canopy,
  f15Sweep,
  f16Reference,
  f16Sketch,
  f16Spline,
  f17Sheets,
  f20SheetFillet,
  f21OffsetSurface,
  f22Split,
  cr6dGroove,
  lampFixture,
  f59Boxes,
  f59SeatBodies,
  f60Sizes,
  f60Wheel,
  f61Mirror,
  f62Sizes,
  f62Steering,
  lampSizes,
  f26Panel,
  f27Windows,
  f23PressLine,
  f24Flare,
  f47Flange,
  f48ProfileSweep,
  f49SpotWelds,
  f29Biw,
  f25B1Car,
  bodyPartContent,
  withMirrorCopy,
  cadPanelGapDefaultMm,
  f28B2Car,
  f28Outlines,
  f17Surfaces,
  edgeRef,
  f17Boundaries,
  f17HyparArea,
  f17LoftReference,
  f18Hood,
  f19Network,
  f19NetworkArea,
  f19NetworkSphere,
  f18Seams,
  cadContinuity,
  cadGapFlush,
  gapFlushReport,
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
  pmiAssetProblem,
  cadPmiItemStates,
  cadPmiTrackedIndex,
  type CadDocument,
  type Vec3,
  type CadPmiAsset,
  type CadPmiItem,
  type CadPmiTarget,
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
import type {
  CadFaceDistanceQuery,
  CadMesh,
  CadWorkerRequest,
  CadWorkerResponse,
} from './protocol';
import { writtenTolerance, type CadStepImportOptions } from './step-import';
import {
  distinctDatums,
  pmiDimensionTypes,
  pmiToleranceTypes,
  readPmiJson,
  type PmiTargetJson,
} from './step-pmi';
import { edgeGapFlush } from './gap-flush';
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

  /** Per face: the triangles' area on the texture (mm²) over their area in space. */
  const textureStretch = (mesh: CadMesh) => {
    const uv = mesh.uvs!;
    const p = mesh.positions;
    const byFace = new Map<number, { uv: number; xyz: number }>();
    for (let t = 0; t < mesh.faceIds.length; t++) {
      const [a, b, c] = [0, 1, 2].map((k) => mesh.indices[t * 3 + k]!);
      const e1 = [0, 1, 2].map((k) => p[b * 3 + k]! - p[a * 3 + k]!);
      const e2 = [0, 1, 2].map((k) => p[c * 3 + k]! - p[a * 3 + k]!);
      const xyz =
        Math.hypot(
          e1[1]! * e2[2]! - e1[2]! * e2[1]!,
          e1[2]! * e2[0]! - e1[0]! * e2[2]!,
          e1[0]! * e2[1]! - e1[1]! * e2[0]!,
        ) / 2;
      // Signed: a mirrored image would be negative.
      const flat =
        ((uv[b * 2]! - uv[a * 2]!) * (uv[c * 2 + 1]! - uv[a * 2 + 1]!) -
          (uv[c * 2]! - uv[a * 2]!) * (uv[b * 2 + 1]! - uv[a * 2 + 1]!)) /
        2;
      const f = byFace.get(mesh.faceIds[t]!) ?? { uv: 0, xyz: 0 };
      f.uv += flat;
      f.xyz += xyz;
      byFace.set(mesh.faceIds[t]!, f);
    }
    return [...byFace.values()].map((f) => f.uv / f.xyz);
  };

  it('gives every face real-size texture coordinates, never mirrored (#662)', async () => {
    // F02: a 100 × 50 × 5 plate with a hole: planes and a cylinder, both unrolled exactly.
    const { mesh: plate } = await evaluated('tex-plate', f02Plate());
    expect(plate.uvs!.length).toBe((plate.positions.length / 3) * 2);
    for (const r of textureStretch(plate)) expect(r).toBeCloseTo(1, 2);
    // The side at y = 0 faces −y: the texture runs along x and up z, in model mm.
    let side = 0;
    for (let v = 0; v < plate.positions.length / 3; v++) {
      const [x, y, z] = [0, 1, 2].map((k) => plate.positions[v * 3 + k]! + plate.origin[k]!);
      if (Math.abs(y!) > 1e-9 || plate.normals[v * 3 + 1]! > -0.99) continue;
      expect(plate.uvs![v * 2]).toBeCloseTo(x!, 4);
      expect(plate.uvs![v * 2 + 1]).toBeCloseTo(z!, 4);
      side++;
    }
    expect(side).toBeGreaterThanOrEqual(4);
    // A loft from a square to a circle: its sides follow their parameters, close to real size.
    const { mesh: loft } = await evaluated('tex-loft', f15Loft());
    for (const r of textureStretch(loft)) {
      expect(r).toBeGreaterThan(0.7);
      expect(r).toBeLessThan(1.3);
    }
    expect(plate.uvs!.every(Number.isFinite)).toBe(true);
  });

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

  it('lofts five closed spline sections whose matching says profiles are inconsistent (ST-89#2)', async () => {
    // OCCT throws `BRepFill :: profiles are inconsistent` for this canopy (a flat first section),
    // with no `BRepFill_CompatibleWires` in the message: built again without the matching.
    const five = await evaluated('st89-canopy-five', f15Canopy('five'));
    const front = await evaluated('st89-canopy-front', f15Canopy('front'));
    const back = await evaluated('st89-canopy-back', f15Canopy('back'));
    const v = (x: typeof five) => solid(x.evaluation.bodies.canopy!).volumeMm3;
    // The halves are matched by OCCT and the five are not, so their rulings differ slightly.
    expect(Math.abs(v(five) / (v(front) + v(back)) - 1)).toBeLessThan(0.01);
    const smooth = await evaluated('st89-canopy-smooth', f15Canopy('five', false));
    expect(rounded(smooth.evaluation.bodies.canopy!.bounds[0].slice(0, 1))).toEqual([1500]);
    expect(smooth.evaluation.bodies.canopy!.bounds[1][0]).toBeCloseTo(3250, 3);
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
    // CR1b (docs/cad/car-design.md, CR1の分け方): the same crown filled G2 to both panels
    // meets them with their curvature: the sewn seams pass the G2 check (TS-1475, ST-243).
    const g2Hood = f18Hood('sew');
    const crown = g2Hood.features.find((x) => x.id === 'crown-fill')!;
    if (crown.type !== 'fill') throw new Error('fixture');
    crown.args.boundary[1]!.continuity = 'G2';
    crown.args.boundary[3]!.continuity = 'G2';
    for (const panel of ['left', 'right']) {
      const r = await report(
        `cr1b-hood-${panel}`,
        g2Hood,
        'left',
        sortedNames([`sew:crown-placement/surface`, `sew:${panel}-placement/surface`]).join(' | '),
      );
      expect(r).toMatchObject({ level: 'G2', g0: { pass: true }, g1: { pass: true } });
      // About 0.35% apart (the G1 crown above is about 1.5%).
      expect(r.g2.max).toBeLessThan(cadContinuity.g2Relative);
    }
    // A G2 side beside the ruled cone asks the plate for no curvature across the rim, which it
    // cannot close the dome with: refused on the G2 sides only, the G1 sides kept.
    const dome = f17Boundaries('dome');
    const cap = dome.features.find((x) => x.id === 'cap')!;
    if (cap.type !== 'fill') throw new Error('fixture');
    cap.args.boundary.forEach((x, i) => (x.continuity = i % 2 ? 'G2' : 'G1'));
    expect(await evaluate('cr1b-dome-g2', dome)).toMatchObject({
      evaluation: {
        status: 'error',
        code: 'fill-g2-unreached',
        featureId: 'cap',
        failedPaths: [1, 3].map((i) => ['boundary', i, 'continuity']),
      },
    });
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
    extra: {
      curvature?: true;
      comb?: { bodyId: string; edge: number };
      gapFlush?: { a: { bodyId: string; edge: number }; b: { bodyId: string; edge: number } };
    },
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

  it('measures the gap and flush between a door and its panel along the facing edges (CR3d)', async () => {
    // TS-1511, ST-256: the F26 door, 3.5 mm from the panel all round.
    const gapFlush = async (id: string, doc: CadDocument, door = 's0', skin = 's0') => {
      const meshes = await meshesOf(`${id}-mesh`, doc);
      const index = (bodyId: string, name: string) => {
        const names = edgeNames(meshes.find((m) => m.bodyId === bodyId)!);
        const i = names.findIndex((n) => n === name);
        if (i < 0) throw new Error(`${name} not in ${JSON.stringify(names)}`);
        return i;
      };
      return (
        await analysed(id, doc, {
          gapFlush: {
            a: {
              bodyId: 'door-body',
              edge: index('door-body', `panel:door:inside/side:e:l | sketch:cutter/cut:e:${door}`),
            },
            b: {
              bodyId: 'panel-body',
              edge: index('panel-body', `sketch:cutter/cut:e:${skin} | trim:trim:outside/side:e:l`),
            },
          },
        })
      ).gapFlush!;
    };
    const moved = (x: number, z: number) => {
      const doc = f26Panel();
      const placement = doc.features.find((f) => f.id === 'door-body-placement')!;
      if (placement.type === 'transform') placement.args.translation = position(x, 0, z);
      return doc;
    };
    const flat = await gapFlush('cr3d-flat', f26Panel());
    if (!('samples' in flat)) throw new Error(JSON.stringify(flat));
    // Every sample along the door's 16.5 mm edge faces the panel's 23.5 mm one.
    expect(flat.samples).toHaveLength(cadGapFlush.samples);
    const report = gapFlushReport(flat.samples);
    expect(report.gap.min).toBeCloseTo(3.5, 6);
    expect(report.gap.max).toBeCloseTo(3.5, 6);
    expect(Math.abs(report.flush.max)).toBeLessThan(1e-6);
    expect(flat.samples[0]!.at[1]).toBeCloseTo(-38.25, 6);
    expect(flat.samples[0]!.to[1]).toBeCloseTo(-41.75, 6);
    // Lifted 2 mm, the door stands 2 mm proud or sunk; the gap across stays.
    const lifted = await gapFlush('cr3d-lifted', moved(0, 2));
    if (!('samples' in lifted)) throw new Error(JSON.stringify(lifted));
    const up = gapFlushReport(lifted.samples);
    expect(up.gap.mean).toBeCloseTo(3.5, 6);
    expect(Math.abs(up.flush.min)).toBeCloseTo(2, 6);
    expect(Math.abs(up.flush.max)).toBeCloseTo(2, 6);
    // Moved 10 mm along the edge, the part past the panel's edge is left out.
    const slid = await gapFlush('cr3d-slid', moved(10, 0));
    if (!('samples' in slid)) throw new Error(JSON.stringify(slid));
    expect(slid.samples.length).toBeLessThan(cadGapFlush.samples);
    expect(slid.samples.length).toBeGreaterThan(cadGapFlush.samples / 2);
    expect(gapFlushReport(slid.samples).gap.max).toBeCloseTo(3.5, 6);
    // Closed borders (Codex on #952): concentric circles 10 and 13.5 mm, the inner one's seam
    // turned 0.001 rad back, measure all 50 points across the outer one's seam.
    const kept: { delete(): void }[] = [];
    const own = <T>(x: T) => (kept.push(x as never), x);
    const circle = (r: number, turn: number) => {
      const x = [Math.cos(turn), Math.sin(turn), 0];
      const ax = own(
        new oc.gp_Ax2_2(
          own(new oc.gp_Pnt_3(0, 0, 0)),
          own(new oc.gp_Dir_4(0, 0, 1)),
          own(new oc.gp_Dir_4(...x)),
        ),
      );
      return own(own(new oc.BRepBuilderAPI_MakeEdge_8(own(new oc.gp_Circ_2(ax, r)))).Edge());
    };
    const inner = circle(10, -0.001);
    const disc = own(
      own(
        new oc.BRepBuilderAPI_MakeFace_15(
          own(own(new oc.BRepBuilderAPI_MakeWire_2(inner)).Wire()),
          true,
        ),
      ).Face(),
    );
    own(new oc.BRepMesh_IncrementalMesh_2(disc, 0.01, false, 0.1, false));
    const ex = own(
      new oc.TopExp_Explorer_2(
        disc,
        oc.TopAbs_ShapeEnum.TopAbs_EDGE,
        oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
      ),
    );
    const border = own(oc.TopoDS.Edge_1(own(ex.Current())));
    const rings = edgeGapFlush(oc, own, border, disc, circle(13.5, 0));
    kept.forEach((x) => x.delete());
    if (typeof rings === 'string') throw new Error(rings);
    expect(rings).toHaveLength(cadGapFlush.samples);
    for (const x of rings) expect(x.gapMm).toBeCloseTo(3.5, 6);
    // Moved 30 mm, the edges never face each other; one body with itself is refused.
    expect(await gapFlush('cr3d-apart', moved(30, 0))).toEqual({ code: 'gap-flush-apart' });
    const doc = f26Panel();
    const meshes = await meshesOf('cr3d-same-mesh', doc);
    const door = edgeNames(meshes.find((m) => m.bodyId === 'door-body')!);
    expect(
      (
        await analysed('cr3d-same', doc, {
          gapFlush: { a: { bodyId: 'door-body', edge: 0 }, b: { bodyId: 'door-body', edge: 1 } },
        })
      ).gapFlush,
    ).toEqual({ code: 'gap-flush-same-body' });
    expect(
      (
        await analysed('cr3d-missing', doc, {
          gapFlush: {
            a: { bodyId: 'door-body', edge: door.length },
            b: { bodyId: 'panel-body', edge: 0 },
          },
        })
      ).gapFlush,
    ).toEqual({ code: 'gap-flush-edge-missing' });
  });

  it('spans a curve network by a Gordon surface and refuses curves that miss (CR1d)', async () => {
    // TS-1479, ST-246: three u arcs and three v arcs of one sphere make one face through them.
    const result = await evaluate('cr1d-sphere', f19Network());
    if (result.type !== 'result' || result.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(result));
    const roof = result.evaluation.bodies.roof;
    if (roof?.kind !== 'sheet') throw new Error(JSON.stringify(roof));
    expect(Math.abs(roof.areaMm2 / f19NetworkArea() - 1)).toBeLessThan(2e-3);
    expect(roof).toMatchObject({ freeEdges: 4 });
    const mesh = result.meshes.find((m) => m.bodyId === 'roof')!;
    expect(faceNames(mesh)).toEqual(['surface']);
    expect(sortedNames(edgeNames(mesh).filter((_, i) => mesh.topology.edges[i]!.boundary))).toEqual(
      [
        'sketch:u0/boundary:e:arc | surface',
        'sketch:u2/boundary:e:arc | surface',
        'sketch:v0/boundary:e:arc | surface',
        'sketch:v2/boundary:e:arc | surface',
      ],
    );
    // Every mesh node (relative to the mesh's origin) lies on the sphere to within the mesh's sag.
    const { radius } = f19NetworkSphere;
    const centre = f19NetworkSphere.centre.map((c, a) => c - mesh.origin[a]!);
    let worst = 0;
    for (let k = 0; k < mesh.positions.length; k += 3)
      worst = Math.max(
        worst,
        Math.abs(
          Math.hypot(
            mesh.positions[k]! - centre[0],
            mesh.positions[k + 1]! - centre[1],
            mesh.positions[k + 2]! - centre[2],
          ) - radius,
        ),
      );
    expect(worst).toBeLessThan(0.05);
    // A 0.02 mm strip: its long sides lie within four tolerances of each other, yet each border
    // keeps its own curve's name (CR1d review).
    const thin = await evaluate('cr1d-thin', f19Network('thin'));
    if (thin.type !== 'result' || thin.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(thin));
    const strip = thin.meshes.find((m) => m.bodyId === 'roof')!;
    expect(
      sortedNames(edgeNames(strip).filter((_, i) => strip.topology.edges[i]!.boundary)),
    ).toEqual(['u0', 'u1', 'v0', 'v1'].map((e) => `sketch:strip/boundary:e:${e} | surface`));
    // The middle v arc 1 mm up misses the u arcs: refused with both curves of the first miss.
    expect(await evaluate('cr1d-gap', f19Network('gap'))).toMatchObject({
      evaluation: {
        status: 'error',
        code: 'curve-network-gap',
        featureId: 'net',
      },
    });
  });

  it('offsets a sheet along its normal into a new sheet body, either side (CR2b)', async () => {
    // TS-1486, ST-248: the line-and-arc wall moved 2 mm each way.
    const base = (40 + 10 * Math.PI) * 30;
    const areas: number[] = [];
    for (const side of ['front', 'back'] as const) {
      const result = await evaluate(`cr2b-${side}`, f21OffsetSurface(side));
      if (result.type !== 'result' || result.evaluation.status !== 'ok')
        throw new Error(JSON.stringify(result));
      const inner = result.evaluation.bodies['inner-body'];
      if (inner?.kind !== 'sheet') throw new Error(JSON.stringify(inner));
      areas.push(inner.areaMm2);
      // The source stays as it was.
      expect(result.evaluation.bodies.surface).toMatchObject({ kind: 'sheet' });
      const mesh = result.meshes.find((m) => m.bodyId === 'inner-body')!;
      expect(faceNames(mesh)).toEqual(['offset/side:e:l0', 'offset/side:e:a0']);
      // The source's named borders carry over, so each copy can be referenced (#930).
      const from = result.meshes.find((m) => m.bodyId === 'surface')!;
      const copied = edgeNames(from).map((n) =>
        n!
          .split(' | ')
          .map((p) => `offset/${p}`)
          .join(' | '),
      );
      expect(sortedNames(edgeNames(mesh))).toEqual(sortedNames(copied));
      expect(new Set(edgeNames(mesh)).size).toBe(edgeNames(mesh).length);
      // The line's part lies 2 mm off the plane y = 0.
      let off = 0;
      for (let k = 0; k < mesh.positions.length; k += 3) {
        const x = mesh.positions[k]! + mesh.origin[0]!;
        if (x > 1 && x < 39)
          off = Math.max(off, Math.abs(Math.abs(mesh.positions[k + 1]! + mesh.origin[1]!) - 2));
      }
      expect(off).toBeLessThan(1e-6);
    }
    // One side's arc is r 22, the other's r 18: π/2 × 2 × 30 each way.
    expect(areas[0]! + areas[1]!).toBeCloseTo(2 * base, 1);
    expect(Math.abs(areas[0]! - areas[1]!)).toBeCloseTo(2 * Math.PI * 30, 1);
    // Past the arc's radius the inner copy would turn inside out.
    const tooFar = await evaluate(
      'cr2b-far',
      f21OffsetSurface(areas[0]! < areas[1]! ? 'front' : 'back', 25),
    );
    expect(tooFar).toMatchObject({
      evaluation: { status: 'error', code: 'offset-failed', featureId: 'inner' },
    });
  });

  it('splits a sheet along a sketch chain and keeps every piece by its side (CR2a)', async () => {
    // TS-1489, ST-249: a 100 × 60 mm panel divided by an open line and by a closed square.
    const pieces = async (kind: 'open' | 'closed' | 'arc') => {
      const result = await evaluate(`cr2a-${kind}`, f22Split(kind));
      if (result.type !== 'result' || result.evaluation.status !== 'ok')
        throw new Error(JSON.stringify(result));
      const panel = result.evaluation.bodies['panel-body'];
      if (panel?.kind !== 'sheet') throw new Error(JSON.stringify(panel));
      expect(panel.areaMm2).toBeCloseTo(kind === 'arc' ? 12 : 6000, 3);
      const mesh = result.meshes.find((m) => m.bodyId === 'panel-body')!;
      const area = new Map<string, number>();
      mesh.topology.faces.forEach((face, i) =>
        area.set(faceNames(mesh)[i]!, (area.get(faceNames(mesh)[i]!) ?? 0) + face.area),
      );
      return { area, edges: edgeNames(mesh) };
    };
    const open = await pieces('open');
    expect([...open.area.keys()].sort()).toEqual([
      'split:split:left/side:e:l',
      'split:split:right/side:e:l',
    ]);
    expect(open.area.get('split:split:left/side:e:l')).toBeCloseTo(1800, 3);
    expect(open.area.get('split:split:right/side:e:l')).toBeCloseTo(4200, 3);
    // The dividing edge lies between the two pieces and is named by them.
    expect(open.edges).toContain('split:split:left/side:e:l | split:split:right/side:e:l');
    const closed = await pieces('closed');
    expect(closed.area.get('split:split:inside/side:e:l')).toBeCloseTo(400, 3);
    expect(closed.area.get('split:split:outside/side:e:l')).toBeCloseTo(5600, 3);
    expect(
      closed.edges.filter(
        (n) => n === 'split:split:inside/side:e:l | split:split:outside/side:e:l',
      ),
    ).toHaveLength(4);
    // A 0.2 mm strip across a 1 m circle: the lens inside it is ∫(√(10⁶ − u²) − 999.9) du.
    const arc = await pieces('arc');
    const lens = 2 * (0.1 * Math.sqrt(200) - Math.sqrt(200) ** 3 / 6000);
    expect(arc.area.get('split:split:inside/side:e:l')).toBeCloseTo(lens, 2);
    expect(arc.area.get('split:split:outside/side:e:l')).toBeCloseTo(12 - lens, 2);
    expect(await evaluate('cr2a-missed', f22Split('missed'))).toMatchObject({
      evaluation: { status: 'error', code: 'split-missed', featureId: 'split' },
    });
  });

  it('cuts a round groove along a line on the nearest face, and a grid of lens cuts (CR6d)', async () => {
    // TS-1598, ST-284.
    const run = async (
      kind:
        | 'open'
        | 'closed'
        | 'grid'
        | 'hollow'
        | 'overhang'
        | 'steep'
        | 'shaded'
        | 'far'
        | 'ring',
      radius?: number,
    ) => {
      const result = await evaluate(`cr6d-${kind}-${radius}`, cr6dGroove(kind, radius));
      if (result.type !== 'result' || result.evaluation.status !== 'ok')
        throw new Error(JSON.stringify(result));
      const id = kind === 'grid' ? 'lens' : 'cushion';
      return {
        volume: solid(result.evaluation.bodies[id]).volumeMm3,
        names: faceNames(result.meshes.find((m) => m.bodyId === id)!),
      };
    };
    // A half-round of r = 1 along 80 mm of the top face (the bottom face, farther, is left).
    const open = await run('open');
    expect(open.volume).toBeCloseTo(120_000 - (Math.PI / 2) * 80, 1);
    // The groove's wall along s0, and its two ends at the line's points.
    expect(new Set(open.names.filter((n) => n?.startsWith('groove:groove:0/')))).toEqual(
      new Set([
        'groove:groove:0/tube:e:s0',
        'groove:groove:0/tube:v:p0',
        'groove:groove:0/tube:v:p1',
      ]),
    );
    expect(open.names).toContain('-z');
    // 200 m from the sketch's origin along its plane: still only the top face.
    expect((await run('far')).volume).toBeCloseTo(120_000 - (Math.PI / 2) * 80, 1);
    // An open arc whose ends are 0.004 mm apart is still grooved all round (126 mm).
    expect((await run('ring')).volume).toBeCloseTo(
      120_000 - (Math.PI / 2) * 20 * (2 * Math.PI - 0.0002),
      1,
    );
    // r = 2: four times the section.
    expect((await run('open', 2)).volume).toBeCloseTo(120_000 - 2 * Math.PI * 80, 1);
    const closed = await run('closed');
    // Around a closed 60 × 40 rectangle, 200 mm, a ball of r at each corner: each adds the
    // quarter of its lower half outside both sides' tubes (π r³ / 6) less where the two tubes
    // overlap inside the corner (an eighth of a Steinmetz solid, 2 r³ / 3).
    expect(closed.volume).toBeCloseTo(120_000 - (Math.PI / 2) * 200 - 4 * (Math.PI / 6 - 2 / 3), 1);
    // Each side and each corner named apart (a reference to one of them can be kept).
    const sides = closed.names.filter((n): n is string => !!n?.startsWith('groove:groove:'));
    expect(new Set(sides.map((n) => n.replace(/^groove:groove:\d+\//, '')))).toEqual(
      new Set(
        ['s0', 's1', 's2', 's3']
          .map((e) => `tube:e:${e}`)
          .concat(['p0', 'p1', 'p2', 'p3'].map((v) => `tube:v:${v}`)),
      ),
    );
    // One face per side and per corner, each name its own.
    expect(sides.filter((n) => n.includes('tube:e:'))).toHaveLength(4);
    expect(new Set(sides).size).toBe(sides.length);
    // A hollow block: only the outer face of its top is grooved, not the inner one under it.
    const hollow = await run('hollow', 0.5);
    expect(hollow.volume).toBeCloseTo(120_000 - 96 * 56 * 16 - (Math.PI / 2) * 0.25 * 80, 1);
    // Under a lid over part of the line: the slab is grooved only where it is in view (x 40–80),
    // the lid's top over x 20–40.
    const overhang = await run('overhang');
    expect(overhang.volume).toBeCloseTo(
      100 * 60 * 10 + 10 * 60 * 10 + 40 * 60 * 10 - (Math.PI / 2) * (40 + 20),
      1,
    );
    // A line beside the block meets nothing.
    expect(await evaluate('cr6d-missed', cr6dGroove('missed'))).toMatchObject({
      evaluation: { status: 'error', code: 'groove-no-hit', featureId: 'groove' },
    });
    // Three by two half-spheres of r = 3 on the plate's top.
    const grid = await run('grid');
    expect(grid.volume).toBeCloseTo(9_600 + 6 * (2 / 3) * Math.PI * 27, 1);
    const copyNames = (names: (string | null | undefined)[]) =>
      [
        ...new Set(names.filter((n) => n?.startsWith('copy:cuts:')).map((n) => n!.split('/')[0])),
      ].sort();
    expect(copyNames(grid.names)).toEqual([
      'copy:cuts:0',
      'copy:cuts:0:row1',
      'copy:cuts:1',
      'copy:cuts:1:row1',
      'copy:cuts:2',
      'copy:cuts:2:row1',
    ]);
    // Two along each row: the sphere at (10, 30) is still copy 0 of row 1, and copy 2 is gone.
    const narrow = structuredClone(cr6dGroove('grid'));
    const cuts = narrow.features.find((f) => f.id === 'cuts')!;
    if (cuts.type === 'pattern' && cuts.args.layout.type === 'linear')
      cuts.args.layout.count = { literal: 2 };
    const two = await evaluate('cr6d-grid-2', narrow);
    if (two.type !== 'result' || two.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(two));
    expect(copyNames(two.meshes.flatMap((m) => faceNames(m)))).toEqual([
      'copy:cuts:0',
      'copy:cuts:0:row1',
      'copy:cuts:1',
      'copy:cuts:1:row1',
    ]);
    // Up a face rising 11.4 mm for each 1 mm across the sketch: the line is kept, 5 mm across and
    // 5 / cos 85° along the face.
    const steep = await run('steep');
    expect(steep.volume).toBeCloseTo(
      120_000 - (Math.PI / 2) * (5 / Math.cos((85 * Math.PI) / 180)),
      0,
    );
    // A lid over the line's low end, higher than the low end plus the middle's distance to the
    // sketch: the curtain still reaches the sketch from there, so only the lid's top is grooved.
    const ungrooved = await evaluate('cr6d-shaded-0', cr6dGroove('shaded', 1, { groove: false }));
    if (ungrooved.type !== 'result' || ungrooved.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(ungrooved));
    const shaded = await run('shaded');
    expect(solid(ungrooved.evaluation.bodies.cushion!).volumeMm3 - shaded.volume).toBeCloseTo(
      (Math.PI / 2) * 5,
      1,
    );
  }, 120_000);

  it('builds the headlamp and tail lamp samples, the lens thickness from its parameter (CR6e)', async () => {
    // TS-1800, ST-285 (F57, F58).
    for (const kind of ['headlamp', 'tail'] as const) {
      const run = async (lensMm: number) => {
        const result = await evaluate(`cr6e-${kind}-${lensMm}`, lampFixture(kind, { lensMm }));
        if (result.type !== 'result' || result.evaluation.status !== 'ok')
          throw new Error(JSON.stringify(result.type === 'result' ? result.evaluation : result));
        return result.evaluation.bodies;
      };
      const s = lampSizes[kind];
      const [depth, width, height] = s.housing;
      const bodies = await run(3);
      expect(Object.keys(bodies).sort()).toEqual(
        ['bulb-body', 'housing', 'inner-lens', 'outer-lens', 'reflector-body'].sort(),
      );
      // The housing: a 2.5 mm wall, its front open (about the outer area less the front, × t).
      const wall = solid(bodies.housing).volumeMm3;
      const skin = 2 * depth * (width + height) + width * height;
      expect(wall).toBeGreaterThan(skin * 2.5 * 0.9);
      expect(wall).toBeLessThan(skin * 2.5 * 1.05);
      // The reflector: the paraboloid's area from r0 to the rim, 8πf²/3 [(1 + (r/2f)²)^1.5].
      const reflector = bodies['reflector-body'];
      if (reflector?.kind !== 'sheet') throw new Error(JSON.stringify(reflector));
      const f = s.focal;
      const cap = (r: number) => (1 + (r / (2 * f)) ** 2) ** 1.5;
      expect(reflector.areaMm2).toBeCloseTo(
        ((8 * Math.PI * f * f) / 3) * (cap(s.rim) - cap(s.r0)),
        0,
      );
      // The inner lens: its plate and the grid of half-sphere cuts.
      const c = s.cuts;
      expect(solid(bodies['inner-lens']).volumeMm3).toBeCloseTo(
        3 * (width - 20) * (height - 10) + c.count * c.rows * (2 / 3) * Math.PI * c.radius ** 3,
        0,
      );
      // The outer lens: the arc's length × the height × the thickness, from its parameter.
      const radius = ((width / 2) ** 2 + s.bulge ** 2) / (2 * s.bulge);
      const arc = 2 * radius * Math.asin(width / 2 / radius);
      expect(solid(bodies['outer-lens']).volumeMm3).toBeCloseTo(arc * height * 3, -1);
      const thicker = await run(4);
      expect(
        solid(thicker['outer-lens']).volumeMm3 / solid(bodies['outer-lens']).volumeMm3,
      ).toBeCloseTo(4 / 3, 3);
    }
  }, 300_000);

  it('builds the seat’s bodies: frame, shelled pan and back shell, grooved foam (CR6f)', async () => {
    // TS-1803, ST-286 (F59).
    const result = await evaluate('cr6f-seat', f59SeatBodies());
    if (result.type !== 'result' || result.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(result.type === 'result' ? result.evaluation : result));
    const b = result.evaluation.bodies;
    const vol = (id: string) => solid(b[id]).volumeMm3;
    const boxVolume = (x: { size: readonly number[] }) => x.size[0]! * x.size[1]! * x.size[2]!;
    // The frame: two plates and a 12 mm tube across between their outer faces.
    const plates = boxVolume(f59Boxes.plateLeft) + boxVolume(f59Boxes.plateRight);
    expect(vol('frame-body')).toBeCloseTo(plates + Math.PI * 144 * (406 - 6), 0);
    // Two 4 mm half-round stitches along each foam: 380 mm on the cushion, 480 mm on the back.
    const stitch = (length: number) => 2 * (Math.PI / 2) * 16 * length;
    expect(vol('cushion')).toBeCloseTo(boxVolume(f59Boxes.cushion) - stitch(380), 0);
    expect(vol('back')).toBeCloseTo(boxVolume(f59Boxes.back) - stitch(480), 0);
    // The pan and back shell: 2.5 mm walls, one face open.
    const [px, py, pz] = f59Boxes.pan.size;
    expect(vol('pan')).toBeCloseTo(px * py * pz - (px - 5) * (py - 5) * (pz - 2.5), 0);
    const [sx, sy, sz] = f59Boxes.backShell.size;
    expect(vol('back-shell')).toBeCloseTo(sx * sy * sz - (sx - 2.5) * (sy - 5) * (sz - 5), 0);
  }, 300_000);

  it('builds the wheel and tyre, door mirror and steering wheel samples (CR6g)', async () => {
    // TS-1805, ST-287 (F60–F62).
    const bodiesOf = async (name: string, doc: Parameters<typeof evaluate>[1]) => {
      const result = await evaluate(name, doc);
      if (result.type !== 'result' || result.evaluation.status !== 'ok')
        throw new Error(JSON.stringify(result.type === 'result' ? result.evaluation : result));
      return result.evaluation.bodies;
    };
    // Pappus: a section of area A with its centroid at radius r̄ turned once is 2π r̄ A.
    const pappus = (pts: [number, number][]) => {
      let moment = 0;
      pts.forEach(([x0, y0], i) => {
        const [x1, y1] = pts[(i + 1) % pts.length]!;
        const cross = x0 * y1 - x1 * y0;
        moment += ((x0 + x1) * cross) / 6;
      });
      return 2 * Math.PI * Math.abs(moment);
    };
    const s = f60Sizes;
    const wheel = await bodiesOf('cr6g-wheel', f60Wheel());
    expect(Object.keys(wheel).sort()).toEqual(['tyre', 'wheel']);
    // The rim and hub, five spokes (each 125 mm long from r 60: 15 mm inside the hub and 5 mm inside
    // the barrel, 105 mm between them), less the five lug holes.
    const hub = Math.PI * s.hub.radius ** 2 * s.hub.width;
    const [sx, sy, sz] = s.spoke.size;
    const spokeOut = sy * sz * (sx - (s.spoke.from + sx - 180) - (s.hub.radius - s.spoke.from));
    const lugs = s.lug.count * Math.PI * s.lug.radius ** 2 * s.hub.width;
    const rim = solid(wheel.wheel).volumeMm3;
    expect(rim).toBeGreaterThan(pappus(s.rim) + hub - lugs + s.spoke.count * spokeOut * 0.9);
    expect(rim).toBeLessThan(pappus(s.rim) + hub - lugs + s.spoke.count * sx * sy * sz);
    // The tyre: its section turned, less 60 slots 8 mm deep across the tread (a little less where
    // the slots run out over the shoulders).
    const tyre = solid(wheel.tyre).volumeMm3;
    const slots = s.tread.slots * s.tread.depth * s.tread.width * s.tread.across;
    expect(tyre).toBeLessThan(pappus(s.tyre));
    expect(tyre).toBeGreaterThan(pappus(s.tyre) - slots);
    // The mirror: a housing lofted through its sections, a glass and a mounting plate.
    const mirror = await bodiesOf('cr6g-mirror', f61Mirror());
    expect(Object.keys(mirror).sort()).toEqual(['glass-body', 'housing', 'mount-body']);
    expect(solid(mirror.housing).volumeMm3).toBeGreaterThan(Math.PI * 30 * 40 * 150);
    expect(solid(mirror.housing).volumeMm3).toBeLessThan(Math.PI * 1.1 * 70 * 1.1 * 110 * 150);
    // The steering wheel: the rim's torus (2π R × π r²) and the hub with three lofted spokes.
    const steering = await bodiesOf('cr6g-steering', f62Steering());
    expect(Object.keys(steering).sort()).toEqual(['hub-body', 'rim']);
    const { rim: ring, hub: boss } = f62Sizes;
    expect(solid(steering.rim).volumeMm3).toBeCloseTo(
      2 * Math.PI * ring.radius * Math.PI * ring.tube ** 2,
      -1,
    );
    expect(solid(steering['hub-body']).volumeMm3).toBeGreaterThan(
      Math.PI * boss.radius ** 2 * boss.height,
    );
  }, 300_000);

  it('cuts a door out of a panel with the gap between them, named apart on both sides (CR3b)', async () => {
    // TS-1504, ST-254: the F22 square as a door, 3.5 mm between it and the panel.
    const run = async (kind: 'flat' | 'channel', gap?: number) => {
      const result = await evaluate(`cr3b-${kind}-${gap}`, f26Panel(kind, gap));
      if (result.type !== 'result' || result.evaluation.status !== 'ok')
        throw new Error(JSON.stringify(result));
      const named = (id: string) => {
        const mesh = result.meshes.find((m) => m.bodyId === id)!;
        return { faces: [...new Set(faceNames(mesh))], edges: edgeNames(mesh) };
      };
      return {
        bodies: result.evaluation.bodies,
        door: kind === 'flat' ? named('door-body') : undefined,
        skin: named('panel-body'),
      };
    };
    const flat = await run('flat');
    // The cut runs 1.75 mm off the square on each side: a 16.5 mm door in a 23.5 mm hole.
    expect(flat.bodies['door-body']).toMatchObject({ kind: 'sheet' });
    expect(flat.bodies['door-body']!.areaMm2).toBeCloseTo(16.5 ** 2, 3);
    expect(flat.bodies['panel-body']!.areaMm2).toBeCloseTo(6000 - 23.5 ** 2, 3);
    expect(flat.door!.faces).toEqual(['panel:door:inside/side:e:l']);
    expect(flat.skin.faces).toEqual(['trim:trim:outside/side:e:l']);
    // Both borders keep the square's element names, though they run along the offset chain.
    for (const e of ['s0', 's1', 's2', 's3']) {
      expect(
        flat.door!.edges.filter(
          (n) => n === `panel:door:inside/side:e:l | sketch:cutter/cut:e:${e}`,
        ),
      ).toHaveLength(1);
      expect(
        flat.skin.edges.filter(
          (n) => n === `sketch:cutter/cut:e:${e} | trim:trim:outside/side:e:l`,
        ),
      ).toHaveLength(1);
    }
    const wide = await run('flat', 10);
    expect(wide.bodies['door-body']!.areaMm2).toBeCloseTo(10 ** 2, 3);
    // 86M2: through the top and the bottom plate, each element cuts twice, told apart by side.
    const channel = await run('channel');
    expect(channel.bodies['panel-body']!.areaMm2).toBeCloseTo(2 * (6000 - 23.5 ** 2) + 1200, 3);
    for (const e of ['s0', 's1', 's2', 's3'])
      for (const side of ['front', 'back'])
        expect(
          channel.skin.edges.filter((n) => n?.includes(`sketch:cutter/cut:e:${e}/at:${side}`)),
        ).toHaveLength(1);
    // A gap the square cannot take (its sides would cross) is refused by the offset.
    const doc = f26Panel('flat');
    const door = doc.features.find((f) => f.id === 'door')!;
    if (door.type === 'panel') door.args.gap = mm(10);
    // An 8 mm square: 5 mm in from each side crosses over.
    const small: Record<string, [number, number]> = {
      p0: [40, -40],
      p1: [48, -40],
      p2: [48, -32],
      p3: [40, -32],
    };
    const tooWide = {
      ...doc,
      sketches: doc.sketches.map((s) => (s.id === 'cutter' ? { ...s, solved: small } : s)),
    };
    expect(await evaluate('cr3b-collapse', tooWide)).toMatchObject({
      evaluation: { status: 'error', code: 'sketch-offset-self-intersects' },
    });
  });

  it('cuts a row of windows in one trim, naming the chain that misses or splits it (CR3c)', async () => {
    // TS-1507, ST-255: three 20 mm windows with 10 mm pillars between them.
    const ok = async (name: string, doc: ReturnType<typeof f27Windows>) => {
      const result = await evaluate(`cr3c-${name}`, doc);
      if (result.type !== 'result' || result.evaluation.status !== 'ok')
        throw new Error(JSON.stringify(result));
      const mesh = result.meshes.find((m) => m.bodyId === 'panel-body')!;
      return { body: result.evaluation.bodies['panel-body']!, edges: edgeNames(mesh) };
    };
    const row = await ok('row', f27Windows('row'));
    expect(row.body).toMatchObject({ kind: 'sheet' });
    expect(row.body.areaMm2).toBeCloseTo(6000 - 3 * 400, 3);
    // Every window's sides are cut edges, once each, named by its own elements.
    for (const k of [0, 1, 2])
      for (const j of [0, 1, 2, 3])
        expect(
          row.edges.filter(
            (n) => n === `sketch:windows/cut:e:w${k}s${j} | trim:windows-trim:outside/side:e:l`,
          ),
        ).toHaveLength(1);
    // A window off the sheet is named; with `skip` it is left out.
    expect(await evaluate('cr3c-missed', f27Windows('missed'))).toMatchObject({
      evaluation: { status: 'error', code: 'trim-no-cut', failedPaths: [['chains', 2]] },
    });
    expect((await ok('skip', f27Windows('missed', 'skip'))).body.areaMm2).toBeCloseTo(4800, 3);
    // 86M3: a window through both long sides parts the sheet; that window is named.
    expect(await evaluate('cr3c-apart', f27Windows('apart'))).toMatchObject({
      evaluation: { status: 'error', code: 'trim-disconnected', failedPaths: [['chains', 0]] },
    });
    // Windows that overlap make one opening; no cut edge is named inside it.
    const overlap = await ok('overlap', f27Windows('overlap'));
    expect(overlap.body.areaMm2).toBeCloseTo(6000 - (400 + 400 - 5 * 15) - 400, 3);
    // Each element keeps one stretch on the border (the parts inside the other window go).
    const cut = overlap.edges.filter((n) => n?.includes('cut:e:'));
    expect(cut).toHaveLength(12);
    expect(new Set(cut).size).toBe(12);
  });

  it('presses a step into a sheet along a chain, its two borders rounded (CR2c)', async () => {
    // TS-1492, ST-250: the F22 panel with a 2 mm step, R 0.5, along the line and the square.
    const run = async (kind: 'open' | 'closed', options?: Parameters<typeof f23PressLine>[1]) => {
      const result = await evaluate(
        `cr2c-${kind}-${JSON.stringify(options ?? {})}`,
        f23PressLine(kind, options),
      );
      if (result.type !== 'result' || result.evaluation.status !== 'ok')
        throw new Error(JSON.stringify(result));
      const panel = result.evaluation.bodies['panel-body'];
      if (panel?.kind !== 'sheet') throw new Error(JSON.stringify(panel));
      const mesh = result.meshes.find((m) => m.bodyId === 'panel-body')!;
      const names = faceNames(mesh);
      // Each face's height range (positions are relative to the mesh's origin).
      const z = new Map<string, [number, number]>();
      for (let t = 0; t < mesh.indices.length / 3; t++) {
        const name = names[mesh.faceIds[t]! - 1]!;
        for (let k = 0; k < 3; k++) {
          const h = mesh.positions[3 * mesh.indices[3 * t + k]! + 2]! + mesh.origin[2];
          const [lo, hi] = z.get(name) ?? [Infinity, -Infinity];
          z.set(name, [Math.min(lo, h), Math.max(hi, h)]);
        }
      }
      return { panel, names, z, edges: edgeNames(mesh).filter((n): n is string => !!n) };
    };
    const open = await run('open');
    const moved = 'press:press:moved/side:e:l';
    const right = 'press:press:right/side:e:l';
    const wall = `press:press/wall:(${moved} | ${right})/e:s0`;
    expect([...open.z.keys()].sort()).toEqual(
      [right, moved, wall, `blend:(${wall} | ${right})`, `blend:(${wall} | ${moved})`].sort(),
    );
    expect(open.z.get(right)).toEqual([0, 0]);
    expect(open.z.get(moved)![0]).toBeCloseTo(2, 6);
    expect(open.z.get(wall)![0]).toBeCloseTo(0.5, 6);
    expect(open.z.get(wall)![1]).toBeCloseTo(1.5, 6);
    // 29.5 × 60 moved, 69.5 × 60 kept, a 1 × 60 wall and two quarter rounds of R 0.5.
    expect(open.panel.areaMm2).toBeCloseTo(1770 + 4170 + 60 + Math.PI * 0.5 * 60, 1);
    // Deeper, against the normal, and around the closed square.
    const deep = await run('open', { depth: 5, toward: 'back', side: 'right' });
    expect(deep.z.get('press:press:moved/side:e:l')![1]).toBeCloseTo(-5, 6);
    expect(deep.z.get('press:press:left/side:e:l')).toEqual([0, 0]);
    const closed = await run('closed');
    const walls = closed.names.filter((n) => n?.startsWith('press:press/wall:'));
    // Each wall and its rounds are told apart by the square's side they run along.
    expect(walls.map((n) => n!.slice(-2)).sort()).toEqual(['s0', 's1', 's2', 's3']);
    expect(new Set(closed.names.filter((n) => n?.startsWith('blend:'))).size).toBe(8);
    // The panel's four borders keep their own names through the press (Codex on #921).
    const outside = 'press:press:outside/side:e:l';
    const borders = closed.edges.filter(
      (n) => n.endsWith(` | ${outside}`) && !n.includes('wall') && !n.startsWith('blend'),
    );
    expect(new Set(closed.edges).size).toBe(closed.edges.length);
    expect(borders.sort()).toEqual(
      ['start', 'end', 'edge:start:e:l', 'edge:end:e:l']
        .map((b) => `press:press/${b} | ${outside}`)
        .sort(),
    );
    expect(open.edges).toContain(`press:press/start | ${moved}`);
    expect(open.edges).toContain(`press:press/edge:end:e:l | ${right}`);
    // The new free edges at the open line's ends, by the border they meet: the wall's two ends
    // and each round's two ends all have their own names, every edge name once.
    const wallOf = `press:press/wall:(${moved} | ${right})/e:s0`;
    for (const end of ['start', 'end'])
      expect(open.edges).toContain(`${wallOf} | press:press:end/${end}`);
    expect(open.edges.filter((n) => n.endsWith(' | press:press:end/start'))).toHaveLength(3);
    expect(new Set(open.edges).size).toBe(open.edges.length);
    expect(closed.z.get('press:press:moved/side:e:l')![0]).toBeCloseTo(2, 6);
    expect(closed.z.get('press:press:outside/side:e:l')).toEqual([0, 0]);
    // A rounding wider than the step cannot be made.
    expect(await evaluate('cr2c-round', f23PressLine('open', { radius: 3 }))).toMatchObject({
      evaluation: { status: 'error', code: 'press-line-failed', featureId: 'press' },
    });
  });

  it('stands flanges up from a sheet’s edges and joins them to it (CR4c)', async () => {
    // TS-1534, ST-263: the F22 panel (100 × 60 in z = 0) and the F24 arch (a half circle R 15).
    const run = async (
      kind: Parameters<typeof f47Flange>[0],
      o?: Parameters<typeof f47Flange>[1],
    ) => {
      const id = `cr4c-${kind}-${JSON.stringify(o ?? {})}`;
      const result = await evaluate(id, f47Flange(kind, o));
      if (result.type !== 'result' || result.evaluation.status !== 'ok')
        throw new Error(JSON.stringify(result.type === 'result' ? result.evaluation : result));
      const panel = result.evaluation.bodies['panel-body'];
      if (panel?.kind !== 'sheet') throw new Error(JSON.stringify(panel));
      const mesh = result.meshes.find((m) => m.bodyId === 'panel-body')!;
      const names = faceNames(mesh);
      // Each face's bounds.
      const box = new Map<string, [Vec3, Vec3]>();
      for (let t = 0; t < mesh.indices.length / 3; t++) {
        const name = names[mesh.faceIds[t]! - 1]!;
        const [lo, hi] = box.get(name) ?? [
          [Infinity, Infinity, Infinity],
          [-Infinity, -Infinity, -Infinity],
        ];
        for (let k = 0; k < 3; k++)
          for (let c = 0; c < 3; c++) {
            const x = mesh.positions[3 * mesh.indices[3 * t + k]! + c]! + mesh.origin[c]!;
            lo[c] = Math.min(lo[c]!, x);
            hi[c] = Math.max(hi[c]!, x);
          }
        box.set(name, [lo, hi]);
      }
      return { panel, names, box, edges: edgeNames(mesh).filter((n): n is string => !!n) };
    };
    const sheet = 'flange:flange/side:e:l';
    const wall = (k: string) => `flange:flange:wall/${k}`;
    // One border, square to the panel: a 100 × 10 wall on y = 0.
    const up = await run('start');
    expect(sortedNames(up.names)).toEqual([sheet, wall('0')]);
    expect(up.panel.areaMm2).toBeCloseTo(7000, 3);
    const [lo, hi] = up.box.get(wall('0'))!;
    expect(lo[1]).toBeCloseTo(0, 6);
    expect(hi[1]).toBeCloseTo(0, 6);
    expect(hi[2] - lo[2]).toBeCloseTo(10, 6);
    // The panel's front is +z (its normal); `back` turns the wall the other way.
    const front = Math.sign(hi[2] + lo[2]);
    const back = (await run('start', { toward: 'back' })).box.get(wall('0'))!;
    expect(Math.sign(back[0][2] + back[1][2])).toBe(-front);
    expect(up.edges).toContain(`${sheet} | ${wall('0')}`);
    expect(up.edges).toContain(`flange:flange:far/0 | ${wall('0')}`);
    // 45°: half out of the panel's plane, half away from it.
    const lean = (await run('start', { angleDeg: 45, width: 20 })).box.get(wall('0'))!;
    expect(lean[1][1] - lean[0][1]).toBeCloseTo(20 * Math.SQRT1_2, 5);
    expect(lean[0][1]).toBeCloseTo(0, 6);
    expect(lean[1][2] - lean[0][2]).toBeCloseTo(20 * Math.SQRT1_2, 5);
    // All four borders: a tray, its walls meeting at the corners.
    const tray = await run('tray');
    expect(tray.names).toHaveLength(5);
    expect(tray.panel.areaMm2).toBeCloseTo(6000 + 10 * 320, 3);
    for (const [a, b] of [
      ['0', '1'],
      ['1', '2'],
      ['2', '3'],
      ['0', '3'],
    ])
      expect(tray.edges).toContain(`${wall(a!)} | ${wall(b!)}`);
    // Leaning out at 45°, the walls part at the corners: one sheet still, with gaps there.
    const open = await run('tray', { angleDeg: 45 });
    expect(open.names).toHaveLength(5);
    expect(open.edges.filter((n) => n.startsWith('flange:flange:start/'))).toHaveLength(4);
    // A curved edge: a half-cylinder wall R 15 × 5 round the arch.
    const arch = await run('arch', { width: 5 });
    const kept = 6000 - (Math.PI * 225) / 2;
    expect(arch.panel.areaMm2).toBeCloseTo(kept + Math.PI * 15 * 5, 2);
    const [alo, ahi] = arch.box.get(wall('0'))!;
    expect(ahi[2] - alo[2]).toBeCloseTo(5, 5);
    expect(alo[1]).toBeCloseTo(-60, 5);
    expect(ahi[1]).toBeCloseTo(-45, 4);
  }, 120000);

  it('refuses a flange that crosses itself or the sheet (CR4c)', async () => {
    // TS-1535: leaning 60° into the arch's hole, 20 mm wide (17.3 mm across the R 15 hole), its
    // far side turns back; folded flat back onto the panel (180°), it lies on the panel; a tray's
    // walls leaning in at 135° run into each other at the corners.
    for (const doc of [
      f47Flange('arch', { width: 20, angleDeg: 30 }),
      f47Flange('start', { angleDeg: 180 }),
      f47Flange('tray', { angleDeg: 135 }),
    ])
      expect(
        await evaluate(`cr4c-refuse-${doc.features.at(-1)!.id}-${cadContentHash(doc)}`, doc),
      ).toMatchObject({
        evaluation: { status: 'error', code: 'flange-self-intersects', featureId: 'flange' },
      });
  }, 120000);

  it('sweeps a hat, Z, channel or flat section along a path, facing hats on their flanges (CR4d)', async () => {
    // TS-1539, ST-264: F48, a hat 30 × 40 with 15 mm flanges and R 3 bends.
    const run = async (o: Parameters<typeof f48ProfileSweep>[0]) => {
      const result = await evaluate(`cr4d-${JSON.stringify(o)}`, f48ProfileSweep(o));
      if (result.type !== 'result' || result.evaluation.status !== 'ok')
        throw new Error(JSON.stringify(result.type === 'result' ? result.evaluation : result));
      const { bodies } = result.evaluation;
      const of = (id: string) => {
        const b = bodies[id];
        if (b?.kind !== 'sheet') throw new Error(JSON.stringify(b));
        return b;
      };
      const mesh = result.meshes.find((m) => m.bodyId === 'member-body')!;
      return { of, names: faceNames(mesh), edges: edgeNames(mesh) };
    };
    const outline = 2 * 12 + 2 * 24 + 34 + 4 * ((Math.PI / 2) * 3);
    const straight = await run({});
    const member = straight.of('member-body');
    expect(member.areaMm2).toBeCloseTo(200 * outline, 3);
    const close = (a: number[], b: number[]) =>
      a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, 6));
    close(member.bounds[0], [0, -35, 0]);
    close(member.bounds[1], [200, 35, 30]);
    expect(sortedNames(straight.names)).toEqual(
      ['bend:1', 'bend:2', 'bend:3', 'bend:4', 'flange:l', 'flange:r', 'top', 'wall:l', 'wall:r']
        .map((x) => `side:p:${x}/path:e:l0`)
        .sort(),
    );
    expect(straight.edges).toContain('edge:start:p:flange:l | side:p:flange:l/path:e:l0');
    // Flipped, and up along the path's in-plane normal (+y).
    close((await run({ flip: true })).of('member-body').bounds[0], [0, -35, -30]);
    const across = (await run({ up: 'inPlane' })).of('member-body').bounds;
    close(across[0], [0, 0, -35]);
    close(across[1], [200, 30, 35]);
    // A given direction on a straight path.
    close((await run({ up: [0, 1, 0] })).of('member-body').bounds[1], [200, 30, 35]);
    // Along a line and a 60° arc of R 300: the section turns with the path, its area the path's
    // length times the outline's (the hat is symmetric across the path).
    const bend = (await run({ path: 'bend' })).of('member-body');
    expect(bend.areaMm2).toBeCloseTo((200 + 100 * Math.PI) * outline, 1);
    // Two hats facing each other: their flanges meet in z = 0.
    const box = await run({ closure: 'hat' });
    close(box.of('closure-body').bounds[0], [0, -35, -30]);
    close(box.of('closure-body').bounds[1], [200, 35, 0]);
    // A hat on a flat closure plate the width of its flanges.
    const flat = (await run({ closure: 'flat' })).of('closure-body');
    expect(flat.areaMm2).toBeCloseTo(200 * 70, 6);
    // Z and channel.
    expect((await run({ kind: 'z', radius: 0 })).of('member-body').areaMm2).toBeCloseTo(
      200 * (15 + 30 + 40),
      3,
    );
    expect((await run({ kind: 'channel', radius: 0 })).of('member-body').areaMm2).toBeCloseTo(
      200 * (30 + 40 + 30),
      3,
    );
  }, 120000);

  it('refuses a profile sweep tighter than its section, or turned by a vector along a curve (CR4d)', async () => {
    // TS-1540: an arc of R 20 under a hat reaching 46 mm; a vector up along the bend.
    for (const [o, code] of [
      [{ path: 'bend', bendRadius: 20 }, 'profile-sweep-tight'],
      [{ path: 'bend', up: [0, 0, 1] }, 'profile-up-curved'],
      [{ up: [1, 0, 0] }, 'profile-up'],
    ] as const)
      expect(
        await evaluate(
          `cr4d-refuse-${JSON.stringify(o)}`,
          f48ProfileSweep(o as Parameters<typeof f48ProfileSweep>[0]),
        ),
      ).toMatchObject({ evaluation: { status: 'error', code, featureId: 'member' } });
  }, 120000);

  it('evaluates the simplified BIW: 42 bodies, the right parts mirrored, 68 weld rows (CR4g, CR5f)', async () => {
    // TS-1551, ST-266: F29. The side outer is trimmed (doors, arch) before its copy is mirrored:
    // the trim names cut edges of pieces it leaves out, which a copying mirror has no image of.
    const run = async (o: Parameters<typeof f29Biw>[0] = {}) => {
      const result = await evaluate(`cr4g-${JSON.stringify(o)}`, f29Biw(o));
      if (result.type !== 'result' || result.evaluation.status !== 'ok')
        throw new Error(JSON.stringify(result.type === 'result' ? result.evaluation : result));
      const welds = result.evaluation.spotWelds!.map((w, i) => {
        if (w.status !== 'ok') throw new Error(`row ${i}: ${JSON.stringify(w)}`);
        return w;
      });
      return { evaluation: result.evaluation, welds };
    };
    const base = await run();
    const bodies = base.evaluation.bodies;
    expect(Object.keys(bodies)).toHaveLength(42);
    const kinds = Object.values(bodies).map((b) => b.kind);
    expect(kinds.filter((k) => k === 'solid')).toHaveLength(4);
    expect(kinds.filter((k) => k === 'sheet')).toHaveLength(38);
    // A right part is its left part reflected in y = 0: the same area, the bounds' y negated.
    for (const id of Object.keys(bodies).filter((k) => k.endsWith('-r'))) {
      const [l, r] = [bodies[id.slice(0, -2)]!, bodies[id]!];
      expect(r.areaMm2, id).toBeCloseTo(l.areaMm2, 3);
      expect(r.bounds[0][1], id).toBeCloseTo(-l.bounds[1][1], 3);
      expect(r.bounds[1][1], id).toBeCloseTo(-l.bounds[0][1], 3);
    }
    // Every row lies on its second flange: 1,543 points at a 40 mm pitch, none too far (CR5f's
    // 14 rows joining the front and rear structures to the cabin add 146; CR5f-4's 6 rows on the
    // rear side members' runs under the floor add 36, and their straight parts under the trunk
    // floor, now 470 mm, carry 24 fewer; CR5f-6's longer pillars, roof rails, cross members and
    // rear runs add 84; CR5f-7's 4 rows on the front extensions add 22).
    const count = (w: typeof base.welds) => w.reduce((n, x) => n + x.points.length / 3, 0);
    expect(base.welds).toHaveLength(68);
    expect(count(base.welds)).toBe(1543);
    expect(base.welds.slice(58, 64).map((w) => w.points.length / 3)).toEqual([7, 7, 7, 7, 7, 7]);
    expect(base.welds.slice(64).map((w) => w.points.length / 3)).toEqual([7, 7, 4, 4]);
    // CR5f-4: the rear side member kicks down under the trunk floor's kick and runs on under the
    // floor pan (top z 250) to x 1260.
    expect(bodies['rear-member']!.bounds[0][2]).toBeCloseTo(190, 3);
    expect(bodies['rear-member']!.bounds[1][0]).toBeCloseTo(1260, 3);
    expect(bodies['rear-member']!.bounds[1][2]).toBeCloseTo(350, 3);
    // CR5f-7: the front extension runs from under its closure (top z 450, x 3400) down under the
    // floor pan to the front cross member's front wall (x 2740).
    expect(bodies['front-extension']!.bounds[0][0]).toBeCloseTo(2740, 3);
    expect(bodies['front-extension']!.bounds[1][0]).toBeCloseTo(3400, 3);
    expect(bodies['front-extension']!.bounds[0][2]).toBeCloseTo(190, 3);
    expect(bodies['front-extension']!.bounds[1][2]).toBeCloseTo(450, 3);
    // CR5f-9: the apron's lower edge is turned in to y −480, over the side member's closure.
    expect(bodies.apron!.bounds[1][1]).toBeCloseTo(-480, 3);
    expect(bodies.apron!.bounds[0][2]).toBeCloseTo(450, 3);
    for (const w of base.welds) {
      expect(w.tooFar).toBe(0);
      w.gaps.forEach((g) => expect(g).toBeLessThan(1e-6));
    }
    const roof = (w: typeof base) => [w.welds[12]!, w.welds[13]!];
    expect(roof(base).map((w) => w.points.length / 3)).toEqual([28, 28]);
    // A wider roof flange (100): the side outers reach further in, the roof still welded.
    const wide = await run({ flangeMm: 100 });
    expect(wide.evaluation.bodies.side!.bounds[1][1]).toBeCloseTo(-650, 3);
    expect(wide.evaluation.bodies['side-r']!.bounds[0][1]).toBeCloseTo(650, 3);
    expect(base.evaluation.bodies.side!.bounds[1][1]).toBeCloseTo(-670, 3);
    expect(wide.evaluation.geometryDigest).not.toBe(base.evaluation.geometryDigest);
    expect(roof(wide).map((w) => w.tooFar)).toEqual([0, 0]);
    // A narrow one (40) ends 20 mm short of the roof strip's centre line: every point too far.
    const narrow = await run({ flangeMm: 40 });
    expect(roof(narrow).map((w) => w.tooFar)).toEqual([28, 28]);
    roof(narrow).forEach((w) => w.gaps.forEach((g) => expect(g).toBeCloseTo(20, 3)));
    // A 60 mm pitch: fewer points, the shapes (and their digest) the same.
    const coarse = await run({ pitchMm: 60 });
    expect(count(coarse.welds)).toBeLessThan(count(base.welds));
    expect(coarse.welds[0]!.points.length / 3).toBe(22);
    expect(coarse.evaluation.geometryDigest).toBe(base.evaluation.geometryDigest);
  }, 600_000);

  it('places spot welds along a flange and measures each to the other flange (CR4e)', async () => {
    // TS-1544, ST-265: F49, a hat's left flange (x 0…200, y −35…−23) on a flat closure plate.
    const run = async (o: Parameters<typeof f49SpotWelds>[0]) => {
      const doc = f49SpotWelds(o);
      const result = await evaluate(`cr4e-${JSON.stringify(o)}`, doc);
      if (result.type !== 'result' || result.evaluation.status !== 'ok')
        throw new Error(JSON.stringify(result.type === 'result' ? result.evaluation : result));
      return { welds: result.evaluation.spotWelds!, digest: result.evaluation.geometryDigest };
    };
    const plate = await run({ both: true });
    const [left, right] = plate.welds;
    if (left?.status !== 'ok' || right?.status !== 'ok') throw new Error(JSON.stringify(plate));
    // 200 mm: 5 points 40 apart, centred, the first 20 from the start (≥ 10 from the ends),
    // on the flange's centre line (y = −29), each on the plate.
    expect(left.lengthMm).toBeCloseTo(200, 6);
    const xs = (w: typeof left) => w.points.filter((_, i) => i % 3 === 0);
    xs(left).forEach((x, i) => expect(x).toBeCloseTo(20 + 40 * i, 6));
    left.points.filter((_, i) => i % 3 === 1).forEach((y) => expect(y).toBeCloseTo(-29, 6));
    left.gaps.forEach((g) => expect(g).toBeLessThan(1e-6));
    expect(left.tooFar).toBe(0);
    right.points.filter((_, i) => i % 3 === 1).forEach((y) => expect(y).toBeCloseTo(29, 6));
    // A pitch of 60 and 30 from the ends: 140 mm → 3 points; the digest stays (no shape changed).
    const coarse = await run({ both: true, pitchMm: 60, endDistanceMm: 30 });
    const c = coarse.welds[0]!;
    if (c.status !== 'ok') throw new Error(JSON.stringify(c));
    expect(xs(c).map((x) => Math.round(x * 1e6) / 1e6)).toEqual([40, 100, 160]);
    expect(coarse.digest).toBe(plate.digest);
    // To the other hat's top, 30 mm below and 12 mm across (its edge at y −17): every point
    // too far.
    const top = (await run({ to: 'top' })).welds[0]!;
    if (top.status !== 'ok') throw new Error(JSON.stringify(top));
    top.gaps.forEach((g) => expect(g).toBeCloseTo(Math.hypot(30, 12), 1));
    expect(top.tooFar).toBe(5);
    // 100 from both ends of 200 mm: one point, in the middle.
    const one = (await run({ endDistanceMm: 100 })).welds[0]!;
    if (one.status !== 'ok') throw new Error(JSON.stringify(one));
    expect(one.points[0]).toBeCloseTo(100, 6);
    expect(one.gaps).toHaveLength(1);
  }, 120000);

  it('reports a spot weld whose flange is gone, and keeps the shapes (CR4e)', async () => {
    // TS-1545: the row's first flange renamed away.
    const doc = f49SpotWelds();
    doc.spotWelds![0]!.flanges[0]!.face = {
      ...doc.spotWelds![0]!.flanges[0]!.face,
      name: [['side:p:wall:x', 'path:e:l0']],
    };
    const result = await evaluate('cr4e-missing', doc);
    if (result.type !== 'result') throw new Error(JSON.stringify(result));
    expect(result.evaluation).toMatchObject({
      status: 'ok',
      spotWelds: [{ id: 'welds-l', status: 'error', code: 'spot-weld-face-missing' }],
    });
  }, 120000);

  it('flares a wheel arch out of a sheet, joining the sheet G1 or G2 (CR2d)', async () => {
    // TS-1495, ST-251: the F22 panel (100 × 60) with a half-disc arch of R 15 at its border,
    // flared 10 mm out along a half circle of R 30 around it.
    const run = async (options?: Parameters<typeof f24Flare>[0]) => {
      const id = `cr2d-${JSON.stringify(options ?? {})}`;
      const doc = f24Flare(options);
      const result = await evaluate(id, doc);
      if (result.type !== 'result' || result.evaluation.status !== 'ok')
        throw new Error(JSON.stringify(result));
      const panel = result.evaluation.bodies['panel-body'];
      if (panel?.kind !== 'sheet') throw new Error(JSON.stringify(panel));
      const mesh = result.meshes.find((m) => m.bodyId === 'panel-body')!;
      const names = faceNames(mesh);
      const z = new Map<string, [number, number]>();
      for (let t = 0; t < mesh.indices.length / 3; t++) {
        const name = names[mesh.faceIds[t]! - 1]!;
        for (let k = 0; k < 3; k++) {
          const h = mesh.positions[3 * mesh.indices[3 * t + k]! + 2]! + mesh.origin[2];
          const [lo, hi] = z.get(name) ?? [Infinity, -Infinity];
          z.set(name, [Math.min(lo, h), Math.max(hi, h)]);
        }
      }
      const seam = await continuityOf(`${id}-seam`, doc, 'panel-body', `${fill} | ${stay}`);
      if (!('samples' in seam)) throw new Error(JSON.stringify(seam));
      return {
        panel,
        names,
        z,
        edges: edgeNames(mesh).filter((n): n is string => !!n),
        level: continuityReport(seam.samples).level,
      };
    };
    const stay = 'flare:flare/trim:arch:outside/side:e:l';
    const fill = 'flare:flare/surface';
    const g1 = await run();
    expect([...g1.z.keys()].sort()).toEqual([fill, stay]);
    for (const h of g1.z.get(stay)!) expect(h).toBeCloseTo(0, 9);
    expect(g1.z.get(fill)![1]).toBeCloseTo(10, 6);
    // The panel less the half disc of R 30, and the fill: more than the flat half ring it
    // replaces (it rises), less than that ring and a 10 mm wall around both its arcs.
    const kept = 6000 - (Math.PI * 900) / 2;
    const ring = (Math.PI * (900 - 225)) / 2;
    const fillArea = g1.panel.areaMm2 - kept;
    expect(fillArea).toBeGreaterThan(ring);
    expect(fillArea).toBeLessThan(ring + Math.PI * 45 * 10);
    expect(g1.level).toBe('G1');
    // The moved arch and the two ramps are named by the edges they replace.
    expect(g1.edges).toContain(`${fill} | flare:flare:moved/sketch:wheel/cut:e:a0`);
    // The ramps replace pieces of one border: each is told by its end of the chain (#927).
    for (const end of ['first', 'last'])
      expect(
        g1.edges.filter((n) => n === `${fill} | flare:flare:${end}/trim:arch:outside/end`),
      ).toHaveLength(1);
    expect(g1.edges).toContain(`${stay} | flare:flare/trim:arch:outside/start`);
    // G2: the profiles leave the sheet with its curvature (none), and the seam holds G2.
    const g2 = await run({ continuity: 'G2' });
    expect(g2.level).toBe('G2');
    expect(g2.z.get(fill)![1]).toBeCloseTo(10, 6);
    // Higher.
    const high = await run({ height: 25 });
    expect(high.z.get(fill)![1]).toBeCloseTo(25, 6);
    expect(high.level).toBe('G1');
  }, 60000);

  it('builds the B1 sample, a hatchback’s left skin, and follows its wheelbase and roof (CR2e)', async () => {
    // TS-1498, ST-252: the curve network, both arches flared G2, the press line and the inner
    // panel; then the wheelbase 2400 → 2500 and the roof 1335 → 1400 mm as parameters.
    const run = async (id: string, doc: CadDocument) => {
      const result = await evaluate(id, doc);
      if (result.type !== 'result' || result.evaluation.status !== 'ok')
        throw new Error(JSON.stringify(result).slice(0, 2000));
      const { bodies } = result.evaluation;
      const skin = bodies['skin-body'];
      const inner = bodies['inner-body'];
      if (skin?.kind !== 'sheet' || inner?.kind !== 'sheet')
        throw new Error(JSON.stringify(bodies));
      const mesh = result.meshes.find((m) => m.bodyId === 'skin-body')!;
      return { skin, inner, names: faceNames(mesh), edges: edgeNames(mesh) };
    };
    const doc = f25B1Car();
    const car = await run('cr2e', doc);
    const skin = 'trim:front-arch:outside/trim:rear-arch:outside/surface';
    // The skin less the arches, in four pieces: below and above the press line, the two flares;
    // the press line's wall and its two rounds.
    expect(car.names.filter((n) => n?.startsWith('press:press:right/')).sort()).toEqual(
      [
        `press:press:right/flare:front-flare/flare:rear-flare/${skin}`,
        'press:press:right/flare:front-flare/flare:rear-flare/surface',
        'press:press:right/flare:front-flare/surface',
      ].sort(),
    );
    expect(car.names).toContain(`press:press:moved/flare:front-flare/flare:rear-flare/${skin}`);
    expect(car.names.filter((n) => n?.startsWith('blend:'))).toHaveLength(2);
    expect(car.names.filter((n) => n?.startsWith('press:press/wall:'))).toHaveLength(1);
    // The arches moved 25 mm out (y < 0 is out): the rear one's top was at y ≈ −806.
    expect(car.edges.some((n) => n?.includes('flare:rear-flare:moved/'))).toBe(true);
    const [lo, hi] = car.skin.bounds;
    // The spline network overshoots the end sections by under a millimetre.
    expect(Math.abs(lo[0])).toBeLessThan(2);
    expect(Math.abs(hi[0] - 4205)).toBeLessThan(2);
    // The crown (1335 at the cabin, its spline a little above) and the press moving the top 2 mm.
    expect(hi[2]).toBeGreaterThan(1337);
    expect(hi[2]).toBeLessThan(1400);
    // The inner panel 20 mm inside: narrower and lower than the skin.
    expect(car.inner.bounds[0][1]).toBeGreaterThan(lo[1] + 15);
    expect(car.inner.bounds[1][2]).toBeLessThan(hi[2] - 15);
    // A longer wheelbase and a higher roof, as an editor sets them: the network still meets,
    // every feature still builds, the nose 100 mm further and the cabin 65 mm higher.
    let longer = applyCadOperation(doc, {
      type: 'setParameter',
      parameterId: 'wheelbase',
      value: 2500,
    });
    longer = applyCadOperation(longer, { type: 'setParameter', parameterId: 'roof', value: 1400 });
    const moved = await run('cr2e-longer', longer);
    expect(Math.abs(moved.skin.bounds[1][0] - 4305)).toBeLessThan(2);
    expect(moved.skin.bounds[1][2]).toBeGreaterThan(hi[2] + 55);
    expect(moved.names.sort()).toEqual(car.names.sort());
  }, 300000);

  it('measures exact distances from points to faces, past the display triangles (CR4a)', async () => {
    // TS-1527, ST-260: F21 scaled 50×, a 2 m flat part and an r = 1 m quarter cylinder 1.5 m
    // high, and its offset 0.3 mm behind. The display deflection is 0.1% of the 3.5 m diagonal,
    // so the triangles lie up to about 3.5 mm off the cylinder.
    const doc = f21OffsetSurface('back', 0.3);
    for (const sketch of doc.sketches)
      for (const k of Object.keys(sketch.solved))
        sketch.solved[k] = sketch.solved[k]!.map((x) => 50 * x) as [number, number];
    doc.parameters = doc.parameters.map((p) =>
      p.id === 'H' ? ({ ...p, value: 1500 } as typeof p) : p,
    );
    const measured = async (id: string, queries: CadFaceDistanceQuery[]) => {
      const document = pinned(doc);
      await handle({
        type: 'evaluate',
        requestId: id,
        generation: 1,
        baseHash: '',
        candidateHash: cadContentHash(document),
        document,
        faceDistances: queries,
      });
      const result = posted.find(
        (m) => 'requestId' in m && m.requestId === id && m.type !== 'progress',
      )!;
      if (result.type !== 'result' || result.evaluation.status !== 'ok')
        throw new Error(JSON.stringify(result).slice(0, 2000));
      return { meshes: result.meshes, distances: result.faceDistances! };
    };
    const { meshes } = await measured('cr4a-mesh', []);
    const [outer, inner] = ['sheet', 'inner-body'].map((id) =>
      meshes.find((m) => m.bodyId === id || (id === 'sheet' && m.bodyId !== 'inner-body')),
    ) as [CadMesh, CadMesh];
    const faces = outer.topology.faces.map((_, i) => i);
    // The inner sheet's display nodes lie on its exact surface.
    const points = new Float64Array(inner.positions.length);
    for (let i = 0; i < inner.positions.length; i++)
      points[i] = inner.positions[i]! + inner.origin[i % 3]!;
    // How far the outer display triangles stray: the cylinder part's triangle centres from the
    // axis (x = 2000, y = 1000), against r = 1000.
    let sag = 0;
    for (let t = 0; t < outer.indices.length / 3; t++) {
      const c = [0, 1, 2].map(
        (a) =>
          [0, 1, 2].reduce((s, k) => s + outer.positions[3 * outer.indices[3 * t + k]! + a]!, 0) /
            3 +
          outer.origin[a]!,
      );
      if (c[0]! > 2000.5) sag = Math.max(sag, 1000 - Math.hypot(c[0]! - 2000, c[1]! - 1000));
    }
    expect(sag).toBeGreaterThan(1);
    // A point 100 mm past the flat part's start (x = −100) is nearest its border edge.
    const past = Float64Array.from([-100, 0, 700]);
    const { distances } = await measured('cr4a-measure', [
      { bodyId: outer.bodyId, faces, points },
      { bodyId: outer.bodyId, faces, points: past },
      { bodyId: outer.bodyId, faces: [faces.length], points: past },
      { bodyId: 'nope', faces: [0], points: past },
    ]);
    const all = distances[0]!;
    if (!('distances' in all)) throw new Error(JSON.stringify(all));
    expect(all.distances).toHaveLength(points.length / 3);
    // The nodes are Float32 (relative to the mesh origin): a few µm off the inner surface.
    for (const d of all.distances) expect(Math.abs(d - 0.3)).toBeLessThan(1e-4);
    const edge = distances[1]!;
    if (!('distances' in edge)) throw new Error(JSON.stringify(edge));
    expect(edge.distances[0]).toBeCloseTo(100, 6);
    expect(distances[2]).toEqual({ code: 'face-distance-face-missing' });
    expect(distances[3]).toEqual({ code: 'face-distance-body-missing' });
    // The inner triangles' centres, off the inner surface by its sag, taken onto it first
    // (`via`, Codex on #960): 0.3 mm again.
    const innerFaces = inner.topology.faces.map((_, i) => i);
    const centres = new Float64Array(inner.indices.length);
    for (let t = 0; t < inner.indices.length / 3; t++)
      for (let a = 0; a < 3; a++)
        centres[3 * t + a] =
          [0, 1, 2].reduce((s, k) => s + inner.positions[3 * inner.indices[3 * t + k]! + a]!, 0) /
            3 +
          inner.origin[a]!;
    const [raw, moved] = (
      await measured('cr4a-via', [
        { bodyId: outer.bodyId, faces, points: centres },
        {
          bodyId: outer.bodyId,
          faces,
          points: centres,
          via: { bodyId: inner.bodyId, faces: innerFaces },
        },
      ])
    ).distances;
    if (!raw || !moved || !('distances' in raw) || !('distances' in moved))
      throw new Error(JSON.stringify([raw, moved]));
    expect(Math.max(...raw.distances.map((d) => Math.abs(d - 0.3)))).toBeGreaterThan(0.5);
    for (const d of moved.distances) expect(Math.abs(d - 0.3)).toBeLessThan(1e-6);
  }, 300000);

  it('measures to a face trimmed by a circle by its exact border (Codex on #960)', async () => {
    // F02: the r = 5 hole at (40, 25) through the 5 mm plate. The display triangulation's
    // polygon of the hole lies inside the circle (its chords' middles at r = 4.964); a point over
    // the hole 0.02 mm inside the circle, 0.02 mm above the top, is √(0.02² + 0.02²) from the
    // border, all round (between the polygon and the circle the triangles alone say 0.02).
    const document = pinned(f02Plate());
    const points: number[] = [];
    for (let k = 0; k < 256; k++) {
      const a = (2 * Math.PI * k) / 256;
      points.push(40 + 4.98 * Math.cos(a), 25 + 4.98 * Math.sin(a), 5.02);
    }
    points.push(40, 25, 5.02);
    await handle({
      type: 'evaluate',
      requestId: 'cr4a-hole',
      generation: 1,
      baseHash: '',
      candidateHash: cadContentHash(document),
      document,
      faceDistances: [
        { bodyId: 'plate', faces: [0, 1, 2, 3, 4, 5, 6], points: Float64Array.from(points) },
      ],
    });
    const result = posted.find(
      (m) => 'requestId' in m && m.requestId === 'cr4a-hole' && m.type !== 'progress',
    )!;
    if (result.type !== 'result' || result.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(result).slice(0, 2000));
    const [r] = result.faceDistances!;
    if (!r || !('distances' in r)) throw new Error(JSON.stringify(r));
    for (let k = 0; k < 256; k++) expect(r.distances[k]).toBeCloseTo(Math.hypot(0.02, 0.02), 6);
    expect(r.distances[256]).toBeCloseTo(Math.hypot(5, 0.02), 6);
    // The hole's wall, a whole cylinder with a seam: 0.3 mm inside it at every angle, the seam's
    // included (the seam is no border).
    const mesh = result.meshes.find((m) => m.bodyId === 'plate')!;
    let wall = -1;
    for (let t = 0; t < mesh.indices.length / 3 && wall < 0; t++) {
      const v = mesh.indices[3 * t]!;
      const [x, y] = [0, 1].map((a) => mesh.positions[3 * v + a]! + mesh.origin[a]!);
      const z = mesh.positions[3 * v + 2]! + mesh.origin[2]!;
      const w = mesh.indices[3 * t + 1]!;
      const z2 = mesh.positions[3 * w + 2]! + mesh.origin[2]!;
      if (Math.abs(Math.hypot(x! - 40, y! - 25) - 5) < 1e-3 && Math.abs(z - z2) > 1e-3)
        wall = mesh.faceIds[t]! - mesh.faceBase - 1;
    }
    expect(wall).toBeGreaterThanOrEqual(0);
    const around: number[] = [];
    for (let k = -8; k <= 8; k++)
      for (const base of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
        const a = base + k * 0.01;
        around.push(40 + 4.7 * Math.cos(a), 25 + 4.7 * Math.sin(a), 2.5);
      }
    await handle({
      type: 'evaluate',
      requestId: 'cr4a-seam',
      generation: 1,
      baseHash: '',
      candidateHash: cadContentHash(document),
      document,
      faceDistances: [{ bodyId: 'plate', faces: [wall], points: Float64Array.from(around) }],
    });
    const seam = posted.find(
      (m) => 'requestId' in m && m.requestId === 'cr4a-seam' && m.type !== 'progress',
    )!;
    if (seam.type !== 'result') throw new Error(JSON.stringify(seam).slice(0, 2000));
    const [w] = seam.faceDistances!;
    if (!w || !('distances' in w)) throw new Error(JSON.stringify(w));
    for (const d of w.distances) expect(d).toBeCloseTo(0.3, 6);
  }, 300000);

  it('mirrors a trimmed sheet into a new body (CR4g)', async () => {
    // TS-1551, ST-266: F24's panel with its wheel arch trimmed out, the trim its result.
    const doc = withMirrorCopy(f24Flare({ flare: false }));
    const result = await evaluate('cr4g-trimmed', doc);
    if (result.type !== 'result' || result.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(result.type === 'result' ? result.evaluation : result));
    const [a, b] = [
      result.evaluation.bodies['panel-body']!,
      result.evaluation.bodies['copy-body']!,
    ];
    expect(b.kind).toBe('sheet');
    expect(b.areaMm2).toBeCloseTo(a.areaMm2, 6);
    expect(b.bounds[0][0]).toBeCloseTo(-a.bounds[1][0], 6);
  });

  it('mirrors a sheet and a solid into new bodies, the source kept and followed (CR4b)', async () => {
    // TS-1531, ST-261: across x = 0.
    const run = async (id: string, doc: CadDocument) => {
      const result = await evaluate(id, doc);
      if (result.type !== 'result' || result.evaluation.status !== 'ok')
        throw new Error(JSON.stringify(result).slice(0, 2000));
      return result;
    };
    for (const [id, doc] of [
      ['sheet', f17Sheets('extrude')],
      ['solid', f02Plate()],
    ] as const) {
      const source = doc.bodies[0]!.id;
      const { evaluation, meshes } = await run(`cr4b-${id}`, withMirrorCopy(doc));
      if (evaluation.status !== 'ok') return;
      const [a, b] = [evaluation.bodies[source]!, evaluation.bodies['copy-body']!];
      expect(b.kind).toBe(a.kind);
      expect(b.kind).toBe(id);
      expect(b.areaMm2).toBeCloseTo(a.areaMm2, 6);
      if (a.kind === 'solid' && b.kind === 'solid') expect(b.volumeMm3).toBeCloseTo(a.volumeMm3, 6);
      expect(b.bounds[0][0]).toBeCloseTo(-a.bounds[1][0], 6);
      expect(b.bounds[1][0]).toBeCloseTo(-a.bounds[0][0], 6);
      expect(b.bounds[0].slice(1)).toEqual(a.bounds[0].slice(1).map((x) => expect.closeTo(x, 6)));
      const names = faceNames(meshes.find((m) => m.bodyId === 'copy-body')!);
      expect(names.every((n) => n?.startsWith('mirror:copy/'))).toBe(true);
    }
    // The copy follows the source: the sheet 40 mm high instead of 30.
    const taller = withMirrorCopy(f17Sheets('extrude'));
    taller.parameters = taller.parameters.map((p) =>
      p.id === 'H' ? ({ ...p, value: 40 } as typeof p) : p,
    );
    const { evaluation } = await run('cr4b-taller', taller);
    if (evaluation.status !== 'ok') return;
    expect(evaluation.bodies['copy-body']!.bounds[1][2]).toBeCloseTo(40, 6);
  }, 300000);

  it('builds the B2 car sample: panels, windows, a gap that follows its parameter (CR3f)', async () => {
    // TS-1525, ST-259: F28 on the B1 skin.
    // The panels first: the whole sample evaluated cold in one job stops in the hatch's trim
    // with a Wasm memory fault (#957), while the same
    // features evaluate after the panels are cached.
    const panels = await evaluate('cr3f-panels', f28B2Car({ upTo: 'panels' }));
    if (panels.type !== 'result' || panels.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(panels).slice(0, 2000));
    const full = await evaluate('cr3f-full', f28B2Car());
    if (full.type !== 'result' || full.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(full).slice(0, 2000));
    const bodies = full.evaluation.bodies;
    for (const id of ['skin-body', 'door-body', 'hood-body', 'hatch-body'])
      expect(bodies[id]?.kind).toBe('sheet');
    // Each panel lies inside its outline, half the gap in from it (x along the car).
    const within = (id: string, [u0, u1]: [number, number, number, number]) => {
      const box = bodies[id]!.bounds;
      expect(box[0][0]).toBeGreaterThan(u0 + 1);
      expect(box[1][0]).toBeLessThan(u1 - 1);
      expect(box[0][0]).toBeLessThan(u0 + 3);
    };
    within('door-body', f28Outlines.door);
    within('hood-body', f28Outlines.hood);
    within('hatch-body', [
      Math.max(f28Outlines.hatch[0], bodies['skin-body']!.bounds[0][0]),
      f28Outlines.hatch[1],
      0,
      0,
    ]);
    // The door as a part's content evaluates to the same sheet on its own.
    const part = await evaluate('cr3f-door-part', bodyPartContent(f28B2Car(), 'door-body'));
    if (part.type !== 'result' || part.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(part).slice(0, 2000));
    expect(Object.keys(part.evaluation.bodies)).toEqual(['door-body']);
    expect(part.evaluation.bodies['door-body']!.areaMm2).toBeCloseTo(
      bodies['door-body']!.areaMm2,
      3,
    );

    // The door's rear edge (b0s1, x = 2550) against the opening's, below the character line.
    const gapAt = async (id: string, gap: number) => {
      const doc = f28B2Car({ gap, upTo: 'door' });
      const meshes = await meshesOf(`${id}-mesh`, doc);
      const index = (bodyId: string, match: (n: string) => boolean) => {
        const names = edgeNames(meshes.find((m) => m.bodyId === bodyId)!);
        const i = names.findIndex((n) => !!n && match(n));
        if (i < 0) throw new Error(`${bodyId}: ${JSON.stringify(names)}`);
        return i;
      };
      const result = await analysed(id, doc, {
        gapFlush: {
          a: {
            bodyId: 'door-body',
            edge: index(
              'door-body',
              (n) =>
                n.startsWith('panel:door:inside/press:press:right/') &&
                n.endsWith('| sketch:door-line/cut:e:b0s1'),
            ),
          },
          b: {
            bodyId: 'skin-body',
            edge: index('skin-body', (n) =>
              n.startsWith(
                'sketch:door-line/cut:e:b0s1 | trim:door-opening:outside/press:press:right/',
              ),
            ),
          },
        },
      });
      const measured = result.gapFlush!;
      if (!('samples' in measured)) throw new Error(JSON.stringify(measured));
      return gapFlushReport(measured.samples);
    };
    const standard = await gapAt('cr3f-gap', cadPanelGapDefaultMm);
    expect(standard.gap.min).toBeGreaterThan(cadPanelGapDefaultMm - 0.05);
    expect(standard.gap.max).toBeLessThan(cadPanelGapDefaultMm + 0.05);
    expect(Math.abs(standard.flush.max)).toBeLessThan(0.05);
    const wider = await gapAt('cr3f-gap-6', 6);
    expect(wider.gap.min).toBeGreaterThan(6 - 0.05);
    expect(wider.gap.max).toBeLessThan(6 + 0.05);
  }, 900000);

  it('fillets the corner between two faces of a sheet, constant or varying along it (CR1e)', async () => {
    // TS-1483, ST-247: an L of two 30 mm walls, its corner edge rounded.
    const run = async (kind: Parameters<typeof f20SheetFillet>[0]) => {
      const result = await evaluate(`cr1e-${kind}`, f20SheetFillet(kind));
      if (result.type !== 'result' || result.evaluation.status !== 'ok')
        throw new Error(JSON.stringify(result));
      const ell = result.evaluation.bodies.ell;
      if (ell?.kind !== 'sheet') throw new Error(JSON.stringify(ell));
      const mesh = result.meshes.find((m) => m.bodyId === 'ell')!;
      const blend = faceNames(mesh).indexOf('blend:(side:e:l0 | side:e:l1)');
      if (blend < 0) throw new Error(JSON.stringify(faceNames(mesh)));
      // The radius at a height: where the blend leaves the wall y = 0, x = 40 − R (face ids
      // count from 1).
      const radiusAt = (z: number) => {
        let x = Infinity;
        for (let t = 0; t < mesh.faceIds.length; t++) {
          if (mesh.faceIds[t] !== blend + 1) continue;
          for (let k = 0; k < 3; k++) {
            const i = 3 * mesh.indices[3 * t + k]!;
            const [px, py, pz] = [0, 1, 2].map((a) => mesh.positions[i + a]! + mesh.origin[a]!);
            if (Math.abs(py!) < 1e-6 && Math.abs(pz! - z) < 1.5) x = Math.min(x, px!);
          }
        }
        return 40 - x;
      };
      return { ell, radiusAt };
    };
    const constant = await run('constant');
    // Each wall loses 5 × 30 mm²; the quarter cylinder adds π/2 × 5 × 30.
    expect(constant.ell.areaMm2).toBeCloseTo(2 * (1200 - 150) + (Math.PI / 2) * 150, 1);
    expect(constant.radiusAt(0)).toBeCloseTo(5, 3);
    expect(constant.radiusAt(30)).toBeCloseTo(5, 3);
    const linear = await run('linear');
    expect(linear.radiusAt(0)).toBeCloseTo(5, 2);
    expect(linear.radiusAt(30)).toBeCloseTo(10, 2);
    const points = await run('points');
    // `at` is the share of the edge's length; the kernel runs a smooth law through the points,
    // so between them the radius may swing past them a little (here up to about 9.9 mm).
    expect(points.radiusAt(0)).toBeCloseTo(5, 2);
    expect(Math.abs(points.radiusAt(7.5) - 9)).toBeLessThan(0.5);
    expect(points.radiusAt(20)).toBeLessThan(points.radiusAt(12));
    expect(Math.max(...[3, 9, 12, 15, 20, 25].map(points.radiusAt))).toBeLessThan(10.5);
    expect(points.radiusAt(30)).toBeCloseTo(5, 2);
    // The wall's top border has one face: refused at the reference.
    expect(await evaluate('cr1e-free', f20SheetFillet('free'))).toMatchObject({
      evaluation: { status: 'error', code: 'fillet-free-edge', featureId: 'fillet' },
    });
  });

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

  it('refuses a union OCCT could not merge, where member ends meet at one point (TW4)', async () => {
    // Three leaning legs of a lattice tower (Ø2,300) and the two rings between their tops
    // (Ø1,200), each ring starting and ending on a leg's axis at its top, as the tower check
    // built them (0.1 mm): OCCT leaves overlapping members in separate solids that touch
    // (docs/cad/bim-tower.md TW4). Rounded to whole millimetres, the same union succeeds.
    type V = [number, number, number];
    type Q = [number, number, number, number];
    const members: [string, number, number, V, Q][] = [
      [
        'Leg 1',
        1150,
        50004.3,
        [-11547, 20000, 0],
        [0.005675889130460291, 0.0032769761173617185, 0, 0.9999785226244137],
      ],
      [
        'Leg 2',
        1150,
        50000.4,
        [-17320.5, 10000, 0],
        [0.0010088385050082784, 0.001747359547306166, 0, 0.99999796448767],
      ],
      ['Leg 3', 1150, 50004.3, [-23094, 0, 0], [0, 0.006553952234723439, 0, 0.9999785226244137]],
      [
        'Ring 1',
        600,
        11225.3,
        [-11219.3, 19432.4, 50000],
        [0.6005239880459787, -0.3733241751900793, 0, 0.7071067811865476],
      ],
      [
        'Ring 2',
        600,
        11225.3,
        [-17145.8, 9899.1, 50000],
        [0.6235702135844702, -0.33340694163472084, 0, 0.7071067811865476],
      ],
    ];
    /** The members joined by one union, the rings' ends `trim` mm short of the leg axes. */
    const lattice = (trim: number) => {
      const b = cadBuilder({ id: cadKernelBuild.id, buildHash });
      const ids = members.map(([name, radius, height, origin, q]) => {
        const t = name.startsWith('Ring') ? trim : 0;
        // The cylinder's axis: +Z turned by q (whose z is 0).
        const u = [2 * q[3] * q[1], -2 * q[3] * q[0], 1 - 2 * (q[0] ** 2 + q[1] ** 2)];
        return b.cylinder(name, {
          radius,
          height: height - 2 * t,
          origin: origin.map((x, i) => x + t * u[i]!) as V,
          orientation: q,
        });
      });
      const union = b.boolean(ids[0]!, ids.slice(1), 'union', 'Lattice');
      return { doc: b.document, union };
    };
    const atAxis = lattice(0);
    expect(await evaluate('tw4-axis', atAxis.doc)).toMatchObject({
      evaluation: { status: 'error', code: 'boolean-incomplete', featureId: atAxis.union },
    });
    // The rings' ends 300 mm short of the axes, still inside the legs: one solid.
    const ok = await evaluate('tw4-inside', lattice(300).doc);
    if (ok.type !== 'result' || ok.evaluation.status !== 'ok') throw new Error(JSON.stringify(ok));
    expect(Object.values(ok.evaluation.bodies)).toMatchObject([{ kind: 'solid' }]);
    expect(Object.values(ok.evaluation.bodies)[0]).not.toHaveProperty('solids');
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
      ); // Nor on the texture (#662): each face covers its real size.
    for (const r of textureStretch(mesh)) expect(r).toBeCloseTo(1, 2);
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

  const importFile = async (
    requestId: string,
    bytes: Uint8Array,
    options?: CadStepImportOptions,
  ) => {
    await handle({ type: 'import-step', requestId, bytes, ...(options ? { options } : {}) });
    const message = posted.find((m) => 'requestId' in m && m.requestId === requestId);
    if (message?.type !== 'import-result') throw new Error(JSON.stringify(message));
    return message.result;
  };
  const corpus = (name: string) => new Uint8Array(readFileSync(corpusFile(name)));
  /** Volume and bounds read by the native OCCT 8.0 reader (f07-corpus.py), in mm. */
  const reference: Record<string, [string, number, number[]]> = {
    'normal-mm-plate.step': ['mm', 19607.300918, [0, 0, 0, 80, 50, 5]],
    'normal-ap203.step': ['mm', 19607.300918, [0, 0, 0, 80, 50, 5]],
    // #811: one part written as AP242 imports as one body.
    'normal-ap242.step': ['mm', 19607.300918, [0, 0, 0, 80, 50, 5]],
    // #810: 1 mm written as CONVERSION_BASED_UNIT('MILLIMETRE'), as the JAMA AP242 files do.
    'normal-millimetre-plate.step': ['mm', 19607.300918, [0, 0, 0, 80, 50, 5]],
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
      'reject-ap209.step': 'step-schema-unsupported',
      'reject-assembly.step': 'step-assembly',
      // PMI-1: read and listed, refused until the user agrees to lose it (below).
      'reject-pmi-dimension.step': 'step-pmi-partial',
      'reject-external-reference.step': 'step-external-reference',
      'reject-not-step.step': 'step-unreadable',
      'reject-truncated.step': 'step-unreadable',
      'reject-two-shells.step': 'step-multiple-shells',
      'reject-two-solids.step': 'step-multiple-solids',
      'reject-free-face.step': 'step-not-single-solid',
      'reject-tolerance-wide.step': 'step-tolerance-unsupported',
      'reject-unit-mile.step': 'step-unit-unknown',
    };
    for (const [name, code] of Object.entries(expected))
      expect(await importFile(`f07-${name}`, corpus(name)), name).toMatchObject({
        status: 'rejected',
        code,
      });
    // The kernel's own reading of a widened tolerance, not a fixed message: past 1 mm (#820).
    const wide = await importFile('wide', corpus('reject-tolerance-wide.step'));
    expect(wide.status === 'rejected' && Number(wide.detail)).toBeGreaterThan(1);
  });

  it('reads F43 PMI with the XDE reader and matches the values written by another OCCT (PMI-1, CAD80)', async () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('../fixtures/f43/pmi-plate.step', import.meta.url)),
    );
    const expected = JSON.parse(
      readFileSync(new URL('../fixtures/f43/expected.json', import.meta.url), 'utf8'),
    ) as {
      dimensions: {
        type: string;
        value: number;
        lower: number | null;
        upper: number | null;
        targets: string[];
      }[];
      tolerances: { type: string; value: number; target: string; datums: string[] }[];
      datums: { name: string; target: string }[];
    };
    oc.FS.writeFile('/f43.step', bytes);
    const json = readPmiJson(oc, '/f43.step');
    oc.FS.unlink('/f43.step');
    // Faces of the plate by their kind: the targets must be faces of the one product.
    const faceOf = (t: PmiTargetJson) => {
      expect(t.shape).toBe(oc.TopAbs_ShapeEnum.TopAbs_FACE.value);
      expect(t.index).toBeGreaterThan(0);
      expect(t.product).toBeDefined();
      return t.index;
    };
    expect(json.dimensions).toHaveLength(expected.dimensions.length);
    expected.dimensions.forEach((e, i) => {
      const d = json.dimensions[i];
      expect(d.object).toBe(true);
      expect(pmiDimensionTypes[d.type!]).toBe(e.type);
      expect(d.values![0]).toBeCloseTo(e.value, 9);
      if (e.lower !== null && e.upper !== null) {
        expect(d.plusMinus).toBe(true);
        // OCCT 7.6 reads the lower deviation as a magnitude (`Abs` of the file's lower bound
        // −0.05): the sign is not the reader's to give, so the comparison checks it.
        expect(d.lowerTol).toBeCloseTo(Math.abs(e.lower), 9);
        expect(d.upperTol).toBeCloseTo(e.upper, 9);
      }
      const targets = [...d.targets, ...(d.targets2 ?? [])];
      expect(targets).toHaveLength(e.targets.length);
      targets.forEach(faceOf);
    });
    // Datums by name, each on one face; tolerances reference them in compartment order. The
    // reader gives a datum once per referencing tolerance; the same letter is the same face.
    const datums = new Map(json.datums.map((d) => [d.label, d]));
    expect(distinctDatums(json.datums).map((d) => d.name)).toEqual(
      expected.datums.map((d) => d.name),
    );
    json.datums.forEach((d) => expect(d.targets.map(faceOf)).toHaveLength(1));
    const faceOfDatum = (name: string) =>
      new Set(json.datums.filter((d) => d.name === name).map((d) => d.targets[0].index));
    expect([...faceOfDatum('A')]).toHaveLength(1);
    expect(faceOfDatum('A')).not.toEqual(faceOfDatum('B'));
    expect(json.tolerances).toHaveLength(expected.tolerances.length);
    expected.tolerances.forEach((e, i) => {
      const t = json.tolerances[i];
      expect(t.object).toBe(true);
      expect(pmiToleranceTypes[t.type!]).toBe(e.type);
      expect(t.value).toBeCloseTo(e.value, 9);
      expect(t.targets.map(faceOf)).toHaveLength(1);
      expect(t.datums!.map((l) => datums.get(l)?.name)).toEqual(e.datums);
    });
    // The same face is named the same way wherever it is a target.
    const top = json.tolerances[0].targets[0].index;
    expect(json.tolerances[1].targets[0].index).toBe(top);
    expect(json.views).toEqual([]);
    // The file's text and the reader agree on every family the reader knows (PMI-U1), and
    // PMI-2 keeps all of it: the file imports without asking, PMI is no loss.
    const imported = await importFile('f43', bytes);
    if (imported.status !== 'ok' || !imported.pmi) throw new Error(JSON.stringify(imported));
    const { pmi } = imported.report;
    expect(pmi).toMatchObject({
      census: { dimension: 2, 'geometric-tolerance': 3, datum: 2 },
      read: { dimensions: 2, tolerances: 3, datums: 2, views: 0 },
      kept: {
        dimension: 2,
        'geometric-tolerance': 3,
        datum: 2,
        'datum-target': 0,
        callout: 0,
        view: 0,
      },
      complete: true,
      lossless: true,
    });
    expect(imported.report.losses).not.toContain('pmi');
    expect(pmi!.axes.every((a) => a.unread === 0)).toBe(true);
    // Each item matched the file's meaning, datum features and datum systems included (#837).
    expect(pmi!.axes.filter((a) => a.axis === 'semantic').map((a) => [a.family, a.read])).toEqual([
      ['dimension', 2],
      ['geometric-tolerance', 3],
      ['datum', 2],
      ['datum-system', 2],
    ]);
    expect(pmi!.axes).toContainEqual({
      axis: 'target',
      family: 'datum-feature',
      inFile: 2,
      read: 2,
      unread: 0,
    });
    // PMI-2 (CAD80): the asset holds the items with their values, on the BRep's faces.
    expect(imported.report.pmiAsset).toEqual({
      sha256: `sha256:${createHash('sha256').update(imported.pmi).digest('hex')}`,
      byteLength: imported.pmi.byteLength,
    });
    const asset = JSON.parse(new TextDecoder().decode(imported.pmi)) as CadPmiAsset;
    expect(pmiAssetProblem(asset, { faces: 7, edges: 15, vertices: 10 })).toBeUndefined();
    // Each face of the BRep by where it is: the plate is 80 × 50 × 5 with a Ø10 hole.
    const owned: { delete(): void }[] = [];
    const own = <T>(x: T) => (owned.push(x as never), x);
    const faces = new Map<number, { centre: number[]; area: number }>();
    try {
      oc.FS.writeFile('/f43.brep', imported.brep);
      const shape = own(new oc.TopoDS_Shape());
      oc.BRepTools.Read_2(
        shape,
        '/f43.brep',
        own(new oc.BRep_Builder()),
        own(new oc.Message_ProgressRange_1()),
      );
      oc.FS.unlink('/f43.brep');
      const map = own(new oc.TopTools_IndexedMapOfShape_1());
      oc.TopExp.MapShapes_1(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, map);
      expect(map.Extent()).toBe(7);
      for (let i = 1; i <= map.Extent(); i++) {
        const props = own(new oc.GProp_GProps_1());
        oc.BRepGProp.SurfaceProperties_1(map.FindKey(i), props, false, false);
        const c = own(props.CentreOfMass());
        faces.set(i, { centre: [c.X(), c.Y(), c.Z()], area: props.Mass() });
      }
    } finally {
      for (const x of owned.reverse()) x.delete();
    }
    const where = (t: { shape: string; index: number }) => {
      expect(t.shape).toBe('face');
      const { centre, area } = faces.get(t.index)!;
      if (Math.abs(area - Math.PI * 10 * 5) < 1e-6) return 'hole';
      if (Math.abs(centre[2]) < 1e-9) return 'bottom';
      if (Math.abs(centre[2] - 5) < 1e-9) return 'top';
      return `side@${centre.map((v) => Math.round(v)).join(',')}`;
    };
    const items = asset.items;
    const datumNamed = (name: string) => items.find((i) => i.kind === 'datum' && i.name === name)!;
    expect(datumNamed('A').targets.map(where)).toEqual(['bottom']);
    // B is the side the fixture's expected.json names `side`.
    expect(datumNamed('B').targets.map(where)[0]).toMatch(/^side@/);
    const dims = items.filter((i) => i.kind === 'dimension');
    expect(dims).toEqual([
      expect.objectContaining({ type: 'Location_LinearDistance', values: [5] }),
      expect.objectContaining({
        type: 'Size_Diameter',
        values: [10],
        deviation: { lower: -0.05, upper: 0.05 },
      }),
    ]);
    expect(
      dims.map((d) =>
        [...d.targets, ...(d.kind === 'dimension' ? (d.targets2 ?? []) : [])].map(where),
      ),
    ).toEqual([['bottom', 'top'], ['hole']]);
    const tolerances = items.filter((i) => i.kind === 'geometric-tolerance');
    expect(
      tolerances.map((t) => [
        t.type,
        t.value,
        t.targets.map(where),
        t.references.map((r) =>
          r.datums.map(
            (d) =>
              items.find((i) => i.id === d)!.kind === 'datum' &&
              (items.find((i) => i.id === d) as { name: string }).name,
          ),
        ),
      ]),
    ).toEqual([
      ['Flatness', 0.02, ['top'], []],
      ['Parallelism', 0.05, ['top'], [['A']]],
      ['Position', 0.1, ['hole'], [['A'], ['B']]],
    ]);
    expect(tolerances[2]).toMatchObject({ zone: 'D' });
  });

  it.each(['pmi-presented.step', 'pmi-placeholder.step'])(
    'keeps the presentation lines the file links to each item, however it links them (PMI-3a, CAD83, TS-1420): %s',
    async (name) => {
      const bytes = new Uint8Array(
        readFileSync(new URL(`../fixtures/f43/${name}`, import.meta.url)),
      );
      const presented = JSON.parse(
        readFileSync(new URL('../fixtures/f43/presented.json', import.meta.url), 'utf8'),
      ) as { presentations: Record<string, { polylines: number[][][]; plane: unknown }> };
      // PMI-3b keeps the saved views too: nothing is lost, so the import does not ask.
      const imported = await importFile(name, bytes);
      if (imported.status !== 'ok' || !imported.pmi) throw new Error(JSON.stringify(imported));
      const pmi = imported.report.pmi!;
      const placeholder = name === 'pmi-placeholder.step';
      expect(pmi.kept).toEqual({
        dimension: 2,
        'geometric-tolerance': 2,
        datum: 2,
        'datum-target': 0,
        callout: 4,
        view: 2,
      });
      expect(pmi.axes.filter((a) => a.axis === 'presentation' || a.axis === 'view')).toEqual([
        { axis: 'presentation', family: 'callout', inFile: 4, read: 4, unread: 0 },
        // The placeholder file's diameter and position callouts each hold a placeholder too.
        {
          axis: 'presentation',
          family: 'annotation',
          inFile: placeholder ? 6 : 4,
          read: placeholder ? 6 : 4,
          unread: 0,
        },
        { axis: 'view', family: 'view', inFile: 2, read: 2, unread: 0 },
      ]);
      expect(pmi.lossless).toBe(true);
      const asset = JSON.parse(new TextDecoder().decode(imported.pmi)) as CadPmiAsset;
      expect(pmiAssetProblem(asset, { faces: 7, edges: 15, vertices: 10 })).toBeUndefined();
      const segments = (lines: number[][][]) =>
        lines.flatMap((line) => line.slice(1).flatMap((p, i) => [...line[i], ...p]));
      const of = (kind: string, test: (i: CadPmiAsset['items'][number]) => boolean) =>
        asset.items.find((i) => i.kind === kind && test(i))!;
      const shown: [CadPmiAsset['items'][number], string][] = [
        [
          of('dimension', (i) => i.kind === 'dimension' && i.type === 'Location_LinearDistance'),
          'distance',
        ],
        [of('dimension', (i) => i.kind === 'dimension' && i.type === 'Size_Diameter'), 'diameter'],
        [
          of(
            'geometric-tolerance',
            (i) => i.kind === 'geometric-tolerance' && i.type === 'Position',
          ),
          'position',
        ],
        [of('datum', (i) => i.kind === 'datum' && i.name === 'A'), 'datum A'],
      ];
      // The lines and plane (PMI-3b adds each callout's views as `ranges`).
      for (const [item, key] of shown)
        expect({ ...item.presentation, ranges: undefined }).toEqual({
          segments: segments(presented.presentations[key].polylines),
          plane: presented.presentations[key].plane,
        });
      // Semantic only: the flatness and datum B have no lines in the file.
      expect(
        of('geometric-tolerance', (i) => i.kind === 'geometric-tolerance' && i.type === 'Flatness')
          .presentation,
      ).toBeUndefined();
      expect(of('datum', (i) => i.kind === 'datum' && i.name === 'B').presentation).toBeUndefined();
    },
  );

  it('keeps the saved views that show kept items, and asks for a view it cannot keep (PMI-3b, CAD80, TS-1424)', async () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('../fixtures/f43/pmi-presented.step', import.meta.url)),
    );
    const expected = JSON.parse(
      readFileSync(new URL('../fixtures/f43/presented.json', import.meta.url), 'utf8'),
    ) as {
      views: {
        name: string;
        eye: number[];
        direction: number[];
        up: number[];
        width: number;
        height: number;
        members: string[];
      }[];
    };
    const imported = await importFile('pmi-views', bytes);
    if (imported.status !== 'ok' || !imported.pmi) throw new Error(JSON.stringify(imported));
    const asset = JSON.parse(new TextDecoder().decode(imported.pmi)) as CadPmiAsset;
    expect(pmiAssetProblem(asset, { faces: 7, edges: 15, vertices: 10 })).toBeUndefined();
    expect(
      [...(asset.views ?? [])]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((v) => ({ name: v.name, ...v.camera })),
    ).toEqual(
      [...expected.views]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(({ members: _members, ...v }) => v),
    );
    // Each item names the views whose draughting model lists its callout.
    const shownIn = (test: (i: CadPmiAsset['items'][number]) => boolean) =>
      (asset.items.find(test)?.views ?? []).map(
        (id) => asset.views!.find((v) => v.id === id)!.name,
      );
    expect(shownIn((i) => i.kind === 'dimension' && i.type === 'Size_Diameter')).toEqual(['Hole']);
    expect(shownIn((i) => i.kind === 'geometric-tolerance' && i.type === 'Position')).toEqual([
      'Hole',
    ]);
    expect(shownIn((i) => i.kind === 'datum' && i.name === 'A')).toEqual(['Datum A']);
    // Each item with views keeps its lines callout by callout, each naming its own views.
    for (const i of asset.items.filter((x) => x.views)) {
      const ranges = i.presentation!.ranges!;
      expect(ranges.at(-1)!.end).toBe(i.presentation!.segments.length);
      expect(ranges.flatMap((r) => r.views).every((v) => i.views!.includes(v))).toBe(true);
    }
    expect(shownIn((i) => i.kind === 'dimension' && i.type === 'Location_LinearDistance')).toEqual(
      [],
    );
    // A central projection is not kept: the import asks, and keeps the other view.
    const central = new TextEncoder().encode(
      new TextDecoder().decode(bytes).replace('.PARALLEL.', '.CENTRAL.'),
    );
    const asked = await importFile('pmi-views-central', central);
    expect(asked).toMatchObject({ status: 'rejected', code: 'step-pmi-partial' });
    const consented = await importFile('pmi-views-central-ok', central, { pmi: 'discard' });
    if (consented.status !== 'ok' || !consented.pmi) throw new Error(JSON.stringify(consented));
    expect(consented.report.pmi!.kept.view).toBe(1);
    expect(consented.report.pmi!.axes.find((a) => a.axis === 'view')).toEqual({
      axis: 'view',
      family: 'view',
      inFile: 2,
      read: 1,
      unread: 1,
    });
  });

  it('evaluates an imported body with its pmi asset and refuses an asset that does not fit it (PMI-2, CAD82)', async () => {
    const imported = await importFile(
      'pmi-eval',
      new Uint8Array(readFileSync(new URL('../fixtures/f43/pmi-plate.step', import.meta.url))),
    );
    if (imported.status !== 'ok' || !imported.pmi || !imported.report.pmiAsset)
      throw new Error(JSON.stringify(imported));
    const { report, brep } = imported;
    const pmiRef = (bytes: Uint8Array) => ({
      id: 'plate-pmi',
      kind: 'pmi' as const,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      byteLength: bytes.byteLength,
      mediaType: 'application/json',
    });
    const document = (pmi: Uint8Array) =>
      pinned(
        applyCadOperation(f01Empty(), {
          type: 'insertImportedBody',
          assets: [
            { id: 's', kind: 'source-step', ...report.source, mediaType: 'model/step' },
            { id: 'b', kind: 'normalized-brep', ...report.brep, mediaType: 'model/x-occt-brep' },
          ]
            .map(({ id, kind, sha256, byteLength, mediaType }) => ({
              id,
              kind: kind as 'source-step' | 'normalized-brep',
              sha256,
              byteLength,
              mediaType,
            }))
            .concat([pmiRef(pmi) as never]),
          feature: {
            id: 'imp',
            name: 'plate',
            type: 'imported',
            inputFeatureIds: [],
            args: {
              kind: 'solid',
              sourceAssetId: 's',
              brepAssetId: 'b',
              pmiAssetId: 'plate-pmi',
              importer: { id: 'dev', buildHash },
              sourceUnit: report.sourceUnit,
              scaleToMm: report.scaleToMm,
            },
          },
          body: {
            id: 'plate',
            name: 'plate',
            sourceFeatureId: 'imp',
            placementFeatureId: 'imp-placement',
            appearance: { color: '#8899aa', opacity: 1 },
          },
        }),
      );
    const evaluate = async (requestId: string, pmi: Uint8Array) => {
      const doc = document(pmi);
      await handle({
        type: 'evaluate',
        requestId,
        generation: 1,
        baseHash: '',
        candidateHash: cadContentHash(doc),
        document: doc,
        assets: { [report.brep.sha256]: brep, [pmiRef(pmi).sha256]: pmi },
      });
      const m = posted.find(
        (x) => 'requestId' in x && x.requestId === requestId && x.type !== 'progress',
      );
      if (m?.type !== 'result') throw new Error(JSON.stringify(m));
      return m.evaluation;
    };
    expect(await evaluate('pmi-eval-ok', imported.pmi)).toMatchObject({ status: 'ok' });
    // PMI-2 (CAD83): the view highlights a target by the mesh's pick table, which lists the
    // body's faces and edges in the same map order as the asset's indices.
    const shown = posted.find(
      (x) => 'requestId' in x && x.requestId === 'pmi-eval-ok' && x.type === 'result',
    );
    if (shown?.type !== 'result') throw new Error('no result');
    const { topology } = shown.meshes[0]!;
    const owned: { delete(): void }[] = [];
    const own = <T>(x: T) => (owned.push(x as never), x);
    try {
      oc.FS.writeFile('/f43-order.brep', brep);
      const shape = own(new oc.TopoDS_Shape());
      oc.BRepTools.Read_2(
        shape,
        '/f43-order.brep',
        own(new oc.BRep_Builder()),
        own(new oc.Message_ProgressRange_1()),
      );
      oc.FS.unlink('/f43-order.brep');
      for (const [kind, rows, props] of [
        ['TopAbs_FACE', topology.faces, 'SurfaceProperties_1'],
        ['TopAbs_EDGE', topology.edges, 'LinearProperties'],
      ] as const) {
        const map = own(new oc.TopTools_IndexedMapOfShape_1());
        oc.TopExp.MapShapes_1(shape, oc.TopAbs_ShapeEnum[kind], map);
        expect(rows, kind).toHaveLength(map.Extent());
        rows.forEach((row: { centroid: number[] }, i: number) => {
          const g = own(new oc.GProp_GProps_1());
          if (props === 'SurfaceProperties_1')
            oc.BRepGProp.SurfaceProperties_1(map.FindKey(i + 1), g, false, false);
          else oc.BRepGProp.LinearProperties(map.FindKey(i + 1), g, false, false);
          const c = own(g.CentreOfMass());
          expect(row.centroid[0], `${kind} ${i + 1}`).toBeCloseTo(c.X(), 6);
          expect(row.centroid[1], `${kind} ${i + 1}`).toBeCloseTo(c.Y(), 6);
          expect(row.centroid[2], `${kind} ${i + 1}`).toBeCloseTo(c.Z(), 6);
        });
      }
    } finally {
      for (const x of owned.reverse()) x.delete();
    }
    // A kept shape is checked as a rebuild is: the same document without its PMI bytes, or with
    // other bytes, is refused although the shape is cached.
    const warm = async (requestId: string, assets: Record<string, Uint8Array>) => {
      const doc = document(imported.pmi!);
      await handle({
        type: 'evaluate',
        requestId,
        generation: 1,
        baseHash: '',
        candidateHash: cadContentHash(doc),
        document: doc,
        assets,
      });
      const m = posted.find(
        (x) => 'requestId' in x && x.requestId === requestId && x.type !== 'progress',
      );
      if (m?.type !== 'result') throw new Error(JSON.stringify(m));
      return m.evaluation;
    };
    expect(await warm('pmi-warm-missing', { [report.brep.sha256]: brep })).toMatchObject({
      status: 'error',
      code: 'asset-missing',
      featureId: 'imp',
    });
    expect(
      await warm('pmi-warm-altered', {
        [report.brep.sha256]: brep,
        [pmiRef(imported.pmi).sha256]: new Uint8Array(imported.pmi.byteLength),
      }),
    ).toMatchObject({ status: 'error', code: 'asset-hash-mismatch', featureId: 'imp' });
    const asset = JSON.parse(new TextDecoder().decode(imported.pmi)) as CadPmiAsset;
    const bytes = (a: unknown) => new TextEncoder().encode(JSON.stringify(a));
    // A face the body does not have, a datum the asset does not hold, and bytes that are not
    // UTF-8 JSON are each refused on the imported feature.
    const outside = structuredClone(asset);
    outside.items[0].targets = [{ shape: 'face', index: 8 }];
    const lost = structuredClone(asset);
    lost.items = lost.items.filter((i) => i.kind !== 'datum');
    for (const [id, pmi] of [
      ['pmi-eval-face', bytes(outside)],
      ['pmi-eval-datum', bytes(lost)],
      ['pmi-eval-json', new Uint8Array([0x7b, 0xff, 0x7d])],
    ] as const)
      expect(await evaluate(id, pmi), id).toMatchObject({
        status: 'error',
        code: 'pmi-invalid',
        featureId: 'imp',
      });
  });

  /** PMI-4a/4b: F43's plate imported with its PMI, and the plate cut by a box. */
  const f43 = (name: string) =>
    new Uint8Array(readFileSync(new URL(`../fixtures/f43/${name}`, import.meta.url)));
  const pmiPlate = async (requestId: string, bytes: Uint8Array = f43('pmi-plate.step')) => {
    const imported = await importFile(requestId, bytes);
    if (imported.status !== 'ok' || !imported.pmi || !imported.report.pmiAsset)
      throw new Error(JSON.stringify(imported));
    const { report, brep, pmi } = imported;
    const pmiSha = `sha256:${createHash('sha256').update(pmi).digest('hex')}`;
    const plate = applyCadOperation(f01Empty(), {
      type: 'insertImportedBody',
      assets: [
        { id: 's', kind: 'source-step', ...report.source, mediaType: 'model/step' },
        { id: 'b', kind: 'normalized-brep', ...report.brep, mediaType: 'model/x-occt-brep' },
        {
          id: 'p',
          kind: 'pmi',
          sha256: pmiSha,
          byteLength: pmi.byteLength,
          mediaType: 'application/json',
        },
      ].map(({ id, kind, sha256, byteLength, mediaType }) => ({
        id,
        kind: kind as 'source-step',
        sha256,
        byteLength,
        mediaType,
      })),
      feature: {
        id: 'imp',
        name: 'plate',
        type: 'imported',
        inputFeatureIds: [],
        args: {
          kind: 'solid',
          sourceAssetId: 's',
          brepAssetId: 'b',
          pmiAssetId: 'p',
          importer: { id: 'dev', buildHash },
          sourceUnit: report.sourceUnit,
          scaleToMm: report.scaleToMm,
        },
      },
      body: {
        id: 'plate',
        name: 'plate',
        sourceFeatureId: 'imp',
        placementFeatureId: 'imp-placement',
        appearance: { color: '#8899aa', opacity: 1 },
      },
    });
    /** The plate cut by a box from `from` to `to` (mm). */
    const cut = (
      from: [number, number, number],
      to: [number, number, number],
      base: CadDocument = plate,
    ) =>
      pinned(
        applyCadOperation(
          applyCadOperation(base, {
            type: 'insertFeatures',
            parameters: [],
            profiles: [],
            features: [
              {
                id: 'tool',
                name: 'tool',
                type: 'box',
                inputFeatureIds: [],
                args: {
                  size: [mm(to[0] - from[0]), mm(to[1] - from[1]), mm(to[2] - from[2])],
                  origin: position(...from),
                  orientation: identityQuaternion(),
                },
              },
            ],
            bodies: [
              {
                id: 'tool-body',
                name: 'tool',
                sourceFeatureId: 'tool',
                placementFeatureId: 'tool-placement',
                appearance: { color: '#9aa4b1', opacity: 1 },
              },
            ],
          }),
          {
            type: 'booleanBodies',
            targetId: 'plate',
            toolId: 'tool-body',
            mode: 'cut',
            booleanFeatureId: 'op',
            placementFeatureId: 'op-placement',
          },
        ),
      );
    return { report, brep, pmi, pmiSha, plate, cut };
  };

  it('keeps the PMI of faces a cut leaves unchanged and makes the rest stale (PMI-4a, CAD84)', async () => {
    const { report, brep, pmi, pmiSha, plate, cut } = await pmiPlate('pmi-track');
    const run = async (requestId: string, doc: CadDocument) => {
      await handle({
        type: 'evaluate',
        requestId,
        generation: 1,
        baseHash: '',
        candidateHash: cadContentHash(doc),
        document: doc,
        assets: { [report.brep.sha256]: brep, [pmiSha]: pmi },
      });
      const m = posted.find(
        (x) => 'requestId' in x && x.requestId === requestId && x.type !== 'progress',
      );
      if (m?.type !== 'result' || m.evaluation.status !== 'ok') throw new Error(JSON.stringify(m));
      const mesh = m.meshes.find((x) => x.bodyId === 'plate')!;
      return mesh;
    };
    const asset = JSON.parse(new TextDecoder().decode(pmi)) as CadPmiAsset;
    /** Each item by what it is, current or why not. */
    const label = (i: CadPmiItem) =>
      i.kind === 'datum' ? `datum ${i.name}` : `${i.kind} ${'type' in i ? i.type : ''}`;
    const states = (mesh: Awaited<ReturnType<typeof run>>) => {
      expect(mesh.pmi?.map((x) => x.featureId)).toEqual(['imp']);
      const s = cadPmiItemStates(asset, mesh.pmi![0]);
      return Object.fromEntries(
        asset.items.map((i) => {
          const r = s.get(i.id)!;
          return [label(i), r.current ? 'current' : r.reason];
        }),
      );
    };
    // The import alone: every sub-shape is its own, at its own index.
    const alone = await run('pmi-track-alone', pinned(plate));
    expect(Object.values(states(alone)).every((s) => s === 'current')).toBe(true);
    const all = alone.pmi![0]!;
    expect(all.faces).toEqual(alone.topology.faces.flatMap((_, i) => [i + 1, i]));
    expect(all.vertices).toHaveLength(2 * alone.topology.vertices.length);
    expect(all.edges).toHaveLength(2 * alone.topology.edges.length);
    // F45 (a): a pocket inside the plate's thickness that splits the hole's face. The hole's
    // diameter and position are stale; the top, bottom and side are untouched.
    const pocket = await run('pmi-track-pocket', cut([30, 24, 1], [50, 26, 4]));
    expect(states(pocket)).toEqual({
      'dimension Location_LinearDistance': 'current',
      'dimension Size_Diameter': 'target',
      'geometric-tolerance Flatness': 'current',
      'geometric-tolerance Parallelism': 'current',
      'geometric-tolerance Position': 'target',
      'datum A': 'current',
      'datum B': 'current',
    });
    // F45 (b): a notch at the far corner changes the top (and the two faces there) only.
    const notch = await run('pmi-track-notch', cut([75, 45, 3], [81, 51, 6]));
    expect(states(notch)).toEqual({
      'dimension Location_LinearDistance': 'target',
      'dimension Size_Diameter': 'current',
      'geometric-tolerance Flatness': 'target',
      'geometric-tolerance Parallelism': 'target',
      'geometric-tolerance Position': 'current',
      'datum A': 'current',
      'datum B': 'current',
    });
    // A current target names the body's own face: the hole, at its own place and size.
    const diameter = asset.items.find((i) => label(i) === 'dimension Size_Diameter')!;
    const hole = notch.topology.faces[cadPmiTrackedIndex(notch.pmi![0]!, diameter.targets[0]!)!]!;
    expect(hole.area).toBeCloseTo(Math.PI * 10 * 5, 6);
    expect(hole.centroid[0]).toBeCloseTo(40, 6);
    expect(hole.centroid[1]).toBeCloseTo(25, 6);
    // The kept shapes of an evaluation of the same document carry the same tracking.
    const again = await run('pmi-track-notch-again', cut([75, 45, 3], [81, 51, 6]));
    expect(again.pmi).toEqual(notch.pmi);
    // A rigid move keeps the sub-shapes themselves: before the cut (the tool moved with it) and
    // after it (the placement path moves the kept shape).
    const move = (doc: CadDocument, x: number) =>
      pinned(
        applyCadOperation(doc, {
          type: 'transformBody',
          bodyId: 'plate',
          translation: position(x, 0, 0),
          rotation: identityQuaternion(),
        }),
      );
    const states0 = states(notch);
    const before = await run(
      'pmi-track-moved-notch',
      cut([175, 45, 3], [181, 51, 6], move(plate, 100)),
    );
    expect(states(before)).toEqual(states0);
    const after = await run('pmi-track-notch-moved', move(cut([75, 45, 3], [81, 51, 6]), 30));
    expect(states(after)).toEqual(states0);
    const after2 = await run('pmi-track-notch-moved-2', move(cut([75, 45, 3], [81, 51, 6]), 60));
    expect(states(after2)).toEqual(states0);
  });

  it('writes only the current PMI into AP242, which reads back the same (PMI-4b/4c, CAD85, TS-1431)', async () => {
    /** Evaluates `doc` with a STEP file, and the plate's mesh. */
    const exported = async (
      requestId: string,
      doc: CadDocument,
      assets: Record<string, Uint8Array>,
    ) => {
      await handle({
        type: 'evaluate',
        requestId,
        generation: 1,
        baseHash: '',
        candidateHash: cadContentHash(doc),
        document: doc,
        assets,
        step: true,
      });
      const m = posted.find(
        (x) => 'requestId' in x && x.requestId === requestId && x.type !== 'progress',
      );
      if (m?.type !== 'result' || m.evaluation.status !== 'ok' || !m.step)
        throw new Error(JSON.stringify(m));
      // The files the independent reader checks (scripts/cad-kernel/pmi-readback.py).
      const dir = process.env.CAD_PMI_STEP_DIR ?? '/tmp/cad-pmi-step';
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/${requestId}.step`, m.step);
      return {
        step: m.step,
        stepPmi: m.stepPmi,
        mesh: m.meshes.find((x) => x.bodyId === 'plate')!,
      };
    };
    /**
     * Each item by its meaning, with its targets as the centroids of the faces, edges and
     * vertices it names (`at` gives a target's row in the body's topology table).
     */
    const meaning = (
      asset: CadPmiAsset,
      mesh: CadMesh,
      at: (t: CadPmiTarget) => number | undefined,
      items = asset.items,
    ) => {
      const where = (list: CadPmiTarget[] = []) =>
        list
          .map((t) => {
            const row = at(t);
            const table = { face: 'faces', edge: 'edges', vertex: 'vertices' } as const;
            const c = row === undefined ? undefined : mesh.topology[table[t.shape]][row]?.centroid;
            return `${t.shape}@${c?.map((v) => v.toFixed(4)).join(',')}`;
          })
          .sort();
      const names = new Map(
        asset.items.flatMap((i) => (i.kind === 'datum' ? [[i.id, i.name] as const] : [])),
      );
      return items
        .map((i) =>
          JSON.stringify({
            ...i,
            id: undefined,
            presentation: i.presentation && {
              segments: i.presentation.segments.map((v) => +v.toFixed(6)),
              plane: i.presentation.plane,
            },
            views: undefined,
            targets: where(i.targets),
            ...(i.kind === 'dimension' && i.targets2 ? { targets2: where(i.targets2) } : {}),
            ...(i.kind === 'geometric-tolerance'
              ? {
                  references: i.references.map((r) => ({
                    ...r,
                    datums: r.datums.map((d) => names.get(d)),
                  })),
                }
              : {}),
          }),
        )
        .sort();
    };
    /** The file read back with this kernel as a new import, and its items by meaning. */
    const readBack = async (requestId: string, step: Uint8Array) => {
      const back = await pmiPlate(requestId, step);
      expect(back.report.pmi, requestId).toMatchObject({ complete: true, lossless: true });
      const asset = JSON.parse(new TextDecoder().decode(back.pmi)) as CadPmiAsset;
      const { mesh } = await exported(`${requestId}-eval`, pinned(back.plate), {
        [back.report.brep.sha256]: back.brep,
        [back.pmiSha]: back.pmi,
      });
      return meaning(asset, mesh, (t) => t.index - 1);
    };

    for (const fixture of ['pmi-plate.step', 'pmi-presented.step']) {
      const { report, brep, pmi, pmiSha, plate, cut } = await pmiPlate(
        `pmi-write-${fixture}`,
        f43(fixture),
      );
      const assets = { [report.brep.sha256]: brep, [pmiSha]: pmi };
      const asset = JSON.parse(new TextDecoder().decode(pmi)) as CadPmiAsset;
      const presentations = asset.items.filter((i) => i.presentation).length;
      // The import alone: every item, on the same faces, edges and vertices.
      const alone = await exported(`pmi-write-alone-${fixture}`, pinned(plate), assets);
      expect(alone.stepPmi).toEqual({
        written: {
          dimension: 2,
          'geometric-tolerance': asset.items.filter((i) => i.kind === 'geometric-tolerance').length,
          datum: 2,
          'datum-target': 0,
        },
        stale: 0,
        unwritable: 0,
        presented: presentations,
        presentationLost: 0,
        views: asset.views?.length ?? 0,
        unsupportedBuild: 0,
      });
      expect(new TextDecoder().decode(alone.step)).toMatch(/AP242/);
      expect(await readBack(`pmi-back-alone-${fixture}`, alone.step)).toEqual(
        meaning(asset, alone.mesh, (t) => t.index - 1),
      );
      // F45 (b), the notch: the top and what depends on it are stale and not written; the
      // hole's diameter and position, and both datums, are written on the faces the body has.
      const notch = await exported(
        `pmi-write-notch-${fixture}`,
        cut([75, 45, 3], [81, 51, 6]),
        assets,
      );
      const states = cadPmiItemStates(asset, notch.mesh.pmi![0]);
      const kept = asset.items.filter((i) => states.get(i.id)?.current);
      expect(
        kept.map((i) => (i.kind === 'datum' ? i.name : 'type' in i ? i.type : 'target')).sort(),
      ).toEqual(['A', 'B', 'Position', 'Size_Diameter']);
      expect(notch.stepPmi?.written).toEqual({
        dimension: 1,
        'geometric-tolerance': 1,
        datum: 2,
        'datum-target': 0,
      });
      expect(notch.stepPmi?.stale).toBe(asset.items.length - 4);
      expect(await readBack(`pmi-back-notch-${fixture}`, notch.step)).toEqual(
        meaning(asset, notch.mesh, (t) => cadPmiTrackedIndex(notch.mesh.pmi![0]!, t), kept),
      );
      // A rigid move after the cut moves the presentation lines with the body.
      const moved = await exported(
        `pmi-write-moved-${fixture}`,
        pinned(
          applyCadOperation(cut([75, 45, 3], [81, 51, 6]), {
            type: 'transformBody',
            bodyId: 'plate',
            translation: position(30, 0, 0),
            rotation: identityQuaternion(),
          }),
        ),
        assets,
      );
      const shift = (i: CadPmiItem): CadPmiItem =>
        i.presentation
          ? {
              ...i,
              presentation: {
                segments: i.presentation.segments.map((v, k) => (k % 3 === 0 ? v + 30 : v)),
                ...(i.presentation.plane && {
                  plane: {
                    ...i.presentation.plane,
                    origin: [
                      i.presentation.plane.origin[0] + 30,
                      i.presentation.plane.origin[1],
                      i.presentation.plane.origin[2],
                    ],
                  },
                }),
              },
            }
          : i;
      expect(await readBack(`pmi-back-moved-${fixture}`, moved.step)).toEqual(
        meaning(
          asset,
          moved.mesh,
          (t) => cadPmiTrackedIndex(moved.mesh.pmi![0]!, t),
          kept.map(shift),
        ),
      );
    }
  });

  it('refuses PMI it does not keep and imports the shape only with consent, listing the loss (PMI-1, CAD81)', async () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('../fixtures/f43/pmi-plate.step', import.meta.url)),
    );
    // F43 loses nothing (PMI-2), so it is never refused; its body is the plate as before.
    const kept = await importFile('pmi-refuse', bytes, { pmi: 'refuse' });
    if (kept.status !== 'ok') throw new Error(JSON.stringify(kept));
    expect(kept.report.pmi).toMatchObject({ complete: true, lossless: true });
    expect(solid(kept.report.body).volumeMm3).toBeCloseTo(19607.300918, 3);
    // F44: a reference through an assembly path, which OCCT 7.6 does not read, is listed.
    const path = await importFile(
      'pmi-path',
      new Uint8Array(
        readFileSync(new URL('../fixtures/f43/loss-component-path.step', import.meta.url)),
      ),
    );
    if (path.status !== 'rejected' || !path.pmi) throw new Error(JSON.stringify(path));
    expect(path.detail).toBe('unread');
    expect(path.pmi.axes).toContainEqual({
      axis: 'unsupported',
      family: 'component-path',
      inFile: 1,
      read: 0,
      unread: 1,
    });
    // With consent the shape is imported with the PMI that was verified; PMI is a loss.
    const agreed = await importFile(
      'pmi-path-agreed',
      new Uint8Array(
        readFileSync(new URL('../fixtures/f43/loss-component-path.step', import.meta.url)),
      ),
      { pmi: 'discard' },
    );
    if (agreed.status !== 'ok') throw new Error(JSON.stringify(agreed));
    expect(agreed.report.losses).toContain('pmi');
    expect(agreed.report.pmi).toMatchObject({
      lossless: false, // The plate's own items are kept; the assembly-path reference is the loss.
      kept: {
        dimension: 2,
        'geometric-tolerance': 3,
        datum: 2,
        'datum-target': 0,
        callout: 0,
        view: 0,
      },
    });
    expect(!!agreed.pmi).toBe(!!agreed.report.pmiAsset);
    // A file whose PMI the reader cannot give as items is listed as not read.
    const partial = await importFile('pmi-dim', corpus('reject-pmi-dimension.step'));
    if (partial.status !== 'rejected' || !partial.pmi) throw new Error(JSON.stringify(partial));
    expect(partial.detail).toBe('unread');
    expect(partial.pmi.complete).toBe(false);
    expect(
      partial.pmi.axes.find((a) => a.family === 'dimension' && a.axis === 'semantic'),
    ).toMatchObject({
      inFile: 1,
      unread: 1,
    });
  });

  it('keeps a tolerance read up to 1 mm and machines the body only within the document limit (#820)', async () => {
    const read = await importFile('loose-1', corpus('loose-tolerance-gap.step'));
    if (read.status !== 'ok') throw new Error(JSON.stringify(read));
    const { report, brep } = read;
    // The reader widens the moved vertex to about 0.005 mm; the shape is kept as read.
    expect(report.maxToleranceMm).toBeGreaterThan(
      cadToleranceSets.standard.maxResultLinearToleranceMm,
    );
    expect(report.maxToleranceMm).toBeLessThan(cadToleranceSets.large.maxResultLinearToleranceMm);
    const imported = (recorded: boolean) =>
      pinned(
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
            name: 'loose',
            type: 'imported',
            inputFeatureIds: [],
            args: {
              kind: 'solid',
              sourceAssetId: 's',
              brepAssetId: 'b',
              importer: { id: 'dev', buildHash },
              sourceUnit: report.sourceUnit,
              scaleToMm: report.scaleToMm,
              ...(recorded && { maxToleranceMm: report.maxToleranceMm }),
            },
          },
          body: {
            id: 'loose',
            name: 'loose',
            sourceFeatureId: 'imp',
            placementFeatureId: 'imp-placement',
            appearance: { color: '#8899aa', opacity: 1 },
          },
        }),
      );
    const assets = { [report.brep.sha256]: brep };
    const evaluate = async (requestId: string, document: CadDocument) => {
      await handle({
        type: 'evaluate',
        requestId,
        generation: 1,
        baseHash: '',
        candidateHash: cadContentHash(document),
        document,
        assets,
      });
      const m = posted.find(
        (x) => 'requestId' in x && x.requestId === requestId && x.type !== 'progress',
      );
      if (m?.type !== 'result') throw new Error(JSON.stringify(m));
      return m.evaluation;
    };
    // Recorded: the body is placed and measured as read.
    expect(await evaluate('loose-2', imported(true))).toMatchObject({ status: 'ok' });
    // Not recorded (a document written before #820): the standard limit still applies.
    expect(await evaluate('loose-3', imported(false))).toMatchObject({
      status: 'error',
      code: 'result-tolerance',
      featureId: 'imp',
    });
    // A cut with a box: refused before the Boolean while the tolerance is above the limit.
    const cut = (document: CadDocument) =>
      pinned(
        applyCadOperation(
          applyCadOperation(document, {
            type: 'insertFeatures',
            parameters: [],
            profiles: [],
            features: [
              {
                id: 'tool',
                name: 'tool',
                type: 'box',
                inputFeatureIds: [],
                args: {
                  size: [mm(4), mm(4), mm(20)],
                  origin: position(3, 3, -5),
                  orientation: identityQuaternion(),
                },
              },
            ],
            bodies: [
              {
                id: 'tool-body',
                name: 'tool',
                sourceFeatureId: 'tool',
                placementFeatureId: 'tool-placement',
                appearance: { color: '#9aa4b1', opacity: 1 },
              },
            ],
          }),
          {
            type: 'booleanBodies',
            targetId: 'loose',
            toolId: 'tool-body',
            mode: 'cut',
            booleanFeatureId: 'op',
            placementFeatureId: 'op-placement',
          },
        ),
      );
    expect(await evaluate('loose-4', cut(imported(true)))).toMatchObject({
      status: 'error',
      code: 'input-tolerance',
      featureId: 'op',
    });
    // Within the `large` set's limit (0.01 mm) the same cut is an ordinary Boolean.
    const large = applyCadOperation(cut(imported(true)), { type: 'setToleranceSet', set: 'large' });
    expect(await evaluate('loose-5', pinned(large))).toMatchObject({ status: 'ok' });
  });

  it('records the tolerance of the BRep as written, which the writer may round up (#802)', async () => {
    // A JAMA bracket part: 0.009395402681850407 mm is written as 0.00939540268185041.
    const read = 0.009395402681850407;
    const owned: { delete(): void }[] = [];
    const own = <T>(x: T) => (owned.push(x as never), x);
    let bytes: Uint8Array;
    let written: number;
    try {
      const box = own(new oc.BRepPrimAPI_MakeBox_2(10, 10, 10)).Shape();
      own(new oc.ShapeFix_ShapeTolerance()).SetTolerance(
        box,
        read,
        oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
      );
      const measured = own(new oc.ShapeAnalysis_ShapeTolerance()).Tolerance(
        box,
        1,
        oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
      );
      expect(measured).toBe(read);
      oc.BRepTools.Write_3(box, '/w.brep', own(new oc.Message_ProgressRange_1()));
      bytes = oc.FS.readFile('/w.brep') as Uint8Array;
      written = writtenTolerance(oc, own, '/w.brep');
      oc.FS.unlink('/w.brep');
    } finally {
      for (const x of owned.reverse()) x.delete();
    }
    expect(written).toBeGreaterThan(read);
    const sha = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const imported = (maxToleranceMm: number) =>
      pinned(
        applyCadOperation(f01Empty(), {
          type: 'insertImportedBody',
          assets: [
            {
              id: 's',
              kind: 'source-step',
              sha256: `sha256:${'0'.repeat(64)}`,
              byteLength: 1,
              mediaType: 'model/step',
            },
            {
              id: 'b',
              kind: 'normalized-brep',
              sha256: sha,
              byteLength: bytes.byteLength,
              mediaType: 'model/x-occt-brep',
            },
          ],
          feature: {
            id: 'imp',
            name: 'rounded',
            type: 'imported',
            inputFeatureIds: [],
            args: {
              kind: 'solid',
              sourceAssetId: 's',
              brepAssetId: 'b',
              importer: { id: 'dev', buildHash },
              sourceUnit: 'mm',
              scaleToMm: 1,
              maxToleranceMm,
            },
          },
          body: {
            id: 'rounded',
            name: 'rounded',
            sourceFeatureId: 'imp',
            placementFeatureId: 'imp-placement',
            appearance: { color: '#8899aa', opacity: 1 },
          },
        }),
      );
    const evaluate = async (requestId: string, document: CadDocument) => {
      await handle({
        type: 'evaluate',
        requestId,
        generation: 1,
        baseHash: '',
        candidateHash: cadContentHash(document),
        document,
        assets: { [sha]: bytes },
      });
      const m = posted.find(
        (x) => 'requestId' in x && x.requestId === requestId && x.type !== 'progress',
      );
      if (m?.type !== 'result') throw new Error(JSON.stringify(m));
      return m.evaluation;
    };
    // The tolerance measured before writing is just below the one read back: refused.
    expect(await evaluate('rounded-1', imported(read))).toMatchObject({
      status: 'error',
      code: 'result-tolerance',
      featureId: 'imp',
    });
    // As written, the body is placed.
    expect(await evaluate('rounded-2', imported(written))).toMatchObject({ status: 'ok' });
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

  it('builds a document once for its bodies’ analysis surfaces (CR5f-5)', async () => {
    // TS-1587, ST-277: a run asks for each body's analysis surface in turn. With the feature
    // cache the first request builds the document and the next builds nothing; each surface is
    // the one a request without the cache gets, and a display evaluation after them reads no
    // analysis triangulation (its meshes are a fresh evaluation's).
    const document = pinned(f05Dependencies(2));
    const hash = cadContentHash(document);
    const surface = (bodyId: string) => ({ bodyId, deflectionMm: 0.05, clampDeflection: true });
    const cache = new FeatureCache();
    try {
      const builds: string[][] = [];
      // The active bodies (a cut's tool body is consumed).
      const fresh = await evaluateCad(oc, document, hash);
      if (fresh.evaluation.status !== 'ok') throw new Error(JSON.stringify(fresh.evaluation));
      const active = Object.keys(fresh.evaluation.bodies);
      expect(active.length).toBeGreaterThan(1);
      for (const body of active) {
        const built: string[] = [];
        const cached = await evaluateCad(oc, document, hash, {
          features: cache,
          analysisSurface: surface(body),
          timing: (phase, id) => void (phase === 'feature' && built.push(id)),
        });
        const full = await evaluateCad(oc, document, hash, { analysisSurface: surface(body) });
        expect(cached.analysisSurface && 'surface' in cached.analysisSurface, body).toBe(true);
        expect(cached.analysisSurface, body).toEqual(full.analysisSurface);
        builds.push(built);
      }
      expect(builds[0]).toHaveLength(document.features.length);
      for (const built of builds.slice(1)) expect(built).toEqual([]);
      const shown = await evaluateCad(oc, document, hash, { features: cache });
      expect(shown.evaluation).toEqual(fresh.evaluation);
      expect(shown.meshes).toEqual(fresh.meshes);
      // An export still builds the full graph.
      const exported: string[] = [];
      await evaluateCad(oc, document, hash, {
        features: cache,
        deflectionMm: 0.5,
        timing: (phase, id) => void (phase === 'feature' && exported.push(id)),
      });
      expect(exported).toHaveLength(document.features.length);
    } finally {
      cache.release();
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
