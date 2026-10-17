// Private per-realm admission. Reservations survive cleanup failures.
const owners = new Map();
let building = 0,
  reads = 0;
export function scratchStatus() {
  return {
    building,
    reads,
    files: owners.size,
    bytes: [...owners.values()].reduce((a, b) => a + b, 0),
  };
}
export function reserveScratch(bytes) {
  if (
    building ||
    owners.size >= 4 ||
    bytes <= 0 ||
    scratchStatus().bytes + bytes > 128 * 1024 * 1024
  )
    throw Error('PCM scratch admission');
  const id = 'video-pcm-' + globalThis.crypto.randomUUID();
  owners.set(id, bytes);
  building++;
  let build = true;
  return {
    id,
    ready() {
      if (build) {
        build = false;
        building--;
      }
    },
    release() {
      this.ready();
      owners.delete(id);
    },
  };
}
export function ownRead() {
  if (reads >= 2) throw Error('PCM concurrent read bound');
  reads++;
  let done = false;
  return () => {
    if (!done) {
      done = true;
      reads--;
    }
  };
}
