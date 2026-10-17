/** Experimental fake-adapter contract; exact draft.2, not production admission. */
import type {
  EditorCommand,
  EditorInputBoundary,
  EditorInputSnapshot,
  LocalDraftRevision,
} from '@editor-platform/editor-core';

export type Scope = Readonly<{ artifactId: string; sessionId: string; generation: string }>;
export type Pin = Readonly<{ id: string; version: string; packageHash: string }>;
export type Grant = 'artifact:read' | 'artifact:edit' | 'artifact:save' | 'resource:read';
export type JsonData =
  | null
  | boolean
  | number
  | string
  | readonly JsonData[]
  | { readonly [key: string]: JsonData };
export interface AddonVersions {
  edit: 'local-edit@0-draft';
  inputs: 'inputs@0-draft';
  save: 'local-persistence@0-draft';
  lifecycle: 'lifecycle@0-draft';
  resources: 'resources@0-draft';
}
export type AddonId = keyof AddonVersions;
export type Requests = {
  readonly [K in AddonId]?: Readonly<{
    version: AddonVersions[K];
    requirement: 'required' | 'optional';
  }>;
};
export interface ManifestD2 extends Pin {
  contractVersion: '1.0.0-draft.2';
  artifactKind: string;
  schemaVersion: number; // Existing numeric toy/legacy schema only; see section 8.
  surface: boolean;
  permissions: readonly Grant[]; // Requested, never self-granted.
  addons: Requests;
  licenseNotices: readonly string[];
}
export interface LocalReadSnapshot<T> {
  readonly scope: Scope;
  readonly revision: Readonly<LocalDraftRevision>;
  readonly content: T; // Detached domain content captured together with revision.
}
export interface Basic<T> {
  readonly scope: Scope;
  read(): LocalReadSnapshot<T>;
}
export interface Edit<T> {
  readonly version: AddonVersions['edit'];
  execute(command: EditorCommand<T>): void;
  undo(): void;
  redo(): void;
}
export interface InputCheckpoint {
  sequence: number;
  baseRevision: Readonly<LocalDraftRevision>;
  codec: Readonly<{ id: string; version: string }>;
  payload: JsonData; // Private buffer only, not an alternative canonical document.
}
export type CheckpointAck =
  | { state: 'retained'; sequence: number }
  | { state: 'refused'; reason: 'policy' | 'limit' | 'stale' | 'revoked' };
export interface InputRegistration {
  changed(sequence: number): void;
  checkpoint(value: InputCheckpoint): CheckpointAck;
  unregister(): void;
}
export interface Inputs {
  readonly version: AddonVersions['inputs'];
  register(id: string, boundary: EditorInputBoundary): InputRegistration;
  getSnapshot(): EditorInputSnapshot;
  subscribe(listener: () => void): () => void;
}
export interface SaveCapture {
  readonly scope: Scope;
  readonly revision: LocalDraftRevision;
  readonly contentHash: string;
}
export type SaveOutcome =
  | {
      state: 'aborted-before-write';
      operationId: string;
      capture: SaveCapture;
      proof: 'not-dispatched' | 'adapter-no-write-guarantee';
    }
  | {
      state: 'committed';
      operationId: string;
      capture: SaveCapture;
      receipt: { adapterReceiptId: string; durability: 'adapter-acknowledged' };
    }
  | {
      state: 'indeterminate';
      operationId: string;
      capture: SaveCapture;
      reason: 'deadline' | 'transport' | 'invalid-receipt' | 'adapter-unknown';
    };
export interface Save {
  readonly version: AddonVersions['save'];
  save(signal?: AbortSignal): Promise<SaveOutcome>;
}
export interface DrainReport {
  readonly scope: Scope;
  readonly state: 'drained' | 'incomplete';
  readonly pending: readonly string[];
  readonly failed: readonly { resourceId: string; reason: string }[];
}
export interface Lifecycle {
  readonly version: AddonVersions['lifecycle'];
  readonly scope: Scope;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  registerDisposable(resourceId: string, dispose: () => void | Promise<void>): void;
}
export interface ResourceIdentity<Ref> {
  readonly ref: Ref;
  readonly sha256: string; // Exact raw byte digest, not automatically native contentHash.
  readonly byteLength: number;
}
export interface ResourceBounds {
  maxReadBytes: number;
  maxTotalBytes: number;
  maxReads: number;
  maxPendingReads: number;
}
export interface ResourceLease<Ref> {
  readonly identity: ResourceIdentity<Ref>;
  readonly bounds: Readonly<ResourceBounds>;
  readonly scope: Scope;
  readonly signal: AbortSignal;
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
  release(options: { deadlineMs: number }): Promise<DrainReport>;
}
export interface Resources<Ref> {
  readonly version: AddonVersions['resources'];
  open(
    expected: ResourceIdentity<Ref>,
    requested: ResourceBounds,
    signal?: AbortSignal,
  ): Promise<ResourceLease<Ref>>;
}
export interface AddonApis<T, Ref> {
  edit: Edit<T>;
  inputs: Inputs;
  save: Save;
  lifecycle: Lifecycle;
  resources: Resources<Ref>;
}
export type Unavailable =
  | 'not-requested'
  | 'unsupported'
  | 'version-mismatch'
  | 'permission-denied'
  | 'dependency-unavailable';
export type Slot<A> = { state: 'granted'; api: A } | { state: 'unavailable'; reason: Unavailable };
export type Slots<T, Ref> = { readonly [K in AddonId]: Slot<AddonApis<T, Ref>[K]> };
export interface Context<T, Ref> {
  readonly basic: Basic<T>;
  readonly addons: Slots<T, Ref>;
}
export interface DefinitionD2<T, Ref> {
  manifest: ManifestD2;
  validate(value: unknown): value is T;
  mount?: (container: HTMLElement, context: Context<T, Ref>) => void;
}
export type RecoverySummary = {
  boundaryId: string;
  state: 'retained' | 'missing' | 'stale' | 'policy-denied' | 'discarded-by-policy';
  sequence?: number;
};
export interface RevokeTicket {
  readonly scope: Scope;
  readonly recovery: readonly RecoverySummary[];
}
export type CloseResult =
  | { state: 'revoked'; ticket: RevokeTicket }
  | { state: 'blocked'; reason: 'input' | 'permission' | 'scope'; boundaryId?: string };
// Host-only control; the extension receives Context, never this controller.
export interface HandleD2<T, Ref> {
  readonly scope: Scope;
  readonly context: Context<T, Ref>;
  mount(container: HTMLElement): void;
  requestClose(): CloseResult;
  revoke(reason: 'uninstall' | 'replace' | 'permission-expired' | 'host-close'): RevokeTicket;
  drain(options: { deadlineMs: number }): Promise<DrainReport>;
}
export type OpenResult<T, Ref> =
  | { state: 'opened'; handle: HandleD2<T, Ref> }
  | {
      state: 'refused';
      code: 'contract' | 'manifest' | 'trust' | 'pin' | 'schema' | 'grant' | 'required-addon';
      addon?: AddonId;
    };
