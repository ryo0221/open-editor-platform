import {
  calculateRun,
  verifyAnalysis,
  type AnalysisDocument,
} from '@editor-platform/analysis-core';
import type { AnalysisWorkerFactory } from './host';
export const testWorker: AnalysisWorkerFactory = () => {
  const worker = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    onerror: null,
    terminate() {},
    postMessage(message: {
      id: string;
      document: AnalysisDocument;
      scenarioId: string | null;
      mode: string;
    }) {
      void (
        message.mode === 'verify'
          ? verifyAnalysis(message.document)
          : calculateRun(message.document, message.id, message.scenarioId)
      )
        .then((result) => worker.onmessage?.({ data: { id: message.id, result } }))
        .catch((error) => worker.onmessage?.({ data: { id: message.id, error: String(error) } }));
    },
  };
  return worker as unknown as Worker;
};
