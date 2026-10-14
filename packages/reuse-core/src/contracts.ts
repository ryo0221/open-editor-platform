import {
  clone,
  contentHash,
  canonicalJson,
  deepFreeze,
  isDeepFrozen,
} from '@editor-platform/artifact-core';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { assertComponentProperties, checkedComponentContract } from './properties';
import { validateRetainedStyles } from './retained-styles';
export const reuseHash = (value: unknown): string => bytesToHex(sha256(canonicalJson(value)));

export const reuseDomains = [
  'design',
  'document',
  'slide',
  'whiteboard',
  'data',
  'review',
  'file',
] as const;
export type ReuseDomain = (typeof reuseDomains)[number];
export type DefinitionKind =
  | 'tokens'
  | 'style'
  | 'component'
  | 'pattern'
  | 'template'
  | 'view-preset';
export interface ReuseAddress {
  definitionId?: string;
  instanceId?: string;
  partId?: string;
  slotId?: string;
  nativeId?: string;
  path?: string;
  revision?: number;
}
export interface ReuseDiagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  domain?: ReuseDomain;
  address: ReuseAddress;
  message: string;
  recovery: string;
}
export class ReuseError extends Error {
  constructor(readonly diagnostics: ReuseDiagnostic[]) {
    super(diagnostics.map((d) => d.message).join('\n'));
    this.name = 'ReuseError';
  }
  get code() {
    return this.diagnostics[0]?.code;
  }
}
export function rejectReuse(code: string, message: string, address: ReuseAddress = {}): never {
  throw new ReuseError([
    {
      code,
      severity: 'error',
      address,
      message,
      recovery: 'Correct the addressed definition or keep the adopted version, then prepare again.',
    },
  ]);
}
export const reuseLimits = Object.freeze({
  definitions: 100,
  dependencyDepth: 16,
  tokens: 2048,
  modes: 16,
  aliasDepth: 32,
  jsonDepth: 64,
  values: 200000,
  bytes: 32 * 1024 * 1024,
  instances: 2000,
  parts: 10000,
  expandedParts: 20000,
});
export type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };
export const stableId = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(v) &&
  !['__proto__', 'prototype', 'constructor'].includes(v);
/** A scoped native address can contain several bounded component-local IDs. */
export const nativeAddress = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 4096 && v.split('/').every(stableId);
export function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
/** Reject executable/non-JSON values and bound traversal before cloning or hashing. */
const utf8Encoder = new TextEncoder();
const utf8Length = (value: string) =>
  // eslint-disable-next-line no-control-regex -- exact ASCII byte fast path
  /^[\x00-\x7f]*$/.test(value) ? value.length : utf8Encoder.encode(value).length;
