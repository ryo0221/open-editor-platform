import { canonicalJson, newId, type Artifact } from '@editor-platform/artifact-core';
import {
  previewProposedCommands,
  transaction,
  type EditorCommand,
} from '@editor-platform/editor-core';
import { type EditorHostAdapter } from '@editor-platform/editor-host';
import { CalculationError } from '@editor-platform/calculation-core';
import {
  assertAnalysis,
  ENGINE,
  isAnalysis,
  verifyAnalysis,
  makeBasis,
  inspectAnalysisJoins,
  replaceAnalysis,
  assertAnalysisAccess,
  type AnalysisDocument,
  type AnalysisGuard,
  type Run,
} from '@editor-platform/analysis-core';
import { isCurrentRun } from './current-run';
export interface AnalysisPort extends AnalysisGuard {
  read(): AnalysisDocument;
  revision(): string;
  generation(): number;
  flush(): void;
  execute(command: EditorCommand<AnalysisDocument>): void;
  canExport(): boolean;
}
export type AnalysisWorkerFactory = () => Worker;
export const browserAnalysisWorker: AnalysisWorkerFactory = () =>
  new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
export function workerRequest(
  factory: AnalysisWorkerFactory,
  document: AnalysisDocument,
  id: string,
  scenarioId: string | null,
  signal: AbortSignal,
  mode: 'run' | 'verify' = 'run',
): Promise<unknown> {
  if (signal.aborted) return Promise.reject(new CalculationError('cancelled'));
  return new Promise((resolve, reject) => {
    const worker = factory();
    const end = (error?: Error, value?: unknown) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => end(new CalculationError('cancelled'));
    const timer = setTimeout(() => end(new CalculationError('calculation-timeout')), 30000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = (e) => end(new Error(e.message));
    worker.onmessage = (e) => {
      if (e.data.id !== id) {
        end(new CalculationError('worker-request-mismatch'));
        return;
      }
      end(e.data.error ? new Error(e.data.error) : undefined, e.data.result);
    };
    worker.postMessage({ document: structuredClone(document), id, scenarioId, mode });
  });
}
export interface AnalysisCandidate {
  document: AnalysisDocument;
  base: AnalysisDocument;
  revision: string;
  generation: number;
  request: number;
}
/** Private execution state only; the Host's native Session owns every edit and Undo. */
export class AnalysisController {
  private serial = 0;
  private abort?: AbortController;
  private closed = false;
  private prepared = new WeakMap<AnalysisCandidate, string>();
  constructor(
    readonly port: AnalysisPort,
    private readonly worker: AnalysisWorkerFactory = browserAnalysisWorker,
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
    assertAnalysisAccess(document, this.port);
  }
  edit(next: AnalysisDocument, label: string) {
    this.guard();
    this.port.execute(replaceAnalysis(this.port.read(), next, this.port, label));
  }
  async prepare(
    scenarioId: string | null = null,
    candidate?: AnalysisDocument,
  ): Promise<AnalysisCandidate> {
    this.port.flush();
    this.guard();
    this.cancel();
    const base = structuredClone(this.port.read()),
      revision = this.port.revision(),
      generation = this.port.generation(),
      request = this.serial;
    const document = structuredClone(candidate ?? base);
    assertAnalysis(document);
    this.guard(document);
    const abort = new AbortController();
    this.abort = abort;
    const runId = newId('run');
    const raw = await workerRequest(this.worker, document, runId, scenarioId, abort.signal);
    this.guard(document);
    if (
      request !== this.serial ||
      revision !== this.port.revision() ||
      generation !== this.port.generation()
    )
      throw new CalculationError('stale-result');
    const next = { ...document, runs: [...document.runs, raw as Run] };
    await verifyAnalysis(next, undefined, true);
    if (
      (raw as Run).id !== runId ||
      canonicalJson((raw as Run).basis) !== canonicalJson(makeBasis(document, scenarioId))
    )
      throw new CalculationError('worker-basis-mismatch');
    if (
      request !== this.serial ||
      revision !== this.port.revision() ||
      generation !== this.port.generation()
    )
      throw new CalculationError('stale-result');
    this.guard(next);
    const preview = previewProposedCommands(base, {
      id: newId('proposal'),
      summary: 'Analysis result',
      commands: [replaceAnalysis(base, next, this.port)],
    });
    const reviewed = { document: preview.content, base, revision, generation, request };
    this.prepared.set(reviewed, canonicalJson(reviewed));
    return reviewed;
  }
  apply(candidate: AnalysisCandidate) {
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
        'Accept analysis result',
        [replaceAnalysis(candidate.base, candidate.document, this.port)],
        { origin: 'proposal', transactionId: newId('transaction') },
      ),
    );
    this.serial++;
  }
  async run(scenarioId: string | null = null) {
    const candidate = await this.prepare(scenarioId);
    this.apply(candidate);
  }
  async inspect(
    scenarioId: string | null = null,
    options: Parameters<typeof inspectAnalysisJoins>[2] = {},
  ) {
    this.port.flush();
    const document = structuredClone(this.port.read()),
      revision = this.port.revision(),
      generation = this.port.generation();
    if (this.closed || !this.port.inputsReady()) throw new CalculationError('input-pending');
    assertAnalysisAccess(document, this.port);
    await verifyAnalysis(document, undefined, true);
    const report = inspectAnalysisJoins(document, scenarioId, options);
    if (
      this.closed ||
      revision !== this.port.revision() ||
      generation !== this.port.generation() ||
      !this.port.inputsReady()
    )
      throw new CalculationError('stale-inspection');
    assertAnalysisAccess(document, this.port);
    return report;
  }
  async verifiedOutput(runId: string, outputId: string) {
    this.port.flush();
    const revision = this.port.revision(),
      generation = this.port.generation(),
      document = structuredClone(this.port.read());
    if (!this.port.canExport() || !this.port.inputsReady())
      throw new CalculationError('export-denied');
    assertAnalysisAccess(document, this.port);
    await verifyAnalysis(document, undefined, true);
    if (
      this.closed ||
      revision !== this.port.revision() ||
      generation !== this.port.generation() ||
      !this.port.canExport() ||
      !this.port.inputsReady()
    )
      throw new CalculationError('stale-export');
    assertAnalysisAccess(document, this.port);
    const run = document.runs.find((r) => r.id === runId),
      table = run?.results[outputId];
    if (!run || !table) throw new CalculationError('missing-result');
    if (run.basis.engine !== ENGINE) throw new CalculationError('unsupported-engine');
    return {
      table,
      run,
      historical: !isCurrentRun(document, run),
    };
  }
}
export const analysisHostAdapter: EditorHostAdapter<AnalysisDocument> = {
  kind: 'analysis',
  validate: isAnalysis,
  preflight: verifyAnalysisArtifact,
  capabilities: {
    undo: true,
    nativeJson: true,
    formats: [],
    preview: 'none',
    shared: false,
    proposals: true,
  },
};
export async function verifyAnalysisArtifact(artifact: Artifact<unknown>): Promise<void> {
  if (artifact.kind !== 'analysis') return;
  const identities = new Map<string, string>();
  for (const content of [artifact.draft.content, ...artifact.versions.map((v) => v.content)]) {
    const checked = await verifyAnalysis(content, artifact.id, true);
    for (const source of checked.retainedSources) {
      const key = canonicalJson([source.pin.domain, source.pin.artifactId, source.pin.versionId]);
      const prior = identities.get(key);
      if (prior && prior !== source.pin.contentHash)
        throw new CalculationError('conflicting-source-pin');
      identities.set(key, source.pin.contentHash);
    }
  }
}
