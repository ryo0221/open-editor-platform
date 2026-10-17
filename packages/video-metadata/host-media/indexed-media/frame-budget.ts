/** Private accounting for application-held decoded frames, not opaque codec/GPU memory. */
export type FrameCapacity = Readonly<{ pixels: number; bytes: number }>;
const pixelsPerFrame = 1920 * (1080 + 32);
// Existing limits: 64 cached outputs + 2 independently held frame clones, 2 readers.
export const FRAME_SESSION_CAPACITY = Object.freeze({
  pixels: pixelsPerFrame * 66,
  bytes: pixelsPerFrame * 66 * 4,
});
export const FRAME_REALM_CAPACITY = Object.freeze({
  pixels: FRAME_SESSION_CAPACITY.pixels * 2,
  bytes: FRAME_SESSION_CAPACITY.bytes * 2,
});
function valid(value: FrameCapacity) {
  if (![value.pixels, value.bytes].every((n) => Number.isSafeInteger(n) && n > 0))
    throw Error('Invalid decoded-frame reservation');
}
export function createFrameBudgetRealm(capacity: FrameCapacity) {
  valid(capacity);
  const limit = { ...capacity },
    total = { pixels: 0, bytes: 0 };
  return {
    snapshot: () => ({ ...total }),
    session(capacity: FrameCapacity) {
      valid(capacity);
      const sessionLimit = { ...capacity },
        used = { pixels: 0, bytes: 0 };
      let closed = false;
      return {
        snapshot: () => ({ ...used }),
        reserve(cost: FrameCapacity) {
          valid(cost);
          const charge = { ...cost };
          if (closed) throw Error('Decoded-frame session closed');
          for (const key of ['pixels', 'bytes'] as const) {
            if (charge[key] > sessionLimit[key] - used[key])
              throw Error('Decoded-frame session budget');
            if (charge[key] > limit[key] - total[key]) throw Error('Decoded-frame realm budget');
          }
          // Both dimensions and both scopes are checked before any mutation/allocation.
          used.pixels += charge.pixels;
          used.bytes += charge.bytes;
          total.pixels += charge.pixels;
          total.bytes += charge.bytes;
          let released = false;
          return {
            release() {
              if (released) return;
              released = true;
              used.pixels -= charge.pixels;
              used.bytes -= charge.bytes;
              total.pixels -= charge.pixels;
              total.bytes -= charge.bytes;
            },
          };
        },
        close() {
          if (used.pixels || used.bytes) throw Error('Decoded-frame reservations outstanding');
          closed = true;
        },
      };
    },
  };
}
const key = Symbol.for('editor-platform.private.decoded-frame-budget.v1');
const realm = globalThis as typeof globalThis & { [key: symbol]: unknown };
// Same realm, including independently bundled private readers, shares one ledger.
export const decodedFrameRealm = (realm[key] ??=
  createFrameBudgetRealm(FRAME_REALM_CAPACITY)) as ReturnType<typeof createFrameBudgetRealm>;
