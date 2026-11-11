import { useCallback, useEffect, useRef, useState } from 'react';
import { cadContentHash, type CadDocument } from '@editor-platform/cad-core';
import {
  resolveKernelBuild,
  WorkerKernelPort,
  type CadCatalogBuild,
  type CadMesh,
} from '@editor-platform/cad-kernel-occt';
import KernelWorker from '@editor-platform/cad-kernel-occt/worker?worker';
import type {
  EditorInputBoundary,
  EditorInputs,
  EditorSession,
} from '@editor-platform/editor-core';
import {
  simulationContentHash,
  simulationEditorCommand,
  type SimulationDocument,
  type SimulationOperation,
} from '@editor-platform/simulation-core';
import {
  simulationSolverBuild,
  type SimulationRunner,
  type StudyRunMessage,
  type StudyRunRequest,
} from '@editor-platform/simulation';
import { SimulationSurface, type SimulationShape } from '@editor-platform/simulation/surface';
import StudyWorker from '@editor-platform/simulation/run-worker?worker';
import mesher from 'virtual:fem-mesher-build';
import computeHost from 'virtual:simulation-compute-host';
import '@editor-platform/simulation/style.css';
import { cadKernel, cadKernels, type StoredArtifact } from '../model';
import { simulationSourceOf, simulationVersionChoices, stageSimulationSource } from './source';

/**
 * The exact kernel build the analysed version names, from the Host's catalog (current or
 * retained). A read-only substitute is not enough: an analysis measures the shape.
 */
function analysisKernel(content: CadDocument): { build: CadCatalogBuild } | { code: string } {
  if (!cadKernel) return { code: 'kernel-build-unavailable' };
  const absolute = (b: CadCatalogBuild): CadCatalogBuild => ({
    ...b,
    moduleUrl: new URL(b.moduleUrl, location.href).href,
    wasmUrl: new URL(b.wasmUrl, location.href).href,
  });
  const r = resolveKernelBuild(
    { ...cadKernels, current: absolute(cadKernel), retained: cadKernels.retained?.map(absolute) },
    content.kernelProfile,
  );
  if (r.mode === 'exact') return { build: r.build };
  return { code: r.mode === 'reference' ? 'kernel-build-reference-only' : r.code };
}

/**
 * R3e-4b: the analysed version evaluated once by its own kernel Worker, for the body's display
 * mesh (its faces are picked for loads and constraints). The kept content never changes for one
 * hash, so a new evaluation runs only when the analysed version does.
 */
