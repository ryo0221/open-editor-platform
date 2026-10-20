/** Actual installed classes/queue; only custom encoder latency is controlled. */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Ledger, ARENA_BYTES, MEMORY_BYTES, FRAMES } from '../../src/pcm/kernel';
import { abortWait } from './consumer-ownership';
const library = await import(
  pathToFileURL(resolve(process.argv[2], 'dist/modules/src/index.js')).href
);
const {
  AudioSampleResource,
  AudioSample,
  AudioSampleSource,
  CustomAudioEncoder,
  registerEncoder,
  Output,
  Mp4OutputFormat,
  NullTarget,
} = library;
const deferred = () => {
  let resolve!: () => void, reject!: (e: Error) => void;
  const promise = new Promise<void>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const tick = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const bits = (x: Float32Array) => Array.from(new Uint32Array(x.buffer, x.byteOffset, x.length));
const pattern = () => new Float32Array([0, -0, 2 ** -149, -(2 ** -149), 0.25, -0.5, 1, -1]);
type Control = {
  init: ReturnType<typeof deferred>;
  gates: ReturnType<typeof deferred>[];
  observed: object[];
  entered: number;
  flushes: number;
  closes: number;
};
let current: Control;
class Delayed extends CustomAudioEncoder {
  static supports(codec: string) {
    return codec === 'aac';
  }
  readonly state = current;
  async init() {
    await this.state.init.promise;
  }
  async encode(sample: InstanceType<typeof AudioSample>) {
    const index = this.state.entered++;
    await this.state.gates[index].promise;
    const releaseCopy = charge(sample.numberOfFrames * sample.numberOfChannels * 4);
    try {
      const data = new Float32Array(sample.numberOfFrames * sample.numberOfChannels);
      sample.copyTo(data, { planeIndex: 0, format: 'f32' });
      this.state.observed.push({
        bits: bits(data),
        format: sample.format,
        rate: sample.sampleRate,
        frames: sample.numberOfFrames,
        channels: sample.numberOfChannels,
        timestamp: sample.timestamp,
        duration: sample.duration,
      });
    } finally {
      releaseCopy();
    }
  }
  async flush() {
    this.state.flushes++;
  }
  close() {
    this.state.closes++;
  }
}
registerEncoder(Delayed);
const realm = new Ledger(8 * 1024 * 1024);
let peak = 0;
function charge(bytes: number) {
  const release = realm.reserve(bytes);
  peak = Math.max(peak, realm.bytes);
  return release;
}
function input(timestamp = 0, bad = false) {
  const release = charge(32),
    done = deferred();
  let data: Float32Array;
  try {
    data = pattern();
  } catch (error) {
    release();
    throw error;
  }
  let closeCalls = 0,
    releases = 0,
    live = true;
  const finish = () => {
    if (live) {
      live = false;
      releases++;
      release();
      done.resolve();
    }
  };
  class Resource extends AudioSampleResource {
    getFormat() {
      return 'f32';
    }
    getSampleRate() {
      return bad ? 0 : 48000;
    }
    getNumberOfFrames() {
      return data.length;
    }
    getNumberOfChannels() {
      return 1;
    }
    getTimestamp() {
      return timestamp;
    }
    getDataPlane(index: number) {
      assert.equal(index, 0);
      return new Uint8Array(data.buffer);
    }
    close() {
      closeCalls++;
      finish();
    }
  }
  const resource = new Resource();
  let sample: InstanceType<typeof AudioSample>;
  try {
    sample = new AudioSample(resource);
  } catch (error) {
    finish();
    throw error;
  }
  return { sample, data, done: done.promise, stats: () => ({ closeCalls, releases }), resource };
}
async function job(count = 4, holdInit = false) {
  current = {
    init: deferred(),
    gates: Array.from({ length: count }, deferred),
    observed: [],
    entered: 0,
    flushes: 0,
    closes: 0,
  };
  if (!holdInit) current.init.resolve();
  const state = current;
  const source = new AudioSampleSource({ codec: 'aac', bitrate: 192000 });
  const output = new Output({ format: new Mp4OutputFormat(), target: new NullTarget() });
  output.addAudioTrack(source);
  await output.start();
  return { state, source, output };
}
const results: object[] = [];
const evidence = {
  scope: 'actual Mediabunny classes + delayed test encoder; not AAC worker/media acceptance',
  code: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
  engine: { node: process.version, v8: process.versions.v8 },
  package: 'mediabunny@1.61.3',
  inputsSha256: process.argv[4],
  results,
};
async function run(name: string, fn: () => Promise<void>) {
  peak = realm.bytes;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error('Fixture correctness deadline: unresolved per-input lifecycle')),
            5000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(realm.bytes, 0);
    results.push({ name, status: 'PASS', realmPeakBytes: peak });
  } catch (e) {
    results.push({ name, status: 'FAIL', error: String(e), remaining: realm.bytes });
    throw e;
  } finally {
    writeFileSync(
      resolve(process.argv[3], 'results.json'),
      JSON.stringify(evidence, null, 2) + '\n',
    );
  }
}
await run(
  'accepted managed-PCM envelope fits; additional concurrent cache pressure refuses without resetting owners',
  async () => {
    // Reservation model only; no codec heap is charged and no source/WASM is instantiated here.
    const module = 9976,
      read = FRAMES * 9 + 4096 * 4,
      backing = FRAMES * 2 * 4,
      output = 4096 * 4;
    const entries = [
      module,
      4 * (ARENA_BYTES + MEMORY_BYTES),
      read,
      backing,
      output,
      65536,
      262144,
      262144,
    ];
    assert.ok(ARENA_BYTES + MEMORY_BYTES + module + read + backing + output <= 2 * 1024 * 1024);
    const releases = entries.map(charge);
    try {
      assert.equal(realm.bytes, 6_964_984);
      releases.push(charge(ARENA_BYTES)); // One coexisting idle JS-backend owner.
      assert.equal(realm.bytes, 7_622_392);
      assert.throws(() => charge(1024 * 1024), /admission/); // Additional managed cache does not fit this overlap.
      assert.equal(realm.bytes, 7_622_392);
    } finally {
      releases.reverse().forEach((release) => release());
    }
  },
);
await run(
  'actual add settles before clone consumption; last alias closes once without flush',
  async () => {
    const j = await job(),
      p = input();
    let consumed = false;
    void p.done.then(() => {
      consumed = true;
    });
    await j.source.add(p.sample);
    assert.equal(j.state.entered, 1);
    assert.equal(j.state.observed.length, 0);
    p.sample.close();
    p.sample.close();
    await tick();
    assert.equal(consumed, false);
    assert.equal(realm.bytes, 32);
    j.state.gates[0].resolve();
    await p.done;
    assert.deepEqual(p.stats(), { closeCalls: 1, releases: 1 });
    assert.equal(j.state.flushes, 0);
    await j.output.cancel();
    assert.equal(j.state.closes, 1);
  },
);
await run('extra external alias prevents release after encoder clone completion', async () => {
  const j = await job(),
    p = input(),
    extra = p.sample.clone();
  await j.source.add(p.sample);
  p.sample.close();
  j.state.gates[0].resolve();
  await tick();
  assert.equal(j.state.observed.length, 1);
  assert.equal(p.stats().releases, 0);
  assert.equal(realm.bytes, 32);
  extra.close();
  extra.close();
  await p.done;
  assert.deepEqual(p.stats(), { closeCalls: 1, releases: 1 });
  await j.output.cancel();
});
await run(
  'cancel after early add settlement waits for delayed clone and preserves its backing',
  async () => {
    const j = await job(),
      p = input();
    await j.source.add(p.sample);
    p.sample.close();
    let canceled = false;
    const cancel = j.output.cancel().then(() => {
      canceled = true;
    });
    await tick();
    assert.equal(canceled, false);
    assert.equal(realm.bytes, 32);
    j.state.gates[0].resolve();
    await Promise.all([cancel, p.done]);
    assert.equal(p.stats().releases, 1);
    assert.equal(j.state.flushes, 0);
  },
);
await run(
  'resource bits/metadata match BufferSource through actual source and encoder clone',
  async () => {
    const j = await job(),
      p = input(0),
      releaseBuffer = charge(32),
      buffer = new AudioSample({
        data: pattern(),
        format: 'f32',
        numberOfChannels: 1,
        sampleRate: 48000,
        timestamp: 8 / 48000,
      });
    await j.source.add(p.sample);
    p.sample.close();
    await j.source.add(buffer);
    buffer.close();
    j.state.gates[0].resolve();
    j.state.gates[1].resolve();
    await p.done;
    await tick();
    const [a, b] = j.state.observed as { timestamp: number; [key: string]: unknown }[];
    assert.ok(a && b);
    assert.deepEqual({ ...a, timestamp: 0 }, { ...b, timestamp: 0 });
    assert.equal(a.timestamp, 0);
    assert.equal(b.timestamp, 8 / 48000);
    assert.equal(j.state.flushes, 0);
    await j.output.cancel();
    releaseBuffer();
  },
);
await run(
  'constructor rejection before handoff releases owner even after library ref increment',
  async () => {
    assert.throws(() => input(0, true), /getSampleRate/);
    assert.equal(realm.bytes, 0);
  },
);
await run('aborted wait during init cannot close caller before actual add settles', async () => {
  const j = await job(2, true),
    p = input(),
    abort = new AbortController();
  let settled = false;
  const add = j.source.add(p.sample);
  const owned = add.finally(() => {
    settled = true;
    p.sample.close();
  });
  const wait = abortWait(owned, abort.signal);
  abort.abort();
  await assert.rejects(wait);
  assert.equal(settled, false);
  assert.equal(p.sample._closed, false);
  assert.equal(realm.bytes, 32);
  j.state.init.resolve();
  await owned;
  assert.equal(p.sample._closed, true);
  assert.equal(p.stats().releases, 0);
  j.state.gates[0].resolve();
  await p.done;
  await j.output.cancel();
});
await run('actual cancellation during init drains actual add before caller close', async () => {
  const j = await job(1, true),
    p = input();
  const add = j.source.add(p.sample).finally(() => p.sample.close());
  await tick();
  const canceled = j.output.cancel();
  assert.equal(p.sample._closed, false);
  j.state.init.resolve();
  await Promise.allSettled([add, canceled]);
  await p.done;
  assert.equal(p.stats().releases, 1);
});
await run(
  'poisoned actual serializer closes queued aliases even when encode never executes',
  async () => {
    const j = await job(3),
      items = [input(0), input(8 / 48000), input(16 / 48000)];
    for (const p of items) {
      await j.source.add(p.sample);
      p.sample.close();
    }
    assert.equal(j.state.entered, 1);
    assert.equal(realm.bytes, 96);
    j.state.gates[0].reject(Error('injected encode failure'));
    await Promise.all(items.map((p) => p.done));
    assert.equal(j.state.entered, 1);
    for (const p of items) assert.deepEqual(p.stats(), { closeCalls: 1, releases: 1 });
    const rejected = input(24 / 48000);
    try {
      await assert.rejects(j.source.add(rejected.sample), /injected/);
    } finally {
      rejected.sample.close();
    }
    await rejected.done;
    await j.output.cancel();
    assert.equal(j.state.closes, 0); // Poisoned serializer skips custom close; not a worker-drain proof.
  },
);
await run('short inputs complete per-input ownership before final flush is requested', async () => {
  const j = await job(3);
  for (let k = 0; k < 3; k++) {
    const p = input((k * 8) / 48000);
    await j.source.add(p.sample);
    p.sample.close();
    j.state.gates[k].resolve();
    await p.done;
    assert.equal(j.state.flushes, 0);
    assert.equal(realm.bytes, 0);
  }
  await j.output.finalize();
  assert.equal(j.state.flushes, 1);
  assert.equal(j.state.closes, 1);
});
console.log(JSON.stringify(evidence, null, 2));
