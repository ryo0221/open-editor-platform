import { BakeError } from '@editor-platform/geometry-mesh';
import { runBake, type BakeRequest, type BakeResponse } from './bake-protocol';

// C7d: the normal-map bake off the main thread; stopping it ends the worker.
onmessage = async ({ data }: MessageEvent<BakeRequest>) => {
  let reply: BakeResponse;
  let transfer: ArrayBuffer[] = [];
  let last = 0;
  try {
    const done = await runBake(data, (rows, size) => {
      // About a hundred progress messages a bake.
      if (rows - last >= size / 100 || rows === size) {
        last = rows;
        postMessage({ id: data.id, status: 'progress', rows, size } satisfies BakeResponse);
      }
    });
    reply = { id: data.id, status: 'done', ...done };
    if (done.png.buffer instanceof ArrayBuffer) transfer = [done.png.buffer];
  } catch (e) {
    reply =
      e instanceof BakeError
        ? { id: data.id, status: 'refused', problem: e.problem, detail: e.detail, faces: e.faces }
        : { id: data.id, status: 'failed', message: e instanceof Error ? e.message : String(e) };
  }
  postMessage(reply, { transfer });
};
