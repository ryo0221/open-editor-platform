/** Private ABI and bounded backing-buffer accounting; not a public Core export. */
export const ROWS = 64,
  TAPS = 513,
  FRAMES = 32768;
export const ARENA_BYTES = 657408,
  MEMORY_BYTES = 786432,
  INPUT_BYTES = 656896;
export const OFFSETS = {
  source: 0,
  weights: 262144,
  addresses: 524800,
  totals: 656128,
  lengths: 656640,
  output: 656896,
} as const;
export function need(ok: unknown, message: string): asserts ok {
  if (!ok) throw Error(message);
}
/** Source/module backings must have immutable extent and exclusive ordinary ArrayBuffer kind. */
export function fixedBacking(buffer: unknown): asserts buffer is ArrayBuffer {
  need(
    buffer instanceof ArrayBuffer &&
      !Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get?.call(buffer),
    'Fixed backing ArrayBuffer required',
  );
}
export class Ledger {
  private used = 0;
  constructor(readonly limit: number) {
    need(Number.isSafeInteger(limit) && limit > 0, 'Ledger limit');
  }
  reserve(bytes: number) {
    need(
      Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= this.limit - this.used,
      'PCM memory admission',
    );
    this.used += bytes;
    let owned = true;
    return () => {
      if (owned) {
        owned = false;
        this.used -= bytes;
      }
    };
  }
  get bytes() {
    return this.used;
  }
}
export const realmLedger = new Ledger(8 * 1024 * 1024);
export class Tile {
  readonly buffer = new ArrayBuffer(ARENA_BYTES);
  readonly source = new Float32Array(this.buffer, OFFSETS.source, FRAMES * 2);
  readonly weights = new Float64Array(this.buffer, OFFSETS.weights, ROWS * TAPS);
  readonly addresses = new Uint32Array(this.buffer, OFFSETS.addresses, ROWS * TAPS);
  readonly totals = new Float64Array(this.buffer, OFFSETS.totals, ROWS);
  readonly lengths = new Uint32Array(this.buffer, OFFSETS.lengths, ROWS);
  readonly output = new Float32Array(this.buffer, OFFSETS.output, ROWS * 2);
}
export function validate(tile: Tile, rows: number, frames: number, channels: number) {
  need(
    Number.isInteger(rows) &&
      rows > 0 &&
      rows <= ROWS &&
      Number.isInteger(frames) &&
      frames > 0 &&
      frames <= FRAMES &&
      Number.isInteger(channels) &&
      channels > 0 &&
      channels <= 2,
    'Kernel shape',
  );
  for (let r = 0; r < rows; r++) {
    const length = tile.lengths[r];
    need(
      length > 0 &&
        length <= TAPS &&
        Number.isFinite(tile.totals[r]) &&
        Math.abs(tile.totals[r]) > 1e-9,
      'Degenerate filter',
    );
    for (let t = 0; t < length; t++) {
      const i = r * TAPS + t,
        address = tile.addresses[i];
      need(Number.isFinite(tile.weights[i]), 'Nonfinite weight');
      need(address < frames, 'Kernel address');
      for (let ch = 0; ch < channels; ch++)
        need(Number.isFinite(tile.source[ch * FRAMES + address]), 'Nonfinite PCM');
    }
  }
}
export function jsKernel(tile: Tile, rows: number, frames: number, channels: number) {
  validate(tile, rows, frames, channels);
  for (let r = 0; r < rows; r++)
    for (let ch = 0; ch < channels; ch++) {
      let sum = 0;
      for (let t = 0; t < tile.lengths[r]; t++) {
        const i = r * TAPS + t;
        sum += tile.source[ch * FRAMES + tile.addresses[i]] * tile.weights[i];
      }
      tile.output[ch * ROWS + r] = sum / tile.totals[r];
    }
}
/** Own a fixed module input before its factory constructs the backing buffer.
 * Taking transfers release authority to prepareModule; caller disposal then cannot
 * free the reservation under hashing, compilation or a live module/session.
 */
