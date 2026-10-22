import { checkedJson } from './json-boundary';
import { confirmImport } from './import';
import {
  adaptImport,
  validateRequest,
  type AdaptedImport,
  type ImportLimits,
  type ImportRequest,
} from './import-adapter';
import { geoEditorCommand, type ExecutionContext } from './commands';
import { hash, record } from './validation';
import type { Pin } from './model';

export interface ImportPreview extends AdaptedImport {
  profile: 'geo-import-preview-m0-v1';
  sequence: number;
  sourceBytesHash: string;
  transformedHash: string;
  planDigest: string;
}
export type ImportDecision = { mode: 'all' } | { mode: 'partial'; excludedRows: number[] };
export interface ImportSourceMaterial {
  bytes: Uint8Array;
  pin: Pin;
}

/** Only ordinary owned Uint8Array input; no SharedArrayBuffer, custom hooks or Proxy sandbox. */
function copyBytes(value: unknown, maximum: number): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.getPrototypeOf(value) !== Uint8Array.prototype
  )
    throw new Error('source-bytes');
  const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
  const size = Object.getOwnPropertyDescriptor(typedPrototype, 'length')!.get!.call(
    value,
  ) as number;
  if (size > maximum) throw new Error('source-byte-limit');
  const buffer = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer')!.get!.call(value);
  if (Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype) throw new Error('source-buffer');
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== size ||
    keys.some((k) => typeof k !== 'string' || !/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= size)
  )
    throw new Error('source-bytes-properties');
  const copy = new Uint8Array(size);
  Uint8Array.prototype.set.call(copy, value as Uint8Array);
  return copy;
}
async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function ownDecision(decision: unknown, limits: ImportLimits): ImportDecision {
  checkedJson(decision, limits.native);
  const keys = record(decision) ? Object.keys(decision).length : 0;
  const valid =
    record(decision) &&
    (decision.mode === 'all'
      ? keys === 1
      : decision.mode === 'partial' &&
        keys === 2 &&
        Array.isArray(decision.excludedRows) &&
        decision.excludedRows.every((n) => Number.isSafeInteger(n) && n > 0));
  if (!valid) throw new Error('import-decision');
  return structuredClone(decision as ImportDecision);
}
const samePin = (pin: unknown, expected: Pin) =>
  record(pin) &&
  Object.keys(pin).length === 3 &&
  ['artifactId', 'versionId', 'contentHash'].every((k) => Object.hasOwn(pin, k)) &&
  pin.artifactId === expected.artifactId &&
  pin.versionId === expected.versionId &&
  pin.contentHash === expected.contentHash;
/**
 * Binary bytes use intrinsic typed-array access; the material object itself must
 * contain exactly two enumerable own data properties, never getter accessors.
 */
function materialBytes(material: unknown, expectedPin: Pin, limits: ImportLimits): unknown {
  if (!record(material) || Reflect.ownKeys(material).length !== 2)
    throw new Error('source-material');
  const bytes = Object.getOwnPropertyDescriptor(material, 'bytes');
  const pin = Object.getOwnPropertyDescriptor(material, 'pin');
  if (!bytes?.enumerable || !('value' in bytes) || !pin?.enumerable || !('value' in pin))
    throw new Error('source-material');
  checkedJson(pin.value, limits.native);
  if (!samePin(pin.value, expectedPin)) throw new Error('source-pin-changed');
  return bytes.value;
}
/** A partial import must exclude exactly the rows that carry error diagnostics, in order. */
function assertPartialSelection(choice: ImportDecision, plan: ImportPreview['plan']) {
  if (choice.mode !== 'partial') return;
  const excluded = plan.candidates
    .filter((c) => c.diagnostics.some((d) => d.severity === 'error'))
    .map((c) => c.inputRow);
  if (
    choice.excludedRows.length !== excluded.length ||
    choice.excludedRows.some((n, i) => n !== excluded[i])
  )
    throw new Error('partial-selection-mismatch');
}

