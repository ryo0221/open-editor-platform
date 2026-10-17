/** Controlled test Host only. Existing exact @noble/hashes1.8.0 is injected, not adopted by the adapter. */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { blobReader, createBrowserVerifier, type ExpectedArchive } from './adapter';
import { CHUNK, createScanner, memory, type DigestFactory } from '../portable/io';
const digest: DigestFactory = () => {
  const h = sha256.create();
  return {
    update: (b) => {
      h.update(b);
    },
    hex: () => bytesToHex(h.digest()),
    dispose: () => h.destroy(),
  };
};
const verifier = createBrowserVerifier(digest),
  scan = createScanner(digest);
let selected: File | undefined;
const input = document.querySelector('input')!;
input.onchange = () => {
  selected = input.files?.[0];
};
Object.assign(window, {
  qa: {
    async vectors() {
      for (const length of [0, 1, 3, 55, 56, 63, 64, 65, 65537]) {
        const bytes = Uint8Array.from({ length }, (_, i) => i % 251);
        const expected = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
        if ((await scan(memory(bytes), new AbortController().signal)).sha256 !== expected)
          throw Error('Digest vector ' + length);
      }
      return 9;
    },
    async inspect(pin?: ExpectedArchive, cancelAt = 0) {
      if (!selected) throw Error('Select portable file');
      const base = blobReader(selected),
        abort = new AbortController();
      let maxRead = 0,
        reads = 0,
        inFlight = 0,
        maxInFlight = 0;
      const reader = {
        size: base.size,
        async read(at: bigint, n: number, signal: AbortSignal) {
          maxRead = Math.max(maxRead, n);
          maxInFlight = Math.max(maxInFlight, ++inFlight);
          try {
            if (++reads === cancelAt) abort.abort();
            return await base.read(at, n, signal);
          } finally {
            inFlight--;
          }
        },
      };
      try {
        const opened = await verifier.open(reader, abort.signal, pin);
        const retained = await Promise.all(
          [...opened.project.originals].map(async ([id, r]) => ({
            id,
            size: r.size.toString(),
            actual: (await scan(r, abort.signal)).sha256,
          })),
        );
        const result = {
          ok: true,
          receipt: opened.receipt,
          versions: opened.project.versions,
          selected: opened.project.selectedVersionId,
          retained,
          maxRead,
          maxInFlight,
          reads,
        };
        document.querySelector('pre')!.textContent = JSON.stringify(result, null, 2);
        return result;
      } catch (e) {
        return { ok: false, reason: String(e), maxRead, maxInFlight, reads };
      }
    },
    async pinMismatch(pin: ExpectedArchive) {
      const r = blobReader(selected!);
      return verifier.verify(
        { size: Number(r.size), read: (at, n, s) => r.read(BigInt(at), n, s) },
        pin,
        new AbortController().signal,
      );
    },
    download() {
      const url = URL.createObjectURL(selected!);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'portable-video.zip';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    async bounds() {
      const r = blobReader(selected!);
      let rejected = 0;
      for (const [at, n] of [
        [-1n, 1],
        [0n, CHUNK + 1],
        [r.size, 1],
      ] as const) {
        try {
          await r.read(at, n, new AbortController().signal);
        } catch {
          rejected++;
        }
      }
      return rejected;
    },
  },
});
