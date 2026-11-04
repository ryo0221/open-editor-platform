import { MeshEditError, subdivideMesh } from '@editor-platform/geometry-mesh';
import {
  meshBuffers,
  type SubdivisionRequest,
  type SubdivisionResponse,
} from './subdivision-protocol';

// C3i: Catmull-Clark off the main thread, so a heavy cage does not stop the view.
onmessage = ({ data }: MessageEvent<SubdivisionRequest>) => {
  let reply: SubdivisionResponse;
  let transfer: ArrayBuffer[] = [];
  try {
    const mesh = subdivideMesh(data.mesh, data.levels);
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
