import { expect, it, vi } from 'vitest';
import { probeMedia, type MediaLease, type ProbeInput } from './index';
const asset = { assetId: 'asset', sha256: 'a'.repeat(64), byteLength: 16 };
const budget = { maxReadBytes: 8, maxTotalBytes: 12, maxReads: 3 };
function setup() {
  const release = vi.fn();
  const read = vi.fn(async (_offset: number, length: number) => new Uint8Array(length));
  const lease: MediaLease = { asset: { ...asset }, read, release };
  const open = vi.fn(async () => lease);
  return { release, read, lease, reader: { open }, abort: new AbortController() };
}
it('provides bounded exact reads and releases once', async () => {
  const s = setup();
  let input: ProbeInput | undefined;
  const result = await probeMedia(
    asset,
    s.reader,
    {
      async probe(p) {
        input = p;
        return (await p.read(2, 8)).length;
      },
      validate(value) {
        expect(value).toBe(8);
        return 'validated';
      },
    },
    budget,
    s.abort.signal,
  );
  expect(result).toBe('validated');
  expect(s.release).toHaveBeenCalledTimes(1);
  await expect(input!.read(0, 1)).rejects.toThrow('expired');
  expect(s.read).toHaveBeenCalledTimes(1);
});
it.each([
  'identity',
  'short',
  'abort',
  'probe',
  'validation',
  'range',
  'per-read',
  'total',
  'reads',
])('cleans up on %s failure', async (mode) => {
  const s = setup();
  if (mode === 'identity') s.lease.asset.sha256 = 'b'.repeat(64);
  if (mode === 'short') s.read.mockResolvedValue(new Uint8Array(1));
  await expect(
    probeMedia(
      asset,
      s.reader,
      {
        async probe(p) {
          if (mode === 'probe') throw new Error('probe failed');
          if (mode === 'abort') s.abort.abort();
          if (mode === 'range') return p.read(15, 2);
          if (mode === 'per-read') return p.read(0, 9);
          if (mode === 'total') {
            await p.read(0, 8);
            return p.read(0, 8);
          }
          if (mode === 'reads') {
            for (let i = 0; i < 4; i++) await p.read(0, 1);
          }
          return p.read(0, 4);
        },
        validate(v) {
          if (mode === 'validation') throw new Error('bad metadata');
          return v;
        },
      },
      budget,
      s.abort.signal,
    ),
  ).rejects.toThrow();
  expect(s.release).toHaveBeenCalledTimes(1);
});
it('does not open on pre-abort or invalid budget', async () => {
  const s = setup();
  s.abort.abort();
  const probe = { probe: async () => ({}), validate: (v: unknown) => v };
  await expect(probeMedia(asset, s.reader, probe, budget, s.abort.signal)).rejects.toThrow();
  await expect(
    probeMedia(asset, s.reader, probe, { ...budget, maxReads: 0 }, new AbortController().signal),
  ).rejects.toThrow();
  expect(s.reader.open).not.toHaveBeenCalled();
});
it('waits for in-flight probe reads before release', async () => {
  const s = setup();
  let resolveRead: ((bytes: Uint8Array<ArrayBuffer>) => void) | undefined;
  s.read.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
  );
  const result = probeMedia(
    asset,
    s.reader,
    {
      async probe(p) {
        void p.read(0, 4);
        return 'done';
      },
      validate: (v) => v,
    },
    budget,
    s.abort.signal,
  );
  await vi.waitFor(() => expect(resolveRead).toBeTypeOf('function'));
  expect(s.release).not.toHaveBeenCalled();
  resolveRead!(new Uint8Array(4));
  await expect(result).resolves.toBe('done');
  expect(s.release).toHaveBeenCalledTimes(1);
});
it.each(['read drain', 'lease release'])(
  'rejects cancellation during %s after validation',
  async (phase) => {
    const s = setup();
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    if (phase === 'read drain') {
      s.read.mockImplementation(async () => {
        await gate;
        return new Uint8Array(4);
      });
    } else s.release.mockImplementation(() => gate);
    const validate = vi.fn((value: unknown) => value);
    const result = probeMedia(
      asset,
      s.reader,
      {
        async probe(input) {
          if (phase === 'read drain') void input.read(0, 4);
          return 'provisional result';
        },
        validate,
      },
      budget,
      s.abort.signal,
    );
    await vi.waitFor(() => expect(validate).toHaveBeenCalledOnce());
    if (phase === 'read drain') expect(s.release).not.toHaveBeenCalled();
    else await vi.waitFor(() => expect(s.release).toHaveBeenCalledOnce());
    const reason = new Error(`Cancelled during ${phase}`);
    const rejected = expect(result).rejects.toBe(reason);
    s.abort.abort(reason);
    unblock();
    await rejected;
    expect(s.release).toHaveBeenCalledTimes(1);
  },
);
