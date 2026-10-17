import { expect, it } from 'vitest';
import { Ledger, ARENA_BYTES, MEMORY_BYTES } from '../pcm-wasm-r0/kernel';
import { ScheduledAudio } from '../pcm-wasm-v1/scheduled-audio';
import {
  FixtureOwner,
  plane,
  mixOwnership,
  hashCopy,
  abortWait,
  scheduleFixture,
  exportFixture,
  type PlaybackPorts,
} from './consumer-ownership';
const deferred = () => {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const signal = () => new AbortController().signal;
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const owner = (realm: Ledger, limit = 65536) => new FixtureOwner(realm, limit);
function source() {
  return {
    buffer: null as AudioBuffer | null,
    onended: null as AudioBufferSourceNode['onended'],
    stop() {},
    disconnect() {},
  };
}
function ports(node = source(), fail = ''): PlaybackPorts {
  return {
    createBuffer() {
      if (fail === 'allocate') throw Error(fail);
      return {} as AudioBuffer;
    },
    copy() {
      if (fail === 'copy') throw Error(fail);
    },
    createSource() {
      if (fail === 'source') throw Error(fail);
      return node;
    },
    connect() {
      if (fail === 'connect') throw Error(fail);
    },
    start() {
      if (fail === 'start') throw Error(fail);
    },
  };
}
const ended = (s: ReturnType<typeof source>) =>
  s.onended?.call(s as unknown as AudioScheduledSourceNode, new Event('ended'));

it('sums four resident WASM bases, coexisting v1, staging, full backing copies and retained outputs in one ledger', async () => {
  const realm = new Ledger(8 * 1024 * 1024),
    resident = owner(realm, realm.limit);
  const releaseModule = resident.reserve(9976, 'module');
  const releases = Array.from({ length: 4 }, () =>
    resident.reserve(ARENA_BYTES + MEMORY_BYTES, 'resident-source'),
  );
  const v1 = resident.reserve(ARENA_BYTES, 'coexisting-v1');
  const preparation = resident.reserve(1024 * 1024, 'preparation-cache');
  const pendingWrite = resident.reserve(256 * 1024, 'pending-write');
  const range = resident.reserve(4096 * 4, 'range-backing');
  const collector = resident.reserve(4096 * 9 + 4096 * 4, 'collector-seen-callback');
  const sourceOwner = owner(realm),
    mix = owner(realm),
    output = owner(realm, 262144);
  const old = plane(mix, 4096, 'returned-mix');
  const native = output.reserve(1920 * 4, 'native-buffer');
  const result = await mixOwnership(
    mix,
    4096,
    [async () => plane(sourceOwner, 4096, 'source-result')],
    () => {
      expect(realm.bytes).toBe(7_896_312); // Worksheet: every charged term, not contributor count.
      expect(() => realm.reserve(realm.limit - realm.bytes + 1)).toThrow('admission');
    },
    () => {},
    signal(),
  );
  expect(sourceOwner.bytes).toBe(0);
  expect(mix.bytes).toBe(32768); // old and new result, separate from consumed source.
  expect(mix.peak).toBe(65536);
  mix.close();
  sourceOwner.close();
  output.close();
  resident.close();
  expect(() => mix.reserve(1)).toThrow('closed');
  expect(realm.bytes).toBeGreaterThan(0);
  old.release();
  result.release();
  native();
  collector();
  range();
  pendingWrite();
  preparation();
  v1();
  releases.forEach((r) => r());
  releaseModule();
  expect(realm.bytes).toBe(0);
});
it('retained mixed outputs cumulatively refuse conversion without revoking old leases', async () => {
  const realm = new Ledger(8 * 1024 * 1024),
    mix = owner(realm);
  const first = await mixOwnership(
    mix,
    4096,
    [],
    () => {},
    () => {},
    signal(),
  );
  const second = await mixOwnership(
    mix,
    4096,
    [],
    () => {},
    () => {},
    signal(),
  );
  await expect(
    mixOwnership(
      mix,
      4096,
      [],
      () => {},
      () => {},
      signal(),
    ),
  ).rejects.toThrow('admission');
  expect(mix.bytes).toBe(32768);
  first.release();
  second.release();
  expect(realm.bytes).toBe(0);
});
for (const failure of ['mismatch', 'gain', 'guard', 'abort'])
  it(`source lease and accumulator cleanup on ${failure}`, async () => {
    const realm = new Ledger(8 * 1024 * 1024),
      mix = owner(realm),
      src = owner(realm),
      abort = new AbortController();
    await expect(
      mixOwnership(
        mix,
        64,
        [
          async () => {
            const lease = plane(src, 64, 'source');
            if (failure === 'abort') abort.abort();
            return lease;
          },
        ],
        () => {
          if (failure !== 'guard') throw Error(failure);
        },
        () => {
          throw Error('guard');
        },
        abort.signal,
      ),
    ).rejects.toBeDefined();
    expect(src.bytes).toBe(0);
    expect(mix.bytes).toBe(0);
    expect(realm.bytes).toBe(0);
  });
it('late digest retains its copied backing after aborted wait, source release and owner close', async () => {
  const realm = new Ledger(8192),
    mix = owner(realm),
    out = owner(realm),
    input = plane(mix, 64, 'mix'),
    digest = deferred(),
    abort = new AbortController();
  const work = hashCopy(out, input, () => digest.promise);
  input.release();
  out.close();
  const wait = abortWait(work, abort.signal);
  abort.abort();
  await expect(wait).rejects.toBeDefined();
  expect(realm.bytes).toBe(256);
  digest.resolve();
  await work;
  expect(realm.bytes).toBe(0);
});
it('skipped scheduling gap releases mixed output while independent digest still drains', async () => {
  const realm = new Ledger(8192),
    mix = owner(realm),
    out = owner(realm),
    input = plane(mix, 64, 'mix'),
    digest = deferred();
  const work = hashCopy(out, input, () => digest.promise);
  try {
    /* controlled scheduling-gap continue: no native handoff */
  } finally {
    input.release();
  }
  expect(mix.bytes).toBe(0);
  expect(out.bytes).toBe(256);
  digest.resolve();
  await work;
  expect(realm.bytes).toBe(0);
});
it('playback retains through delayed ended and enforces cumulative output cap, not scheduling threshold', async () => {
  const realm = new Ledger(1024 * 1024),
    mix = owner(realm),
    out = owner(realm, 262144),
    close = deferred(),
    audio = new ScheduledAudio({ close: () => close.promise });
  const nodes = Array.from({ length: 16 }, () => source());
  for (const node of nodes) scheduleFixture(plane(mix, 4096, 'mix'), out, audio, ports(node));
  expect(out.bytes).toBe(262144);
  expect(mix.bytes).toBe(0);
  expect(() => scheduleFixture(plane(mix, 4096, 'mix'), out, audio, ports())).toThrow('admission');
  expect(mix.bytes).toBe(0);
  out.close();
  const drain = audio.close();
  expect(audio.close()).toBe(drain);
  await tick();
  expect(out.bytes).toBe(262144);
  ended(nodes[0]);
  ended(nodes[0]);
  expect(out.bytes).toBe(245760);
  close.resolve();
  await drain;
  expect(realm.bytes).toBe(0);
  expect(nodes.every((n) => n.buffer === null)).toBe(true);
});
it('rejected/unknown native close retains until ended, even if control state says closed', async () => {
  const realm = new Ledger(8192),
    mix = owner(realm),
    out = owner(realm),
    node = source();
  const context = {
      state: 'closed',
      close: async () => {
        throw Error('external close already pending');
      },
    },
    audio = new ScheduledAudio(context);
  scheduleFixture(plane(mix, 64, 'mix'), out, audio, ports(node));
  out.close();
  await expect(audio.close()).rejects.toThrow();
  expect(out.bytes).toBe(256);
  ended(node);
  expect(realm.bytes).toBe(0);
});
for (const failure of ['allocate', 'copy', 'source', 'connect', 'start'])
  it(`playback ${failure} failure preserves correct handoff ownership`, async () => {
    const realm = new Ledger(8192),
      mix = owner(realm),
      out = owner(realm),
      close = deferred(),
      audio = new ScheduledAudio({ close: () => close.promise }),
      node = source();
    expect(() => scheduleFixture(plane(mix, 64, 'mix'), out, audio, ports(node, failure))).toThrow(
      failure,
    );
    expect(mix.bytes).toBe(0);
    expect(out.bytes).toBe(['connect', 'start'].includes(failure) ? 256 : 0);
    const drain = audio.close();
    close.resolve();
    await drain;
    expect(realm.bytes).toBe(0);
  });
for (const order of ['add-first', 'consumer-first'])
  it(`export alias backing waits for both proofs: ${order}`, async () => {
    const realm = new Ledger(8192),
      mix = owner(realm),
      out = owner(realm),
      add = deferred(),
      done = deferred(),
      abort = new AbortController();
    let closed = 0,
      alias: Float32Array | undefined;
    const sample = {
      close() {
        closed++;
      },
    };
    const work = exportFixture(plane(mix, 64, 'mix'), out, {
      sample(data) {
        alias = new Float32Array(data.buffer, data.byteOffset, data.length);
        return sample;
      },
      add: () => add.promise,
      consumersDone: done.promise,
      digest: async () => {},
    });
    await tick();
    expect(alias!.buffer.byteLength).toBe(256);
    expect(mix.bytes).toBe(0);
    expect(out.bytes).toBe(256);
    sample.close();
    const wait = abortWait(work, abort.signal);
    abort.abort();
    await expect(wait).rejects.toBeDefined();
    out.close();
    if (order === 'add-first') add.resolve();
    else done.resolve();
    await tick();
    expect(out.bytes).toBe(256);
    if (order === 'add-first') done.resolve();
    else add.resolve();
    await work;
    expect(closed).toBe(2);
    expect(realm.bytes).toBe(0);
  });
for (const kind of ['reject', 'throw', 'close-throw'])
  it(`export ${kind} still requires consumer proof and drains independent copies`, async () => {
    const realm = new Ledger(8192),
      mix = owner(realm),
      out = owner(realm),
      done = deferred();
    const work = exportFixture(plane(mix, 64, 'mix'), out, {
      sample: () => ({
        close() {
          if (kind === 'close-throw') throw Error(kind);
        },
      }),
      add: () => {
        if (kind === 'throw') throw Error(kind);
        return kind === 'reject' ? Promise.reject(Error(kind)) : Promise.resolve();
      },
      consumersDone: done.promise,
      digest: async () => {},
    });
    const rejected = expect(work).rejects.toThrow('cleanup');
    await tick();
    expect(out.bytes).toBe(256);
    done.resolve();
    await rejected;
    expect(realm.bytes).toBe(0);
  });
it('failed consumer proof retains export backing after add settlement and sample close', async () => {
  const realm = new Ledger(8192),
    mix = owner(realm),
    out = owner(realm),
    done = deferred();
  let closed = 0;
  const work = exportFixture(plane(mix, 64, 'mix'), out, {
    sample: () => ({
      close() {
        closed++;
      },
    }),
    add: async () => {},
    consumersDone: done.promise,
    digest: async () => {},
  });
  const rejected = expect(work).rejects.toThrow('cleanup');
  done.reject(Error('unproven drain'));
  await rejected;
  out.close();
  expect(closed).toBe(1);
  expect(out.bytes).toBe(256);
  expect(realm.bytes).toBe(256); // Intentional conservative retention, not forced ledger reset.
});
for (const failure of ['digest', 'sample', 'copy-admission'])
  it(`export pre-handoff ${failure} cleans independent reservations`, async () => {
    const realm = new Ledger(8192),
      mix = owner(realm),
      out = owner(realm, failure === 'copy-admission' ? 256 : 65536),
      done = deferred();
    const invoke = () =>
      exportFixture(plane(mix, 64, 'mix'), out, {
        sample: () => {
          if (failure === 'sample') throw Error(failure);
          return { close() {} };
        },
        add: async () => {},
        consumersDone: done.promise,
        digest: async () => {
          if (failure === 'digest') throw Error(failure);
        },
      });
    if (failure === 'copy-admission') expect(invoke).toThrow('admission');
    else await expect(invoke()).rejects.toThrow('cleanup');
    expect(mix.bytes).toBe(0);
    expect(out.bytes).toBe(0);
    done.resolve();
  });

it('subarray/clone aliases retain the full backing reservation, not view length', async () => {
  const realm = new Ledger(65536),
    src = owner(realm),
    mix = owner(realm);
  const full = plane(src, 4096, 'source-full-backing');
  const alias = { ...full, planes: [full.planes[0].subarray(0, 64)] };
  const result = await mixOwnership(
    mix,
    64,
    [async () => alias],
    () => {
      expect(src.bytes).toBe(16384);
      expect(alias.planes[0].byteLength).toBe(256);
    },
    () => {},
    signal(),
  );
  expect(src.bytes).toBe(0);
  expect(mix.bytes).toBe(256);
  result.release();
  expect(realm.bytes).toBe(0);
});
it('transferred export backing remains charged through add and remote-consumer proof after wait abort', async () => {
  const realm = new Ledger(8192),
    mix = owner(realm),
    out = owner(realm),
    add = deferred(),
    done = deferred(),
    abort = new AbortController();
  let transferred: ArrayBuffer | undefined;
  const work = exportFixture(plane(mix, 64, 'mix'), out, {
    sample(data) {
      transferred = structuredClone(data.buffer, { transfer: [data.buffer] }) as ArrayBuffer;
      expect(data.buffer.byteLength).toBe(0);
      return { close() {} };
    },
    add: () => add.promise,
    consumersDone: done.promise,
    digest: async () => {},
  });
  await tick();
  expect(transferred!.byteLength).toBe(256);
  const wait = abortWait(work, abort.signal);
  abort.abort();
  await expect(wait).rejects.toBeDefined();
  add.resolve();
  await tick();
  expect(out.bytes).toBe(256);
  done.resolve();
  await work;
  expect(realm.bytes).toBe(0);
});
it('export and digest are two actual copies, and abort during digest does not release either early', async () => {
  const realm = new Ledger(8192),
    mix = owner(realm),
    out = owner(realm),
    digest = deferred(),
    done = deferred(),
    add = deferred(),
    abort = new AbortController();
  const work = exportFixture(plane(mix, 64, 'mix'), out, {
    sample: () => ({ close() {} }),
    add: () => add.promise,
    consumersDone: done.promise,
    digest: () => digest.promise,
  });
  expect(mix.bytes).toBe(0);
  expect(out.bytes).toBe(512);
  expect(out.realmPeak).toBe(768); // Mixed input + export backing + hash staging overlap.
  const wait = abortWait(work, abort.signal);
  abort.abort();
  await expect(wait).rejects.toBeDefined();
  out.close();
  expect(out.bytes).toBe(512);
  digest.resolve();
  await tick();
  expect(out.bytes).toBe(256);
  add.resolve();
  done.resolve();
  await work;
  expect(realm.bytes).toBe(0);
});
it('native cleanup failure does not skip other owners or release before close fulfillment', async () => {
  const realm = new Ledger(8192),
    mix = owner(realm),
    out = owner(realm),
    close = deferred(),
    audio = new ScheduledAudio({ close: () => close.promise });
  const bad = source(),
    good = source();
  bad.disconnect = () => {
    throw Error('disconnect');
  };
  scheduleFixture(plane(mix, 64, 'mix'), out, audio, ports(bad));
  scheduleFixture(plane(mix, 64, 'mix'), out, audio, ports(good));
  const rejected = expect(audio.close()).rejects.toThrow('cleanup');
  await tick();
  expect(out.bytes).toBe(512);
  close.resolve();
  await rejected;
  expect(realm.bytes).toBe(0);
  expect(good.buffer).toBe(null);
});
