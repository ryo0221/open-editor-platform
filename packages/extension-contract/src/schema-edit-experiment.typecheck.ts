/** Compile-only compatibility assertions; not runtime conformance evidence. */
import type { Context, ManifestD2 } from './draft2';
import type { SchemaExperimentManifest } from './schema-experiment';
import type {
  SchemaEditContext,
  SchemaEditManifest,
  SchemaEditIdentity,
} from './schema-edit-experiment';
type Assert<T extends true> = T;
type NotAssignable<A, B> = [A] extends [B] ? false : true;
export type SchemaEditTypeChecks = [
  Assert<NotAssignable<ManifestD2, SchemaEditManifest>>,
  Assert<NotAssignable<SchemaExperimentManifest, SchemaEditManifest>>,
  Assert<NotAssignable<SchemaEditManifest, ManifestD2>>,
  Assert<NotAssignable<Context<unknown, never>, SchemaEditContext<unknown>>>,
  Assert<NotAssignable<SchemaEditContext<unknown>, Context<unknown, never>>>,
  Assert<NotAssignable<{ kind: 'numeric'; value: string }, SchemaEditIdentity>>,
  Assert<NotAssignable<{ kind: 'literal'; value: number }, SchemaEditIdentity>>,
  Assert<
    NotAssignable<
      Omit<SchemaEditManifest['addons'], 'resources'> & {
        resources: { version: 'resources@0-draft'; requirement: 'optional' };
      },
      SchemaEditManifest['addons']
    >
  >,
  Assert<
    NotAssignable<readonly ['artifact:read', 'resource:read'], SchemaEditManifest['permissions']>
  >,
];
export const schemaEditExample: SchemaEditManifest = {
  id: 'typecheck.tagged-editor',
  version: '0.0.0-experiment.1',
  packageHash: 'a'.repeat(64),
  contractVersion: '1.0.0-experiment.schema-edit.1',
  artifactKind: 'test-domain',
  schemaIdentity: { kind: 'literal', value: 'test-native-v0' },
  surface: true,
  permissions: ['artifact:read', 'artifact:edit', 'artifact:save'],
  addons: {
    lifecycle: { version: 'lifecycle@0-draft', requirement: 'required' },
    edit: { version: 'local-edit@0-draft', requirement: 'optional' },
    inputs: { version: 'inputs@0-draft', requirement: 'optional' },
    save: { version: 'local-persistence@0-draft', requirement: 'optional' },
  },
  licenseNotices: [],
};
