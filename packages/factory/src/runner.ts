import {
  FactoryValidationError,
  type FactoryExperimentRun,
  type FactoryRunProgress,
  type FactoryRunResult,
} from '@editor-platform/factory-core';
import type { FactoryExperimentRunner, FactoryRunner } from './controller';

/** A runner that starts one Worker per run and ends it when the run stops (FT-U5). */
export const factoryWorkerRunner: FactoryRunner = (doc, signal, onProgress) =>
  new Promise<FactoryRunResult>((resolve, reject) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const end = () => worker.terminate();
    signal.addEventListener('abort', () => {
      end();
      reject(new Error('stopped'));
    });
    worker.onmessage = (
      e: MessageEvent<
        | { ok: true; result: FactoryRunResult }
        | { ok: false; code: string; message: string }
        | { ok?: undefined; progress: FactoryRunProgress }
      >,
    ) => {
      if (e.data.ok === undefined) return onProgress?.(e.data.progress);
      end();
      if (e.data.ok) resolve(e.data.result);
      else reject(new FactoryValidationError(e.data.code, e.data.message));
    };
    worker.onerror = (e) => {
      end();
      reject(new Error(e.message || 'worker-failed'));
    };
    worker.postMessage(doc);
  });

type ExperimentMessage =
  | { type: 'runs'; runs: FactoryExperimentRun[] }
  | { type: 'done' }
  | { type: 'error'; code: string; message: string };

/** FT5: one Worker per experiment, ended when the experiment stops or finishes. */
export const factoryExperimentWorkerRunner: FactoryExperimentRunner = (doc, onRuns, signal) =>
  new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL('./experiment-worker.ts', import.meta.url), {
      type: 'module',
    });
    const end = () => worker.terminate();
    if (signal.aborted) {
      end();
      return reject(new Error('stopped'));
    }
    signal.addEventListener('abort', () => {
      end();
      reject(new Error('stopped'));
    });
    worker.onmessage = (e: MessageEvent<ExperimentMessage>) => {
      if (e.data.type === 'runs') return onRuns(e.data.runs);
      end();
      if (e.data.type === 'done') resolve();
      else reject(new FactoryValidationError(e.data.code, e.data.message));
    };
    worker.onerror = (e) => {
      end();
      reject(new Error(e.message || 'worker-failed'));
    };
    worker.postMessage(doc);
  });
