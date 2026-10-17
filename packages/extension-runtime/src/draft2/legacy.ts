import type { ExtensionDefinition, ScopedHost } from '@editor-platform/extension-contract';
import type { Context, DefinitionD2, Pin } from '@editor-platform/extension-contract/draft2';
import { ReferenceError, deferred, frozen, requireThat } from './primitives';
import { samePin } from './manifest';
export class LegacySaveError extends ReferenceError {
  constructor(
    code: string,
    readonly operationId: string,
  ) {
    super(code);
  }
}
/** Explicit reviewed toy-only adapter. Neither eligibility nor hashes verify executable bytes. */
export function adaptLegacy<T>(
  definition: ExtensionDefinition<T>,
  review: { originalPin: Pin; adapterPin: Pin; eligibleSynchronousToy: true },
): {
  definition: DefinitionD2<T, never>;
  evidence: { originalPin: Pin; originalContract: '1.0.0-draft.1'; adapterPin: Pin };
  facade(context: Context<T, never>): ScopedHost<T>;
} {
  const manifest = frozen(definition.manifest);
  requireThat(
    Object.keys(manifest).every((key) =>
      [
        'id',
        'version',
        'packageHash',
        'contractVersion',
        'artifactKind',
        'schemaVersion',
        'capabilities',
        'permissions',
        'licenseNotices',
      ].includes(key),
    ) && manifest.permissions.every((value) => ['artifact:read', 'artifact:write'].includes(value)),
    'LegacyCapability',
  );
  requireThat(
    review.eligibleSynchronousToy === true &&
      manifest.contractVersion === '1.0.0-draft.1' &&
      samePin(manifest, review.originalPin),
    'LegacyAdmission',
  );
  requireThat(
    manifest.capabilities.every((value) =>
      ['local-edit', 'persistence', 'surface'].includes(value),
    ) && !manifest.permissions.includes('selection:write'),
    'LegacyCapability',
  );
  requireThat(manifest.permissions.includes('artifact:read'), 'LegacyRead');
  const edit = manifest.capabilities.includes('local-edit');
  const save = manifest.capabilities.includes('persistence');
  const surface = manifest.capabilities.includes('surface');
  requireThat(!surface || typeof definition.mount === 'function', 'LegacySurface');
  const facade = (context: Context<T, never>): ScopedHost<T> => ({
    read: () => context.basic.read().content,
    execute: (command) => {
      requireThat(context.addons.edit.state === 'granted', 'LegacyEdit');
      context.addons.edit.api.execute(command);
    },
    undo: () => {
      requireThat(context.addons.edit.state === 'granted', 'LegacyEdit');
      context.addons.edit.api.undo();
    },
    redo: () => {
      requireThat(context.addons.edit.state === 'granted', 'LegacyEdit');
      context.addons.edit.api.redo();
    },
    save: async () => {
      requireThat(context.addons.save.state === 'granted', 'LegacySave');
      const result = await context.addons.save.api.save();
      if (result.state !== 'committed')
        throw new LegacySaveError(
          result.state === 'indeterminate' ? 'SaveIndeterminate' : 'SaveAborted',
          result.operationId,
        );
    },
    select: () => {
      throw new ReferenceError('LegacySelection');
    },
    requireCapability: (capability) => {
      context.basic.read();
      requireThat(manifest.capabilities.includes(capability as 'local-edit'), 'LegacyCapability');
    },
  });
  const adapted: DefinitionD2<T, never> = {
    manifest: {
      ...review.adapterPin,
      contractVersion: '1.0.0-draft.2',
      artifactKind: manifest.artifactKind,
      schemaVersion: manifest.schemaVersion,
      surface,
      permissions: [
        'artifact:read',
        ...(edit ? ['artifact:edit' as const] : []),
        ...(save ? ['artifact:save' as const] : []),
      ],
      addons: {
        ...(edit
          ? { edit: { version: 'local-edit@0-draft' as const, requirement: 'required' as const } }
          : {}),
        ...(save
          ? {
              save: {
                version: 'local-persistence@0-draft' as const,
                requirement: 'required' as const,
              },
            }
          : {}),
        lifecycle: { version: 'lifecycle@0-draft', requirement: 'required' },
      },
      licenseNotices: [...manifest.licenseNotices],
    },
    validate: definition.validate,
    ...(surface
      ? {
          mount: (container: HTMLElement, context: Context<T, never>) => {
            requireThat(context.addons.lifecycle.state === 'granted', 'LegacyLifecycle');
            const mounted = deferred<() => void>();
            context.addons.lifecycle.api.registerDisposable('legacy-surface', async () => {
              const cleanup = await mounted.promise;
              const result: unknown = cleanup();
              // Reviewed eligibility is required before import. Unexpected async cleanup
              // is still observed/owned, but never silently certified as compatible.
              if (result && typeof result === 'object' && 'then' in result) {
                await result;
                throw new ReferenceError('LegacyAsyncCleanup');
              }
            });
            try {
              const cleanup = definition.mount!(container, facade(context));
              requireThat(typeof cleanup === 'function', 'LegacyCleanup');
              mounted.resolve(cleanup);
            } catch (error) {
              mounted.resolve(() => {});
              throw error;
            }
          },
        }
      : {}),
  };
  return {
    definition: adapted,
    evidence: frozen({
      originalPin: review.originalPin,
      originalContract: '1.0.0-draft.1',
      adapterPin: review.adapterPin,
    }),
    facade,
  };
}
