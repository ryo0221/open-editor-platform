import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { mountV2Host, emptyV2 } from './host-v2';
import { productCodecV2 } from './product-codec-v2.mjs';
import { createAdmittedPersistenceV2 } from './storage-admission-v2.mjs';
export const digest = () => {
  const h = sha256.create();
  return {
    update: (b) => h.update(b),
    hex: () => bytesToHex(h.digest()),
    dispose: () => h.destroy(),
  };
};
let namespaces = 0;
export const options = {
  digest,
  namespace: () => {
    namespaces++;
    return 'm2-admitted-' + globalThis.crypto.randomUUID();
  },
  newArtifactId: () => globalThis.crypto.randomUUID(),
  empty: emptyV2,
  now: () => new Date().toISOString(),
  journalBytes: 1024 ** 3,
  scratchBytes: 256 * 1024 ** 2,
  externalBytes: 256 * 1024 ** 2,
  authorize: () => true,
};
// Local reference Host only. No new total policy, product auth or normal Host registration.
const factory = createAdmittedPersistenceV2(options);
globalThis.m2Namespaces = () => namespaces;
globalThis.videoV2Ready = mountV2Host(
  globalThis.document.querySelector('main'),
  factory,
  productCodecV2,
).then((host) => {
  globalThis.closeVideoV2 = host.close;
});
