import type {
  Budgets,
  Diagnostic,
  Field,
  GeoDocument,
  Pin,
  ReadonlyKeyJoin,
  Scalar,
  SourceSnapshot,
  VectorLayer,
} from './model';
import { checkedJson } from './json-boundary';
import { assertGeo, hash, id, record } from './validation';

export type DeepReadonly<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;
export interface KeyJoinLimits {
  native: Budgets;
  /** Combined left + right rows at execution; total document rows during capture. */
  inputRows: number;
  outputRows: number;
  diagnostics: number;
  outputBytes: number;
}
interface SnapshotData {
  pin: Pin;
  layer: VectorLayer;
  sources: SourceSnapshot[];
}
/** Issued in-process snapshot, detached/frozen; source pin authenticity remains Host-owned. */
export type KeyJoinSnapshot = DeepReadonly<SnapshotData>;
export interface KeyJoinDiagnostic extends Diagnostic {
  side: 'left' | 'right';
  fieldId: string;
  featureId?: string;
  rowId?: string;
}
export interface JoinedRow {
  featureId: string;
  rowId: string;
  key: Scalar;
  status: 'matched' | 'unmatched' | 'null-key';
  leftValues: Record<string, Scalar>;
  right: { featureId: string; rowId: string; values: Record<string, Scalar> } | null;
}
export interface JoinCounts {
  leftRows: number;
  rightRows: number;
  matchedLeftRows: number;
  unmatchedLeftRows: number;
  unusedRightRows: number;
  nullKeys: { left: number; right: number };
  missingKeyRows: { left: number; right: number };
  typeMismatchRows: { left: number; right: number };
  duplicateKeyRows: { left: number; right: number };
}
interface JoinResult {
  access: 'readonly';
  status: 'ready' | 'blocked';
  contract: ReadonlyKeyJoin;
  inputs: {
    left: { pin: Pin; layerId: string; sources: SourceSnapshot[] };
    right: { pin: Pin; layerId: string; sources: SourceSnapshot[] };
  };
  fields: { left: Field[]; right: Field[] };
  counts: JoinCounts;
  /** Empty for blocked joins: no arbitrary partial or first-match result. */
  rows: JoinedRow[];
  diagnostics: KeyJoinDiagnostic[];
}
export type ReadonlyJoinResult = DeepReadonly<JoinResult>;
const issued = new WeakSet<object>();
const samePin = (a: DeepReadonly<Pin>, b: DeepReadonly<Pin>) =>
  a.artifactId === b.artifactId && a.versionId === b.versionId && a.contentHash === b.contentHash;
function freeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
function validateLimits(limits: KeyJoinLimits) {
  checkedJson(limits.native, limits.native);
  if (
    !['inputRows', 'outputRows', 'diagnostics', 'outputBytes'].every(
      (k) =>
        Number.isSafeInteger(limits[k as keyof KeyJoinLimits]) &&
        (limits[k as keyof KeyJoinLimits] as number) > 0,
    )
  )
    throw new Error('join-limits');
}
function validPin(value: unknown): value is Pin {
  return (
    record(value) &&
    Object.keys(value).length === 3 &&
    ['artifactId', 'versionId', 'contentHash'].every((k) => Object.hasOwn(value, k)) &&
    id(value.artifactId) &&
    id(value.versionId) &&
    hash(value.contentHash)
  );
}

/** Only this entrypoint issues inputs; copied/fabricated snapshots are not authenticated restores. */
export function captureKeyJoinSnapshot(
  document: GeoDocument,
  layerId: string,
  pin: Pin,
  limits: KeyJoinLimits,
): KeyJoinSnapshot {
  validateLimits(limits);
  checkedJson(
    { document, layerId, pin },
    { ...limits.native, features: Math.min(limits.native.features, limits.inputRows) },
  );
  if (!id(layerId) || !validPin(pin)) throw new Error('join-snapshot-pin');
  assertGeo(document, limits.native);
  const layer = document.layers.find((l) => l.id === layerId);
  if (!layer) throw new Error('join-missing-layer');
  const required = new Set(
    layer.features.flatMap((f) => (f.sourceRef ? [f.sourceRef.sourceId] : [])),
  );
  const data = structuredClone({
    pin,
    layer,
    sources: document.sources.filter((s) => required.has(s.id)),
  });
  const snapshot = freeze(data);
  issued.add(snapshot);
  return snapshot;
}

