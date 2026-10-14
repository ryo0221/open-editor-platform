import {
  clone,
  contentHash,
  createArtifact,
  createArtifactIfAbsent,
  deepFreeze,
  type Artifact,
  type StorageAdapter,
} from '@editor-platform/artifact-core';
import {
  checkImportAbort,
  ImportError,
  sourceKey,
  type OfficeSourceAddress,
  type ImportDiagnostic,
  type ImportDisposition,
  type ImportConsent,
  type OfficeImportOptions,
  type OfficeImportReport,
} from './types';
export type ReadonlyImport<T> = T extends readonly (infer U)[]
  ? readonly ReadonlyImport<U>[]
  : T extends object
    ? { readonly [K in keyof T]: ReadonlyImport<T[K]> }
    : T;
declare const planBrand: unique symbol;
export interface OfficeImportPlan<T> {
  readonly [planBrand]: true;
  readonly preview: ReadonlyImport<T>;
  readonly report: ReadonlyImport<OfficeImportReport>;
}
interface OwnedPlan<T> {
  artifact: Artifact<T>;
  state: 'prepared' | 'applying' | 'uncertain' | 'applied' | 'cancelled';
  report: OfficeImportReport;
}
const plans = new WeakMap<object, OwnedPlan<unknown>>();
export class ImportReportBuilder {
  readonly diagnostics: ImportDiagnostic[] = [];
  private exclusions = new Set<string>();
  private diagnosticIds = new Map<string, ImportDiagnostic>();
  constructor(readonly options: OfficeImportOptions) {
    if (
      !['reject', 'review-conversions'].includes(options.unsupported) ||
      options.fontProfileId !== 'noto-cjk-jp-2.004'
    )
      throw new ImportError('OPTIONS', 'Unsupported import options or font profile');
    if (
      options.exclude &&
      (!Array.isArray(options.exclude) ||
        options.exclude.length > 10_000 ||
        options.exclude.some((s) => typeof s !== 'string'))
    )
      throw new ImportError('OPTIONS', 'Invalid exclusions');
  }
  add(
    code: string,
    disposition: ImportDisposition,
    address: OfficeSourceAddress,
    message: string,
    requiresConsent = false,
  ) {
    const effective =
      disposition === 'approximation' && this.options.unsupported === 'reject'
        ? 'blocked'
        : disposition;
    const id = `${sourceKey(address)}:${code}`;
    if (!this.diagnosticIds.has(id)) {
      const diagnostic: ImportDiagnostic = {
        id,
        code,
        disposition: effective,
        address,
        message,
        requiresConsent: effective !== 'blocked' && requiresConsent,
      };
      this.diagnostics.push(diagnostic);
      this.diagnosticIds.set(id, diagnostic);
    }
  }
  /** Only the specifically addressed unsupported feature may be excluded. Structural corruption is never waivable. */
  unsupported(code: string, address: OfficeSourceAddress, message: string): boolean {
    const key = sourceKey(address),
      chosen = this.options.exclude?.includes(key) ?? false;
    if (chosen) this.exclusions.add(key);
    this.add(code, chosen ? 'excluded' : 'blocked', address, message, chosen);
    const diagnostic = this.diagnosticIds.get(`${key}:${code}`)!;
    diagnostic.excludable = true;
    return chosen;
  }
  finalize() {
    for (const key of this.options.exclude ?? [])
      if (!this.exclusions.has(key))
        throw new ImportError(
          'EXCLUSION_MISMATCH',
          `The selected exclusion no longer matches an unsupported feature: ${key}`,
        );
  }
}
export function importNativeId(requestId: string, index: number, prefix = 'element') {
  return `office_${requestId}_${prefix}_${index}`;
}
export async function ownOfficeImportPlan<T>(
  content: T,
  report: Omit<OfficeImportReport, 'planHash'>,
  options: OfficeImportOptions,
  signal?: AbortSignal,
): Promise<OfficeImportPlan<T>> {
  checkImportAbort(signal);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(report.requestId))
    throw new ImportError('REQUEST_ID', 'Invalid creation request ID');
  const ownedContent = clone(content),
    base = clone(report),
    ownedOptions = clone(options);
  const planHash = await contentHash({
    report: base,
    content: ownedContent,
    options: ownedOptions,
  });
  checkImportAbort(signal);
  const completed = { ...base, planHash };
  const artifact = createArtifact(
    base.domain,
    options.name?.trim() ||
      (base.domain === 'slide' ? 'Imported presentation' : 'Imported document'),
    ownedContent,
    {
      source: 'imported',
      format: base.format,
      officeImport: {
        requestId: base.requestId,
        sourceHash: base.sourceHash,
        fingerprint: planHash,
        adapterVersion: base.parser.adapterVersion,
      },
    },
  );
  artifact.id = `office_${base.requestId}`;
  const handle = deepFreeze({
    preview: clone(ownedContent),
    report: clone(completed),
  }) as unknown as OfficeImportPlan<T>;
  plans.set(handle, { artifact, report: completed, state: 'prepared' });
  return handle;
}
function getPlan<T>(plan: OfficeImportPlan<T>): OwnedPlan<T> {
  const value = plans.get(plan) as OwnedPlan<T> | undefined;
  if (!value) throw new ImportError('FOREIGN_PLAN', 'Only an owned prepared plan is accepted');
  if (value.state === 'cancelled') throw new ImportError('CANCELLED', 'Import was cancelled');
  return value;
}
export function materializeOfficeImport<T>(
  plan: OfficeImportPlan<T>,
  consent: ImportConsent,
): Artifact<T> {
  const owned = getPlan(plan);
  if (owned.report.diagnostics.some((d) => d.disposition === 'blocked'))
    throw new ImportError('BLOCKED', 'Resolve blocked import diagnostics first');
  const required = owned.report.diagnostics
    .filter((d) => d.requiresConsent)
    .map((d) => d.id)
    .sort();
  const accepted = [...new Set(consent.acceptedDiagnosticIds)].sort();
  if (
    consent.planHash !== owned.report.planHash ||
    required.length !== accepted.length ||
    required.some((id, i) => id !== accepted[i])
  )
    throw new ImportError(
      'CONSENT_MISMATCH',
      'Confirm the current plan and its exact conversion warnings',
    );
  return clone(owned.artifact);
}
export interface HostArtifactCreationAdapter<T> {
  /** Trusted Host boundary. Authorize on every invocation, including retries, then atomically create or return the existing artifact. */
  createIfAbsent(artifact: Artifact<T>, signal?: AbortSignal): Promise<Artifact<T>>;
}
/** Reference local Host adapter; production Hosts must enforce their own authority inside storage. */
export function localImportCreationAdapter<T>(
  storage: Pick<StorageAdapter<Artifact<T>>, 'putIfAbsent'>,
  canCreate: () => boolean,
): HostArtifactCreationAdapter<T> {
  return {
    async createIfAbsent(artifact, signal) {
      checkImportAbort(signal);
      if (!canCreate()) throw new ImportError('UNAUTHORIZED', 'Host does not permit creation');
      const fingerprint = artifact.provenance.officeImport?.fingerprint;
      if (!fingerprint) throw new ImportError('INVALID_PLAN', 'Missing creation fingerprint');
      return createArtifactIfAbsent(
        storage,
        artifact,
        fingerprint,
        (stored) => stored.provenance.officeImport?.fingerprint,
        (code, message) => {
          throw new ImportError(code, message);
        },
      );
    },
  };
}
export async function applyOfficeImport<T>(
  plan: OfficeImportPlan<T>,
  consent: ImportConsent,
  creation: HostArtifactCreationAdapter<T>,
  signal?: AbortSignal,
): Promise<Artifact<T>> {
  checkImportAbort(signal);
  const value = materializeOfficeImport(plan, consent),
    owned = getPlan(plan);
  if (owned.state === 'applying') throw new ImportError('APPLYING', 'Creation is already pending');
  owned.state = 'applying';
  try {
    const stored = await creation.createIfAbsent(value, signal);
    if (
      stored.id !== value.id ||
      stored.provenance.officeImport?.fingerprint !== value.provenance.officeImport?.fingerprint
    )
      throw new ImportError(
        'request-conflict',
        'Creation request was already used for different input',
      );
    owned.state = 'applied';
    // A committed creation cannot be undone by a late abort. Return its receipt for Host navigation.
    return clone(stored);
  } catch (e) {
    const knownNoCreation =
      e instanceof ImportError &&
      ['UNAUTHORIZED', 'request-conflict', 'storage-capability'].includes(e.code);
    owned.state = knownNoCreation ? 'prepared' : 'uncertain';
    throw e;
  }
}
export function cancelOfficeImport(plan: OfficeImportPlan<unknown>) {
  const owned = getPlan(plan);
  if (owned.state !== 'prepared')
    throw new ImportError(
      'CREATION_STARTED',
      'Once creation starts, resolve its receipt before leaving',
    );
  owned.state = 'cancelled';
}
