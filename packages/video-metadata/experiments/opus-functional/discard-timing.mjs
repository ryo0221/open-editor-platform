import assert from 'node:assert/strict';
// Approved finite 48 kHz profile: nearest integer ns, positive ties upward.
export function discardNanoseconds(frames) {
  assert(typeof frames === 'bigint' && frames >= 0n && frames < 960n, 'Invalid end discard');
  return (frames * 1000000000n + 24000n) / 48000n;
}
export function discardSamples(ns) {
  assert(typeof ns === 'bigint' && ns >= 0n, 'Invalid discard nanoseconds');
  const frames = (ns * 48000n + 500000000n) / 1000000000n;
  assert.equal(discardNanoseconds(frames), ns, 'Noncanonical sample discard');
  return Number(frames);
}