export class ModuleInput {
  private value: Uint8Array<ArrayBuffer> | undefined;
  private transferred = false;
  private releases: (() => void)[] = [];
  private charged = 0;
  private released = false;
  private constructor(readonly realm: Ledger) {}
  static allocate(length: number, make: () => Uint8Array<ArrayBuffer>, realm: Ledger) {
    need(Number.isSafeInteger(length) && length > 0 && length <= 65536, 'Module bytes budget');
    const owner = new ModuleInput(realm);
    try {
      owner.add(length);
      owner.value = make();
      fixedBacking(owner.value.buffer);
      need(
        owner.value.byteLength === length && owner.value.buffer.byteLength === length,
        'Module input extent',
      );
      return owner;
    } catch (error) {
      owner.dispose();
      throw error;
    }
  }
  get chargedBytes() {
    return this.charged;
  }
  get available() {
    return !!this.value && !this.transferred;
  }
  private add(bytes: number) {
    need(!this.released, 'Module input released');
    const release = this.realm.reserve(bytes);
    this.releases.push(release);
    this.charged += bytes;
  }
  private release() {
    if (this.released) return;
    this.released = true;
    for (const release of this.releases.splice(0)) release();
    this.charged = 0;
  }
  take(realm: Ledger) {
    need(this.available && realm === this.realm, 'Module input ownership');
    const bytes = this.value!;
    this.value = undefined;
    this.transferred = true;
    return { bytes, add: (count: number) => this.add(count), release: () => this.release() };
  }
  dispose() {
    if (!this.transferred) {
      this.value = undefined;
      this.release();
    }
  }
}
export interface ModulePin {
  module: WebAssembly.Module;
  sha256: string;
  byteLength: number;
  chargedBytes: number;
  realm: Ledger;
  retain(): () => void;
  dispose(): void;
}
/** Trusted local build input only. Verify the exact expected hash before compiling. */
export async function prepareModule(
  input: Uint8Array<ArrayBuffer> | ModuleInput,
  expected: string,
  realm: Ledger = realmLedger,
): Promise<ModulePin> {
  const owned = input instanceof ModuleInput ? input.take(realm) : undefined;
  const bytes = owned?.bytes ?? (input as Uint8Array<ArrayBuffer>);
  let release = owned?.release ?? (() => {});
  try {
    need(
      bytes.byteLength > 0 &&
        bytes.byteLength <= 65536 &&
        bytes.buffer.byteLength === bytes.byteLength,
      'Module bytes budget',
    );
    fixedBacking(bytes.buffer);
    need(/^[a-f0-9]{64}$/.test(expected), 'Module SHA');
    const chargedBytes = bytes.byteLength * 2 + 32;
    if (owned) owned.add(bytes.byteLength + 32);
    else release = realm.reserve(chargedBytes);
    const snapshot = bytes.slice();
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', snapshot)),
      (x) => x.toString(16).padStart(2, '0'),
    ).join('');
    need(digest === expected, 'Module hash mismatch');
    // Require one fixed, nonshared memory with equal min/max. No imported memory or credentials.
    let at = 8,
      found = false;
    const leb = () => {
      let n = 0,
        s = 0,
        b: number;
      do {
        need(at < snapshot.length && s < 35, 'Module LEB');
        b = snapshot[at++];
        n += (b & 127) * 2 ** s;
        s += 7;
      } while (b & 128);
      return n;
    };
    while (at < snapshot.length) {
      const id = snapshot[at++],
        length = leb(),
        end = at + length;
      need(end <= snapshot.length, 'Module section');
      if (id === 5) {
        need(
          leb() === 1 && leb() === 1 && leb() === 12 && leb() === 12 && at === end,
          'Module memory bounds',
        );
        found = true;
      }
      at = end;
    }
    need(found, 'Module memory missing');
    const module = await WebAssembly.compile(snapshot);
    need(WebAssembly.Module.imports(module).length === 0, 'Module imports');
    need(
      WebAssembly.Module.exports(module)
        .map((x) => x.name)
        .sort()
        .join(',') === '__data_end,__heap_base,abi,arena,arena_bytes,kernel,memory,written',
      'Module exports',
    );
    let references = 0,
      disposed = false;
    return Object.freeze({
      module,
      sha256: digest,
      byteLength: bytes.length,
      chargedBytes,
      realm,
      retain() {
        need(!disposed, 'Module disposed');
        references++;
        let owned = true;
        return () => {
          if (owned) {
            owned = false;
            references--;
            if (disposed && references === 0) release();
          }
        };
      },
      dispose() {
        disposed = true;
        if (references === 0) release();
      },
    });
  } catch (error) {
    release();
    throw error;
  }
}
interface Exports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  abi(): number;
  arena(): number;
  arena_bytes(): number;
  written(): number;
  kernel(rows: number, frames: number, channels: number): number;
}
export class WasmKernel {
  private readonly exports: Exports;
  private readonly buffer: ArrayBuffer;
  private readonly base: number;
  invocations = 0;
  completions = 0;
  constructor(readonly pin: ModulePin) {
    this.exports = new WebAssembly.Instance(pin.module).exports as Exports;
    const e = this.exports;
    this.buffer = e.memory.buffer;
    this.base = e.arena();
    need(
      e.abi() === 1 &&
        e.arena_bytes() === ARENA_BYTES &&
        this.buffer.byteLength === MEMORY_BYTES &&
        Number.isInteger(this.base) &&
        this.base >= 0 &&
        this.base % 8 === 0 &&
        this.base + ARENA_BYTES <= this.buffer.byteLength,
      'Module layout',
    );
  }
  run(tile: Tile, rows: number, frames: number, channels: number) {
    validate(tile, rows, frames, channels);
    const e = this.exports;
    need(
      e.memory.buffer === this.buffer && this.buffer.byteLength === MEMORY_BYTES,
      'Module memory changed',
    );
    new Uint8Array(this.buffer, this.base, INPUT_BYTES).set(
      new Uint8Array(tile.buffer, 0, INPUT_BYTES),
    );
    this.invocations++;
    const status = e.kernel(rows, frames, channels);
    need(status === 0 && e.written() === rows * channels, `WASM kernel failure ${status}`);
    this.completions++;
    tile.output.set(new Float32Array(this.buffer, this.base + OFFSETS.output, ROWS * 2));
  }
}
