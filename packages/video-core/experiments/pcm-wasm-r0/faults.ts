/** Test-only module mutation: insert an actual WASM trap for batches > 1 after self-test. */
import { need } from '../../src/pcm/kernel';
export function trapBatches(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const leb = (n: number) => {
    const out: number[] = [];
    do {
      let b = n & 127;
      n >>>= 7;
      if (n) b |= 128;
      out.push(b);
    } while (n);
    return out;
  };
  let at = 8,
    kernel = -1;
  const read = () => {
    let n = 0,
      s = 0,
      b: number;
    do {
      b = bytes[at++];
      n += (b & 127) * 2 ** s;
      s += 7;
    } while (b & 128);
    return n;
  };
  const out: number[] = [...bytes.subarray(0, 8)];
  while (at < bytes.length) {
    const start = at,
      id = bytes[at++],
      length = read(),
      end = at + length;
    if (id === 7) {
      const count = read();
      for (let i = 0; i < count; i++) {
        const size = read(),
          name = new TextDecoder().decode(bytes.subarray(at, at + size));
        at += size;
        const kind = bytes[at++],
          index = read();
        if (name === 'kernel') {
          need(kind === 0, 'Kernel export');
          kernel = index;
        }
      }
    }
    if (id === 10) {
      need(kernel >= 0, 'Kernel index');
      const count = read(),
        body: number[] = [...leb(count)];
      for (let i = 0; i < count; i++) {
        const size = read(),
          first = at,
          last = at + size;
        if (i === kernel) {
          const groups = read();
          for (let g = 0; g < groups; g++) {
            read();
            at++;
          }
          const prefix = [0x20, 0x00, 0x41, 0x01, 0x4b, 0x04, 0x40, 0x00, 0x0b];
          const changed = [...bytes.subarray(first, at), ...prefix, ...bytes.subarray(at, last)];
          body.push(...leb(changed.length), ...changed);
        } else body.push(...leb(size), ...bytes.subarray(first, last));
        at = last;
      }
      out.push(id, ...leb(body.length), ...body);
    } else out.push(...bytes.subarray(start, end));
    at = end;
  }
  return new Uint8Array(out);
}
