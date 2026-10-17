import { sameLocalRevision, EditorSession } from '@editor-platform/editor-core';
import {
  SCHEMA_EXPERIMENT_VERSION,
  type SchemaIdentity,
  type SchemaExperimentContext,
  type SchemaExperimentDefinition,
  type SchemaExperimentManifest,
} from '@editor-platform/extension-contract/schema-experiment';
import type {
  DrainReport,
  Pin,
  RevokeTicket,
  Scope,
} from '@editor-platform/extension-contract/draft2';
import { copyData, frozen, Ownership, requireThat, type Clock } from './draft2/primitives';

export interface SchemaExperimentBinding<T> {
  artifactId: string;
  artifactKind: string;
  schemaIdentity: SchemaIdentity;
  session: EditorSession<T>;
  allowedRead(): boolean;
  subscribeReadPermission(listener: () => void): () => void;
}
export interface SchemaExperimentHandle<T> {
  readonly scope: Scope;
  readonly context: SchemaExperimentContext<T>;
  mount(container: HTMLElement): void;
  revoke(): RevokeTicket;
  drain(options: { deadlineMs: number }): Promise<DrainReport>;
}
function keys(value: object, allowed: readonly string[]) {
  requireThat(
    Object.keys(value).length === allowed.length &&
      Object.keys(value).every((key) => allowed.includes(key)),
    'manifest',
  );
}
function identity(input: unknown): SchemaIdentity {
  const value = copyData(input) as SchemaIdentity;
  requireThat(value && typeof value === 'object', 'schema');
  keys(value, ['kind', 'value']);
  requireThat(
    value.kind === 'numeric'
      ? Number.isSafeInteger(value.value) && value.value > 0
      : value.kind === 'literal' &&
          typeof value.value === 'string' &&
          value.value.length > 0 &&
          value.value.length <= 128,
    'schema',
  );
  return frozen(value);
}
const sameSchema = (a: SchemaIdentity, b: SchemaIdentity) =>
  a.kind === b.kind && a.value === b.value;
function parse(input: unknown): SchemaExperimentManifest {
  const value = copyData(input) as SchemaExperimentManifest;
  requireThat(value && typeof value === 'object', 'manifest');
  keys(value, [
    'id',
    'version',
    'packageHash',
    'contractVersion',
    'artifactKind',
    'schemaIdentity',
    'surface',
    'permissions',
    'addons',
    'licenseNotices',
  ]);
  requireThat(value.contractVersion === SCHEMA_EXPERIMENT_VERSION, 'contract');
  for (const field of ['id', 'version', 'artifactKind'] as const)
    requireThat(
      typeof value[field] === 'string' && value[field].length > 0 && value[field].length <= 128,
      'manifest',
    );
  requireThat(
    typeof value.packageHash === 'string' && /^[a-f0-9]{64}$/.test(value.packageHash),
    'manifest',
  );
  identity(value.schemaIdentity);
  requireThat(typeof value.surface === 'boolean', 'manifest');
  requireThat(
    Array.isArray(value.permissions) &&
      value.permissions.length === 1 &&
      value.permissions[0] === 'artifact:read',
    'permission',
  );
  requireThat(value.addons && typeof value.addons === 'object', 'manifest');
  keys(value.addons, ['lifecycle']);
  keys(value.addons.lifecycle, ['version', 'requirement']);
  requireThat(
    value.addons.lifecycle.version === 'lifecycle@0-draft' &&
      value.addons.lifecycle.requirement === 'required',
    'required-addon',
  );
  requireThat(
    Array.isArray(value.licenseNotices) &&
      value.licenseNotices.every((item) => typeof item === 'string'),
    'manifest',
  );
  return frozen(value);
}
/** Inspect descriptors before reading values: old fields and accessors are not a protocol. */
function parseBinding<T>(input: SchemaExperimentBinding<T>): SchemaExperimentBinding<T> {
  requireThat(input && typeof input === 'object' && !Array.isArray(input), 'binding');
  requireThat(
    Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null,
    'binding',
  );
  const fields = [
    'artifactId',
    'artifactKind',
    'schemaIdentity',
    'session',
    'allowedRead',
    'subscribeReadPermission',
  ];
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const names = Reflect.ownKeys(descriptors);
  requireThat(
    names.length === fields.length &&
      names.every((key) => typeof key === 'string' && fields.includes(key)),
    'binding',
  );
  for (const field of fields)
    requireThat(descriptors[field]?.enumerable && 'value' in descriptors[field], 'binding');
  const textField = (value: unknown) => {
    requireThat(typeof value === 'string' && value.length > 0 && value.length <= 128, 'binding');
    return value;
  };
  const artifactId = textField(descriptors.artifactId.value),
    artifactKind = textField(descriptors.artifactKind.value),
    session = descriptors.session.value,
    allowedRead = descriptors.allowedRead.value,
    subscribeReadPermission = descriptors.subscribeReadPermission.value;
  requireThat(
    session instanceof EditorSession &&
      typeof allowedRead === 'function' &&
      typeof subscribeReadPermission === 'function',
    'binding',
  );
  // Capture the immutable scope wiring, retaining the actual Core session and live provider closures.
  return Object.freeze({
    artifactId,
    artifactKind,
    schemaIdentity: identity(descriptors.schemaIdentity.value),
    session,
    allowedRead,
    subscribeReadPermission,
  });
}
/** Separate admission version using the same Core session and lifecycle ownership machinery.
 * The Host supplies supported kind/identity pairs; no domain branching or schema coercion. */
