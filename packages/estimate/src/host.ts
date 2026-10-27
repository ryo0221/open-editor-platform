import { canonicalJson, newId, type Artifact } from '@editor-platform/artifact-core';
import {
  previewProposedCommands,
  transaction,
  type EditorCommand,
} from '@editor-platform/editor-core';
import type { EditorHostAdapter } from '@editor-platform/editor-host';
import { CalculationError } from '@editor-platform/calculation-core';
import {
  assertEstimate,
  assertEstimateAccess,
  isEstimate,
  verifyEstimate,
  makeEstimateBasis,
  replaceEstimate,
  ENGINE,
  LIMITS,
  type EstimateGuard,
  type EstimateDocument,
  type Calculation,
  type QuantityVerification,
} from '@editor-platform/estimate-core';
/** Domain adapters load only when a retained geometric source requires verification. */
const quantityVerification: QuantityVerification = {
  verifySource: async (source, sources) => {
    const { bimQuantityVerification } = await import('./bim-source');
    return bimQuantityVerification().verifySource(source, sources);
  },
  verifyQuantities: async (quantities, sources) => {
    const { bimQuantityVerification } = await import('./bim-source');
    return bimQuantityVerification().verifyQuantities(quantities, sources);
  },
};
export interface EstimatePort extends EstimateGuard {
  quantityVerification?: QuantityVerification;
  read(): EstimateDocument;
  revision(): string;
  generation(): number;
  flush(): void;
  execute(command: EditorCommand<EstimateDocument>): void;
  canExport(): boolean;
}
export type EstimateWorkerFactory = () => Worker;
export const browserEstimateWorker: EstimateWorkerFactory = () =>
  new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
