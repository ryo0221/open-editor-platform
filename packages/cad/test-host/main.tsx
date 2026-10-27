import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  applyCadOperation,
  CadAssemblyPort,
  emptyCad,
  f02Plate,
  f11Bracket,
  f15Loft,
  f15Sweep,
  f17Sheets,
  f18Hood,
  f18Seams,
  f17Surfaces,
  f12Fillet,
  f12Holes,
  fixtureKernel,
  k5aBars,
  r2bScale,
  identityQuaternion,
  mm,
  position,
  fixtureComponent,
  r2bBom,
  r2bJoints,
  r2bParts,
  r2bVersions,
  type CadDocument,
  type Vec3,
} from '@editor-platform/cad-core';
import { CatalogKernelPort } from '@editor-platform/cad-kernel-occt';
import KernelWorker from '@editor-platform/cad-kernel-occt/worker?worker';
import { EditorInputs, EditorSession } from '@editor-platform/editor-core';
import { EditorInputsContext } from '@editor-platform/editor-ui';
import '@editor-platform/editor-ui/styles.css';
import kernelBuild from 'virtual:cad-kernel-build';
import {
  CadAssembly,
  CadController,
  CadSurface,
  type CadPartSourceHost,
  type CadPartStore,
  cadBudgets,
} from '../src';
import { cadPerf } from './perf';

// Standalone host: ?fixture=plate|hub|holes|fillet|bracket|sections|chains|tube|hood|seam|r2b|r2b-joints|r2b-versions|r2b-authoring|r2b-bom|r2b-scale, ?persist=1 (the last applied content is kept
// in sessionStorage and opened again on reload), ?view=side|far|plan (plate with a saved view), ?readonly=1,
// ?kernel=missing, ?kernel=reference (an earlier build this Host shows only through an approved
// substitute), ?pair=1 (two Surfaces).
const params = new URLSearchParams(location.search);
const current = kernelBuild?.buildHash ?? 'sha256:' + '0'.repeat(64);
const earlier = 'sha256:' + 'e'.repeat(64);
const buildHash =
  params.get('kernel') === 'missing' || !kernelBuild
    ? 'sha256:' + '0'.repeat(64)
    : params.get('kernel') === 'reference'
      ? earlier
      : current;
const empty = emptyCad({ ...fixtureKernel, buildHash });
// ?fixture=hub: one sphere of radius 3,600 mm, the BLUE ARC turbine hub (#372).
const hub = (): CadDocument =>
  applyCadOperation(empty, {
    type: 'insertFeatures',
    parameters: [],
    profiles: [],
    features: [
      {
        id: 'hub',
        name: 'Hub',
        type: 'sphere',
        inputFeatureIds: [],
        args: { radius: mm(3600), origin: position(0, 0, 0), orientation: identityQuaternion() },
      },
    ],
    bodies: [
      {
        id: 'hub-body',
        name: 'Hub',
        sourceFeatureId: 'hub',
        placementFeatureId: 'hub-placement',
        appearance: { color: '#8aa1b8', opacity: 1 },
      },
    ],
  });
