import type { CaptureBasis, ExportConsent } from '@editor-platform/export-core';
import type { SlideContent } from '@editor-platform/slide/model';
import type { PptxFigureReference, SlidePptxOptions } from '@editor-platform/slide-export';
import type { PptxJobRequest, PptxJobResponse } from './pptx-protocol';

export type PptxFigureSource = (reference: PptxFigureReference) => Promise<string>;

/** Keeps the opaque plan and all binary assets in one worker. Cancel kills even a busy encoder. */
export class PptxExportJob {
  private worker?: Worker;
  private sequence = 0;
  private pending?: {
    id: number;
    resolve(value: PptxJobResponse | { status: 'cancelled' }): void;
    reject(error: Error): void;
  };
  private request(
    message:
      | Omit<Extract<PptxJobRequest, { action: 'prepare' }>, 'id'>
      | Omit<Extract<PptxJobRequest, { action: 'encode' }>, 'id'>,
    resolveReference?: PptxFigureSource,
  ) {
    if (this.pending) throw Error('An Office export operation is already running');
    this.worker ??= new Worker(new URL('./pptx-worker.ts', import.meta.url), { type: 'module' });
    const worker = this.worker;
    worker.onmessage = ({ data }: MessageEvent<PptxJobResponse>) => {
      if (worker !== this.worker || this.pending?.id !== data.id) return;
      if (data.status === 'reference-request') {
        void this.resolveFigure(worker, data, resolveReference);
        return;
      }
      const pending = this.pending;
      this.pending = undefined;
      if (data.status === 'failed') pending.reject(Error(data.message));
      else pending.resolve(data);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      if (worker !== this.worker) return;
      const pending = this.pending;
      this.pending = undefined;
      worker.terminate();
      this.worker = undefined;
      pending?.reject(Error('The export worker failed. Retry to prepare a new snapshot.'));
    };
    return new Promise<PptxJobResponse | { status: 'cancelled' }>((resolve, reject) => {
      const id = ++this.sequence;
      this.pending = { id, resolve, reject };
      try {
        worker.postMessage({ ...message, id });
      } catch (error) {
        this.pending = undefined;
        reject(error);
      }
    });
  }
  private async resolveFigure(
    worker: Worker,
    { id, reference }: Extract<PptxJobResponse, { status: 'reference-request' }>,
    resolveReference?: PptxFigureSource,
  ) {
    let result: Extract<PptxJobRequest, { action: 'reference-result' }>['result'];
    try {
      if (!resolveReference) throw Error('The Host has no fixed figure connection');
      result = { src: await resolveReference(reference) };
    } catch (error) {
      result = { error: error instanceof Error ? error.message : 'Fixed figure resolution failed' };
    }
    if (worker === this.worker && this.pending?.id === id)
      worker.postMessage({ action: 'reference-result', id, result } satisfies PptxJobRequest);
  }
  prepare(
    content: SlideContent,
    basis: CaptureBasis,
    options: SlidePptxOptions,
    fontManifestUrl: string,
    resolveReference?: PptxFigureSource,
  ) {
    // postMessage takes a synchronous structured copy before this method returns.
    return this.request(
      { action: 'prepare', content, basis, options, fontManifestUrl },
      resolveReference,
    );
  }
  encode(consent: ExportConsent) {
    return this.request({ action: 'encode', consent });
  }
  cancel() {
    this.worker?.terminate();
    this.worker = undefined;
    this.pending?.resolve({ status: 'cancelled' });
    this.pending = undefined;
  }
}