function useSourceShape(
  content: CadDocument | undefined,
  bodyId: string,
  featureId: string | undefined,
): SimulationShape | undefined {
  const hash = content ? cadContentHash(content) : undefined;
  const [shape, setShape] = useState<{ key: string; shape: SimulationShape }>();
  const key = `${hash}/${bodyId}`;
  useEffect(() => {
    if (!content || !hash || !featureId) return;
    const resolved = analysisKernel(content);
    if ('code' in resolved) {
      setShape({ key, shape: { status: 'failed', message: resolved.code } });
      return;
    }
    let meshes: CadMesh[] = [];
    let live = true;
    let distanceRuns = 0;
    const port = new WorkerKernelPort({
      spawn: () => new KernelWorker() as never,
      build: resolved.build,
      onMeshes: (h, m) => {
        if (h === hash) meshes = m;
      },
    });
    port
      .evaluate({
        requestId: `simulation-source-${hash}`,
        generation: 1,
        baseHash: '',
        candidateHash: hash,
        document: content,
      })
      .then((evaluation) => {
        if (!live) return;
        // A failed body's shape before its failure (U4) is not the analysed shape.
        const meshOf = (id: string) =>
          meshes.find((m) => m.bodyId === id && !m.beforeFailure && !m.lod);
        const mesh = meshOf(bodyId);
        // R3j-6a: the version's other bodies, which may be analysed with it.
        const others = content.bodies.flatMap((b) => {
          // Only active bodies are analysed (`checkSimulationSource`), as the source picker offers;
          // CR5e: a sheet as a shell on itself.
          if (b.id === bodyId || !b.resultFeatureId || b.state !== 'active') return [];
          const m = meshOf(b.id);
          return [
            {
              bodyId: b.id,
              name: b.name,
              featureId: b.resultFeatureId,
              ...(m ? { mesh: m } : {}),
              ...(b.appearance ? { color: b.appearance.color } : {}),
              ...(b.kind === 'sheet' ? { sheet: true } : {}),
            },
          ];
        });
        // CR5b: the version's spot weld rows, with the points the kernel placed.
        const placed = new Map(
          (evaluation.status === 'ok' ? (evaluation.spotWelds ?? []) : []).map((r) => [r.id, r]),
        );
        type WeldRow = NonNullable<Extract<SimulationShape, { status: 'ok' }>['spotWelds']>[number];
        const spotWelds = (content.spotWelds ?? []).map((w): WeldRow => {
          const r = placed.get(w.id);
          return {
            id: w.id,
            name: w.name,
            flanges: [
              { bodyId: w.flanges[0].bodyId, face: w.flanges[0].face },
              { bodyId: w.flanges[1].bodyId, face: w.flanges[1].face },
            ],
            maxGapMm: w.maxGapMm,
            ...(r?.status === 'ok'
              ? { points: r.points.length / 3 }
              : { error: r?.status === 'error' ? r.code : 'not placed' }),
          };
        });
        // CR0c: the analysed body drawn in its CAD colour (its paint) while setting up.
        const color = content.bodies.find((b) => b.id === bodyId)?.appearance?.color;
        setShape({
          key,
          shape:
            mesh && evaluation.status === 'ok'
              ? {
                  status: 'ok',
                  mesh,
                  featureId,
                  ...(others.length ? { others } : {}),
                  ...(color ? { color } : {}),
                  ...(spotWelds.length ? { spotWelds } : {}),
                  ...(content.bodies.find((b) => b.id === bodyId)?.kind === 'sheet'
                    ? { sheet: true }
                    : {}),
                  // CR4a: bond candidates measured on the exact surfaces by the same Worker.
                  measure: async (queries) => {
                    const measured = await port.measureFaceDistances(
                      {
                        requestId: `simulation-distances-${hash}-${++distanceRuns}`,
                        generation: 1,
                        baseHash: '',
                        candidateHash: hash,
                        document: content,
                      },
                      queries,
                    );
                    if (!measured.faceDistances)
                      throw new Error(
                        measured.evaluation.status === 'ok'
                          ? 'face-distance-missing'
                          : measured.evaluation.code,
                      );
                    return measured.faceDistances;
                  },
                }
              : {
                  status: 'failed',
                  message: evaluation.status === 'ok' ? 'body-not-shown' : evaluation.code,
                },
        });
      })
      .catch((e: unknown) => {
        if (live)
          setShape({
            key,
            shape: { status: 'failed', message: e instanceof Error ? e.message : String(e) },
          });
      });
    return () => {
      live = false;
      port.dispose();
    };
    // `content` is fixed by `hash`.
  }, [key, featureId]);
  if (!content || !featureId) return undefined;
  return shape?.key === key ? shape.shape : { status: 'evaluating' };
}

/**
 * Playground binding for the structural analysis Surface (R3e-4a). Each edit is one session
 * command, prepared against the content it was made on and applied at once; the Host saves the
 * draft afterwards and owns Undo/Redo. The analysed CAD version is read from the record.
 */
