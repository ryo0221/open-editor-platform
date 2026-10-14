import type { CaptureBasis, ExportConsent } from '@editor-platform/export-core';
import type { DocumentContent } from '@editor-platform/document/model';
import type { DocumentDocxOptions } from '@editor-platform/document-export';
import type { DocxJobRequest, DocxJobResponse } from './docx-protocol';
import { renderOfficeMermaidFrame } from './mermaid-frame';

type JobResponse = Exclude<DocxJobResponse, { status: 'render-mermaid' }>;
export class DocxExportJob {
  private worker?: Worker;
  private sequence = 0;
  private renderAbort = new AbortController();
  private frameUrl = '/office-mermaid.html';
  private pending?: {
    id: number;
    resolve(value: JobResponse | { status: 'cancelled' }): void;
    reject(error: Error): void;
  };
  private request(
    message:
      | Omit<Extract<DocxJobRequest, { action: 'prepare' }>, 'id'>
      | Omit<Extract<DocxJobRequest, { action: 'encode' }>, 'id'>,
  ) {
    if (this.pending) throw Error('An Office export operation is already running');
    this.worker ??= new Worker(new URL('./docx-worker.ts', import.meta.url), { type: 'module' });
    const worker = this.worker;
    worker.onmessage = ({ data }: MessageEvent<DocxJobResponse>) => {
      if (worker !== this.worker || this.pending?.id !== data.id) return;
      if (data.status === 'render-mermaid') {
        void renderOfficeMermaidFrame(this.frameUrl, data, this.renderAbort.signal)
          .then((result) => {
            if (worker === this.worker)
              worker.postMessage({
                id: data.id,
                action: 'mermaid-result',
                renderId: data.renderId,
                result,
              } satisfies DocxJobRequest);
          })
          .catch((error: unknown) => {
            if (worker === this.worker)
              worker.postMessage({
                id: data.id,
                action: 'mermaid-result',
                renderId: data.renderId,
                message: error instanceof Error ? error.message : 'Mermaid rendering failed',
              } satisfies DocxJobRequest);
          });
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
      this.renderAbort.abort();
      this.renderAbort = new AbortController();
      pending?.reject(Error('The export worker failed. Retry to prepare a new snapshot.'));
    };
    return new Promise<JobResponse | { status: 'cancelled' }>((resolve, reject) => {
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
  prepare(
    content: DocumentContent,
    basis: CaptureBasis,
    options: DocumentDocxOptions,
    fontManifestUrl: string,
    codeFontManifestUrl: string,
    mermaidFrameUrl = '/office-mermaid.html',
  ) {
    this.frameUrl = mermaidFrameUrl;
    return this.request({
      action: 'prepare',
      content,
      basis,
      options,
      fontManifestUrl,
      codeFontManifestUrl,
    });
  }
  encode(consent: ExportConsent) {
    return this.request({ action: 'encode', consent });
  }
  cancel() {
    this.renderAbort.abort();
    this.renderAbort = new AbortController();
    this.worker?.terminate();
    this.worker = undefined;
    this.pending?.resolve({ status: 'cancelled' });
    this.pending = undefined;
  }
}