export class SchemaExperimentRegistry {
  private installations = new Map<string, { revoke(): void }>();
  private transitioning = false;
  private supported: readonly { artifactKind: string; schemaIdentity: SchemaIdentity }[];
  constructor(
    private clock: Clock,
    supported: readonly { artifactKind: string; schemaIdentity: SchemaIdentity }[],
  ) {
    this.supported = frozen(
      supported.map((item) => ({
        artifactKind: item.artifactKind,
        schemaIdentity: identity(item.schemaIdentity),
      })),
    );
  }
  private transition<R>(work: () => R): R {
    requireThat(!this.transitioning, 'RegistryTransition');
    this.transitioning = true;
    try {
      return work();
    } finally {
      this.transitioning = false;
    }
  }
  install<T>(
    definition: SchemaExperimentDefinition<T>,
    admission: { trust: 'trusted' | 'untrusted'; verifiedPin: Pin },
  ) {
    return this.transition(() => {
      requireThat(admission.trust === 'trusted', 'trust');
      const manifest = parse(definition.manifest),
        pin = frozen(admission.verifiedPin);
      requireThat(
        manifest.id === pin.id &&
          manifest.version === pin.version &&
          manifest.packageHash === pin.packageHash,
        'pin',
      );
      requireThat(
        this.supported.some(
          (item) =>
            item.artifactKind === manifest.artifactKind &&
            sameSchema(item.schemaIdentity, manifest.schemaIdentity),
        ),
        'schema',
      );
      requireThat(
        typeof definition.validate === 'function' &&
          typeof definition.schemaOf === 'function' &&
          (!manifest.surface || typeof definition.mount === 'function'),
        'manifest',
      );
      const validate = definition.validate,
        schemaOf = definition.schemaOf,
        mount = definition.mount;
      requireThat(!this.installations.has(manifest.id), 'Installed');
      const active = new Set<() => RevokeTicket>();
      const installed = {
        revoke: () => {
          for (const revoke of [...active]) revoke();
        },
      };
      this.installations.set(manifest.id, installed);
      return Object.freeze({
        pin,
        open: (
          input: SchemaExperimentBinding<T>,
        ):
          | { state: 'opened'; handle: SchemaExperimentHandle<T> }
          | { state: 'refused'; code: 'schema' | 'grant' } =>
          this.transition(() => {
            requireThat(this.installations.get(manifest.id) === installed, 'Uninstalled');
            const binding = parseBinding(input);
            if (
              binding.artifactKind !== manifest.artifactKind ||
              !sameSchema(identity(binding.schemaIdentity), manifest.schemaIdentity)
            )
              return { state: 'refused', code: 'schema' };
            if (!binding.allowedRead()) return { state: 'refused', code: 'grant' };
            const scope: Scope = frozen({
              artifactId: binding.artifactId,
              sessionId: binding.session.revision.sessionId,
              generation: crypto.randomUUID(),
            });
            const sourceRevision = frozen(binding.session.revision);
            const controller = new AbortController(),
              ownership = new Ownership(scope, this.clock);
            const teardown = ownership.hold('host:teardown');
            let ticket: RevokeTicket | undefined,
              stop: (() => void) | undefined,
              stopRequested = false,
              mounted = false;
            const failures: string[] = [];
            const unsubscribe = () => {
              stopRequested = true;
              const owned = stop;
              stop = undefined;
              owned?.();
            };
            const revoke = (): RevokeTicket => {
              if (ticket) return ticket;
              ticket = frozen({ scope, recovery: [] });
              try {
                unsubscribe();
              } catch (error) {
                failures.push(String(error));
              }
              controller.abort();
              if (failures.length) teardown.fail(failures.join('; '));
              else teardown.done();
              ownership.revoke();
              active.delete(revoke);
              return ticket;
            };
            const check = () => {
              requireThat(!ticket && !controller.signal.aborted, 'ScopeRevoked');
              if (
                !binding.allowedRead() ||
                !sameLocalRevision(binding.session.revision, sourceRevision)
              ) {
                revoke();
                requireThat(false, 'ScopeRevoked');
              }
            };
            const read = () => {
              check();
              const revision = frozen(binding.session.revision),
                content = frozen(binding.session.content);
              requireThat(validate(content), 'InvalidContent');
              requireThat(
                sameSchema(identity(schemaOf(content)), manifest.schemaIdentity),
                'schema',
              );
              check();
              requireThat(sameLocalRevision(revision, binding.session.revision), 'ReadConflict');
              return Object.freeze({ scope, revision, content });
            };
            const context: SchemaExperimentContext<T> = Object.freeze({
              basic: Object.freeze({ scope, read }),
              lifecycle: Object.freeze({
                version: 'lifecycle@0-draft',
                scope,
                signal: controller.signal,
                assertCurrent: check,
                registerDisposable: (id: string, dispose: () => void | Promise<void>) => {
                  check();
                  ownership.register('extension:' + id, dispose);
                },
              }),
            });
            const handle: SchemaExperimentHandle<T> = Object.freeze({
              scope,
              context,
              mount: (container: HTMLElement) => {
                check();
                requireThat(manifest.surface && !mounted, 'Mount');
                mounted = true;
                try {
                  mount!(container, context);
                  check();
                } catch (error) {
                  this.transition(revoke);
                  throw error;
                }
              },
              revoke: () => this.transition(revoke),
              drain: (options: { deadlineMs: number }) => ownership.drain(options),
            });
            active.add(revoke);
            const subscription = ownership.hold('host:permission-subscription');
            try {
              read(); // Native schema is verified before mount or consumer delivery.
              stop = binding.subscribeReadPermission(() => {
                if (!binding.allowedRead()) revoke();
              });
              if (stopRequested) unsubscribe();
              subscription.done();
              check();
            } catch (error) {
              subscription.fail(String(error));
              revoke();
              throw error;
            }
            return { state: 'opened', handle };
          }),
      });
    });
  }
  uninstall(id: string): void {
    this.transition(() => {
      const installed = this.installations.get(id);
      if (installed) {
        installed.revoke();
        this.installations.delete(id);
      }
    });
  }
}
