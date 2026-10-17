import { EditorSession, EditorInputs } from '@editor-platform/editor-core';
import {
  SCHEMA_EDIT_EXPERIMENT_VERSION,
  type SchemaEditManifest,
  type SchemaEditIdentity,
  type SchemaEditProfile,
  type SchemaEditGrant,
} from '@editor-platform/extension-contract/schema-edit-experiment';
import type { SchemaEditBinding } from '../schema-edit-experiment';
import type { RecoveryPolicy } from '../draft2/inputs';
import type { Storage } from '../draft2/save';
import { frozen, finite, requireThat } from '../draft2/primitives';
/** Copy own enumerable data descriptors without invoking accessors. Never read input twice. */
export function fields(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  requireThat(input && typeof input === 'object' && !Array.isArray(input), 'manifest');
  requireThat(
    Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null,
    'manifest',
  );
  const descriptors = Object.getOwnPropertyDescriptors(input),
    names = Reflect.ownKeys(descriptors);
  requireThat(
    names.every((key) => typeof key === 'string' && [...required, ...optional].includes(key)),
    'manifest',
  );
  requireThat(
    required.every((key) => Object.hasOwn(descriptors, key)),
    'manifest',
  );
  const result: Record<string, unknown> = Object.create(null);
  for (const key of names) {
    requireThat(typeof key === 'string', 'manifest');
    const descriptor = descriptors[key];
    requireThat(descriptor.enumerable && 'value' in descriptor, 'manifest');
    result[key] = descriptor.value;
  }
  return result;
}
/** Dense ordinary arrays only: reject inherited/hidden/symbol/accessor protocol entries. */
export function list(input: unknown, limit = 128): unknown[] {
  requireThat(
    Array.isArray(input) &&
      Object.getPrototypeOf(input) === Array.prototype &&
      input.length <= limit,
    'manifest',
  );
  const descriptors = Object.getOwnPropertyDescriptors(input),
    names = Reflect.ownKeys(descriptors);
  requireThat(names.length === input.length + 1, 'manifest');
  const result: unknown[] = [];
  for (let i = 0; i < input.length; i++) {
    const d = descriptors[String(i)];
    requireThat(d?.enumerable && 'value' in d, 'manifest');
    result.push(d.value);
  }
  return result;
}
export function text(value: unknown): string {
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= 128, 'manifest');
  return value;
}
export function identity(input: unknown): SchemaEditIdentity {
  const v = fields(input, ['kind', 'value']);
  if (v.kind === 'numeric') {
    requireThat(
      typeof v.value === 'number' && Number.isSafeInteger(v.value) && v.value > 0,
      'schema',
    );
    return Object.freeze({ kind: 'numeric', value: v.value });
  }
  requireThat(v.kind === 'literal', 'schema');
  return Object.freeze({ kind: 'literal', value: text(v.value) });
}
export const sameIdentity = (a: SchemaEditIdentity, b: SchemaEditIdentity) =>
  a.kind === b.kind && a.value === b.value;