// ?fixture=bars: a plate, a bar and a path sketch to pattern it along (K5a, CM-7b).
// ?fixture=sections: the F15 loft and sweep sketches without their features (R1e).
const sections = (): CadDocument => ({
  ...empty,
  sketches: [...f15Loft().sketches, ...f15Sweep().sketches],
});
// ?fixture=r2b: the R2b assembly (two plates, a shaft and a nested pair) with its closure, read only
// through the part cache (R2b-1). Nothing can be inserted: this Host offers no saved parts.
// ?fixture=r2b-joints: F20 (R2b-2), the base plate with one joint of each type; &tamper=1 stores
// the shaft 1 mm higher than its joint solves it.
// ?fixture=r2b-versions: F21 (R2b-2b), the shaft on base v1 and the cap on the tower v1; this Host
// offers base v1–v4 and tower v1–v3 as saved versions, the newest one as the latest.
// ?fixture=r2b-authoring: R2b-2c, this document's plate and the shaft (a ring, r 10–15 mm and
// 20 mm high) fixed beside it at x = 120, with no joint yet.
// ?fixture=r2b-bom: F22 (R2b-3), a plate of its own, two plate versions, four wheels (a hub and
// two bolts each), two bolts, a ring of 8 and a row of 6 bolts (component patterns) and a jig
// left out of the BOM.
// ?fixture=r2b-scale: F23 (R2b-4), 300 kinds of bracket placed 1,000 times, nested three deep;
// the parts no joint reads evaluate after the result.
const r2bAuthoring = (kernel: Parameters<typeof r2bParts>[0]) => {
  const f = r2bParts(kernel);
  const plate = { ...f02Plate(), kernelProfile: f.assembly.kernelProfile };
  const assembly = applyCadOperation(plate, {
    type: 'insertComponents',
    parts: f.assembly.parts.filter((p) => p.id === 'part-shaft'),
    components: [fixtureComponent('c-shaft', 'part-shaft', [120, 25, 0])],
  });
  return { ...f, assembly };
};
const r2bFixture =
  params.get('fixture') === 'r2b-joints'
    ? r2bJoints
    : params.get('fixture') === 'r2b-versions'
      ? r2bVersions
      : params.get('fixture') === 'r2b-authoring'
        ? r2bAuthoring
        : params.get('fixture') === 'r2b-bom'
          ? r2bBom
          : params.get('fixture') === 'r2b-scale'
            ? r2bScale
            : r2bParts;
const r2b = r2bFixture({ id: fixtureKernel.id, buildHash });
const offered =
  'bases' in r2b
    ? [
        { artifactId: 'base', name: 'Base', versions: r2b.bases },
        { artifactId: 'tower', name: 'Tower', versions: r2b.towers },
      ]
    : [];
const partSource: CadPartSourceHost | undefined = offered.length
  ? {
      list: async () =>
        offered.map((a) => ({
          artifactId: a.artifactId,
          name: a.name,
          versions: a.versions.map((v) => ({
            versionId: v.versionId,
            label: v.versionId,
            contentHash: v.contentHash,
          })),
        })),
      readVersion: async (artifactId, versionId) => {
        const v = offered
          .find((a) => a.artifactId === artifactId)
          ?.versions.find((x) => x.versionId === versionId);
        if (!v) throw new Error('part-source-missing');
        // ?tamper=hash: the Host's copy of base v2 differs from the hash it names.
        const content =
          params.get('tamper') === 'hash' && versionId === 'v2' && artifactId === 'base'
            ? { ...v.content, parameters: [...v.content.parameters].reverse() }
            : v.content;
        const closure = [...r2b.closure.values()].filter((d) =>
          v.content.parts.some((p) => r2b.closure.get(p.source.contentHash) === d),
        );
        return { content, contentHash: v.contentHash, closure, assets: [] };
      },
      latestVersion: (artifactId) => {
        const versions = offered.find((a) => a.artifactId === artifactId)?.versions ?? [];
        const last = versions[versions.length - 1];
        return (
          last && {
            versionId: last.versionId,
            contentHash: last.contentHash,
            label: last.versionId,
          }
        );
      },
      checkAccess: () => true,
    }
  : undefined;
// The retained closure, as a Host's binding gives it (also without a part source).
const partStore: CadPartStore = {
  get: (hash) => r2b.closure.get(hash),
  stage: async () => undefined,
};
if (params.get('tamper') === '1') r2b.assembly.solvedPoses['c-shaft']!.translationMm[2] += 1;
// ?fixture=tube: the F17 open tube, a 40 mm square carried 20 mm up, whose top edges a fill or
// a loft can reference (R2a-2c).
const tube = (): CadDocument => ({ ...f17Sheets('closed'), kernelProfile: empty.kernelProfile });
// ?fixture=hood: the F18 hood's three sheets and its window sketch, before the sew (R2a-3).
const hood = (): CadDocument => {
  const sheets = f18Hood('sheets');
  const window = f18Hood('trim').sketches.find((s) => s.id === 'window')!;
  return { ...sheets, sketches: [...sheets.sketches, window], kernelProfile: empty.kernelProfile };
};
// ?fixture=seam: the F18 tangent seam, a plane continued by a cylinder of r = 20 (R2a-4); with
// view=side it is seen from -Y, the seam upright in the middle; view=plan from above.
const seam = (): CadDocument => ({
  ...f18Seams({ kind: 'tangent' }),
  kernelProfile: empty.kernelProfile,
});
// ?fixture=chains: the F17 surface loft's squares and surface sweep's chains without features (R2a-2b).
const chains = (): CadDocument => ({
  ...empty,
  sketches: [...f17Surfaces('closed').sketches, ...f17Surfaces('sweep').sketches],
});
// ?gpuBytes=N: a smaller GPU budget (CAD26).
const gpuBytes = params.has('gpuBytes') ? Number(params.get('gpuBytes')) : undefined;
const fixture = params.get('fixture');
const assemblyFixture =
  fixture === 'r2b' ||
  fixture === 'r2b-joints' ||
  fixture === 'r2b-versions' ||
  fixture === 'r2b-authoring' ||
  fixture === 'r2b-bom' ||
  fixture === 'r2b-scale';