/** Ephemeral, bounded preparation registry. No durable storage/resource closure claim. */
export function createGeoImporter(options: ImportLimits) {
  checkedJson(options.native, options.native);
  if (
    !['sourceBytes', 'rows', 'columns', 'pendingPlans'].every(
      (k) =>
        Number.isSafeInteger(options[k as keyof ImportLimits]) &&
        (options[k as keyof ImportLimits] as number) > 0,
    )
  )
    throw new Error('import-limits');
  const limits = structuredClone(options);
  type Stored = { bytes: Uint8Array<ArrayBuffer>; sealed: string; preview: ImportPreview };
  const plans = new Map<string, Stored | symbol>();
  let disposed = false;
  let sequence = 0;
  const live = () => {
    if (disposed) throw new Error('importer-disposed');
  };
  return {
    async prepare(input: Uint8Array, request: ImportRequest): Promise<ImportPreview> {
      live();
      validateRequest(request, limits);
      if (plans.has(request.planId)) throw new Error('plan-id-in-use');
      if (plans.size >= limits.pendingPlans) throw new Error('pending-plan-limit');
      const owned = structuredClone(request),
        bytes = copyBytes(input, limits.sourceBytes);
      if (!Number.isSafeInteger(sequence + 1)) throw new Error('preview-sequence-limit');
      const preparedSequence = ++sequence;
      const reservation = Symbol();
      plans.set(owned.planId, reservation);
      try {
        // Preserve original BOM in the source digest, strip exactly one BOM for parsing.
        const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        const text = decoded.startsWith('\uFEFF') ? decoded.slice(1) : decoded;
        const sourceBytesHash = await digest(bytes);
        live();
        if (plans.get(owned.planId) !== reservation) throw new Error('preview-released');
        const adapted = adaptImport(text, owned, sourceBytesHash, limits);
        const transformedHash = await digest(
          new TextEncoder().encode(checkedJson(adapted.plan.layer, limits.native)),
        );
        const payload = {
          profile: 'geo-import-preview-m0-v1' as const,
          sequence: preparedSequence,
          ...adapted,
          sourceBytesHash,
          transformedHash,
        };
        const planDigest = await digest(
          new TextEncoder().encode(checkedJson(payload, limits.native)),
        );
        const preview = freeze({ ...payload, planDigest });
        const sealed = checkedJson(preview, limits.native);
        live();
        if (plans.get(owned.planId) !== reservation) throw new Error('preview-released');
        plans.set(owned.planId, { bytes, sealed, preview });
        return preview;
      } catch (error) {
        if (plans.get(owned.planId) === reservation) plans.delete(owned.planId);
        throw error;
      }
    },
    async confirm(
      preview: ImportPreview,
      decision: ImportDecision,
      material: ImportSourceMaterial,
      current: () => ExecutionContext,
    ) {
      live();
      const encoded = checkedJson(preview, limits.native);
      // No incoming preview field is read until the complete bounded data check passes.
      if (
        !record(preview) ||
        !record(preview.request) ||
        typeof preview.request.planId !== 'string'
      )
        throw new Error('preview-shape');
      const stored = plans.get(preview.request.planId);
      if (!stored || typeof stored === 'symbol' || stored.sealed !== encoded)
        throw new Error('preview-changed-or-unknown');
      const choice = ownDecision(decision, limits);
      const sourceBytes = materialBytes(material, stored.preview.request.source.pin, limits);
      const bytes = copyBytes(sourceBytes, limits.sourceBytes);
      const sourceHash = await digest(bytes);
      live();
      if (plans.get(stored.preview.request.planId) !== stored) throw new Error('preview-released');
      if (sourceHash !== stored.preview.sourceBytesHash || !hash(sourceHash))
        throw new Error('source-bytes-changed');
      const ctx = current(); // Fresh trusted authority/revision after all async digest work.
      if (!ctx.canEdit) throw new Error('permission-denied');
      const expected = stored.preview.request.revision;
      if (
        expected.sessionId !== ctx.revision.sessionId ||
        expected.sequence !== ctx.revision.sequence
      )
        throw new Error('stale-preview');
      assertPartialSelection(choice, stored.preview.plan);
      const confirmed = confirmImport(
        stored.preview.plan,
        expected,
        choice.mode === 'partial',
        ctx.budgets,
      );
      // Reuse the same command preflight as other entrypoints, then capture fresh authority
      // again if the Host executes the returned local command later.
      const editorCommand = geoEditorCommand(confirmed.command, current);
      return {
        ...confirmed,
        editorCommand,
        sourceBytesHash: sourceHash,
        planDigest: stored.preview.planDigest,
      };
    },
    /** Caller-owned original bytes for retaining in Host storage; never an external fetch. */
    sourceBytes(planId: string): Uint8Array {
      live();
      const value = plans.get(planId);
      if (!value || typeof value === 'symbol') throw new Error('unknown-preview');
      return new Uint8Array(value.bytes);
    },
    release(planId: string) {
      plans.delete(planId);
    },
    dispose() {
      disposed = true;
      plans.clear();
    },
  };
}