const jsonStringBytes = (value: string) =>
  // eslint-disable-next-line no-control-regex -- strings needing JSON escapes or UTF-8 encoding
  /["\\\x00-\x1f\x80-\uffff]/.test(value) ? utf8Length(JSON.stringify(value)) : value.length + 2;
interface JsonBudget {
  count: number;
  bytes: number;
  depth: number;
  jsonBytes: number;
}
// Certified immutable subtrees cannot acquire a cycle, new key, or changed bytes.
// Include their full costs on every occurrence; sharing never discounts a budget.
const jsonBudgets = new WeakMap<object, JsonBudget>();
export function assertReuseJson(value: unknown, maxBytes: number = reuseLimits.bytes): void {
  let count = 0,
    bytes = 0,
    jsonBytes = 0;
  const active = new Set<object>();
  const check = (depth: number) => {
    if (count > reuseLimits.values || depth > reuseLimits.jsonDepth)
      rejectReuse('reuse-limit', 'Reusable data exceeds the value/depth budget');
    if (bytes > maxBytes) rejectReuse('reuse-limit', 'Reusable data exceeds the byte budget');
  };
  const walk = (v: unknown, depth: number): number => {
    const cached = v && typeof v === 'object' ? jsonBudgets.get(v) : undefined;
    if (cached) {
      count += cached.count;
      bytes += cached.bytes;
      jsonBytes += cached.jsonBytes;
      check(depth + cached.depth);
      return cached.depth;
    }
    const beforeCount = count,
      beforeBytes = bytes,
      beforeJsonBytes = jsonBytes;
    count++;
    check(depth);
    let nestedDepth = 0;
    if (typeof v === 'string') {
      bytes += utf8Length(v);
      jsonBytes += jsonStringBytes(v);
    } else if (v === null || typeof v === 'boolean') {
      bytes += 5;
      jsonBytes += v === false ? 5 : 4;
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      bytes += 24;
      jsonBytes += JSON.stringify(v).length;
    } else if (v && typeof v === 'object') {
      if (active.has(v))
        rejectReuse('reuse-cycle', 'Cyclic JavaScript data is not a portable definition');
      const array = Array.isArray(v);
      if (!array && !record(v)) rejectReuse('reuse-schema', 'Expected plain JSON data');
      // Portable data must not change its serialized representation by running
      // an own or inherited hook, including non-enumerable methods/accessors.
      if ('toJSON' in v) {
        let owner: object | null = v;
        while (owner && !Object.hasOwn(owner, 'toJSON')) owner = Object.getPrototypeOf(owner);
        const descriptor = owner && Object.getOwnPropertyDescriptor(owner, 'toJSON');
        if (descriptor && (!('value' in descriptor) || typeof descriptor.value === 'function'))
          rejectReuse('reuse-schema', 'Executable JSON serialization is not portable');
      }
      const entries = Object.entries(v);
      if (
        array &&
        (entries.length !== v.length || entries.some(([key], index) => key !== String(index)))
      )
        rejectReuse('reuse-schema', 'Sparse arrays and named array properties are not portable');
      active.add(v);
      jsonBytes += 2 + (array ? Math.max(0, entries.length - 1) : 0);
      let properties = 0;
      for (const [key, child] of entries) {
        if (['__proto__', 'prototype', 'constructor'].includes(key))
          rejectReuse('reuse-key', 'Reserved property key', { path: key });
        bytes += utf8Length(key) + 4;
        check(depth);
        if (child !== undefined || array) {
          if (!array) jsonBytes += jsonStringBytes(key) + 1 + (properties++ ? 1 : 0);
          nestedDepth = Math.max(nestedDepth, walk(child, depth + 1) + 1);
        }
      }
      active.delete(v);
    } else rejectReuse('reuse-schema', 'Non-JSON value in reusable data');
    check(depth);
    if (v && typeof v === 'object' && isDeepFrozen(v))
      jsonBudgets.set(v, {
        count: count - beforeCount,
        bytes: bytes - beforeBytes,
        depth: nestedDepth,
        jsonBytes: jsonBytes - beforeJsonBytes,
      });
    return nestedDepth;
  };
  walk(value, 0);
  // Exact JSON punctuation, escaping and UTF-8 costs are accumulated during the
  // same validation. Cached trees still pay their full serialized size on every
  // occurrence, without allocating their entire JSON again for every instance.
  if (jsonBytes > maxBytes) rejectReuse('reuse-limit', 'Reusable JSON exceeds the byte budget');
}
export interface DefinitionRef {
  libraryId: string;
  definitionId: string;
  version: number;
  hash: string;
  kind: DefinitionKind;
  domain: ReuseDomain | 'shared';
}
export interface ReusableDefinition<T = JsonValue> extends DefinitionRef {
  schemaVersion: 1;
  name: string;
  dependencies: DefinitionRef[];
  payload: T;
}
export function refKey(ref: Pick<DefinitionRef, 'libraryId' | 'definitionId' | 'version'>): string {
  return JSON.stringify([ref.libraryId, ref.definitionId, ref.version]);
}
export function definitionRef(d: DefinitionRef): DefinitionRef {
  return {
    libraryId: d.libraryId,
    definitionId: d.definitionId,
    version: d.version,
    hash: d.hash,
    kind: d.kind,
    domain: d.domain,
  };
}
export function validateRef(raw: unknown): asserts raw is DefinitionRef {
  if (
    !record(raw) ||
    !stableId(raw.libraryId) ||
    !stableId(raw.definitionId) ||
    !Number.isSafeInteger(raw.version) ||
    Number(raw.version) < 1 ||
    typeof raw.hash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(raw.hash) ||
    typeof raw.kind !== 'string' ||
    !['tokens', 'style', 'component', 'pattern', 'template', 'view-preset'].includes(raw.kind) ||
    typeof raw.domain !== 'string' ||
    ![...reuseDomains, 'shared'].includes(raw.domain)
  )
    rejectReuse('reference-schema', 'Invalid exact definition reference');
  if (raw.domain === 'shared' && raw.kind !== 'tokens')
    rejectReuse('reference-domain', 'Only token definitions are independent of a native domain');
}
function checkHeader(raw: unknown): asserts raw is ReusableDefinition<unknown> {
  if (
    !record(raw) ||
    raw.schemaVersion !== 1 ||
    typeof raw.name !== 'string' ||
    !raw.name.trim() ||
    !Array.isArray(raw.dependencies) ||
    raw.dependencies.length > reuseLimits.definitions ||
    !Object.hasOwn(raw, 'payload') ||
    raw.payload === undefined
  )
    rejectReuse('definition-schema', 'Unsupported reusable definition schema');
  validateRef(raw);
  raw.dependencies.forEach(validateRef);
  if (new Set(raw.dependencies.map(refKey)).size !== raw.dependencies.length)
    rejectReuse('dependency-duplicate', 'Duplicate dependency identity');
}
export async function sealReusableDefinition<T>(
  value: Omit<ReusableDefinition<T>, 'hash'>,
): Promise<ReusableDefinition<T>> {
  assertReuseJson(value);
  const payload = clone(value);
  delete (payload as Partial<ReusableDefinition<T>>).hash;
  const d = { ...payload, hash: await contentHash(payload) };
  checkHeader(d);
  return deepFreeze(d);
}
export async function validateReusableDefinition<T = JsonValue>(
  value: unknown,
): Promise<ReusableDefinition<T>> {
  return validateReusableDefinitionSync<T>(value);
}
const validatedDefinitions = new WeakMap<object, ReusableDefinition<unknown>>();
export function validateReusableDefinitionSync<T = JsonValue>(
  value: unknown,
): ReusableDefinition<T> {
  if (value && typeof value === 'object' && validatedDefinitions.has(value))
    return validatedDefinitions.get(value) as ReusableDefinition<T>;
  assertReuseJson(value);
  checkHeader(value);
  const { hash, ...unsigned } = value;
  if (hash !== reuseHash(unsigned))
    rejectReuse('definition-hash', 'Reusable definition content does not match its exact hash', {
      definitionId: value.definitionId,
    });
  const result = deepFreeze(clone(value)) as ReusableDefinition<T>;
  if (isDeepFrozen(value)) validatedDefinitions.set(value, result);
  validatedDefinitions.set(result, result);
  return result;
}
export interface LockedClosure<T = JsonValue> {
  schemaVersion: 1;
  roots: DefinitionRef[];
  definitions: ReusableDefinition<T>[];
  hash: string;
}
/** Pure, offline closure. Host discovery/fetch/authorization happens before this call. */
export async function lockClosure<T = JsonValue>(
  roots: DefinitionRef[],
  values: ReusableDefinition<T>[],
): Promise<LockedClosure<T>> {
  return lockClosureSync(roots, values);
}
export function lockClosureSync<T = JsonValue>(
  roots: DefinitionRef[],
  values: ReusableDefinition<T>[],
): LockedClosure<T> {
  assertReuseJson({ roots, values });
  if (!roots.length || values.length > reuseLimits.definitions)
    rejectReuse('closure-limit', 'Closure needs roots and at most 100 definitions');
  roots.forEach(validateRef);
  const all = new Map<string, ReusableDefinition<T>>();
  for (const value of values) {
    const d = validateReusableDefinitionSync<T>(value),
      key = refKey(d);
    if (all.has(key))
      rejectReuse('definition-conflict', 'Duplicate immutable identity in closure', {
        definitionId: d.definitionId,
      });
    all.set(key, d);
  }
  const used = new Map<string, ReusableDefinition<T>>(),
    active = new Set<string>();
  const heights = new Map<string, number>();
  const visit = (ref: DefinitionRef): number => {
    const key = refKey(ref),
      d = all.get(key);
    if (!d)
      rejectReuse('dependency-missing', 'An exact dependency is missing', {
        definitionId: ref.definitionId,
      });
    if (d.hash !== ref.hash || d.domain !== ref.domain || d.kind !== ref.kind)
      rejectReuse('dependency-mismatch', 'Dependency identity/hash/capability disagrees', {
        definitionId: ref.definitionId,
      });
    if (active.has(key))
      rejectReuse('dependency-cycle', 'Cyclic reusable dependency', {
        definitionId: ref.definitionId,
      });
    if (heights.has(key)) return heights.get(key)!;
    if (active.size >= reuseLimits.dependencyDepth)
      rejectReuse('closure-depth', 'Dependency graph exceeds nesting budget');
    active.add(key);
    const height = 1 + Math.max(0, ...d.dependencies.map(visit));
    if (height > reuseLimits.dependencyDepth)
      rejectReuse('closure-depth', 'Dependency graph exceeds nesting budget');
    active.delete(key);
    heights.set(key, height);
    used.set(key, d);
    return height;
  };
  roots.forEach(visit);
  if (used.size !== all.size)
    rejectReuse('closure-extra', 'Closure contains unreferenced definitions');
  const order = (a: DefinitionRef, b: DefinitionRef) =>
    refKey(a) < refKey(b) ? -1 : refKey(a) > refKey(b) ? 1 : 0;
  const sortedRoots = [...new Map(roots.map((r) => [refKey(r), definitionRef(r)])).values()].sort(
    order,
  );
  const definitions = [...used.values()].sort(order);
  return deepFreeze({
    schemaVersion: 1,
    roots: sortedRoots,
    definitions,
    hash: reuseHash({ roots: sortedRoots, definitions }),
  });
}
export async function validateClosure<T = JsonValue>(raw: unknown): Promise<LockedClosure<T>> {
  return validateClosureSync<T>(raw);
}
const validatedClosures = new WeakMap<object, LockedClosure<unknown>>();
export function validateClosureSync<T = JsonValue>(raw: unknown): LockedClosure<T> {
  if (raw && typeof raw === 'object' && validatedClosures.has(raw))
    return validatedClosures.get(raw) as LockedClosure<T>;
  assertReuseJson(raw);
  if (
    !record(raw) ||
    raw.schemaVersion !== 1 ||
    !Array.isArray(raw.roots) ||
    !Array.isArray(raw.definitions)
  )
    rejectReuse('closure-schema', 'Unsupported lock closure schema');
  const locked = lockClosureSync(
    raw.roots as DefinitionRef[],
    raw.definitions as ReusableDefinition<T>[],
  );
  if (locked.hash !== raw.hash) rejectReuse('closure-hash', 'Lock closure fingerprint mismatch');
  if (isDeepFrozen(raw)) validatedClosures.set(raw, locked);
  validatedClosures.set(locked, locked);
  return locked;
}
/** Native content is authoritative; these references never store a second editable document. */
export interface ReuseInstance {
  id: string;
  ref: DefinitionRef;
  closureHash: string;
  mode?: string;
  variant?: string;
  inputs: Record<string, JsonValue>;
  overrides: Record<string, Record<string, JsonValue>>;
  parts: Record<string, string>;
  /** Definition-local native references (component/style/field IDs) retained across remaps. */
  nativeIds?: Record<string, string>;
  slots: Record<string, string[]>;
}
export interface ReuseState {
  schemaVersion: 1;
  artifactMode?: string;
  closures: LockedClosure<unknown>[];
  instances: ReuseInstance[];
}
/** Structural read only; use validateReuseState at an untrusted load/pack boundary.
 * Absence is the legacy copy-only state. Never rewrite immutable native versions. */
export function readReuseState(raw: unknown): ReuseState | undefined {
  const state = checkReuseState(raw);
  return state && clone(state);
}
const checkedInstanceShapes = new WeakSet<object>();
function checkReuseState(raw: unknown): ReuseState | undefined {
  if (raw === undefined) return undefined;
  assertReuseJson(raw);
  if (
    !record(raw) ||
    raw.schemaVersion !== 1 ||
    (raw.artifactMode !== undefined && !stableId(raw.artifactMode)) ||
    !Array.isArray(raw.closures) ||
    !Array.isArray(raw.instances) ||
    raw.closures.length > reuseLimits.definitions ||
    raw.instances.length > reuseLimits.instances
  )
    rejectReuse('instance-schema', 'Unsupported reusable instance state');
  const ids = new Set<string>();
  for (const item of raw.instances) {
    if (
      !record(item) ||
      !stableId(item.id) ||
      ids.has(item.id) ||
      typeof item.closureHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.closureHash) ||
      !record(item.inputs) ||
      !record(item.overrides) ||
      !record(item.parts) ||
      !record(item.slots)
    )
      rejectReuse('instance-schema', 'Invalid reusable instance');
    ids.add(item.id);
    if (checkedInstanceShapes.has(item)) continue;
    validateRef(item.ref);
    if (
      (item.mode !== undefined && !stableId(item.mode)) ||
      (item.variant !== undefined && !stableId(item.variant))
    )
      rejectReuse('instance-schema', 'Invalid instance mode/variant identity');
    const partMap = item.parts;
    if (
      item.nativeIds !== undefined &&
      (!record(item.nativeIds) ||
        Object.entries(item.nativeIds).some(([id, native]) => !stableId(id) || !stableId(native)))
    )
      rejectReuse('native-map', 'Invalid retained native reference mapping');
    if (
      Object.entries(item.overrides).some(
        ([part, fields]) => !Object.hasOwn(partMap, part) || !record(fields),
      )
    )
      rejectReuse('override-schema', 'Explicit override must address an existing stable part');
    if (
      Object.keys(item.parts).length > reuseLimits.parts ||
      Object.entries(item.parts).some(
        ([part, native]) => !stableId(part) || !nativeAddress(native),
      ) ||
      new Set(Object.values(item.parts)).size !== Object.keys(item.parts).length
    )
      rejectReuse('part-map', 'Invalid or aliased native part mapping');
    if (
      Object.entries(item.slots).some(
        ([slot, native]) =>
          !stableId(slot) || !Array.isArray(native) || native.some((id) => !nativeAddress(id)),
      )
    )
      rejectReuse('slot-map', 'Invalid native slot mapping');
    if (isDeepFrozen(item)) checkedInstanceShapes.add(item);
  }
  return raw as unknown as ReuseState;
}
export async function validateReuseState(raw: unknown): Promise<ReuseState | undefined> {
  return validateReuseStateSync(raw);
}
const validatedStates = new WeakMap<object, ReuseState>();
/** Authority/load validation is synchronous. Cache only recursively immutable validated values. */
export function validateReuseStateSync(raw: unknown): ReuseState | undefined {
  if (raw && typeof raw === 'object' && validatedStates.has(raw)) return validatedStates.get(raw);
  const state = checkReuseState(raw);
  if (!state) return undefined;
  const closures = state.closures.map((value) => validateClosureSync(value));
  if (new Set(closures.map((c) => c.hash)).size !== closures.length)
    rejectReuse('closure-duplicate', 'Duplicate adopted closure');
  const supportedModes = new Map(
    closures.map((closure) => [closure.hash, validateRetainedStyles(closure)]),
  );
  for (const instance of state.instances) {
    const closure = closures.find((c) => c.hash === instance.closureHash);
    const definition = closure?.definitions.find((d) => refKey(d) === refKey(instance.ref));
    if (
      !definition ||
      definition.hash !== instance.ref.hash ||
      definition.domain !== instance.ref.domain ||
      definition.kind !== instance.ref.kind
    )
      rejectReuse(
        'instance-dependency',
        'Instance does not resolve to its retained exact definition',
        { instanceId: instance.id },
      );
    const modes = supportedModes.get(instance.closureHash)!.get(refKey(definition));
    const selectedMode = instance.mode ?? state.artifactMode;
    if (
      (instance.mode !== undefined && !modes) ||
      (modes && selectedMode !== undefined && !modes.includes(selectedMode))
    )
      rejectReuse('token-mode', 'The adopted component mode does not exist', {
        instanceId: instance.id,
        path: selectedMode,
      });
    if (record(definition.payload) && definition.payload.contract !== undefined) {
      const contract = checkedComponentContract(definition.payload.contract);
      assertComponentProperties(contract, instance.inputs, instance.variant);
      const partIds = new Set(contract.parts.map((part) => part.id));
      if (
        contract.parts.some((p) => !Object.hasOwn(instance.parts, p.id)) ||
        Object.keys(instance.parts).some((p) => !partIds.has(p))
      )
        rejectReuse('instance-parts', 'Instance mappings must match declared stable parts', {
          instanceId: instance.id,
        });
      for (const [id, values] of Object.entries(instance.slots)) {
        const slot = contract.slots.find((s) => s.id === id);
        if (!slot || values.length > slot.max || values.length < slot.min)
          rejectReuse('slot-count', 'Adopted slot is not declared or exceeds its count', {
            instanceId: instance.id,
            slotId: id,
          });
      }
      for (const slot of contract.slots)
        if ((instance.slots[slot.id]?.length ?? 0) < slot.min)
          rejectReuse('slot-required', 'Required slot has no adopted content', {
            instanceId: instance.id,
            slotId: slot.id,
          });
    }
  }
  // Charge every occurrence, including cached instances with no slot edges.
  const expanded = state.instances.reduce(
    (count, item) => count + Object.keys(item.parts).length,
    0,
  );
  if (expanded > reuseLimits.expandedParts)
    rejectReuse('expanded-limit', 'Adopted parts exceed the expansion budget');
  // An empty edge set cannot form a cycle. Avoid building the full address index
  // for the common independent-instance case; linked slots still check the graph.
  if (
    state.instances.some((item) => Object.values(item.slots).some((addresses) => addresses.length))
  ) {
    const owners = new Map<string, Set<string>>();
    for (const instance of state.instances)
      for (const address of Object.values(instance.parts)) {
        const segments = instance.ref.domain === 'design' ? address.split('/') : [address];
        for (let count = 1; count <= segments.length; count++) {
          const prefix = segments.slice(0, count).join('/'),
            ids = owners.get(prefix) ?? new Set<string>();
          ids.add(instance.id);
          owners.set(prefix, ids);
        }
      }
    const children = new Map(
      state.instances.map((instance) => [
        instance.id,
        new Set(
          Object.values(instance.slots)
            .flat()
            .flatMap((address) => [...(owners.get(address) ?? [])]),
        ),
      ]),
    );
    const active = new Set<string>(),
      heights = new Map<string, number>();
    const height = (id: string): number => {
      if (active.has(id))
        rejectReuse('slot-cycle', 'Adopted instance slots form a cycle', { instanceId: id });
      if (heights.has(id)) return heights.get(id)!;
      if (active.size >= reuseLimits.dependencyDepth)
        rejectReuse('slot-depth', 'Adopted instance slots exceed their depth', { instanceId: id });
      active.add(id);
      const value = 1 + Math.max(0, ...[...(children.get(id) ?? [])].map(height));
      active.delete(id);
      if (value > reuseLimits.dependencyDepth)
        rejectReuse('slot-depth', 'Adopted instance slots exceed their depth', { instanceId: id });
      heights.set(id, value);
      return value;
    };
    state.instances.forEach((instance) => height(instance.id));
  }
  const result = deepFreeze({
    ...state,
    closures,
    instances: state.instances.map((instance) =>
      isDeepFrozen(instance) ? instance : clone(instance),
    ),
  });
  if (raw && typeof raw === 'object' && isDeepFrozen(raw)) validatedStates.set(raw, result);
  validatedStates.set(result, result);
  return result;
}
export function validNativeReuse(raw: unknown, domain: ReuseDomain): boolean {
  try {
    const state = validateReuseStateSync(raw);
    return !state || state.instances.every((i) => i.ref.domain === domain);
  } catch {
    return false;
  }
}
