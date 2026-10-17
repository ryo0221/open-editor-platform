/** Separately approved typed experiment. No draft.2 or readonly-token coercion. */
import type {
  Basic,
  Pin,
  Slot,
  Edit,
  Inputs,
  Save,
  Lifecycle,
  Scope,
  CloseResult,
  RevokeTicket,
  DrainReport,
} from './draft2';
import type { ControlledSurfaceController } from './controlled-surface';
export const SCHEMA_EDIT_EXPERIMENT_VERSION = '1.0.0-experiment.schema-edit.1' as const;
/** Runtime requires a positive safe integer or a nonempty bounded literal; no native rewrite. */
export type SchemaEditIdentity =
  | { readonly kind: 'numeric'; readonly value: number }
  | { readonly kind: 'literal'; readonly value: string };
export interface SchemaEditProfile {
  readonly artifactKind: string;
  readonly schemaIdentity: SchemaEditIdentity;
}
export type SchemaEditGrant = 'artifact:read' | 'artifact:edit' | 'artifact:save';
export interface SchemaEditManifest extends Pin, SchemaEditProfile {
  readonly contractVersion: typeof SCHEMA_EDIT_EXPERIMENT_VERSION;
  /** Old untagged fields are not an alternate representation. */
  readonly schemaVersion?: never;
  readonly surface: boolean;
  readonly permissions: readonly ['artifact:read', ...Exclude<SchemaEditGrant, 'artifact:read'>[]];
  readonly addons: {
    readonly lifecycle: { readonly version: 'lifecycle@0-draft'; readonly requirement: 'required' };
    readonly edit?: { readonly version: 'local-edit@0-draft'; readonly requirement: 'optional' };
    readonly inputs?: { readonly version: 'inputs@0-draft'; readonly requirement: 'optional' };
    readonly save?: {
      readonly version: 'local-persistence@0-draft';
      readonly requirement: 'optional';
    };
    readonly resources?: never;
  };
  readonly licenseNotices: readonly string[];
}
export interface SchemaEditContext<T> {
  readonly contractVersion: typeof SCHEMA_EDIT_EXPERIMENT_VERSION;
  readonly basic: Basic<T>;
  readonly addons: {
    readonly edit: Slot<Edit<T>>;
    readonly inputs: Slot<Inputs>;
    readonly save: Slot<Save>;
    readonly lifecycle: { readonly state: 'granted'; readonly api: Lifecycle };
    readonly resources?: never;
  };
}
export interface SchemaEditDefinition<T> {
  readonly manifest: SchemaEditManifest;
  /** Domain-owned native validation, required on delivery and canonical commit boundaries. */
  validate(value: unknown): value is T;
  /** Must match the admitted kind/identity pair; never maps a literal to a fake numeric schema. */
  schemaOf(content: T): SchemaEditIdentity;
  mount?: (container: HTMLElement, context: SchemaEditContext<T>) => void;
}
/** Existing controlled facade, injected by Host until the new runtime factory is implemented. */
export type SchemaEditControllerFactory = <T>(
  context: SchemaEditContext<T>,
  options: { beforeMutation?(): void; onError(error: unknown): void },
) => ControlledSurfaceController<T>;
/** Host-only controls; the domain receives Context, not session/storage/admission. */
export interface SchemaEditHandle<T> {
  readonly scope: Scope;
  readonly context: SchemaEditContext<T>;
  mount(container: HTMLElement): void;
  requestClose(): CloseResult;
  revoke(reason: 'uninstall' | 'replace' | 'permission-expired' | 'host-close'): RevokeTicket;
  drain(options: { deadlineMs: number }): Promise<DrainReport>;
}
export type SchemaEditOpenResult<T> =
  | { state: 'opened'; handle: SchemaEditHandle<T> }
  | {
      state: 'refused';
      code: 'contract' | 'manifest' | 'trust' | 'pin' | 'schema' | 'grant' | 'required-addon';
      addon?: 'edit' | 'inputs' | 'save' | 'lifecycle';
    };
