// Dedicated validation origin only. Every served Video entry must participate.
// This lock cannot exclude legacy builds, arbitrary writers or another origin.
import { TotalCapacity } from '../../../../packages/video-metadata/file-backed-storage/integration/capacity';
import { validationPolicy } from '../../../../packages/video-metadata/host-media/m2/capacity-validation-policy.mjs';
export async function acquireValidationOwner() {
  let release, ready, refused;
  const held = new Promise((r) => {
    release = r;
  });
  const admitted = new Promise((r, j) => {
    ready = r;
    refused = j;
  });
  const task = globalThis.navigator.locks
    .request('normal-video-validation-media-owner@0', { ifAvailable: true }, async (lock) => {
      if (!lock) {
        refused(Error('Another validation Video owns media resources'));
        return;
      }
      ready();
      await held;
    })
    .catch(refused);
  await admitted;
  let capacity;
  try {
    capacity = await TotalCapacity.open(validationPolicy);
  } catch (error) {
    release();
    await task;
    throw error;
  }
  let closing;
  return {
    capacity,
    codec(actual) {
      const codec = { ...actual };
      for (const method of ['preview', 'play', 'encode']) {
        if (typeof actual[method] !== 'function') continue;
        codec[method] = async (...args) => {
          const usage = await capacity.inspect();
          if (usage.overBudget || usage.availableBytes < 128 * 1024 ** 2)
            throw Error('Insufficient logical capacity before media scratch');
          return actual[method](...args);
        };
      }
      return codec;
    },
    close() {
      return (closing ??= (async () => {
        capacity.close();
        release();
        await task;
      })());
    },
  };
}