export function profile(input: unknown): SchemaEditProfile {
  const v = fields(input, ['artifactKind', 'schemaIdentity']);
  return Object.freeze({
    artifactKind: text(v.artifactKind),
    schemaIdentity: identity(v.schemaIdentity),
  });
}
function request<V extends string, R extends string>(input: unknown, version: V, requirement: R) {
  const v = fields(input, ['version', 'requirement']);
  requireThat(v.version === version && v.requirement === requirement, 'required-addon');
  return Object.freeze({ version, requirement });
}
export function parseManifest(input: unknown): SchemaEditManifest {
  const v = fields(input, [
    'id',
    'version',
    'packageHash',
    'contractVersion',
    'artifactKind',
    'schemaIdentity',
    'surface',
    'permissions',
    'addons',
    'licenseNotices',
  ]);
  requireThat(v.contractVersion === SCHEMA_EDIT_EXPERIMENT_VERSION, 'contract');
  requireThat(typeof v.packageHash === 'string' && /^[a-f0-9]{64}$/.test(v.packageHash), 'pin');
  requireThat(typeof v.surface === 'boolean', 'manifest');
  const permissions = list(v.permissions, 3);
  requireThat(
    Array.isArray(permissions) &&
      permissions[0] === 'artifact:read' &&
      new Set(permissions).size === permissions.length &&
      permissions.slice(1).every((p) => p === 'artifact:edit' || p === 'artifact:save'),
    'manifest',
  );
  const rest: ('artifact:edit' | 'artifact:save')[] = [];
  for (const p of permissions.slice(1)) {
    requireThat(p === 'artifact:edit' || p === 'artifact:save', 'manifest');
    rest.push(p);
  }
  const addons = fields(v.addons, ['lifecycle'], ['edit', 'inputs', 'save']);
  const notices = list(v.licenseNotices);
  requireThat(Array.isArray(notices) && notices.every((n) => typeof n === 'string'), 'manifest');
  return frozen({
    id: text(v.id),
    version: text(v.version),
    packageHash: v.packageHash,
    contractVersion: SCHEMA_EDIT_EXPERIMENT_VERSION,
    artifactKind: text(v.artifactKind),
    schemaIdentity: identity(v.schemaIdentity),
    surface: v.surface,
    permissions: ['artifact:read', ...rest],
    addons: {
      lifecycle: request(addons.lifecycle, 'lifecycle@0-draft', 'required'),
      ...(Object.hasOwn(addons, 'edit')
        ? { edit: request(addons.edit, 'local-edit@0-draft', 'optional') }
        : {}),
      ...(Object.hasOwn(addons, 'inputs')
        ? { inputs: request(addons.inputs, 'inputs@0-draft', 'optional') }
        : {}),
      ...(Object.hasOwn(addons, 'save')
        ? { save: request(addons.save, 'local-persistence@0-draft', 'optional') }
        : {}),
    },
    licenseNotices: notices,
  });
}
function policy(input: unknown): RecoveryPolicy {
  const p = fields(input, ['codecs', 'perBoundaryBytes', 'totalBytes', 'ttlMs', 'onRevoke']);
  for (const n of [p.perBoundaryBytes, p.totalBytes, p.ttlMs])
    requireThat(typeof n === 'number' && finite(n), 'RecoveryPolicy');
  const values = list(p.codecs);
  requireThat(Array.isArray(values), 'RecoveryPolicy');
  const codecs = values.map((value) => {
    const c = fields(value, ['id', 'version']);
    return { id: text(c.id), version: text(c.version) };
  });
  requireThat(
    typeof p.perBoundaryBytes === 'number' &&
      typeof p.totalBytes === 'number' &&
      typeof p.ttlMs === 'number' &&
      (p.onRevoke === 'retain' || p.onRevoke === 'discard'),
    'RecoveryPolicy',
  );
  return frozen({
    codecs,
    perBoundaryBytes: p.perBoundaryBytes,
    totalBytes: p.totalBytes,
    ttlMs: p.ttlMs,
    onRevoke: p.onRevoke,
  });
}
/** Storage is a trusted Host object (class methods allowed); capture its dispatch wiring once. */
function storage<T>(input: Storage<T>): Storage<T> {
  requireThat(input && typeof input === 'object', 'Storage');
  const { key, settlementMs, write, beforeDispatch, retainCapture, markSaved } = input;
  requireThat(typeof key === 'string' && key.length > 0, 'Storage');
  requireThat(finite(settlementMs) && typeof write === 'function', 'Storage');
  for (const f of [beforeDispatch, retainCapture, markSaved])
    requireThat(f === undefined || typeof f === 'function', 'Storage');
  return Object.freeze({
    key,
    settlementMs,
    write: write.bind(input),
    ...(beforeDispatch ? { beforeDispatch: beforeDispatch.bind(input) } : {}),
    ...(retainCapture ? { retainCapture: retainCapture.bind(input) } : {}),
    ...(markSaved ? { markSaved: markSaved.bind(input) } : {}),
  });
}
export function parseBinding<T>(input: SchemaEditBinding<T>): SchemaEditBinding<T> {
  const v = fields(
    input,
    [
      'artifactId',
      'artifactKind',
      'schemaIdentity',
      'session',
      'inputs',
      'allowed',
      'subscribePermissions',
    ],
    ['recovery', 'storage'],
  );
  requireThat(v.session instanceof EditorSession && v.inputs instanceof EditorInputs, 'binding');
  requireThat(
    typeof v.allowed === 'function' && typeof v.subscribePermissions === 'function',
    'binding',
  );
  // Functions are trusted Host providers, but their own field descriptors were checked above.
  const allowed = v.allowed,
    subscribe = v.subscribePermissions;
  return Object.freeze({
    artifactId: text(v.artifactId),
    artifactKind: text(v.artifactKind),
    schemaIdentity: identity(v.schemaIdentity),
    session: v.session,
    inputs: v.inputs,
    allowed: (grant: SchemaEditGrant) => {
      const result = allowed.call(input, grant);
      requireThat(typeof result === 'boolean', 'binding');
      return result;
    },
    subscribePermissions: (listener: () => void) => {
      const stop = subscribe.call(input, listener);
      requireThat(typeof stop === 'function', 'binding');
      return () => {
        stop();
      };
    },
    ...(Object.hasOwn(v, 'recovery') ? { recovery: policy(v.recovery) } : {}),
    ...(Object.hasOwn(v, 'storage') ? { storage: storage(v.storage as Storage<T>) } : {}),
  });
}
