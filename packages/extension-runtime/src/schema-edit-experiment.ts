/** Separate tagged edit/save experiment. Existing protocol entrypoints are unchanged. */
import type { EditorSession, EditorInputs } from '@editor-platform/editor-core';
import type {
  SchemaEditDefinition,
  SchemaEditGrant,
  SchemaEditIdentity,
  SchemaEditOpenResult,
} from '@editor-platform/extension-contract/schema-edit-experiment';
import type { Pin } from '@editor-platform/extension-contract/draft2';
import type { Admission, RecoveryPolicy, Storage, ReferenceRegistry } from './draft2';
export type { SchemaEditControllerFactory } from '@editor-platform/extension-contract/schema-edit-experiment';
export interface SchemaEditBinding<T> {
  readonly artifactId: string;
  readonly artifactKind: string;
  readonly schemaIdentity: SchemaEditIdentity;
  readonly schemaVersion?: never;
  readonly session: EditorSession<T>;
  readonly inputs: EditorInputs;
  allowed(grant: SchemaEditGrant): boolean;
  subscribePermissions(listener: () => void): () => void;
  readonly recovery?: RecoveryPolicy;
  readonly storage?: Storage<T>;
  readonly resources?: never;
}
/** Both front doors must use this same existing registry owner, clock and SaveCoordinator.
 * A new experiment must not silently allocate a parallel save-lock domain. */
export type SchemaEditRuntimeOwner = Pick<ReferenceRegistry, 'clock' | 'saves' | 'recovery'>;
export interface SchemaEditInstallation<T> {
  readonly pin: Pin;
  open(binding: SchemaEditBinding<T>): SchemaEditOpenResult<T>;
}
export interface SchemaEditRegistry {
  install<T>(definition: SchemaEditDefinition<T>, admission: Admission): SchemaEditInstallation<T>;
  uninstall(id: string): void;
}

export { SchemaEditExperimentRegistry } from './schema-edit/registry';
import type { SchemaEditContext } from '@editor-platform/extension-contract/schema-edit-experiment';
import { assertSchemaEditContext } from './schema-edit/registry';
import { createControlledExecution } from './controlled-execution';
export function createSchemaEditController<T>(
  context: SchemaEditContext<T>,
  options: { beforeMutation?(): void; onError(error: unknown): void },
) {
  assertSchemaEditContext(context);
  return createControlledExecution(context, options);
}