const contractKeys = [
  'left',
  'right',
  'leftFieldId',
  'rightFieldId',
  'keyType',
  'cardinality',
  'normalization',
  'nullPolicy',
  'duplicatePolicy',
  'resultAccess',
];
const validContract = (contract: unknown): contract is ReadonlyKeyJoin =>
  record(contract) &&
  Object.keys(contract).length === contractKeys.length &&
  contractKeys.every((k) => Object.hasOwn(contract, k)) &&
  validPin(contract.left) &&
  validPin(contract.right) &&
  id(contract.leftFieldId) &&
  id(contract.rightFieldId) &&
  ['string', 'number'].includes(contract.keyType as string) &&
  ['one-to-one', 'many-to-one'].includes(contract.cardinality as string) &&
  contract.normalization === 'none' &&
  contract.nullPolicy === 'unmatched' &&
  contract.duplicatePolicy === 'reject' &&
  contract.resultAccess === 'readonly';
function assertJoinInputs(
  contract: ReadonlyKeyJoin,
  left: KeyJoinSnapshot,
  right: KeyJoinSnapshot,
  limits: KeyJoinLimits,
) {
  if (!issued.has(left) || !issued.has(right)) throw new Error('join-unissued-snapshot');
  if (left.layer.features.length + right.layer.features.length > limits.inputRows)
    throw new Error('join-input-row-limit');
  checkedJson({ contract, left, right }, limits.native);
  if (!validContract(contract)) throw new Error('join-contract');
  if (!samePin(contract.left, left.pin) || !samePin(contract.right, right.pin))
    throw new Error('join-pin-mismatch');
  // The same declared immutable artifact version cannot have two hash values; the same
  // layer/pin cannot have different captured data. No external hash verification implied.
  if (left.pin.artifactId === right.pin.artifactId && left.pin.versionId === right.pin.versionId) {
    if (!samePin(left.pin, right.pin)) throw new Error('join-pin-conflict');
    if (
      left.layer.id === right.layer.id &&
      checkedJson(left, limits.native) !== checkedJson(right, limits.native)
    )
      throw new Error('join-snapshot-conflict');
  }
}
type Side = 'left' | 'right';
type Row = DeepReadonly<VectorLayer['features'][number]>;
type Index = Map<string | number, Row[]>;
const emptyCounts = (left: KeyJoinSnapshot, right: KeyJoinSnapshot): JoinCounts => ({
  leftRows: left.layer.features.length,
  rightRows: right.layer.features.length,
  matchedLeftRows: 0,
  unmatchedLeftRows: 0,
  unusedRightRows: 0,
  nullKeys: { left: 0, right: 0 },
  missingKeyRows: { left: 0, right: 0 },
  typeMismatchRows: { left: 0, right: 0 },
  duplicateKeyRows: { left: 0, right: 0 },
});
/** Diagnostics are bounded by count and by their share of the output byte budget. */
function createDiagnostics(limits: KeyJoinLimits) {
  const items: KeyJoinDiagnostic[] = [];
  let bytes = 0;
  const report = (
    code: string,
    side: Side,
    fieldId: string,
    severity: Diagnostic['severity'],
    feature?: Row,
  ) => {
    if (items.length >= limits.diagnostics) throw new Error('join-diagnostic-limit');
    const item: KeyJoinDiagnostic = {
      code,
      side,
      fieldId,
      severity,
      path: `${side}.${fieldId}`,
      ...(feature ? { featureId: feature.id, rowId: feature.rowId } : {}),
    };
    const separator = items.length ? 1 : 0;
    bytes += separator + encodedBytes(item, limits.outputBytes - bytes - separator, limits);
    items.push(item);
  };
  return { items, report };
}
type Diagnose = ReturnType<typeof createDiagnostics>['report'];
function encodedBytes(value: unknown, remaining: number, limits: KeyJoinLimits) {
  if (remaining <= 0) throw new Error('join-output-byte-limit');
  const encoded = checkedJson(value, { ...limits.native, bytes: remaining });
  return new TextEncoder().encode(encoded).length;
}
function indexSide(
  snapshot: KeyJoinSnapshot,
  side: Side,
  fieldId: string,
  contract: ReadonlyKeyJoin,
  counts: JoinCounts,
  diagnose: Diagnose,
): Index {
  const result: Index = new Map();
  const field = snapshot.layer.fields.find((f) => f.id === fieldId);
  if (!field) {
    counts.missingKeyRows[side] = snapshot.layer.features.length;
    diagnose('missing-key-field', side, fieldId, 'error');
    return result;
  }
  if (field.type !== contract.keyType) diagnose('key-type-mismatch', side, fieldId, 'error');
  for (const row of snapshot.layer.features) {
    const value = row.values[fieldId];
    if (value === null) {
      counts.nullKeys[side]++;
      diagnose('null-key', side, fieldId, 'warning', row);
      continue;
    }
    if (typeof value !== contract.keyType) {
      counts.typeMismatchRows[side]++;
      diagnose('key-type-mismatch', side, fieldId, 'error', row);
      continue;
    }
    const key = value as string | number;
    const rows = result.get(key) ?? [];
    rows.push(row);
    result.set(key, rows);
  }
  // Input iteration order and first occurrence order are preserved; no sorting/coercion.
  const allowed = side === 'left' && contract.cardinality === 'many-to-one';
  for (const rows of result.values())
    if (rows.length > 1) {
      counts.duplicateKeyRows[side] += rows.length;
      for (const row of rows)
        diagnose(
          allowed ? 'repeated-left-key' : 'duplicate-key',
          side,
          fieldId,
          allowed ? 'warning' : 'error',
          row,
        );
    }
  return result;
}
/** Rows whose key has no partner on the other side; returns how many were reported. */
function reportUnpaired(index: Index, other: Index, report: (row: Row) => void) {
  let count = 0;
  for (const [key, rows] of index)
    if (!other.has(key)) {
      count += rows.length;
      for (const row of rows) report(row);
    }
  return count;
}
function joinedRow(row: Row, leftFieldId: string, rightIndex: Index): JoinedRow {
  const key = row.values[leftFieldId];
  const matches = key === null ? undefined : rightIndex.get(key as string | number);
  if (matches && matches.length !== 1) throw new Error('join-duplicate-invariant');
  const match = matches?.[0]; // Explicit uniqueness invariant above; never an arbitrary first match.
  return {
    featureId: row.id,
    rowId: row.rowId,
    key,
    status: key === null ? 'null-key' : match ? 'matched' : 'unmatched',
    leftValues: row.values,
    right: match ? { featureId: match.id, rowId: match.rowId, values: match.values } : null,
  };
}