const initial: CadDocument =
  fixture === 'plate'
    ? { ...f02Plate('center'), kernelProfile: empty.kernelProfile }
    : fixture === 'hub'
      ? hub()
      : fixture === 'holes'
        ? { ...f12Holes(), kernelProfile: empty.kernelProfile }
        : fixture === 'fillet'
          ? { ...f12Fillet(), kernelProfile: empty.kernelProfile }
          : fixture === 'bracket'
            ? { ...f11Bracket(), kernelProfile: empty.kernelProfile }
            : fixture === 'sections'
              ? sections()
              : fixture === 'bars'
                ? k5aBars({ ...fixtureKernel, buildHash })
                : fixture === 'chains'
                  ? chains()
                  : fixture === 'tube'
                    ? tube()
                    : fixture === 'hood'
                      ? hood()
                      : fixture === 'seam'
                        ? seam()
                        : assemblyFixture
                          ? r2b.assembly
                          : empty;
const persist = params.get('persist') === '1';
const stored = (() => {
  try {
    const text = persist ? sessionStorage.getItem('cad-test-host') : null;
    return text ? (JSON.parse(text) as CadDocument) : undefined;
  } catch {
    return undefined;
  }
})();
// ?view=far: the same side view from 500 m away (orthographic, so the picture is the same).
// ?view=plan: looking down Z with +Y up. ?view=long-up: the side view with up saved as [0, 0, 2]
// (validation allows any length).
const view = params.get('view');
const side = (distance: number) => ({
  position: [40, 25 - distance, 2.5] as Vec3,
  target: [40, 25, 2.5] as Vec3,
  up: [0, 0, 1] as Vec3,
});
const camera =
  view === 'side' && fixture === 'seam'
    ? { position: [40, -300, 10] as Vec3, target: [40, 0, 10] as Vec3, up: [0, 0, 1] as Vec3 }
    : view === 'side'
      ? side(325)
      : view === 'far'
        ? side(500_000)
        : view === 'long-up'
          ? { ...side(325), up: [0, 0, 2] as Vec3 }
          : view === 'plan'
            ? fixture === 'tube'
              ? // About the tube's middle, so its four sides fit the narrow layout too.
                {
                  position: [20, 20, 300] as Vec3,
                  target: [20, 20, 10] as Vec3,
                  up: [0, 1, 0] as Vec3,
                }
              : fixture === 'seam'
                ? // From above: the seam's profile, where an edge's comb lies flat.
                  {
                    position: [35, 15, 300] as Vec3,
                    target: [35, 15, 10] as Vec3,
                    up: [0, 1, 0] as Vec3,
                  }
                : fixture === 'r2b-authoring'
                  ? // Over the plate and the shaft beside it.
                    {
                      position: [70, 25, 300] as Vec3,
                      target: [70, 25, 2.5] as Vec3,
                      up: [0, 1, 0] as Vec3,
                    }
                  : {
                      position: [40, 25, 300] as Vec3,
                      target: [40, 25, 2.5] as Vec3,
                      up: [0, 1, 0] as Vec3,
                    }
            : undefined;
if (camera)
  initial.namedViews = [
    {
      id: 'side',
      name: 'Side',
      bodyIds: fixture === 'tube' || fixture === 'seam' ? ['surface'] : ['plate'],
      camera,
      projection: { type: 'orthographic', spanMm: fixture === 'r2b-authoring' ? 160 : 120 },
    },
  ];

