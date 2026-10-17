/** Private product Host orchestration; codec adoption is injected after review. */
import { contentHash } from '@editor-platform/artifact-core';
import { assertVideoContent, type VideoContent, type Time } from '@editor-platform/video-core';
import type { LocalReadSnapshot } from '@editor-platform/extension-contract/draft2';
import { digest, type ImportSet } from './import';
import type { MediaStore } from './bundle';
export interface ExportSnapshot {
  readonly native: LocalReadSnapshot<VideoContent>;
  readonly hash: string;
  readonly originals: readonly { sourceId: string; bytes: Blob; plan: ImportSet }[];
}
export interface ExportBinding {
  read(): LocalReadSnapshot<VideoContent>;
  /** Existing Host scope/permission and input checks, including save reconciliation. */
  check(): void;
}
export interface Mp4Codec {
  provenance?(bytes: Blob): unknown;
  preview?(
    snapshot: ExportSnapshot,
    at: Time,
    canvas: HTMLCanvasElement,
    signal: AbortSignal,
  ): Promise<unknown>;
  play?(
    snapshot: ExportSnapshot,
    at: Time,
    canvas: HTMLCanvasElement,
    signal: AbortSignal,
    report: (evidence: unknown) => void,
  ): Promise<unknown>;
  encode(snapshot: ExportSnapshot, signal: AbortSignal): Promise<Blob>;
  /** Parse the staged bytes, checking both tracks, timing and declared output profile. */
  verify(bytes: Blob, snapshot: ExportSnapshot, signal: AbortSignal): Promise<void>;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !(value instanceof Blob)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** One replaceable completed output, never a history or persistence backend. */
export class VideoExport {
  private active?: AbortController;
  private disposed = false;
  private settlement: Promise<void> = Promise.resolve();
  private published?: { bytes: Blob; snapshot: ExportSnapshot };
  constructor(
    private readonly binding: ExportBinding,
    private readonly store: MediaStore,
    private readonly codec: Mp4Codec,
  ) {}
  get completed() {
    return this.published;
  }
  cancel() {
    this.active?.abort();
  }
  dispose() {
    this.disposed = true;
    const old = this.active;
    this.active = undefined;
    this.published = undefined;
    old?.abort();
    return this.settlement;
  }
  async run(caller: AbortSignal): Promise<{ bytes: Blob; snapshot: ExportSnapshot }> {
    if (this.disposed) throw Error('Export disposed');
    if (this.active) throw Error('Export busy');
    let settled!: () => void;
    this.settlement = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const job = new AbortController();
    this.active = job;
    const abort = () => job.abort(caller.reason);
    caller.addEventListener('abort', abort, { once: true });
    let scope: string | undefined;
    const check = () => {
      caller.throwIfAborted();
      job.signal.throwIfAborted();
      if (this.disposed || this.active !== job) throw Error('Export closed');
      this.binding.check();
      if (scope !== undefined && JSON.stringify(this.binding.read().scope) !== scope)
        throw Error('Export scope changed');
      // Host callbacks may reenter cancel/dispose.
      caller.throwIfAborted();
      job.signal.throwIfAborted();
      if (this.disposed || this.active !== job) throw Error('Export closed');
    };
    try {
      check();
      const native = structuredClone(this.binding.read());
      scope = JSON.stringify(native.scope);
      assertVideoContent(native.content);
      const originals = native.content.sources.map((source) => {
        const bytes = this.store.get(source.asset.sha256),
          plan = this.store.getPlan(source.id);
        if (!bytes || !plan || bytes.size !== source.asset.byteLength)
          throw Error('Missing original');
        return { sourceId: source.id, bytes, plan };
      });
      freeze(native);
      freeze(originals);
      const snapshot = freeze({ native, originals, hash: await contentHash(native.content) });
      check();
      for (let i = 0; i < originals.length; i++) {
        if ((await digest(originals[i].bytes)) !== native.content.sources[i].asset.sha256)
          throw Error('Original hash mismatch');
        check();
      }
      check();
      const bytes = await this.codec.encode(snapshot, job.signal);
      check();
      if (bytes.type !== 'video/mp4' || !bytes.size || bytes.size > 32 * 1024 * 1024)
        throw Error('Export output profile/size');
      await this.codec.verify(bytes, snapshot, job.signal);
      check();
      // Synchronous in-memory publication: no await or external callback between
      // the final authority check and swapping the completed output. Download is separate.
      const result = Object.freeze({ bytes, snapshot });
      this.published = result;
      return result;
    } finally {
      caller.removeEventListener('abort', abort);
      if (this.active === job) this.active = undefined;
      settled();
    }
  }
}