/** Deterministic synchronous projection. No commands, source updates, fetch or history. */
export function runReadonlyKeyJoin(
  contract: ReadonlyKeyJoin,
  left: KeyJoinSnapshot,
  right: KeyJoinSnapshot,
  limits: KeyJoinLimits,
): ReadonlyJoinResult {
  validateLimits(limits);
  assertJoinInputs(contract, left, right, limits);
  const counts = emptyCounts(left, right);
  const diagnostics = createDiagnostics(limits);
  const diagnose = diagnostics.report;
  const leftIndex = indexSide(left, 'left', contract.leftFieldId, contract, counts, diagnose),
    rightIndex = indexSide(right, 'right', contract.rightFieldId, contract, counts, diagnose);
  const compatibleFields =
    left.layer.fields.find((f) => f.id === contract.leftFieldId)?.type === contract.keyType &&
    right.layer.fields.find((f) => f.id === contract.rightFieldId)?.type === contract.keyType;
  if (compatibleFields) {
    counts.unmatchedLeftRows += reportUnpaired(leftIndex, rightIndex, (row) =>
      diagnose('unmatched-key', 'left', contract.leftFieldId, 'warning', row),
    );
    counts.unusedRightRows += reportUnpaired(rightIndex, leftIndex, (row) =>
      diagnose('unused-right-key', 'right', contract.rightFieldId, 'warning', row),
    );
  }
  const blocked = diagnostics.items.some((d) => d.severity === 'error');
  if (!blocked)
    for (const [key, rows] of leftIndex)
      if (rightIndex.has(key)) counts.matchedLeftRows += rows.length;
  if (!blocked && left.layer.features.length > limits.outputRows)
    throw new Error('join-output-row-limit');
  const result: JoinResult = {
    access: 'readonly',
    status: blocked ? 'blocked' : 'ready',
    contract: structuredClone(contract),
    inputs: {
      left: { pin: left.pin, layerId: left.layer.id, sources: left.sources as SourceSnapshot[] },
      right: {
        pin: right.pin,
        layerId: right.layer.id,
        sources: right.sources as SourceSnapshot[],
      },
    },
    fields: { left: left.layer.fields as Field[], right: right.layer.fields as Field[] },
    counts,
    rows: [],
    diagnostics: diagnostics.items,
  };
  // Reserve complete metadata and diagnostics first, then charge every row before adding it.
  // A many-to-one result references frozen values, rather than cloning a large right row N times.
  let outputBytes = encodedBytes(result, limits.outputBytes, limits);
  if (!blocked)
    for (const row of left.layer.features) {
      const joined = joinedRow(row, contract.leftFieldId, rightIndex);
      const separator = result.rows.length ? 1 : 0;
      outputBytes +=
        separator + encodedBytes(joined, limits.outputBytes - outputBytes - separator, limits);
      result.rows.push(joined);
    }
  return freeze(result);
}
