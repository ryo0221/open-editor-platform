import {
  kernelLoadMarksOf,
  loadKernelBuild,
  type OcModule,
} from '@editor-platform/geometry-kernel-occt';
import { createBimKernelHost } from './kernel-host';
import type { BimWorkerRequest } from './protocol';

/** Start-up marks of the bim kernel Worker's performance timeline. */
const marks = kernelLoadMarksOf('bim-kernel');

// Browser Worker entry. A MessageChannel round-trip is a macrotask boundary for cancel delivery.
const channel = new MessageChannel();
const waiting: (() => void)[] = [];
channel.port1.onmessage = () => waiting.shift()?.();
// Typed locally: a webworker lib reference would change DOM globals for the whole program.
const scope = self as unknown as {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<BimWorkerRequest>) => void) | null;
};
const handle = createBimKernelHost({
  load: async (build) => (await loadKernelBuild(build, marks)) as OcModule,
  post: (message, transfer) => scope.postMessage(message, transfer),
  yieldTask: () =>
    new Promise((resolve) => {
      waiting.push(resolve);
      channel.port2.postMessage(0);
    }),
});
scope.onmessage = (event: MessageEvent<BimWorkerRequest>) => void handle(event.data);
