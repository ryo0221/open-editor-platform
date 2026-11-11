/**
 * R3e-4c: the messages between a Host and the study Worker (`./run-worker`). One Worker runs one
 * study and is then closed; cancelling a run terminates its Worker (the solve is one synchronous
 * loop, so nothing inside it could read a cancel message).
 */
import type { CadDocument, CadTopologyTable } from '@editor-platform/cad-core';
import type { CadKernelBuild } from '@editor-platform/cad-kernel-occt';
import type { SimulationDocument } from '@editor-platform/simulation-core';
import type { SimulationComputeDescriptor } from './compute';
import type { RunProgress, StudyRun } from './run';

/** The solver's build identity, recorded with each run (the solver is part of this package). */
export const simulationSolverBuild = 'geometry-fem';

/** A verified Netgen build: the loader and the Wasm whose SHA-256 must be `buildHash`. */
export interface FemMesherBuild {
  buildHash: string;
  moduleUrl: string;
  wasmUrl: string;
}
export interface StudyRunRequest {
  type: 'run';
  doc: SimulationDocument;
  cad: CadDocument;
  cadContentHash: string;
  studyId: string;
  /** The source body's table from the Host's display evaluation of the same version. */
  table: CadTopologyTable;
  /** R3j-6a: the other analysed bodies' tables from the same display evaluation, by body. */
  bodyTables?: Record<string, CadTopologyTable>;
  kernel: CadKernelBuild;
  mesher: FemMesherBuild;
  /**
   * R3f-3: solve on this compute Host (its endpoint an absolute URL) instead of the browser
   * solver; only given after the user chose it.
   */
  compute?: SimulationComputeDescriptor;
}
/** R3f-3: stops a Host solve (the Worker is idle while it waits, so it reads this). */
export interface StudyCancelRequest {
  type: 'cancel';
}
export type StudyRunMessage =
  | { type: 'progress'; progress: RunProgress }
  | { type: 'done'; run: StudyRun }
  /** The run could not start (a build did not load or verify) or threw unexpectedly. */
  | { type: 'error'; message: string };
