import { createPcmFile } from './pcm-file.mjs';
import { createVideoWindow } from './video-window.mjs';
const need = (x, m) => {
  if (!x) throw Error(m);
};
export async function resourceCheck(original, identity) {
  const clean = new Uint8Array(await original.slice().arrayBuffer());
  const bytes = clean.slice(),
    v = new DataView(bytes.buffer);
  let patches = 0;
  for (let p = 4; p + 16 < bytes.length; p++)
    if (String.fromCharCode(...bytes.subarray(p, p + 4)) === 'stsz') {
      const fixed = v.getUint32(p + 8);
      v.setUint32(p + (fixed ? 8 : 16), 2 * 1024 * 1024);
      patches++;
    }
  need(patches === 2, 'Fixture size tables');
  const huge = new globalThis.Blob([bytes]),
    slice = huge.slice.bind(huge);
  let reads = 0;
  huge.slice = (start, end, ...rest) => {
    reads++;
    need(end - start <= 8 * 1024 * 1024, 'Unbounded metadata range');
    if (end - start > 16)
      need(
        String.fromCharCode(...bytes.subarray(start + 4, start + 8)) === 'moov',
        'Payload read before size validation',
      );
    return slice(start, end, ...rest);
  };
  const rows = [];
  for (const make of [
    () => createPcmFile(huge, new globalThis.AbortController().signal, identity),
    () => createVideoWindow(huge, new globalThis.AbortController().signal),
  ]) {
    let rejected = false;
    try {
      await make();
    } catch (e) {
      rejected = String(e).includes('MP4 index profile/bounds');
    }
    need(rejected, 'Oversized declared sample not refused');
    rows.push({ rejected, reads });
  }
  const box = (type, length = 8) => {
    const b = new Uint8Array(length);
    new DataView(b.buffer).setUint32(0, length);
    b.set(
      Array.from(type, (c) => c.charCodeAt(0)),
      4,
    );
    return b;
  };
  const append = (type, addition) => {
    const view = new DataView(clean.buffer);
    let selected;
    const walk = (first, end, parents = []) => {
      for (let at = first; at < end && !selected; ) {
        const size = view.getUint32(at),
          kind = String.fromCharCode(...clean.subarray(at + 4, at + 8)),
          chain = [...parents, at];
        if (kind === type) {
          selected = { at: at + size, parents: chain };
          return;
        }
        if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(kind)) walk(at + 8, at + size, chain);
        at += size;
      }
    };
    walk(0, clean.length);
    need(selected, 'Mutation container');
    const next = new Uint8Array(clean.length + addition.length);
    next.set(clean.subarray(0, selected.at));
    next.set(addition, selected.at);
    next.set(clean.subarray(selected.at), selected.at + addition.length);
    const v = new DataView(next.buffer);
    for (const at of selected.parents) v.setUint32(at, v.getUint32(at) + addition.length);
    return next;
  };
  const trailing = box('mfra', 9 * 1024 * 1024),
    footer = box('mfro', 16);
  new DataView(footer.buffer).setUint32(12, trailing.length);
  trailing.set(footer, trailing.length - footer.length);
  const withTrailer = new Uint8Array(clean.length + trailing.length);
  withTrailer.set(clean);
  withTrailer.set(trailing, clean.length);
  for (const [mode, mutated] of [
    ['conflicting-stsz-stz2', append('stbl', box('stz2', 20))],
    ['unsupported-sample-table', append('stbl', box('senc', 16))],
    ['fragment-declaration', append('moov', box('mvex'))],
    ['oversized-trailing-mfra', withTrailer],
  ]) {
    const candidate = new globalThis.Blob([mutated]),
      slice = candidate.slice.bind(candidate);
    let payloadReads = 0,
      maxRead = 0;
    candidate.slice = (start, end, ...rest) => {
      maxRead = Math.max(maxRead, end - start);
      if (
        end - start > 16 &&
        String.fromCharCode(...mutated.subarray(start + 4, start + 8)) !== 'moov'
      ) {
        payloadReads++;
        throw Error('Payload allocation attempted');
      }
      return slice(start, end, ...rest);
    };
    for (const make of [
      () => createPcmFile(candidate, new globalThis.AbortController().signal, identity),
      () => createVideoWindow(candidate, new globalThis.AbortController().signal),
    ]) {
      let refusal;
      try {
        const value = await make();
        await value.dispose();
      } catch (e) {
        refusal = String(e);
      }
      need(refusal && payloadReads === 0, 'Unsupported declarations reached payload allocation');
      rows.push({ mode, refusal, payloadReads, maxRead });
    }
  }
  const prototype = globalThis.Blob.prototype,
    read = prototype.arrayBuffer;
  let enter, release;
  const entered = new Promise((r) => {
      enter = r;
    }),
    gate = new Promise((r) => {
      release = r;
    });
  let calls = 0;
  prototype.arrayBuffer = async function () {
    calls++;
    if (calls === 1) {
      enter();
      await gate;
    }
    return read.call(this);
  };
  const caller = new globalThis.AbortController();
  const first = createPcmFile(original, caller.signal, identity).then(
    () => {
      throw Error('Unexpected index');
    },
    () => {},
  );
  try {
    await entered;
    const before = calls;
    let rejected = false;
    try {
      await createPcmFile(original, caller.signal, identity);
    } catch (e) {
      rejected = String(e).includes('preflight admission');
    }
    need(rejected && calls === before, 'Parallel preflight read metadata');
    rows.push({ parallelPreflightRejected: rejected, additionalReads: calls - before });
    caller.abort();
    release();
    await first;
  } finally {
    release();
    prototype.arrayBuffer = read;
  }
  return rows;
}
