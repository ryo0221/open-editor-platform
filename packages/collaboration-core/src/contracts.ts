import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
/** Wire contracts contain data only. Domain content remains an opaque, separate schema. */
export type Domain =
  | 'document'
  | 'slide'
  | 'design'
  | 'whiteboard'
  | 'data'
  | 'review'
  | 'file'
  | 'react-ui'
  | 'animation';
export type Origin = 'human' | 'agent' | 'proposal' | 'undo' | 'redo' | 'restore';
export interface Identity {
  actorId: string;
  clientId: string;
  sessionId: string;
}
export interface Principal extends Identity {
  writable: boolean;
  scopes: string[];
  expiresAt?: number;
  /** Origins this connection may declare on submitted operations. Defaults to
   * human and locally reviewed proposal input; `agent` needs an explicit Host grant.
   * Undo, redo, restore and authority proposal provenance are never client-declared. */
  origins?: Origin[];
}
export interface Action {
  type: string;
  target: string;
  payload: Record<string, unknown>;
}
export interface Condition {
  key: string;
  stamp: number;
  fingerprint: string;
}
export interface Operation extends Identity {
  protocol: 1;
  schema: 1;
  artifactId: string;
  domain: Domain;
  operationId: string;
  transactionId: string;
  origin: Origin;
  baseRevision: number;
  targets: string[];
  actions: Action[];
  conditions: Condition[];
  undoOf?: string;
  proposalId?: string;
  sourceActorId?: string;
}
export type ErrorCode =
  | 'unauthorized'
  | 'stale-precondition'
  | 'target-deleted'
  | 'schema-mismatch'
  | 'unsupported-operation'
  | 'resync-required'
  | 'protocol-error'
  | 'invalid-operation'
  | 'undo-conflict'
  | 'cancelled'
  | 'asset-unavailable';
export class Conflict extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public keys: string[] = [],
  ) {
    super(message);
  }
}
export type Receipt =
  | { operationId: string; status: 'accepted'; revision: number; durable: false }
  | { operationId: string; status: 'rejected'; code: ErrorCode; message: string; keys: string[] };
export type Anchor =
  | { type: 'text'; from: number; to: number; orphan?: boolean }
  | { type: 'canvas-text'; elementId: string; from: number; to: number; orphan?: boolean }
  | {
      type: 'element';
      elementId: string;
      region?: import('@editor-platform/editor-core').Region;
      orphan?: boolean;
    }
  | {
      type: 'fixed';
      elementId: string;
      versionId: string;
      side?: 'old' | 'new';
      page?: number;
      region?: import('@editor-platform/editor-core').Region;
      orphan?: boolean;
    };
export interface Thread {
  id: string;
  anchor: Anchor;
  resolved: boolean;
  createdAt?: string;
  color?: string;
  replies: { id: string; actorId: string; text: string; createdAt?: string }[];
}
export interface Snapshot<T = unknown> {
  protocol: 1;
  artifactId: string;
  domain: Domain;
  revision: number;
  content: T;
  threads: Thread[];
  stamps: Record<string, number>;
  engineVersion: number;
  /** Per-element text engines; absent means no accepted canvas text steps yet. */
  textVersions?: Record<string, number>;
}
export interface Effect<T> {
  content: T;
  required: string[];
  touched: string[];
  targets: string[];
  inverse: Action[];
  engineSteps?: unknown[];
  /** Read projections invalidated by this edit, without owning them for Undo. */
  invalidates?: string[];
  textSteps?: { target: string; steps: unknown[] };
}
export interface DomainCodec<T> {
  domain: Domain;
  validate(content: unknown): content is T;
  resource(content: T, key: string): unknown;
  /** Optional call-scoped lookup index. Results must equal resource(content, key). */
  resources?(content: T, keys: readonly string[]): unknown[];
  /** Optional serialization boundary, for example replacing image bytes with Host asset refs. */
  encode?(action: Action): Action;
  /** Optional batch serialization before encode. Must preserve ordered effects and checks. */
  encodeActions?(actions: Action[]): Action[];
  apply(
    content: T,
    action: Action,
    engineVersion: number,
    textVersions?: Record<string, number>,
  ): Effect<T>;
  /** Optional pure evaluation. Must not mutate content or nested objects, including
   * on failure. Its result may share unchanged branches with the input. */
  applyReadonly?: DomainCodec<T>['apply'];
  rebaseInverse?(event: Accepted<T>, later: Accepted<T>[], current: Snapshot<T>): Action[];
  /** The trusted apply boundary supplies the completed content for stable-ID relocation. */
  mapAnchor?(anchor: Anchor, before: T, action: Action, after?: T): Anchor;
  validateAnchor(content: T, anchor: Anchor): boolean;
}
export interface Accepted<T = unknown> {
  revision: number;
  operation: Operation;
  snapshot: Snapshot<T>;
  inverse: Action[];
  touched: string[];
  engineSteps: unknown[];
}
export interface Presence extends Identity {
  /** Canonical live revision in which anchor positions were measured. */
  basis?: number;
  name: string;
  color: string;
  page?: string;
  anchor?: Anchor;
  activity?: string;
  expiresAt: number;
}
export interface Proposal {
  schema: 1;
  id: string;
  artifactId: string;
  sourceActorId: string;
  baseRevision: number;
  summary: string;
  actions: Action[];
  reads: Condition[] | null;
  writes: Condition[];
  external: { reference: string; version: string }[];
}
export interface ProposalState {
  proposal: Proposal;
  state: 'ready' | 'preview' | 'applied' | 'conflicted' | 'cancelled' | 'rejected';
  token?: string;
  receipt?: Receipt;
}
export interface Preview<T> {
  token: string;
  before: T;
  after: T;
  changedKeys: string[];
}
export type AdapterStatus =
  | { type: 'permissions'; principal: Principal }
  | { type: 'connection'; state: 'online' | 'disconnected' | 'closed' };
