/// <reference lib="webworker" />
import {
  runFactory,
  FactoryValidationError,
  type FactoryDocument,
} from '@editor-platform/factory-core';

/** FT2: runs one model off the page's thread (FT-U5). */
self.onmessage = (e: MessageEvent<FactoryDocument>) => {
  try {
    self.postMessage({ ok: true, result: runFactory(e.data, { record: true }) });
  } catch (error) {
    self.postMessage({
      ok: false,
      code: error instanceof FactoryValidationError ? error.code : 'failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
