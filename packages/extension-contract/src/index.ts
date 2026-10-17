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
  validate(value: unknown): value is T;
  mount?: (container: HTMLElement, host: ScopedHost<T>) => () => void;
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
