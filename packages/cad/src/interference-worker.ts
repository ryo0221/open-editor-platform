import {
  runInterference,
  type CadInterferenceRequest,
  type CadInterferenceResponse,
} from './interference-job';

// MR3: interference checks off the main thread, so a large assembly does not stop the view.
onmessage = ({ data }: MessageEvent<{ id: number; request: CadInterferenceRequest }>) => {
  let reply: CadInterferenceResponse;
  try {
    reply = { id: data.id, status: 'done', report: runInterference(data.request) };
  } catch (e) {
    reply = { id: data.id, status: 'failed', message: e instanceof Error ? e.message : String(e) };
  }
  postMessage(reply);
};
