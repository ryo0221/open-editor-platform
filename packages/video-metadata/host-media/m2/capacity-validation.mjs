/** Explicit approved local validation configuration. Never imported by normal/default Host. */
import { TotalCapacity } from '../../file-backed-storage/integration/capacity';
import { createAdmittedPersistenceV2 } from './storage-admission-v2.mjs';
import { createV2MountSlot } from './mount-adapter.mjs';
import { emptyV2 } from './host-v2';
import { productCodecV2 } from './product-codec-v2.mjs';
import {
  validationLimits,
  validationPolicy,
  validationDigest,
} from './capacity-validation-policy.mjs';
export {
  validationLimits,
  validationPolicy,
  validationDigest,
} from './capacity-validation-policy.mjs';
const MiB = 1024 ** 2;
async function acquireOwner() {
  let release, ready, refused;
  const held = new Promise((r) => {
      release = r;
    }),
    admitted = new Promise((r, j) => {
      ready = r;
      refused = j;
    });
  const task = globalThis.navigator.locks
    .request('video-m2-capacity-validation-owner', { ifAvailable: true }, async (lock) => {
      if (!lock) {
        refused(Error('Validation origin already has an owner'));
        return;
      }
      ready();
      await held;
    })
    .catch(refused);
  await admitted;
  return async () => {
    release();
    await task;
  };
}
export async function createCapacityValidation(root, { onCapacity, onPersistence } = {}) {
  const unlock = await acquireOwner();
  let capacity, slot;
  try {
    capacity = await TotalCapacity.open(validationPolicy);
    await onCapacity?.(capacity);
    const codec = { ...productCodecV2 };
    for (const method of ['preview', 'play', 'encode'])
      codec[method] = async (...args) => {
        const usage = await capacity.inspect();
        if (usage.overBudget || usage.availableBytes < 128 * MiB)
          throw Error('Insufficient logical capacity before media scratch');
        return productCodecV2[method](...args);
      };
    slot = createV2MountSlot(root);
    const replace = async (file) => {
      let savedHash;
      const actual = createAdmittedPersistenceV2({
        digest: validationDigest,
        capacity,
        ...validationLimits,
        namespace: () => 'm2-validation-' + globalThis.crypto.randomUUID(),
        newArtifactId: () => globalThis.crypto.randomUUID(),
        empty: emptyV2,
        now: () => new Date().toISOString(),
        authorize: () => true,
      });
      return slot.replace({
        file,
        codec,
        factory: async (live, input) => {
          const p = await actual(live, input);
          p.storage.markSaved = (c) => {
            savedHash = c.contentHash;
          };
          try {
            await onPersistence?.(p);
            return p;
          } catch (error) {
            await p.close();
            throw error;
          }
        },
        assertCanLeave: async ({ snapshot, initialHash, fromPortable }) => {
          if (snapshot.hash !== (savedHash ?? initialHash) || (fromPortable && !savedHash))
            throw Error('Save validation project before leaving');
        },
      });
    };
    await replace();
    let closing;
    return {
      capacity,
      slot,
      replace,
      close() {
        if (closing) return closing;
        closing = (async () => {
          await slot.close();
          capacity.close();
          await unlock();
        })().catch((e) => {
          closing = undefined;
          throw e;
        });
        return closing;
      },
    };
  } catch (error) {
    capacity?.close();
    await unlock();
    throw error;
  }
}
