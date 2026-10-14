import type { ImportRequest, ImportResponse } from './protocol';
export class OfficeImportJob {
  private worker?: Worker;
  private nextId = 0;
  private pending = new Map<
    number,
    { resolve: (r: ImportResponse) => void; reject: (e: Error) => void }
  >();
  run(
    input:
      | Omit<Extract<ImportRequest, { action: 'prepare' }>, 'id'>
      | Omit<Extract<ImportRequest, { action: 'materialize' }>, 'id'>,
  ) {
    if (!this.worker) {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }: MessageEvent<ImportResponse>) => {
        const pending = this.pending.get(data.id);
        if (!pending) return;
        this.pending.delete(data.id);
        if (data.status === 'failed')
          pending.reject(Object.assign(Error(data.message), { code: data.code }));
        else pending.resolve(data);
      };
      this.worker.onerror = (event) => {
        event.preventDefault();
        this.cancel(Error(event.message || 'Import Worker failed'));
      };
    }
    const id = ++this.nextId;
    return new Promise<ImportResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker!.postMessage({ ...input, id });
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  cancel(error = Error('Import cancelled')) {
    this.worker?.terminate();
    this.worker = undefined;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }
}
