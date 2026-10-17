import { trapBatches } from './faults';
/** Manual forced-execution suite, shared verbatim by Node and Chromium. */
import { time } from '@editor-platform/video-core';
import { renderPcm as oracle } from './frozen/render';
import { PcmBackend } from './adapter';
import {
  Tile,
  ROWS,
  TAPS,
  FRAMES,
  INPUT_BYTES,
  OFFSETS,
  Ledger,
  WasmKernel,
  jsKernel,
  prepareModule,
  need,
} from './kernel';
import { prepare, type Mapping, type PcmWindow, type SourceBoundary } from './prepare';
const signal = () => new AbortController().signal;
const bits = (a: Float32Array) => new Uint32Array(a.buffer, a.byteOffset, a.length);
function same(a: Float32Array, b: Float32Array) {
  need(a.length === b.length, 'Length mismatch');
  const x = bits(a),
    y = bits(b);
  for (let i = 0; i < x.length; i++)
    need(x[i] === y[i], `Bit mismatch ${i}: ${x[i].toString(16)} != ${y[i].toString(16)}`);
}
async function hash(a: ArrayBuffer) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', a)), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('');
}
async function inputHashes(
  m: Mapping,
  first: number,
  end: number,
  rate: number,
  pcm: PcmWindow,
  boundary?: SourceBoundary,
) {
  const tile = new Tile(),
    plan = prepare(m, first, end, rate, pcm, boundary),
    rows = [];
  pcm.planes.forEach((p, ch) => tile.source.set(p, ch * FRAMES));
  for (let k = first; k < end; k += ROWS) {
    const count = Math.min(ROWS, end - k);
    for (let r = 0; r < count; r++) plan.row(tile, r, k + r);
    rows.push({ first: k, rows: count, sha256: await hash(tile.buffer.slice(0, INPUT_BYTES)) });
  }
  return rows;
}
async function verifyJs(
  realm: Ledger,
  m: Mapping,
  first: number,
  end: number,
  pcm: PcmWindow,
  expected: PcmWindow,
  boundary?: SourceBoundary,
) {
  const backend = new PcmBackend({ mode: 'js', realm, yieldTask: async () => {} });
  try {
    const result = await backend.render(m, first, end, 48000, pcm, signal(), boundary);
    try {
      for (let ch = 0; ch < expected.planes.length; ch++)
        same(result.pcm.planes[ch], expected.planes[ch]);
    } finally {
      result.release();
    }
    need(
      backend.diagnostics.backend === 'js' && !backend.diagnostics.fallback,
      'Explicit JS pairing',
    );
  } finally {
    await backend.close();
  }
}
export async function suite(bytes: Uint8Array<ArrayBuffer>, sha: string) {
  const realm = new Ledger(8 * 1024 * 1024),
    pin = await prepareModule(bytes, sha, realm);
  const records: unknown[] = [];
  // Raw kernel comparisons intentionally precede and do not use the product finite/clipping guard.
  const knownBits: Record<string, number> = {
    'positive-zero': 0,
    'negative-zero': 0x80000000,
    'source-negative-zero': 0,
    subnormal: 1,
    'negative-underflow': 0x80000000,
    'ties-even': 0x3f800000,
    'above-half': 0x3f800001,
    'finite-f32-overflow': 0x7f800000,
    'negative-f32-overflow': 0xff800000,
    'ordered-cancellation': 0x3f800000,
    'ordered-f64': 0,
    'unfused-product': 0,
  };
  for (const [name, values, weights, total] of [
    ['positive-zero', [0], [1], 1],
    ['negative-zero', [0], [1], -1],
    ['source-negative-zero', [-0], [1], 1],
    ['subnormal', [2 ** -149], [1], 1],
    ['negative-underflow', [-(2 ** -149)], [0.5], 1],
    ['ties-even', [1, 2 ** -24], [1, 1], 1],
    ['above-half', [1, 2 ** -24, 2 ** -52], [1, 1, 1], 1],
    ['finite-f32-overflow', [Math.fround(3.4028234663852886e38)], [2], 1],
    ['negative-f32-overflow', [-Math.fround(3.4028234663852886e38)], [2], 1],
    ['ordered-cancellation', [2 ** 24, 1, -(2 ** 24)], [1, 1, 1], 1],
    ['ordered-f64', [2 ** 53, 1, -(2 ** 53)], [1, 1, 1], 1],
    ['unfused-product', [-1, 1 + 2 ** -23], [1, 1 - 2 ** -23 + 2 ** -46], 1],
  ] as [string, number[], number[], number][]) {
    const t = new Tile();
    t.source.set(values);
    t.weights.set(weights);
    t.addresses.set(values.map((_, i) => i));
    t.lengths[0] = values.length;
    t.totals[0] = total;
    const inputHash = await hash(t.buffer.slice(0, INPUT_BYTES));
    jsKernel(t, 1, values.length, 1);
    const expected = t.output.slice(0, 1);
    need(bits(expected)[0] === knownBits[name], 'Independent IEEE expected bits: ' + name);
    const wasm = new WasmKernel(pin);
    wasm.run(t, 1, values.length, 1);
    same(expected, t.output.subarray(0, 1));
    need(wasm.invocations === 1 && wasm.completions === 1, 'Forced execution missing');
    records.push({
      name,
      kind: 'raw',
      inputHash,
      outputBits: [...bits(expected)],
      backend: 'wasm',
      invocations: 1,
      completions: 1,
    });
  }
  // Direct ABI probes bypass the JS guard to exercise Rust validation and initialized-length semantics.
  const raw = new WebAssembly.Instance(pin.module).exports as {
    memory: WebAssembly.Memory;
    arena(): number;
    kernel(r: number, f: number, c: number): number;
    written(): number;
  };
  const base = raw.arena();
  const lengths = new Uint32Array(raw.memory.buffer, base + OFFSETS.lengths, ROWS),
    totals = new Float64Array(raw.memory.buffer, base + OFFSETS.totals, ROWS),
    addresses = new Uint32Array(raw.memory.buffer, base + OFFSETS.addresses, ROWS * TAPS),
    weights = new Float64Array(raw.memory.buffer, base + OFFSETS.weights, ROWS * TAPS),
    source = new Float32Array(raw.memory.buffer, base, FRAMES * 2);
  lengths[0] = 1;
  totals[0] = 1;
  weights[0] = 1;
  need(raw.kernel(1, 1, 1) === 0 && raw.written() === 1, 'ABI success');
  for (const [r, f, c] of [
    [0, 1, 1],
    [65, 1, 1],
    [1, 32769, 1],
    [1, 1, 3],
    [-1, 1, 1],
  ])
    need(raw.kernel(r, f, c) === 1 && raw.written() === 0, 'ABI shape');
  lengths[0] = 514;
  need(raw.kernel(1, 1, 1) === 2 && raw.written() === 0, 'ABI lengths');
  lengths[0] = 1;
  totals[0] = 1e-10;
  need(raw.kernel(1, 1, 1) === 2, 'ABI total');
  totals[0] = 1;
  weights[0] = NaN;
  need(raw.kernel(1, 1, 1) === 2, 'ABI weight');
  weights[0] = 1;
  addresses[0] = 1;
  need(raw.kernel(1, 1, 1) === 3, 'ABI address');
  addresses[0] = 0;
  source[0] = Infinity;
  need(raw.kernel(1, 1, 1) === 4 && raw.written() === 0, 'ABI PCM');
  let refused = false;
  try {
    raw.memory.grow(1);
  } catch {
    refused = true;
  }
  need(refused && raw.memory.buffer.byteLength === 786432, 'Growth ceiling');
  records.push({ name: 'rust-validation-and-no-growth', backend: 'wasm' });
  for (const sourceRate of [44100, 48000])
    for (const channels of [1, 2])
      for (const mode of ['require-support', 'edge-hold-v0', 'valid-taps-v0'] as const) {
        const m: Mapping = {
          start: time(0),
          end: time(4096, 48000),
          sourceStart: time(mode === 'require-support' ? 512 : 0, sourceRate),
          speed: time(1),
        };
        const pcm: PcmWindow = {
          first: 0,
          rate: sourceRate,
          planes: Array.from({ length: channels }, (_, ch) =>
            Float32Array.from({ length: 8192 }, (_, i) =>
              i === 100 ? 0.8 : Math.sin(i * (ch + 1) * 0.19) * 0.2,
            ),
          ),
        };
        const boundary: SourceBoundary | undefined =
          mode === 'require-support'
            ? undefined
            : { mode, valid: { start: time(0), end: time(8192, sourceRate) } };
        const expected = oracle(m, 0, 4096, 48000, pcm, signal(), boundary);
        const js = new PcmBackend({ mode: 'js', realm, yieldTask: async () => {} }),
          wasm = new PcmBackend({ mode: 'wasm', pin, realm, yieldTask: async () => {} });
        try {
          const coefficients = await inputHashes(m, 0, 4096, 48000, pcm, boundary);
          for (const size of [1, 64, 127, 4096]) {
            const result = await wasm.render(m, 0, size, 48000, pcm, signal(), boundary),
              ref = await js.render(m, 0, size, 48000, pcm, signal(), boundary);
            for (let ch = 0; ch < channels; ch++) {
              same(result.pcm.planes[ch], expected.planes[ch].subarray(0, size));
              same(ref.pcm.planes[ch], result.pcm.planes[ch]);
            }
            result.release();
            ref.release();
          }
          // Deterministic irregular chunking, then out-of-order seeks/cuts on the unchanged global grid.
          let first = 0,
            seed = 37;
          const ranges: [number, number][] = [];
          while (first < 4096) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            const end = Math.min(4096, first + 1 + (seed % 211));
            ranges.push([first, end]);
            first = end;
          }
          for (const [lo, hi] of ranges.reverse()) {
            const out = await wasm.render(m, lo, hi, 48000, pcm, signal(), boundary);
            for (let ch = 0; ch < channels; ch++)
              same(out.pcm.planes[ch], expected.planes[ch].subarray(lo, hi));
            out.release();
          }
          need(
            wasm.diagnostics.backend === 'wasm' &&
              !wasm.diagnostics.fallback &&
              wasm.diagnostics.invocations === wasm.diagnostics.completions &&
              wasm.diagnostics.completions > 0,
            'Forced WASM evidence',
          );
          records.push({
            name: `whole-${sourceRate}-${channels}-${mode}`,
            coefficients,
            outputHashes: await Promise.all(
              expected.planes.map((p) => hash(p.buffer as ArrayBuffer)),
            ),
            ...wasm.diagnostics,
          });
        } finally {
          await js.close();
          await wasm.close();
        }
      }
  // Physical endpoint lengths, DC/silence/impulse/extreme finite overflow, fractional origins and cuts.
  for (const count of [1, 2, 17, 127])
    for (const mode of ['edge-hold-v0', 'valid-taps-v0'] as const)
      for (const amplitude of [0, 0.25, Math.fround(3.4028234663852886e38)]) {
        const m = {
          start: time(1, 96000),
          end: time(1, 96000),
          sourceStart: time(0),
          speed: time(1),
        };
        m.end = time(2 * count + 1, 96000);
        const pcm = {
          first: 0,
          rate: 48000,
          planes: [
            Float32Array.from({ length: count }, (_, i) => (i === count - 1 ? amplitude : 0)),
          ],
        };
        const boundary = { mode, valid: { start: time(0), end: time(count, 48000) } };
        const expected = oracle(m, 1, count + 1, 48000, pcm, signal(), boundary);
        await verifyJs(realm, m, 1, count + 1, pcm, expected, boundary);
        const wasm = new PcmBackend({ mode: 'wasm', pin, realm, yieldTask: async () => {} });
        try {
          const out = await wasm.render(m, 1, count + 1, 48000, pcm, signal(), boundary);
          same(out.pcm.planes[0], expected.planes[0]);
          out.release();
          records.push({
            name: `endpoint-${count}-${mode}-${amplitude}`,
            coefficients: await inputHashes(m, 1, count + 1, 48000, pcm, boundary),
            outputBits: [...bits(expected.planes[0])],
            ...wasm.diagnostics,
          });
        } finally {
          await wasm.close();
        }
      }
  // Negative source origin is supported by raw require-support mode and preserves exact rational phase.
  const m = { start: time(0), end: time(127, 48000), sourceStart: time(-1, 96000), speed: time(1) };
  const pcm = {
    first: -256,
    rate: 48000,
    planes: [Float32Array.from({ length: 1024 }, (_, i) => Math.sin(i) * 0.1)],
  };
  const wasm = new PcmBackend({ mode: 'wasm', pin, realm, yieldTask: async () => {} });
  const out = await wasm.render(m, 0, 127, 48000, pcm, signal());
  const negativeExpected = oracle(m, 0, 127, 48000, pcm, signal());
  same(out.pcm.planes[0], negativeExpected.planes[0]);
  await verifyJs(realm, m, 0, 127, pcm, negativeExpected);
  out.release();
  await wasm.close();
  // Invalid/missing support follows the independent old renderer's failure, with no fallback.
  for (const input of [
    { ...pcm, first: 1000 },
    { ...pcm, planes: [new Float32Array(1024).fill(NaN)] },
  ]) {
    let oldFailed = false;
    try {
      oracle(m, 0, 127, 48000, input, signal());
    } catch {
      oldFailed = true;
    }
    need(oldFailed, 'Oracle must reject');
    const b = new PcmBackend({ mode: 'wasm', pin, realm, yieldTask: async () => {} });
    let failed = false;
    try {
      await b.render(m, 0, 127, 48000, input, signal());
    } catch {
      failed = true;
    }
    need(failed && !b.diagnostics.fallback, 'Error fallback prohibited');
    await b.close();
  }
  // Forced WASM cancellation while a completed tile is waiting to publish; no preemption claim.
  for (const count of [1, 127]) {
    let resume!: () => void, reached!: () => void;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const b = new PcmBackend({
      mode: 'wasm',
      pin,
      realm,
      yieldTask: () => {
        reached();
        return new Promise((resolve) => {
          resume = resolve;
        });
      },
    });
    const c = new AbortController();
    const pending = b.render(m, 0, count, 48000, pcm, c.signal);
    const rejected = pending.then(
      () => false,
      () => true,
    );
    await started;
    c.abort();
    const close = b.close();
    need(b.close() === close, 'Idempotent close');
    need(b.ownedBytes > 0, 'Premature release');
    resume();
    need(await rejected, 'Cancelled block published');
    await close;
    need(b.ownedBytes === 0, 'Cancelled owner leaked');
    records.push({ name: `forced-cancel-${count}`, ...b.diagnostics });
  }
  // A real runtime trap after a successful one-row self-test must fail and dispose, never fallback.
  const trapBytes = trapBatches(bytes),
    trapSha = await hash(trapBytes.buffer);
  const trapPin = await prepareModule(trapBytes, trapSha, realm);
  const trapped = new PcmBackend({ mode: 'wasm', pin: trapPin, realm, yieldTask: async () => {} });
  let trappedError = false;
  try {
    await trapped.render(m, 0, 127, 48000, pcm, signal());
  } catch (e) {
    trappedError = e instanceof WebAssembly.RuntimeError;
  }
  need(
    trappedError &&
      !trapped.diagnostics.fallback &&
      trapped.diagnostics.invocations === 1 &&
      trapped.diagnostics.completions === 0,
    'Trap must fail without fallback',
  );
  await trapped.close();
  trapPin.dispose();
  records.push({ name: 'runtime-trap', testMutantSha256: trapSha, ...trapped.diagnostics });
  // Exact rational split at 29.97 fps, fractional source phase, large global timeline and rate extremes.
  for (const speed of [time(1, 4), time(4)]) {
    const start = time(1001, 30000),
      end = time(1001 + 300, 30000);
    const map = { start, end, sourceStart: time(1025, 96000), speed };
    const first = Math.ceil((start.value / start.timescale) * 48000);
    const b = new PcmBackend({ mode: 'wasm', pin, realm, yieldTask: async () => {} });
    const input = {
      first: 0,
      rate: 44100,
      planes: [Float32Array.from({ length: 8192 }, (_, i) => Math.cos(i) * 0.1)],
    };
    const result = await b.render(map, first, first + 127, 48000, input, signal());
    same(result.pcm.planes[0], oracle(map, first, first + 127, 48000, input, signal()).planes[0]);
    result.release();
    await b.close();
    await verifyJs(
      realm,
      map,
      first,
      first + 127,
      input,
      oracle(map, first, first + 127, 48000, input, signal()),
    );
    records.push({
      name: `fractional-cut-speed-${speed.value}-${speed.timescale}`,
      ...b.diagnostics,
    });
  }
  const large = {
    start: time(1000000000),
    end: time(1000000000 * 48000 + 127, 48000),
    sourceStart: time(512, 48000),
    speed: time(1),
  };
  const largePcm = {
    first: 0,
    rate: 48000,
    planes: [Float32Array.from({ length: 1024 }, (_, i) => Math.sin(i) * 0.1)],
  };
  const largeBackend = new PcmBackend({ mode: 'wasm', pin, realm, yieldTask: async () => {} });
  const largeOut = await largeBackend.render(
    large,
    48000000000000,
    48000000000127,
    48000,
    largePcm,
    signal(),
  );
  same(
    largeOut.pcm.planes[0],
    oracle(large, 48000000000000, 48000000000127, 48000, largePcm, signal()).planes[0],
  );
  largeOut.release();
  await largeBackend.close();
  await verifyJs(
    realm,
    large,
    48000000000000,
    48000000000127,
    largePcm,
    oracle(large, 48000000000000, 48000000000127, 48000, largePcm, signal()),
  );
  records.push({ name: 'large-global-clock', ...largeBackend.diagnostics });
  // Module reservation follows outstanding instances even if its creator disposes first.
  const moduleRealm = new Ledger(4 * 1024 * 1024),
    ownedPin = await prepareModule(bytes, sha, moduleRealm);
  const moduleBackend = new PcmBackend({ mode: 'wasm', pin: ownedPin, realm: moduleRealm });
  const held = moduleRealm.bytes;
  ownedPin.dispose();
  need(moduleRealm.bytes === held, 'Module released while instance alive');
  await moduleBackend.close();
  need(moduleRealm.bytes === 0, 'Module disposal leak');
  records.push({ name: 'module-dispose-drain', backend: 'wasm' });
  pin.dispose();
  need(realm.bytes === 0, 'Realm reservation leak');
  return { wasmSha256: sha, records, realmBytesAfterClose: realm.bytes };
}
