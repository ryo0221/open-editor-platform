import { calculateRun, verifyAnalysis } from '@editor-platform/analysis-core';
self.onmessage = async (event: MessageEvent) => {
  const { id, document, scenarioId, mode } = event.data;
  try {
    const result =
      mode === 'verify'
        ? await verifyAnalysis(document)
        : await calculateRun(document, id, scenarioId);
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
