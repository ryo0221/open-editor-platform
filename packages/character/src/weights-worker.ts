import { boneHeatWeights, MeshEditError } from '@editor-platform/geometry-mesh';
import { meshBuffers } from './subdivision-protocol';
import type { WeightsRequest, WeightsResponse } from './weights-protocol';

// C5b: bone heat off the main thread; a cancel terminates this worker.
onmessage = ({ data }: MessageEvent<WeightsRequest>) => {
  let reply: WeightsResponse;
  let transfer: ArrayBuffer[] = [];
  try {
    const mesh = boneHeatWeights(data.mesh, data.bones, data.boneIds, (done, total) =>
      postMessage({ id: data.id, status: 'progress', done, total } satisfies WeightsResponse),
    );
    reply = { id: data.id, status: 'done', mesh };
    transfer = meshBuffers(mesh);
  } catch (e) {
    reply =
      e instanceof MeshEditError
        ? { id: data.id, status: 'refused', problem: e.problem, detail: e.detail }
        : { id: data.id, status: 'failed', message: e instanceof Error ? e.message : String(e) };
  }
  postMessage(reply, { transfer });
};
