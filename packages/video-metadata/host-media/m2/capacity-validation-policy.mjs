/** Explicit validation policy, not a normal Host default or whole-origin enforcement. */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
const MiB = 1024 ** 2;
export const validationLimits = Object.freeze({
  externalBytes: 512 * MiB,
  scratchBytes: 512 * MiB,
  journalBytes: 1024 * MiB,
});
export const validationPolicy = Object.freeze({
  totalBytes: 2048 * MiB,
  managementBytes: 144 * MiB,
  maxEntries: 1000,
  maxDepth: 10,
  maxReservations: 20,
});
// 128MiB existing PCM allowance +16MiB management allowance are withheld inside2GiB.
// Visible PCM files still count, deliberately conservative. No physical-disk/RAM guarantee.
export const validationDigest = () => {
  const h = sha256.create();
  return {
    update: (b) => h.update(b),
    hex: () => bytesToHex(h.digest()),
    dispose: () => h.destroy(),
  };
};
