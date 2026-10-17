import {
  SCHEMA_EDIT_EXPERIMENT_VERSION,
  type SchemaEditProfile,
  type SchemaEditDefinition,
  type SchemaEditContext,
  type SchemaEditOpenResult,
} from '@editor-platform/extension-contract/schema-edit-experiment';
import type {
  Basic,
  Grant,
  Slot,
  Pin,
  RevokeTicket,
} from '@editor-platform/extension-contract/draft2';
import type { SchemaEditBinding, SchemaEditInstallation } from '../schema-edit-experiment';
import { ReferenceRegistry, type Admission } from '../draft2';
import { negotiate, ADDONS, samePin } from '../draft2/manifest';
import { openScoped, type ExecutionApis, type ExecutionOwner } from '../scoped-execution';
import { frozen, requireThat } from '../draft2/primitives';
import {
  fields,
  list,
  text,
  identity,
  sameIdentity,
  profile,
  parseManifest,
  parseBinding,
} from './admission';
const contexts = new WeakSet<object>();
export function assertSchemaEditContext(context: object): void {
  requireThat(contexts.has(context), 'contract');
}
/** Distinct admission, same execution/SaveCoordinator owner as the old front door. */
export class SchemaEditExperimentRegistry {
  private transitioning = false;
  private readonly owner: ExecutionOwner;
  private readonly profiles: readonly SchemaEditProfile[];
  private readonly installed = new Map<string, { revoke(): void }>();
  constructor(
    private readonly source: ReferenceRegistry,
    supported: readonly SchemaEditProfile[],
  ) {
    requireThat(source instanceof ReferenceRegistry, 'Owner');
    this.owner = Object.freeze({
      clock: source.clock,
      saves: source.saves,
      recovery: source.recovery,
    });
    const data = list(supported, 64);
    requireThat(Array.isArray(data) && data.length > 0 && data.length <= 64, 'schema');
    this.profiles = Object.freeze(data.map(profile));
  }
  private checkOwner() {
    requireThat(
      this.source.clock === this.owner.clock &&
        this.source.saves === this.owner.saves &&
        this.source.recovery === this.owner.recovery,
      'OwnerChanged',
    );
  }
  private transition<R>(work: () => R): R {
    requireThat(!this.transitioning, 'RegistryTransition');
    this.transitioning = true;
    try {
      this.checkOwner();
      return work();
    } finally {
      this.transitioning = false;
    }
  }
  install<T>(input: SchemaEditDefinition<T>, admission: Admission): SchemaEditInstallation<T> {
    return this.transition(() => {
      const d = fields(input, ['manifest', 'validate', 'schemaOf'], ['mount']);
      const manifest = parseManifest(d.manifest);
      const a = fields(admission, ['trust', 'verifiedPin']);
      requireThat(a.trust === 'trusted', 'trust');
      const p = fields(a.verifiedPin, ['id', 'version', 'packageHash']);
      const pin: Pin = frozen({
        id: text(p.id),
        version: text(p.version),
        packageHash: text(p.packageHash),
      });
      requireThat(samePin(manifest, pin), 'pin');
      requireThat(
        this.profiles.some(
          (v) =>
            v.artifactKind === manifest.artifactKind &&
            sameIdentity(v.schemaIdentity, manifest.schemaIdentity),
        ),
        'schema',
      );
      requireThat(
        typeof d.validate === 'function' &&
          typeof d.schemaOf === 'function' &&
          (!manifest.surface || typeof d.mount === 'function'),
        'manifest',
      );
      requireThat(d.mount === undefined || typeof d.mount === 'function', 'manifest');
      const validate = d.validate,
        schemaOf = d.schemaOf,
        mount = d.mount;
      requireThat(!this.installed.has(manifest.id), 'Installed');
      const active = new Set<() => RevokeTicket>();
      const installed = {
        revoke: () => {
          for (const revoke of [...active]) revoke();
        },
      };
      this.installed.set(manifest.id, installed);
      return Object.freeze({
        pin,
        open: (inputBinding: SchemaEditBinding<T>): SchemaEditOpenResult<T> =>
          this.transition(() => {
            requireThat(this.installed.get(manifest.id) === installed, 'Uninstalled');
            const binding = parseBinding(inputBinding);
            if (
              binding.artifactKind !== manifest.artifactKind ||
              !sameIdentity(binding.schemaIdentity, manifest.schemaIdentity)
            )
              return { state: 'refused', code: 'schema' };
            const grants = new Set<Grant>(
              manifest.permissions.filter((grant) => binding.allowed(grant)),
            );
            if (!grants.has('artifact:read')) return { state: 'refused', code: 'grant' };
            const reasons = negotiate(
              manifest,
              { validate: (value: unknown): value is T => validate(value) === true, mount },
              {
                supported: ADDONS,
                grants,
                recovery: !!binding.recovery,
                storage: !!binding.storage,
                resources: false,
              },
            );
            if (reasons.lifecycle)
              return { state: 'refused', code: 'required-addon', addon: 'lifecycle' };
            if (reasons.inputs && !reasons.edit) reasons.edit = 'dependency-unavailable';
            const slot = <A>(reason: typeof reasons.edit, api: A | undefined): Slot<A> => {
              if (reason) return Object.freeze({ state: 'unavailable', reason });
              requireThat(api, 'required-addon');
              return Object.freeze({ state: 'granted', api: Object.freeze(api) });
            };
            const contextFor = (
              basic: Basic<T>,
              apis: ExecutionApis<T, never>,
            ): SchemaEditContext<T> => {
              const context: SchemaEditContext<T> = Object.freeze({
                contractVersion: SCHEMA_EDIT_EXPERIMENT_VERSION,
                basic,
                addons: Object.freeze({
                  edit: slot(reasons.edit, apis.edit),
                  inputs: slot(reasons.inputs, apis.inputs),
                  save: slot(reasons.save, apis.save),
                  lifecycle: Object.freeze({
                    state: 'granted',
                    api: Object.freeze(apis.lifecycle),
                  }),
                }),
              });
              contexts.add(context);
              return context;
            };
            const handle = openScoped({
              owner: this.owner,
              binding: {
                ...binding,
                allowed: (grant: Grant) => grant !== 'resource:read' && binding.allowed(grant),
              },
              grants,
              inputsAvailable: !reasons.inputs,
              strict: true,
              validate: (content: T) => {
                requireThat(validate(content), 'InvalidContent');
                requireThat(
                  sameIdentity(identity(schemaOf(content)), manifest.schemaIdentity),
                  'schema',
                );
              },
              surface: manifest.surface,
              mount: mount
                ? (container: HTMLElement, context: SchemaEditContext<T>) => {
                    mount(container, context);
                  }
                : undefined,
              contextFor,
              transition: (work) => this.transition(work),
              isTransitioning: () => this.transitioning,
              onActive: (revoke) => active.add(revoke),
              onRevoke: (revoke) => {
                active.delete(revoke);
              },
              checkOwner: () => this.checkOwner(),
            });
            return { state: 'opened', handle };
          }),
      });
    });
  }
  uninstall(id: string) {
    this.transition(() => {
      const value = this.installed.get(id);
      if (value) {
        value.revoke();
        this.installed.delete(id);
      }
    });
  }
}