// ?perf=1: part job times and mesh bytes for experiments/cad-r2b-perf (assembly fixtures only).
const perf = params.get('perf') === '1' ? cadPerf(cadBudgets.mainBytes) : undefined;
if (perf) Object.assign(window, { cadPerf: perf });

let n = 0;
function mount() {
  const build = {
    id: kernelBuild?.id ?? fixtureKernel.id,
    buildHash: current,
    moduleUrl: new URL(kernelBuild?.moduleUrl ?? '/cad-kernel/kernel.js', location.href).href,
    wasmUrl: kernelBuild?.wasmUrl ?? '/cad-kernel/kernel.wasm',
  };
  const port = new CatalogKernelPort(
    {
      current: build,
      substitutes: [{ from: earlier, to: current, semanticsVersion: 2 }],
    },
    {
      spawn: () => new KernelWorker() as never,
      onMeshes: (hash, meshes) => {
        perf?.arriving(meshes);
        if (parts?.partJobs.has(hash)) assembly!.receive(hash, meshes);
        else controller.receiveMeshes(hash, meshes);
        perf?.sample();
      },
    },
  );
  const parts = assemblyFixture
    ? // As the binding: parts no joint reads evaluate after the result (R2b-4).
      new CadAssemblyPort({
        kernel: perf ? perf.timed(port) : port,
        parts: (hash) => r2b.closure.get(hash),
        background: true,
        coarse: true,
      })
    : undefined;
  const controller: CadController = new CadController({
    session: new EditorSession(stored ?? initial),
    kernel: parts ?? port,
    exportMeshes: (request, deflectionMm) => port.exportMeshes(request, deflectionMm),
    exportStep: (request) => port.exportStep(request),
    analyzeContinuity: (request, edge) => port.analyzeContinuity(request, edge),
    analyzeCurvature: (request) => port.analyzeCurvature(request),
    analyzeComb: (request, edge) => port.analyzeComb(request, edge),
    canEdit: () => params.get('readonly') !== '1',
    currentKernel: { id: build.id, buildHash: build.buildHash },
    permissionGeneration: () => 1,
    newId: (prefix) => `${prefix}-${++n}`,
    ...(persist
      ? {
          onApplied: (content: CadDocument) =>
            sessionStorage.setItem('cad-test-host', JSON.stringify(content)),
        }
      : {}),
  });
  const assembly =
    parts &&
    new CadAssembly({
      controller,
      port: parts,
      exportBrep: (request) => port.exportBrep(request),
      exportAssemblyStep: (profile, requestId, plan, breps) =>
        port.exportAssemblyStep(profile, requestId, plan, breps),
      store: partStore,
      ...(partSource ? { source: partSource } : {}),
      // ?mainBytes=n: a smaller main-thread budget for part meshes (R2b-4, 簡略表示).
      ...(params.has('mainBytes') ? { mainBytes: Number(params.get('mainBytes')) } : {}),
    });
  if (perf && assembly) perf.attach(controller, assembly);
  return { controller, port, assembly };
}
const surfaces = params.get('pair') === '1' ? [mount(), mount()] : [mount()];
// window.cad.setGpuBytes(n) changes the first Surface's GPU budget while it is mounted.
const cad: (typeof surfaces)[0] & { setGpuBytes?(bytes: number | undefined): void } = surfaces[0];
Object.assign(window, { cad });
// The first Surface's field buffers, as a Host registry holds them (Sketch mode's entries flush it).
const inputs = new EditorInputs();
function First() {
  const [budget, setBudget] = useState(gpuBytes);
  cad.setGpuBytes = setBudget;
  return (
    <EditorInputsContext.Provider value={inputs}>
      <CadSurface
        controller={cad.controller}
        gpuBytes={budget}
        {...(cad.assembly ? { assembly: cad.assembly } : {})}
      />
    </EditorInputsContext.Provider>
  );
}
createRoot(document.getElementById('root')!).render(
  surfaces.length === 1 ? (
    <First />
  ) : (
    <div style={{ display: 'grid', gridTemplateRows: '1fr 1fr', height: '100%' }}>
      {surfaces.map(({ controller }, i) => (
        <div key={i} data-testid={`surface-${i}`} style={{ minHeight: 0, display: 'grid' }}>
          <CadSurface controller={controller} />
        </div>
      ))}
    </div>
  ),
);