export default function SimulationHost({
  session,
  readOnly,
  inputs,
  record,
  records,
  persist,
  persistRecord,
}: {
  session: EditorSession<SimulationDocument>;
  readOnly: boolean;
  inputs: EditorInputs;
  record(): StoredArtifact | undefined;
  /** Every stored record: names the analysed CAD Artifact and version, when it is still here. */
  records(): StoredArtifact[];
  persist(content: SimulationDocument): void;
  /** Saves the whole record (a new source version is kept before the edit names it). */
  persistRecord(record: StoredArtifact): Promise<boolean>;
}) {
  // Re-read on every session revision (Host Undo/Redo, restore).
  const [, setTick] = useState(0);
  const doc = session.content;
  const kept = simulationSourceOf(record(), doc);
  const body = kept?.bodies.find((b) => b.id === doc.source.bodyId);
  const cad = records().find((r) => r.id === doc.source.artifactId);
  const at = cad?.versions.findIndex((v) => v.versionId === doc.source.versionId) ?? -1;
  // The CAD Artifact may since be renamed, changed or deleted: the kept version still evaluates.
  const shape = useSourceShape(kept, doc.source.bodyId, body?.resultFeatureId);
  const cadName = cad && at >= 0 ? `${cad.name} · v${at + 1}` : 'A saved 3D CAD version';
  // A number field being typed in is pending at the Host's boundaries (save, export, switch).
  // Stable, as re-registering a dirty boundary changes the Host snapshot.
  const registerInput = useCallback(
    (boundary: EditorInputBoundary) => inputs.register(boundary),
    [inputs],
  );
  // Read at the commit, so an edit that resumes after an await sees the current permission.
  const readOnlyNow = useRef(readOnly);
  readOnlyNow.current = readOnly;
  const apply = (op: SimulationOperation | SimulationOperation[]) => {
    try {
      const base = session.content;
      session.execute(
        simulationEditorCommand(op, {
          expectedHash: simulationContentHash(base),
          canEdit: () => !readOnlyNow.current,
        }),
      );
      persist(session.content);
      setTick((n) => n + 1);
      return undefined;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  // R3e-5b: the other saved versions of the analysed CAD Artifact with the same body.
  const versionChoices = cad ? simulationVersionChoices([cad], doc) : [];
  const versions = versionChoices.map((c) => ({
    versionId: c.versionId,
    label: `v${cad!.versions.findIndex((v) => v.versionId === c.versionId) + 1}`,
  }));
  const switchVersion = async (versionId: string) => {
    const choice = versionChoices.find((c) => c.versionId === versionId);
    const latest = record();
    if (!choice || !latest) return 'The version is no longer available.';
    if (readOnlyNow.current) return 'The analysis is read only.';
    // Kept first, so the edit that names it is never saved without it.
    if (!(await persistRecord(stageSimulationSource(latest, choice.content))))
      return 'The version could not be kept with the analysis.';
    // CR5e (Codex on #977): a thickness stays only on a body still a sheet in the version.
    const stale = (doc.sheets ?? []).filter(
      (t) => choice.content.bodies.find((b) => b.id === t.bodyId)?.kind !== 'sheet',
    );
    return apply([
      {
        type: 'setSource',
        source: {
          artifactId: choice.artifactId,
          versionId: choice.versionId,
          contentHash: cadContentHash(choice.content),
          bodyId: choice.bodyId,
        },
        resultFeatureId: choice.content.bodies.find((b) => b.id === choice.bodyId)?.resultFeatureId,
        // R3j-2: each other analysed body's targets are renamed to its own result feature.
        bodyResultFeatureIds: (doc.bodies ?? []).flatMap((b) => {
          const featureId = choice.content.bodies.find((c) => c.id === b.bodyId)?.resultFeatureId;
          return featureId ? [{ bodyId: b.bodyId, featureId }] : [];
        }),
      },
      ...stale.map((t) => ({
        type: 'setSheetThickness' as const,
        bodyId: t.bodyId,
        thicknessMm: null,
      })),
    ]);
  };
  // R3e-4c: each run is its own Worker with the kernel and Netgen builds; cancel terminates it.
  // R3f-3: a Host run asks the Worker to cancel the Host job first, then terminates it.
  const kernel = kept ? analysisKernel(kept) : { code: 'source-not-kept' };
  const runner: SimulationRunner = {
    unavailable: !kept
      ? 'the analysed version is not kept'
      : 'code' in kernel
        ? `the CAD kernel build is not available (${kernel.code})`
        : !mesher
          ? 'the mesher (Netgen) build is not part of this build'
          : shape?.status !== 'ok'
            ? shape?.status === 'failed'
              ? 'the analysed part could not be evaluated'
              : 'the analysed part is still being evaluated'
            : undefined,
    builds:
      'code' in kernel || !mesher
        ? undefined
        : {
            kernel: kernel.build.buildHash,
            mesher: mesher.buildHash,
            solver: simulationSolverBuild,
          },
    host: computeHost
      ? {
          label: computeHost.label,
          destination: computeHost.destination,
          limits: computeHost.limits,
          builds:
            'code' in kernel || !mesher
              ? undefined
              : {
                  kernel: kernel.build.buildHash,
                  mesher: mesher.buildHash,
                  solver: computeHost.solverBuild,
                },
        }
      : undefined,
    run(studyId, onProgress, options) {
      const worker = new StudyWorker();
      let settle: { ok(r: StudyRunMessage & { type: 'done' }): void; fail(e: Error): void };
      const result = new Promise<(StudyRunMessage & { type: 'done' })['run']>((ok, fail) => {
        settle = { ok: (m) => ok(m.run), fail };
      });
      worker.onmessage = (e: MessageEvent<StudyRunMessage>) => {
        const m = e.data;
        if (m.type === 'progress') onProgress(m.progress);
        else {
          worker.terminate();
          if (m.type === 'done') settle.ok(m);
          else settle.fail(new Error(m.message));
        }
      };
      worker.onerror = (e) => {
        worker.terminate();
        settle.fail(new Error(e.message || 'worker-error'));
      };
      if ('code' in kernel || !mesher || !kept || shape?.status !== 'ok') {
        worker.terminate();
        return { result: Promise.reject(new Error('unavailable')), cancel: () => {} };
      }
      const request: StudyRunRequest = {
        type: 'run',
        doc: session.content,
        cad: kept,
        cadContentHash: session.content.source.contentHash,
        studyId,
        table: shape.mesh.topology,
        // R3j-6a: each other analysed body's display table, as faces were picked on it.
        bodyTables: Object.fromEntries(
          (shape.others ?? []).flatMap((o) =>
            o.mesh && session.content.bodies?.some((b) => b.bodyId === o.bodyId)
              ? [[o.bodyId, o.mesh.topology]]
              : [],
          ),
        ),
        kernel: kernel.build,
        mesher: {
          ...mesher,
          moduleUrl: new URL(mesher.moduleUrl, location.href).href,
          wasmUrl: new URL(mesher.wasmUrl, location.href).href,
        },
        ...(options?.onHost && computeHost
          ? {
              compute: {
                ...computeHost,
                endpoint: new URL(computeHost.endpoint, location.href).href,
              },
            }
          : {}),
      };
      worker.postMessage(request);
      return {
        result,
        cancel: () => {
          if (!request.compute) return worker.terminate();
          // The Worker waits on the Host and reads this; it is stopped shortly after anyway.
          worker.postMessage({ type: 'cancel' });
          setTimeout(() => worker.terminate(), 2000);
        },
      };
    },
  };
  return (
    <SimulationSurface
      doc={doc}
      source={
        kept && body ? { label: `${cadName} · ${body.name}`, bodyName: body.name } : undefined
      }
      shape={shape}
      readOnly={readOnly}
      apply={apply}
      version={at >= 0 ? `v${at + 1}` : undefined}
      versions={readOnly ? [] : versions}
      switchVersion={switchVersion}
      registerInput={registerInput}
      runner={runner}
    />
  );
}
