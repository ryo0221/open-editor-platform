import { EditorSession, EditorInputs, command } from '@editor-platform/editor-core';
import type {
  SchemaEditDefinition,
  SchemaEditIdentity,
} from '@editor-platform/extension-contract/schema-edit-experiment';
import type { DefinitionD2, Grant } from '@editor-platform/extension-contract/draft2';
import { ReferenceRegistry } from '../draft2';
import {
  SchemaEditExperimentRegistry,
  createSchemaEditController,
  type SchemaEditBinding,
} from '../schema-edit-experiment';
import { ManualClock, FakeStorage } from '../draft2/reference';
export interface Native {
  schemaVersion: number;
  format: string;
  value: number;
}
export const initial: Native = { schemaVersion: 1, format: 'test-native-v0', value: 0 };
export function definition(
  identity: SchemaEditIdentity = { kind: 'numeric', value: 1 },
): SchemaEditDefinition<Native> {
  return {
    manifest: {
      id: 'tagged-test',
      version: '0',
      packageHash: 'a'.repeat(64),
      contractVersion: '1.0.0-experiment.schema-edit.1',
      artifactKind: 'test',
      schemaIdentity: identity,
      surface: false,
      permissions: ['artifact:read', 'artifact:edit', 'artifact:save'],
      addons: {
        lifecycle: { version: 'lifecycle@0-draft', requirement: 'required' },
        edit: { version: 'local-edit@0-draft', requirement: 'optional' },
        inputs: { version: 'inputs@0-draft', requirement: 'optional' },
        save: { version: 'local-persistence@0-draft', requirement: 'optional' },
      },
      licenseNotices: [],
    },
    validate: (v: unknown): v is Native =>
      !!v &&
      typeof v === 'object' &&
      'value' in v &&
      typeof v.value === 'number' &&
      Number.isFinite(v.value) &&
      v.value >= 0,
    schemaOf: (v) =>
      identity.kind === 'numeric'
        ? { kind: 'numeric', value: v.schemaVersion }
        : { kind: 'literal', value: v.format },
  };
}
export function setup(
  options: {
    identity?: SchemaEditIdentity;
    inputs?: boolean;
    grants?: Grant[];
    storageSetup?: (storage: FakeStorage<Native>) => void;
  } = {},
) {
  const clock = new ManualClock(),
    owner = new ReferenceRegistry(clock),
    def = definition(options.identity);
  const registry = new SchemaEditExperimentRegistry(owner, [
    { artifactKind: 'test', schemaIdentity: def.manifest.schemaIdentity },
  ]);
  const session = new EditorSession({ ...initial }),
    inputs = new EditorInputs(),
    storage = new FakeStorage<Native>('same-key');
  options.storageSetup?.(storage);
  let grants = new Set<Grant>(
    options.grants ?? ['artifact:read', 'artifact:edit', 'artifact:save'],
  );
  const listeners = new Set<() => void>();
  const binding: SchemaEditBinding<Native> = {
    artifactId: 'native',
    artifactKind: 'test',
    schemaIdentity: def.manifest.schemaIdentity,
    session,
    inputs,
    storage,
    allowed: (g) => grants.has(g),
    subscribePermissions: (f) => {
      listeners.add(f);
      return () => {
        listeners.delete(f);
      };
    },
    ...(options.inputs === false
      ? {}
      : {
          recovery: {
            codecs: [],
            perBoundaryBytes: 2048,
            totalBytes: 8192,
            ttlMs: 1000,
            onRevoke: 'discard' as const,
          },
        }),
  };
  const installed = registry.install(def, {
    trust: 'trusted',
    verifiedPin: {
      id: def.manifest.id,
      version: def.manifest.version,
      packageHash: def.manifest.packageHash,
    },
  });
  const open = () => {
    const r = installed.open(binding);
    if (r.state !== 'opened') throw Error(r.code);
    return r.handle;
  };
  const handle = open(),
    errors: unknown[] = [];
  const controller = createSchemaEditController(handle.context, { onError: (e) => errors.push(e) });
  const oldDefinition: DefinitionD2<Native, never> = {
    manifest: {
      id: 'numeric-test',
      version: '0',
      packageHash: 'b'.repeat(64),
      contractVersion: '1.0.0-draft.2',
      artifactKind: 'test',
      schemaVersion: 1,
      surface: false,
      permissions: ['artifact:read', 'artifact:edit', 'artifact:save'],
      addons: def.manifest.addons,
      licenseNotices: [],
    },
    validate: def.validate,
  };
  const oldInstall = owner.install(oldDefinition, {
    trust: 'trusted',
    verifiedPin: oldDefinition.manifest,
  });
  const old = oldInstall.open({
    artifactId: binding.artifactId,
    artifactKind: 'test',
    schemaVersion: 1,
    session,
    inputs,
    allowed: binding.allowed,
    subscribePermissions: binding.subscribePermissions,
    storage,
    recovery: binding.recovery,
  });
  if (old.state !== 'opened') throw Error(old.code);
  return {
    clock,
    owner,
    registry,
    def,
    binding,
    session,
    inputs,
    storage,
    handle,
    controller,
    errors,
    open,
    installed,
    old: old.handle,
    grants(next: Grant[]) {
      grants = new Set(next);
      for (const f of [...listeners]) f();
    },
    execute(value: number) {
      return controller.execute({
        baseRevision: session.revision,
        command: command<Native>('set', 'set', (v) => ({ ...v, value })),
      });
    },
  };
}
