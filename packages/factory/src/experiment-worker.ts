/// <reference lib="webworker" />
import {
  runFactoryExperiment,
  FactoryValidationError,
  type FactoryDocument,
  type FactoryExperimentRun,
} from '@editor-platform/factory-core';

/**
 * FT5: runs a model's experiment off the page's thread (FT-U5). Finished runs are posted in
 * batches (at most every 100 ms); the page stops the experiment by ending the Worker.
 */
self.onmessage = (e: MessageEvent<FactoryDocument>) => {
  let batch: FactoryExperimentRun[] = [];
  let sent = Date.now();
  const flush = () => {
    if (batch.length) self.postMessage({ type: 'runs', runs: batch });
    batch = [];
    sent = Date.now();
  };
  try {
    for (const run of runFactoryExperiment(e.data)) {
      batch.push(run);
      if (Date.now() - sent >= 100) flush();
    }
    flush();
    self.postMessage({ type: 'done' });
  } catch (error) {
    flush();
    self.postMessage({
      type: 'error',
      code: error instanceof FactoryValidationError ? error.code : 'failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