function request(
  factory: EstimateWorkerFactory,
  document: EstimateDocument,
  id: string,
  scenarioId: string | null,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) return Promise.reject(new CalculationError('cancelled'));
  return new Promise((resolve, reject) => {
    const worker = factory();
    let ended = false;
    const finish = (error?: Error, value?: unknown) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => finish(new CalculationError('cancelled'));
    const timer = setTimeout(() => finish(new CalculationError('calculation-timeout')), 30000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = (event) => finish(new Error(event.message));
    worker.onmessage = (event) => {
      if (!event.data || typeof event.data !== 'object' || event.data.id !== id)
        finish(new CalculationError('worker-request-mismatch'));
      else
        finish(
          event.data.error ? new Error(String(event.data.error)) : undefined,
          event.data.result,
        );
    };
    try {
      worker.postMessage({ document: structuredClone(document), id, scenarioId });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
export interface EstimateCandidate {
  document: EstimateDocument;
  base: EstimateDocument;
  revision: string;
  generation: number;
  request: number;
}
/** Private execution state; edits and successful calculations use the existing Host Session. */
export class EstimateController {
  private serial = 0;
  private abort?: AbortController;
  private closed = false;
  private prepared = new WeakMap<EstimateCandidate, string>();
  constructor(
    readonly port: EstimatePort,
    private readonly worker: EstimateWorkerFactory = browserEstimateWorker,
  ) {}
  cancel() {
    this.serial++;
    this.abort?.abort();
    this.abort = undefined;
  }
  close() {
    this.closed = true;
    this.cancel();
  }
  private guard(document = this.port.read()) {
    if (this.closed) throw new CalculationError('closed');
    if (!this.port.canEdit()) throw new CalculationError('read-only');
    if (!this.port.inputsReady()) throw new CalculationError('input-pending');
    assertEstimateAccess(document, this.port);
  }
  edit(next: EstimateDocument, label = 'Edit estimate') {
    this.guard();
    this.port.execute(replaceEstimate(this.port.read(), next, this.port, label));
  }
  async prepare(
    scenarioId: string | null = null,
    candidate?: EstimateDocument,
    retention: 'append' | 'replace' = 'append',
  ): Promise<EstimateCandidate> {
    this.port.flush();
    this.guard();
    this.cancel();
    const base = structuredClone(this.port.read()),
      revision = this.port.revision(),
      generation = this.port.generation(),
      serial = this.serial;
    const document = structuredClone(candidate ?? base);
    if (retention !== 'append' && retention !== 'replace')
      throw new CalculationError('unsupported-retention');
    if (retention === 'replace') document.calculations = [];
    if (document.calculations.length >= LIMITS.calculations)
      throw new CalculationError(
        'calculation-history-full',
        '計算記録は5件までです。保存後に「作業中の記録を置換」を選ぶか、不要な計算記録を削除してください。',
      );
    assertEstimate(document);
    this.guard(document);
    const abort = new AbortController();
    this.abort = abort;
    const id = newId('calculation');
    const raw = await request(this.worker, document, id, scenarioId, abort.signal);
    const fresh = () => {
      this.guard(document);
      if (
        this.serial !== serial ||
        this.port.revision() !== revision ||
        this.port.generation() !== generation
      )
        throw new CalculationError('stale-result');
    };
    fresh();
    const next = { ...document, calculations: [...document.calculations, raw as Calculation] };
    if (new TextEncoder().encode(JSON.stringify(next)).length > LIMITS.bytes)
      throw new CalculationError(
        'calculation-capacity',
        '計算記録を追加すると2 MiBの容量上限を超えます。現在の結果を保存し、「作業中の記録を置換」で再試算してください。入力だけで上限に近い場合は見積を分割してください。',
      );
    await verifyEstimate(
      next,
      undefined,
      true,
      this.port.quantityVerification ?? quantityVerification,
    );
    fresh();
    if (
      (raw as Calculation).id !== id ||
      canonicalJson((raw as Calculation).basis) !==
        canonicalJson(makeEstimateBasis(document, scenarioId))
    )
      throw new CalculationError('worker-basis-mismatch');
    const preview = previewProposedCommands(base, {
      id: newId('proposal'),
      summary: 'Estimate calculation',
      commands: [replaceEstimate(base, next, this.port)],
    });
    const reviewed = { document: preview.content, base, revision, generation, request: serial };
    this.prepared.set(reviewed, canonicalJson(reviewed));
    return reviewed;
  }
  apply(candidate: EstimateCandidate) {
    if (this.prepared.get(candidate) !== canonicalJson(candidate))
      throw new CalculationError('unverified-candidate');
    this.port.flush();
    this.guard(candidate.document);
    if (
      candidate.request !== this.serial ||
      candidate.revision !== this.port.revision() ||
      candidate.generation !== this.port.generation()
    )
      throw new CalculationError('stale-result');
    this.port.execute(
      transaction(
        'Accept estimate calculation',
        [replaceEstimate(candidate.base, candidate.document, this.port)],
        { origin: 'proposal', transactionId: newId('transaction') },
      ),
    );
    this.serial++;
  }
  async run(scenarioId: string | null = null, retention: 'append' | 'replace' = 'append') {
    this.apply(await this.prepare(scenarioId, undefined, retention));
  }
  async verifiedCalculation(id: string) {
    this.port.flush();
    const revision = this.port.revision(),
      generation = this.port.generation(),
      document = structuredClone(this.port.read());
    if (this.closed || !this.port.canExport() || !this.port.inputsReady())
      throw new CalculationError('export-denied');
    assertEstimateAccess(document, this.port);
    await verifyEstimate(
      document,
      undefined,
      true,
      this.port.quantityVerification ?? quantityVerification,
    );
    if (
      this.closed ||
      revision !== this.port.revision() ||
      generation !== this.port.generation() ||
      !this.port.canExport() ||
      !this.port.inputsReady()
    )
      throw new CalculationError('stale-export');
    assertEstimateAccess(document, this.port);
    const calculation = document.calculations.find((r) => r.id === id);
    if (!calculation) throw new CalculationError('missing-calculation');
    if (calculation.basis.engine !== ENGINE) throw new CalculationError('unsupported-engine');
    return calculation;
  }
}
export async function verifyEstimateArtifact(
  artifact: Artifact<unknown>,
  verifier: QuantityVerification = quantityVerification,
) {
  if (artifact.kind !== 'estimate') return;
  const identities = new Map<string, string>();
  for (const content of [artifact.draft.content, ...artifact.versions.map((v) => v.content)]) {
    const checked = await verifyEstimate(content, artifact.id, true, verifier);
    for (const source of checked.retainedSources) {
      const key = canonicalJson([source.pin.domain, source.pin.artifactId, source.pin.versionId]);
      const prior = identities.get(key);
      if (prior && prior !== source.pin.contentHash)
        throw new CalculationError('conflicting-source-pin');
      identities.set(key, source.pin.contentHash);
    }
  }
}
export const estimateHostAdapter: EditorHostAdapter<EstimateDocument> = {
  kind: 'estimate',
  validate: isEstimate,
  preflight: verifyEstimateArtifact,
  capabilities: {
    undo: true,
    nativeJson: true,
    formats: [],
    preview: 'none',
    shared: false,
    proposals: true,
  },
};
