import { calculateEstimate } from '@editor-platform/estimate-core';
self.onmessage = async (event: MessageEvent) => {
  const { id, document, scenarioId } = event.data;
  try {
    self.postMessage({ id, result: await calculateEstimate(document, id, scenarioId) });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
