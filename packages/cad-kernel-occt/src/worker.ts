import { createKernelHost, loadVerifiedBuild } from './host';
import type { CadWorkerRequest } from './protocol';

// Browser Worker entry. A MessageChannel round-trip is a macrotask boundary for cancel delivery.
const channel = new MessageChannel();
const waiting: (() => void)[] = [];
channel.port1.onmessage = () => waiting.shift()?.();
// Typed locally: a webworker lib reference would change DOM globals for the whole program.
const scope = self as unknown as {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<CadWorkerRequest>) => void) | null;
};
const handle = createKernelHost({
  load: loadVerifiedBuild,
  post: (message, transfer) => scope.postMessage(message, transfer),
  yieldTask: () =>
    new Promise((resolve) => {
      waiting.push(resolve);
      channel.port2.postMessage(0);
    }),
});
scope.onmessage = (event: MessageEvent<CadWorkerRequest>) => void handle(event.data);
