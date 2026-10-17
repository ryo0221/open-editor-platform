import {
  planWindow,
  renderPcm,
  type Mapping,
  type PcmWindow,
  type WindowPlan,
  type BoundaryMode,
} from './render';
import type { Time } from '../../../../core';
export interface DecodePort {
  decode(plan: WindowPlan, signal: AbortSignal): Promise<PcmWindow>;
}
/** One request owns one bounded window; a newer seek aborts and supersedes it. */
export class PcmRenderSession {
  private generation = 0;
  private active: AbortController | undefined;
  private disposed = false;
  constructor(
    private readonly decoder: DecodePort,
    private readonly boundary: BoundaryMode = 'require-support',
  ) {}
  async render(
    mapping: Mapping,
    first: number,
    end: number,
    outputRate: number,
    sourceRate: number,
    valid: { start: Time; end: Time },
    channels: number,
    caller: AbortSignal,
  ) {
    if (this.disposed) throw Error('Renderer disposed');
    caller.throwIfAborted();
    const previous = this.active;
    const generation = ++this.generation,
      abort = new AbortController();
    this.active = abort;
    const cancel = () => abort.abort(caller.reason);
    caller.addEventListener('abort', cancel, { once: true });
    const check = () => {
      caller.throwIfAborted();
      abort.signal.throwIfAborted();
      if (this.disposed || this.active !== abort || generation !== this.generation)
        throw Error('Stale render');
    };
    try {
      // Publish ownership first: synchronous old-owner listeners may render/dispose.
      previous?.abort();
      check();
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
      check();
      const pcm = await this.decoder.decode(plan, abort.signal);
      check();
      const result = renderPcm(
        mapping,
        first,
        end,
        outputRate,
        pcm,
        abort.signal,
        this.boundary === 'require-support' ? undefined : { mode: this.boundary, valid },
      );
      check();
      return result;
    } finally {
      caller.removeEventListener('abort', cancel);
      if (this.active === abort) this.active = undefined;
    }
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    const previous = this.active;
    this.active = undefined;
    previous?.abort();
  }
}
