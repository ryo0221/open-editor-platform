import type { EditorCommand } from '@editor-platform/editor-core';

/** Experimental exact-match token. Owner approval is required before stabilization. */
export const CONTRACT_VERSION = '1.0.0-draft.1' as const;
export const CAPABILITIES = ['local-edit', 'selection', 'surface', 'persistence'] as const;
export const PERMISSIONS = ['artifact:read', 'artifact:write', 'selection:write'] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type Permission = (typeof PERMISSIONS)[number];
export interface ExtensionManifest {
  contractVersion: typeof CONTRACT_VERSION;
  id: string;
  version: string;
  artifactKind: string;
  schemaVersion: number;
  packageHash: string;
  capabilities: readonly Capability[];
  permissions: readonly Permission[];
  licenseNotices: readonly string[];
  /** Optional exact-version add-ons. Absent for packages that declare none. */
  addons?: ManifestAddons;
}
/** Exact token for the optional AI/automation operations add-on. Unknown versions are refused. */
export const OPERATIONS_ADDON = 'operations@0-draft' as const;
/**
 * Bounded JSON Schema subset for one operation input. Data only: no `$ref`, external references,
 * patterns or formats. Strings and arrays must state their upper bound; objects are closed.
 */
export type OperationSchema =
  | Readonly<{
      type: 'object';
      properties: Readonly<Record<string, OperationSchema>>;
      required?: readonly string[];
      additionalProperties: false;
      description?: string;
    }>
  | Readonly<{
      type: 'array';
      items: OperationSchema;
      maxItems: number;
      minItems?: number;
      description?: string;
    }>
  | Readonly<{
      type: 'string';
      maxLength: number;
      minLength?: number;
      enum?: readonly string[];
      description?: string;
    }>
  | Readonly<{
      type: 'number' | 'integer';
      minimum?: number;
      maximum?: number;
      enum?: readonly number[];
      description?: string;
    }>
  | Readonly<{ type: 'boolean' | 'null'; description?: string }>;
/** What a Host or provider may see about one operation. The schema is data, never code. */
export interface OperationDeclaration {
  id: string;
  version: string;
  title: string;
  inputSchema: OperationSchema;
}
/**
 * Exact token for the optional create add-on: the package can make the first, empty content of
 * its artifact kind, so a Host can start an artifact that has no file yet. Unknown versions are refused.
 */
export const CREATE_ADDON = 'create@0-draft' as const;
export interface ManifestAddons {
  operations?: Readonly<{
    version: typeof OPERATIONS_ADDON;
    declarations: readonly OperationDeclaration[];
  }>;
  create?: Readonly<{ version: typeof CREATE_ADDON }>;
}
/**
 * Package code for declared operations. `checkInput` covers rules the schema cannot express
 * (for example that a target id exists). `command` builds an ordinary EditorCommand from the
 * given content; its apply must check the original values it relies on and throw if they changed.
 */
export interface OperationsAdapter<T> {
  checkInput(operation: string, input: unknown, content: T): readonly string[];
  command(operation: string, input: unknown, content: T): EditorCommand<T>;
}
export interface ScopedHost<T> {
  read(): T;
  /** Requires current artifact:read + artifact:write; read-only always denies mutations. */
  execute(command: EditorCommand<T>): void;
  undo(): void;
  redo(): void;
  save(): Promise<void>;
  select(elementIds: readonly string[]): void;
  requireCapability(capability: string): void;
}
export interface ExtensionDefinition<T> {
  manifest: ExtensionManifest;
  /**
   * Pure check of saved content. A Host may run the package's entry and this function in a
   * sandbox that has only the ECMAScript language (no DOM, `Intl`, `TextEncoder` or `crypto`), so
   * loading the entry and calling `validate` must not need those APIs.
   */
  validate(value: unknown): value is T;
  mount?: (container: HTMLElement, host: ScopedHost<T>) => () => void;
  /** Present exactly when the manifest declares the operations add-on. */
  operations?: OperationsAdapter<T>;
  /**
   * Present exactly when the manifest declares the create add-on. Returns new content that holds
   * no user data and passes `validate`. It takes no input and must not read Host state; the Host
   * decides where the content goes and saves it through its own persistence.
   */
  create?: () => T;
}
/** Trusted adapter binds one artifact, owns session/history/persistence and final authorization. */
export interface HostAdapter<T> {
  artifactKind: string;
  schemaVersion: number;
  allowed(permission: Permission): boolean;
  readOnly(): boolean;
  read(): T;
  execute(command: EditorCommand<T>): void;
  undo(): void;
  redo(): void;
  save(): Promise<void>;
  select(elementIds: readonly string[]): void;
}
