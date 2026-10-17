import { PcmBackend, SESSION_BYTES, type OwnedBlock } from '../pcm-wasm-r0/adapter';
import {
  Ledger,
  ModuleInput,
  prepareModule,
  need,
  fixedBacking,
  type ModulePin,
} from '../pcm-wasm-r0/kernel';
import { planWindow, type Mapping, type BoundaryMode } from '../pcm-renderer/render';
import { PcmRenderSession, type DecodePort } from '../pcm-renderer/session';
import type { Time } from '@editor-platform/video-core';
// Reviewed fixed kernel identity, not caller-provided code approval. Build wrapper verifies manifest + bytes.
export const APPROVED_WASM_SHA = '142871dcfdb24035b228f42ae72a369f6fb389d9b179a13512ae0053901a6bca';
type Mode = 'js' | 'wasm' | 'auto';
interface Selection {
  mode: Mode;
  realm: Ledger;
  bytes?: Uint8Array<ArrayBuffer>;
  input?: ModuleInput;
  sha256?: string;
}
let selection: Selection | undefined, moduleJob: Promise<ModulePin> | undefined;
let moduleInput: ModuleInput | undefined;
const records: { read?: () => object; value?: object; closed: boolean }[] = [];
export function configurePcmBackend(config: Selection) {
  need(!selection && records.length === 0, 'PCM selection already active');
  need(
    ['js', 'wasm', 'auto'].includes(config.mode) && config.realm.limit === 8 * 1024 * 1024,
    'PCM Host configuration',
  );
  need(!(config.bytes && config.input), 'Ambiguous module input');
  if (config.input)
    need(
      config.mode !== 'js' && config.input.realm === config.realm && config.input.available,
      'Module input ownership',
    );
  if (config.bytes || config.input) {
    if (config.bytes) fixedBacking(config.bytes.buffer);
    need(config.sha256 === APPROVED_WASM_SHA, 'Unreviewed WASM hash');
  }
  if (config.mode !== 'js')
    moduleInput =
      config.input ??
      (config.bytes
        ? ModuleInput.allocate(config.bytes.byteLength, () => config.bytes!, config.realm)
        : undefined);
  // Never retain a raw input separately after ownership transfers to preparation.
  selection = Object.freeze({ mode: config.mode, realm: config.realm, sha256: config.sha256 });
}
export function pcmBackendDiagnostics() {
  return {
    configured: selection?.mode ?? 'js-default',
    realmBytes: selection?.realm.bytes ?? null,
    moduleBytes: moduleInput?.chargedBytes ?? 0,
    sessions: records.map((s) => s.read?.() ?? s.value),
  };
}
export async function selectedPcmSession(
  decoder: DecodePort,
  boundary: BoundaryMode,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  let backend: PcmBackend | undefined, fallback: string | undefined;
  const config = selection;
  if (config && config.mode !== 'js') {
    try {
      need(moduleInput, 'WASM unavailable');
      const input = moduleInput;
      // Publish the shared job before admission can call a trusted Host ledger.
      moduleJob ??= Promise.resolve().then(() =>
        prepareModule(input, APPROVED_WASM_SHA, config.realm),
      );
      const pin = await moduleJob;
      signal.throwIfAborted();
      backend = new PcmBackend({ mode: 'wasm', pin, realm: config.realm });
    } catch (error) {
      signal.throwIfAborted();
      if (config.mode === 'wasm') throw error;
      fallback = String(error);
    }
  }
  try {
    signal.throwIfAborted();
    // Bounded diagnostics retain scalars only, never sessions/buffers after drain.
    if (records.length >= 64) {
      const i = records.findIndex((x) => x.closed);
      need(i >= 0, 'PCM diagnostic owner limit');
      records.splice(i, 1);
    }
    const session = new SelectedPcmSession(decoder, boundary, config?.realm, backend, fallback);
    const record: { read?: () => object; value?: object; closed: boolean } = {
      read: () => session.diagnostics(),
      closed: false,
    };
    session.retire = () => {
      record.value = session.diagnostics();
      record.closed = true;
      record.read = undefined;
    };
    records.push(record);
    return session;
  } catch (error) {
    await backend?.close();
    throw error;
  }
}
export class SelectedPcmSession {
  private generation = 0;
  private controller: AbortController | undefined;
  private active: Promise<OwnedBlock> | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  private extra = 0;
  private js: PcmRenderSession;
  private calls = 0;
  private completions = 0;
  private lastBackend: object | undefined;
  isDrained = false;
  retire: () => void = () => {};
  constructor(
    private decoder: DecodePort,
    private boundary: BoundaryMode,
    private realm?: Ledger,
    private backend?: PcmBackend,
    private fallback?: string,
  ) {
    this.js = new PcmRenderSession(
      {
        decode: async (plan, signal) => {
          const pcm = await decoder.decode(plan, signal);
          for (const p of pcm.planes) fixedBacking(p.buffer);
          return pcm;
        },
      },
      boundary,
    );
  }
  diagnostics() {
    return {
      backend: this.backend ? 'wasm' : this.lastBackend ? 'wasm' : 'js',
      fallback: !!this.fallback,
      fallbackReason: this.fallback,
      calls: this.calls,
      completedRequests: this.completions,
      closed: this.closed,
      drained: this.isDrained,
      externalBytes: this.extra,
      ...(this.backend?.diagnostics ?? this.lastBackend),
    };
  }
  reserve(bytes: number) {
    need(!this.closed, 'Renderer disposed');
    need(
      Number.isSafeInteger(bytes) &&
        bytes >= 0 &&
        bytes + this.extra + (this.backend?.ownedBytes ?? 0) <= SESSION_BYTES,
      'PCM session total admission',
    );
    const release = this.realm?.reserve(bytes);
    this.extra += bytes;
    let owned = true;
    return () => {
      if (owned) {
        owned = false;
        this.extra -= bytes;
        release?.();
        if (this.isDrained && this.extra === 0) this.retire();
      }
    };
  }
  render(
    mapping: Mapping,
    first: number,
    end: number,
    outputRate: number,
    sourceRate: number,
    valid: { start: Time; end: Time },
    channels: number,
    caller: AbortSignal,
  ): Promise<OwnedBlock> {
    if (this.closed) return Promise.reject(Error('Renderer disposed'));
    caller.throwIfAborted();
    const previous = this.controller,
      previousWork = this.active,
      generation = ++this.generation,
      abort = new AbortController();
    this.controller = abort;
    const cancel = () => abort.abort(caller.reason);
    caller.addEventListener('abort', cancel, { once: true });
    const check = () => {
      caller.throwIfAborted();
      abort.signal.throwIfAborted();
      need(
        !this.closed && this.controller === abort && generation === this.generation,
        'Stale render',
      );
    };
    const work = Promise.resolve().then(async () => {
      let block: OwnedBlock | undefined;
      this.calls++;
      try {
        check();
        if (previousWork) await previousWork.catch(() => {});
        check();
        need(channels === 1, 'v1 PCM channel profile');
        const plan = planWindow(
          mapping,
          first,
          end,
          outputRate,
          sourceRate,
          valid,
          channels,
          this.boundary,
        );
        // Existing PCM-file read: interleaved buffer + collector planes + seen map + one callback block.
        const frames = plan.end - plan.first,
          releaseRead = this.reserve(frames * (channels * 8 + 1) + 4096 * channels * 4);
        try {
          if (this.backend) {
            const pcm = await this.decoder.decode(plan, abort.signal);
            check();
            for (const p of pcm.planes) fixedBacking(p.buffer);
            const backing = [...new Set(pcm.planes.map((p) => p.buffer))].reduce(
              (n, b) => n + b.byteLength,
              0,
            );
            need(
              this.extra + this.backend.ownedBytes + backing + (end - first) * channels * 4 <=
                SESSION_BYTES,
              'PCM session total admission',
            );
            block = await this.backend.render(
              mapping,
              first,
              end,
              outputRate,
              pcm,
              abort.signal,
              this.boundary === 'require-support' ? undefined : { mode: this.boundary, valid },
            );
          } else {
            const release = this.reserve((end - first) * channels * 4);
            try {
              block = {
                pcm: await this.js.render(
                  mapping,
                  first,
                  end,
                  outputRate,
                  sourceRate,
                  valid,
                  channels,
                  abort.signal,
                ),
                release,
              };
            } catch (error) {
              release();
              throw error;
            }
          }
        } finally {
          releaseRead();
        }
        check();
        this.completions++;
        const result = block;
        block = undefined;
        return result!;
      } finally {
        block?.release();
        caller.removeEventListener('abort', cancel);
        if (this.controller === abort) this.controller = undefined;
        if (this.active === work) this.active = undefined;
      }
    });
    this.active = work;
    // Publish generation and pending work before reentrant old-owner listeners run.
    previous?.abort();
    return work;
  }
  dispose(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.generation++;
      const previous = this.controller;
      this.controller = undefined;
      previous?.abort();
      this.js.dispose();
      this.closing = (
        this.active
          ? this.active.then(
              () => {},
              () => {},
            )
          : Promise.resolve()
      ).then(async () => {
        await this.backend?.close();
        this.lastBackend = this.backend ? { ...this.backend.diagnostics } : undefined;
        this.backend = undefined;
        this.isDrained = true;
        if (this.extra === 0) this.retire();
      });
    }
    return this.closing;
  }
}