export interface SyncAdapter<T> {
  identity: Identity;
  subscribeStatus(listener: (status: AdapterStatus) => void): () => void;
  open(): Promise<Snapshot<T>>;
  submit(operation: Operation): Promise<Receipt>;
  receipt(id: string): Promise<Receipt | undefined>;
  changes(after: number): Promise<{ snapshot?: Snapshot<T>; events: Accepted<T>[] }>;
  subscribe(listener: (event: Accepted<T>) => void): () => void;
  presence(value: Omit<Presence, keyof Identity | 'expiresAt'> | null): Promise<Presence[]>;
  permissions(): Promise<Principal>;
  close(): void;
}
export const copy = <T>(value: T): T => structuredClone(value);
export function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    let result = '{',
      separator = '';
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) continue;
      result += separator + JSON.stringify(key) + ':' + canonical(child);
      separator = ',';
    }
    return result + '}';
  }
  return JSON.stringify(value);
}
export const uid = () => crypto.randomUUID();
export function fail(code: ErrorCode, message: string, keys: string[] = []): never {
  throw new Conflict(code, message, keys);
}
export function serializable(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((v) => serializable(v, depth + 1));
  if (typeof value !== 'object' || !value || Object.getPrototypeOf(value) !== Object.prototype)
    return false;
  return Object.entries(value).every(
    ([k, v]) =>
      !['__proto__', 'constructor', 'prototype'].includes(k) && serializable(v, depth + 1),
  );
}
export function validateOperation(value: unknown): asserts value is Operation {
  if (!serializable(value) || canonical(value).length > 1_000_000)
    fail('schema-mismatch', 'Expected bounded JSON operation');
  const o = value as Operation;
  if (!o || o.protocol !== 1 || o.schema !== 1)
    fail('schema-mismatch', 'Unsupported protocol/schema');
  if (
    ![
      'document',
      'slide',
      'design',
      'whiteboard',
      'data',
      'review',
      'file',
      'react-ui',
      'animation',
    ].includes(o.domain) ||
    !['human', 'agent', 'proposal', 'undo', 'redo', 'restore'].includes(o.origin)
  )
    fail('schema-mismatch', 'Invalid domain/origin');
  for (const key of [
    'actorId',
    'clientId',
    'sessionId',
    'artifactId',
    'operationId',
    'transactionId',
  ] as const)
    if (typeof o[key] !== 'string' || !o[key] || o[key].length > 200)
      fail('schema-mismatch', `Invalid ${key}`);
  if (
    !Number.isSafeInteger(o.baseRevision) ||
    o.baseRevision < 0 ||
    !Array.isArray(o.targets) ||
    !o.targets.every((s) => typeof s === 'string') ||
    !Array.isArray(o.actions) ||
    !o.actions.length ||
    o.actions.length > 500 ||
    !Array.isArray(o.conditions)
  )
    fail('schema-mismatch', 'Invalid operation shape');
  for (const a of o.actions)
    if (
      !a ||
      typeof a.type !== 'string' ||
      typeof a.target !== 'string' ||
      !a.payload ||
      Array.isArray(a.payload) ||
      typeof a.payload !== 'object'
    )
      fail('schema-mismatch', 'Invalid action');
  for (const c of o.conditions)
    if (
      !c ||
      typeof c.key !== 'string' ||
      typeof c.fingerprint !== 'string' ||
      !Number.isSafeInteger(c.stamp) ||
      c.stamp < 0
    )
      fail('schema-mismatch', 'Invalid condition');
  if (new Set(o.conditions.map((c) => c.key)).size !== o.conditions.length)
    fail('schema-mismatch', 'Duplicate conditions');
}
export function rejected(id: string, error: unknown): Receipt {
  return {
    operationId: id,
    status: 'rejected',
    code: error instanceof Conflict ? error.code : 'invalid-operation',
    message: error instanceof Error ? error.message : 'Invalid operation',
    keys: error instanceof Conflict ? error.keys : [],
  };
}

const fingerprintEncoder = new TextEncoder();
// Geometry dependencies contain many identical small values (absent fields,
// flags, empty child lists). Cache the canonical bytes' hash, never an object's
// identity: mutable inputs are still serialized afresh on every call.
const smallFingerprints = new Map<string, string>();
export function fingerprint(value: unknown): string {
  const text = canonical(value);
  const small = typeof text === 'string' && text.length <= 2048;
  if (small) {
    const existing = smallFingerprints.get(text);
    if (existing !== undefined) return existing;
  }
  const hash = bytesToHex(sha256(fingerprintEncoder.encode(text)));
  if (small) {
    if (smallFingerprints.size === 512)
      smallFingerprints.delete(smallFingerprints.keys().next().value!);
    smallFingerprints.set(text, hash);
  }
  return hash;
}
