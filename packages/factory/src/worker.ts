/// <reference lib="webworker" />
import {
  startFactoryRun,
  FactoryValidationError,
  type FactoryDocument,
} from '@editor-platform/factory-core';

/** Events handled between two progress reports (#17). */
const slice = 500_000;

/**
 * FT2: runs one model off the page's thread (FT-U5). #17: in slices, reporting how far the
 * simulated time has come after each; the run's state stays here between slices, so a long run
 * (a simulated year) ends with the same result as one taken at once. Stopping ends the Worker.
 */
self.onmessage = (e: MessageEvent<FactoryDocument>) => {
  try {
    const run = startFactoryRun(e.data, { record: true });
    let p = run.progress();
    while (!p.done) {
      p = run.advance(slice);
      if (!p.done) self.postMessage({ progress: p });
    }
    self.postMessage({ ok: true, result: run.finish() });
  } catch (error) {
    self.postMessage({
      ok: false,
      code: error instanceof FactoryValidationError ? error.code : 'failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
