import { createPcmFile } from './pcm-file.mjs';
import { scratchStatus } from './scratch.mjs';
const need = (ok, msg) => {
  if (!ok) throw Error(msg);
};
const latch = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
export async function indexFaults(original, identity) {
  const prototype = globalThis.FileSystemWritableFileStream.prototype,
    write = prototype.write,
    close = prototype.close,
    rows = [];
  for (const mode of ['disk-full', 'write-cancel', 'close-cancel']) {
    const caller = new globalThis.AbortController(),
      entered = latch(),
      release = latch();
    let count = 0,
      settled = false;
    prototype.write = async function (...args) {
      count++;
      if (mode === 'disk-full' && count === 2)
        throw new globalThis.DOMException('Injected disk quota', 'QuotaExceededError');
      if (mode === 'write-cancel' && count === 1) {
        entered.resolve();
        await release.promise;
      }
      return write.apply(this, args);
    };
    prototype.close = async function (...args) {
      if (mode === 'close-cancel') {
        entered.resolve();
        await release.promise;
      }
      return close.apply(this, args);
    };
    const operation = createPcmFile(original, caller.signal, identity).then(
      async (value) => {
        settled = true;
        await value.dispose();
        return 'unexpected-ready';
      },
      (error) => {
        settled = true;
        return String(error);
      },
    );
    let pendingHeld = true,
      concurrentRefused = true;
    if (mode !== 'disk-full') {
      await entered.promise;
      try {
        await createPcmFile(original, new globalThis.AbortController().signal, identity);
        concurrentRefused = false;
      } catch (e) {
        need(String(e).includes('admission'), 'Concurrent refusal reason');
      }
      caller.abort();
      await new Promise((r) => globalThis.setTimeout(r, 0));
      pendingHeld = !settled;
      need(
        scratchStatus().building === 1 && scratchStatus().files === 1,
        'Reservation dropped before actual writer completion',
      );
      release.resolve();
    }
    const outcome = await operation;
    prototype.write = write;
    prototype.close = close;
    need(
      outcome !== 'unexpected-ready' && pendingHeld && concurrentRefused,
      'Fault publication/lifetime',
    );
    need(
      scratchStatus().files === 0 && scratchStatus().bytes === 0 && scratchStatus().building === 0,
      'Fault scratch leaked',
    );
    rows.push({ mode, outcome, pendingHeld, concurrentRefused, budget: scratchStatus() });
  }
  return rows;
}
