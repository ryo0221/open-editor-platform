/**
 * R3e-4c: the browser Worker that runs one study (docs/cad/r3-analysis.md: heavy work in a
 * Worker). It loads the CAD kernel build and the Netgen build, each verified by its SHA-256,
 * runs `runStudy` and posts its progress and the run. Hosts start it with Vite's `?worker`.
 */
import { evaluateCad, FeatureCache, loadVerifiedBuild } from '@editor-platform/cad-kernel-occt';
import { meshSurfaceReport, type FemMesherModule } from '@editor-platform/fem-mesher';
import { FrdError } from '@editor-platform/geometry-fem';
import {
  ComputeHostError,
  computeEquilibriumTolerance,
  computeModalTolerance,
  solveBondedModalOnHost,
  solveBondedOnHost,
  solveModalOnHost,
  solveOnHost,
  solveShellModalOnHost,
  solveShellOnHost,
} from './compute';
import { RunRefusal, runStudy } from './run';
import {
  simulationSolverBuild,
  type FemMesherBuild,
  type StudyCancelRequest,
  type StudyRunMessage,
  type StudyRunRequest,
} from './run-protocol';

// Typed locally: a webworker lib reference would change DOM globals for the whole program.
const scope = self as unknown as {
  postMessage(message: StudyRunMessage): void;
  onmessage: ((event: MessageEvent<StudyRunRequest | StudyCancelRequest>) => void) | null;
};

/** The Netgen module from verified bytes: a build whose Wasm is not `buildHash` never runs. */
export async function loadVerifiedMesher(build: FemMesherBuild): Promise<FemMesherModule> {
  const bytes = new Uint8Array(
    await (await fetch(build.wasmUrl, { credentials: 'same-origin' })).arrayBuffer(),
  );
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  if (`sha256:${hex}` !== build.buildHash) throw new Error('mesher-build-hash');
  const { default: create } = (await import(/* @vite-ignore */ build.moduleUrl)) as {
    default: (options: { wasmBinary: Uint8Array }) => Promise<FemMesherModule>;
  };
  return create({ wasmBinary: bytes });
}

const abort = new AbortController();
/** A Host call with its failures as the run's `host` refusals. */
async function hostCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (e instanceof ComputeHostError && e.reason !== 'cancelled')
      throw new RunRefusal('host', `${e.reason}: ${e.message}`);
    if (e instanceof FrdError) throw new RunRefusal('host', e.message);
    throw e;
  }
}

scope.onmessage = async (event) => {
  const r = event.data;
  if (r?.type === 'cancel') return abort.abort();
  if (r?.type !== 'run') return;
  const host = r.compute;
  // CR5f-5: the run's evaluations of the version (each body's analysis surface, the spot weld
  // rows) build its features once and read them from here after.
  const features = new FeatureCache();
  try {
    const [oc, fem] = await Promise.all([
      loadVerifiedBuild(r.kernel),
      loadVerifiedMesher(r.mesher),
    ]);
    const run = await runStudy(
      r.doc,
      r.cad,
      r.cadContentHash,
      r.studyId,
      r.table,
      {
        builds: {
          kernel: r.kernel.buildHash,
          mesher: r.mesher.buildHash,
          solver: host ? host.solverBuild : simulationSolverBuild,
        },
        ...(host
          ? {
              remote: {
                name: host.label,
                limits: host.limits,
                equilibrium: computeEquilibriumTolerance,
                solve: (input) =>
                  hostCall(() => solveOnHost(host, input, { signal: abort.signal })),
                solveShell: (input) =>
                  hostCall(() => solveShellOnHost(host, input, { signal: abort.signal })),
                solveBonded: (input) =>
                  hostCall(() => solveBondedOnHost(host, input, { signal: abort.signal })),
                orthogonality: computeModalTolerance,
                solveModal: (input) =>
                  hostCall(() => solveModalOnHost(host, input, { signal: abort.signal })),
                solveShellModal: (input) =>
                  hostCall(() => solveShellModalOnHost(host, input, { signal: abort.signal })),
                solveBondedModal: (input) =>
                  hostCall(() => solveBondedModalOnHost(host, input, { signal: abort.signal })),
              },
            }
          : {}),
        surface: async (cad, request) => {
          const out = await evaluateCad(oc, cad, r.cadContentHash, {
            analysisSurface: request,
            features,
          });
          if (!out.analysisSurface) throw new Error('analysis-surface-missing');
          return out.analysisSurface;
        },
        mesh: (surface, settings) => meshSurfaceReport(fem, surface, settings),
        // CR5b: the spot weld rows' points, from a display evaluation of the version.
        spotWelds: async (cad) => {
          const { evaluation, meshes } = await evaluateCad(oc, cad, r.cadContentHash, {
            features,
          });
          return {
            rows: evaluation.status === 'ok' ? (evaluation.spotWelds ?? []) : [],
            tables: new Map(
              meshes.filter((m) => !m.lod && !m.beforeFailure).map((m) => [m.bodyId, m.topology]),
            ),
          };
        },
        checkpoint: (progress) => scope.postMessage({ type: 'progress', progress }),
      },
      r.bodyTables ? new Map(Object.entries(r.bodyTables)) : undefined,
    );
    scope.postMessage({ type: 'done', run });
  } catch (e) {
    scope.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  } finally {
    features.release();
  }
};
