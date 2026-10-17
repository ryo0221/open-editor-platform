import { prepare, type Mapping, type PcmWindow, type SourceBoundary } from './prepare';
import {
  ARENA_BYTES,
  MEMORY_BYTES,
  FRAMES,
  ROWS,
  Ledger,
  Tile,
  WasmKernel,
  jsKernel,
  need,
  type ModulePin,
  realmLedger,
} from './kernel';
export const SESSION_BYTES = 2 * 1024 * 1024;
export { realmLedger } from './kernel';
export type Mode = 'js' | 'wasm' | 'auto';
export interface OwnedBlock {
  pcm: PcmWindow;
  release(): void;
}
/** Private decoded-window adapter. The existing decoder/source/session owner stays authoritative.
 * A returned block is an explicit lease: release only after the consumer drops all plane references.
 * Close drains work but cannot revoke a consumer's retained output lease.
 */
export class PcmBackend {
  private tile: Tile | undefined;
  private wasm: WasmKernel | undefined;
  private readonly local: Ledger;
  private readonly releaseBase: () => void;
  private active: Promise<OwnedBlock> | undefined;
  private closed = false;
  private drained = false;
  private generation = 0;
  private closePromise: Promise<void> | undefined;
  readonly diagnostics: {
    backend: 'js' | 'wasm';
    fallback: boolean;
    reason?: string;
    wasmSha256?: string;
    invocations: number;
    completions: number;
    selfTests: number;
  };
  constructor(options: {
    mode: Mode;
    pin?: ModulePin;
    realm?: Ledger;
    sessionBytes?: number;
    yieldTask?: () => Promise<void>;
  }) {
    need(['js', 'wasm', 'auto'].includes(options.mode), 'Backend mode');
    const limit = options.sessionBytes ?? SESSION_BYTES;
    need(limit <= SESSION_BYTES, 'Session ceiling');
    this.local = new Ledger(limit);
    this.realm = options.realm ?? options.pin?.realm ?? realmLedger;
    need(!options.pin || options.pin.realm === this.realm, 'Module realm mismatch');
    this.yieldTask = options.yieldTask ?? (() => new Promise((resolve) => setTimeout(resolve, 0)));
    const wantsWasm = options.mode !== 'js' && options.pin !== undefined;
    // Binary loading/compile is separately admitted by prepareModule. Module code is realm-owned.
    const base = this.reserve(ARENA_BYTES + (wantsWasm ? MEMORY_BYTES : 0));
    let moduleRelease: (() => void) | undefined, moduleLocal: (() => void) | undefined;
    try {
      if (wantsWasm) {
        moduleLocal = this.local.reserve(options.pin!.chargedBytes);
        moduleRelease = options.pin!.retain();
      }
    } catch (error) {
      moduleLocal?.();
      base();
      throw error;
    }
    this.releaseBase = () => {
      base();
      moduleLocal?.();
      moduleRelease?.();
    };
    this.diagnostics = {
      backend: 'js',
      fallback: false,
      invocations: 0,
      completions: 0,
      selfTests: 0,
    };
    try {
      this.tile = new Tile();
      if (options.mode !== 'js') {
        try {
          need(options.pin, 'WASM unavailable');
          this.wasm = new WasmKernel(options.pin);
          const t = this.tile;
          t.source[0] = 0;
          t.weights[0] = 1;
          t.addresses[0] = 0;
          t.lengths[0] = 1;
          t.totals[0] = -1;
          this.wasm.run(t, 1, 1, 1);
          need(Object.is(t.output[0], -0), 'WASM self-test');
          this.diagnostics.backend = 'wasm';
          this.diagnostics.wasmSha256 = options.pin.sha256;
          this.diagnostics.selfTests = 1;
        } catch (error) {
          this.wasm = undefined;
          if (options.mode === 'wasm') throw error;
          this.diagnostics.fallback = true;
          this.diagnostics.reason = String(error);
        }
      }
    } catch (error) {
      this.tile = undefined;
      this.wasm = undefined;
      this.releaseBase();
      throw error;
    }
  }
  private readonly realm: Ledger;
  private readonly yieldTask: () => Promise<void>;
  private reserve(bytes: number) {
    const local = this.local.reserve(bytes);
    try {
      const realm = this.realm.reserve(bytes);
      return () => {
        local();
        realm();
      };
    } catch (error) {
      local();
      throw error;
    }
  }
  get ownedBytes() {
    return this.local.bytes;
  }
  render(
    m: Mapping,
    first: number,
    end: number,
    outputRate: number,
    pcm: PcmWindow,
    signal: AbortSignal,
    boundary?: SourceBoundary,
  ): Promise<OwnedBlock> {
    need(!this.closed, 'Backend closed');
    need(!this.active, 'Backend busy; drain before replacement');
    signal.throwIfAborted();
    const generation = ++this.generation;
    // No await before copying bounded native scalar metadata and source planes.
    const mapping: Mapping = {
      start: { ...m.start },
      end: { ...m.end },
      sourceStart: { ...m.sourceStart },
      speed: { ...m.speed },
    };
    const edge = boundary
      ? {
          mode: boundary.mode,
          valid: { start: { ...boundary.valid.start }, end: { ...boundary.valid.end } },
        }
      : undefined;
    const snapshot = { first: pcm.first, rate: pcm.rate, planes: pcm.planes.slice() };
    const job = prepare(mapping, first, end, outputRate, snapshot, edge);
    const buffers = new Set(snapshot.planes.map((p) => p.buffer));
    let borrowed = 0;
    for (const buffer of buffers) {
      need(buffer.byteLength <= FRAMES * 2 * 4, 'Source backing buffer budget');
      borrowed += buffer.byteLength;
    }
    const releaseInput = this.reserve(borrowed);
    let releaseOutput: (() => void) | undefined;
    try {
      releaseOutput = this.reserve((end - first) * job.channels * 4);
    } catch (error) {
      releaseInput();
      throw error;
    }
    const outputRelease = releaseOutput;
    const tile = this.tile!;
    let output: Float32Array[];
    try {
      output = Array.from({ length: job.channels }, () => new Float32Array(end - first));
      snapshot.planes.forEach((p, ch) => tile.source.set(p, ch * FRAMES));
    } catch (error) {
      releaseInput();
      outputRelease();
      throw error;
    }
    const check = () => {
      signal.throwIfAborted();
      need(!this.closed && generation === this.generation, 'Stale render');
    };
    // Start after publishing active ownership; yields are explicit cancellation points.
    const work = Promise.resolve().then(async () => {
      let published = false;
      try {
        for (let k = first; k < end; k += ROWS) {
          check();
          const rows = Math.min(ROWS, end - k);
          for (let r = 0; r < rows; r++) job.row(tile, r, k + r);
          check();
          if (this.wasm) {
            const before = this.wasm.invocations;
            try {
              this.wasm.run(tile, rows, job.frames, job.channels);
            } catch (error) {
              // Semantic JS validation errors are not retried. An entered failed WASM call poisons this owner.
              if (this.wasm.invocations !== before) {
                this.closed = true;
                this.generation++;
              }
              throw error;
            } finally {
              this.diagnostics.invocations = this.wasm.invocations - this.diagnostics.selfTests;
              this.diagnostics.completions = this.wasm.completions - this.diagnostics.selfTests;
            }
          } else jsKernel(tile, rows, job.frames, job.channels);
          check();
          for (let ch = 0; ch < job.channels; ch++)
            output[ch].set(tile.output.subarray(ch * ROWS, ch * ROWS + rows), k - first);
          await this.yieldTask();
          check();
        }
        check();
        published = true;
        return { pcm: { first, rate: outputRate, planes: output }, release: outputRelease };
      } finally {
        releaseInput();
        if (!published) outputRelease();
        this.active = undefined;
        if (this.closed) this.drain();
      }
    });
    this.active = work;
    return work;
  }
  private drain() {
    if (this.drained || this.active) return;
    this.drained = true;
    this.tile = undefined;
    this.wasm = undefined;
    this.releaseBase();
  }
  close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      this.generation++;
      this.closePromise = (
        this.active
          ? this.active.then(
              () => {},
              () => {},
            )
          : Promise.resolve()
      ).then(() => this.drain());
    }
    return this.closePromise;
  }
}
