/** Separate exact experiment. Never passed through draft.2 numeric schema admission. */
import type { Basic, Lifecycle, Pin } from './draft2';
export const SCHEMA_EXPERIMENT_VERSION = '1.0.0-experiment.schema.1' as const;
export type SchemaIdentity =
  | { readonly kind: 'numeric'; readonly value: number }
  | { readonly kind: 'literal'; readonly value: 'video-core-prototype-v0' };
export interface SchemaExperimentManifest extends Pin {
  contractVersion: typeof SCHEMA_EXPERIMENT_VERSION;
  artifactKind: string;
  schemaIdentity: SchemaIdentity;
  surface: boolean;
  permissions: readonly ['artifact:read'];
  addons: {
    readonly lifecycle: { readonly version: 'lifecycle@0-draft'; readonly requirement: 'required' };
  };
  licenseNotices: readonly string[];
}
export interface SchemaExperimentContext<T> {
  readonly basic: Basic<T>;
  readonly lifecycle: Lifecycle;
}
export interface SchemaExperimentDefinition<T> {
  manifest: SchemaExperimentManifest;
  validate(value: unknown): value is T;
  /** Domain-owned exact native discriminant reader; no numeric mapping or byte rewrite. */
  schemaOf(content: T): SchemaIdentity;
  mount?: (container: HTMLElement, context: SchemaExperimentContext<T>) => void;
}
