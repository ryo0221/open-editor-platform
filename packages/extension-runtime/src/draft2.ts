import { openScoped } from './scoped-execution';
/** Bounded trusted fake-adapter reference. No production Host or sandbox claim. */
import { type EditorInputs, type EditorSession } from '@editor-platform/editor-core';
import type {
  AddonId,
  Context,
  DefinitionD2,
  Grant,
  OpenResult,
  Pin,
  RevokeTicket,
  Slots,
} from '@editor-platform/extension-contract/draft2';
import { ADDONS, negotiate, parseManifest, samePin } from './draft2/manifest';
import { finite, frozen, requireThat, type Clock } from './draft2/primitives';
import { RecoveryStore, type RecoveryPolicy } from './draft2/inputs';
import { type ResourceProvider } from './draft2/resources';
import { SaveCoordinator, type Storage } from './draft2/save';
export { ReferenceError } from './draft2/primitives';
export { VERSIONS, TOKEN } from './draft2/manifest';
export type { Clock } from './draft2/primitives';
export type { Storage, WriteEvidence, WriteRequest } from './draft2/save';
export type { ResourceProvider, RawLease } from './draft2/resources';
export type { RecoveryPolicy } from './draft2/inputs';
export interface Binding<T, Ref> {
  artifactId: string;
  artifactKind: string;
  schemaVersion: number;
  session: EditorSession<T>;
  inputs: EditorInputs;
  allowed(grant: Grant): boolean;
  subscribePermissions(listener: () => void): () => void;
  recovery?: RecoveryPolicy;
  storage?: Storage<T>;
  resources?: ResourceProvider<Ref>;
}
export interface Admission {
  trust: 'trusted' | 'untrusted';
  verifiedPin: Pin;
}
export class ReferenceRegistry {
  readonly saves: SaveCoordinator;
  readonly recovery: RecoveryStore;
  private transitioning = false;
  private installations = new Map<string, { pin: Pin; revoke: () => void }>();
  constructor(
    readonly clock: Clock,
    private readonly supported: readonly AddonId[] = ADDONS,
  ) {
    this.saves = new SaveCoordinator(clock);
    this.recovery = new RecoveryStore(clock);
  }
  private transition<T>(work: () => T): T {
    requireThat(!this.transitioning, 'RegistryTransition');
    this.transitioning = true;
    try {
      return work();
    } finally {
      this.transitioning = false;
    }
  }
  install<T, Ref>(definition: DefinitionD2<T, Ref>, admission: Admission) {
    return this.transition(() => {
      requireThat(admission.trust === 'trusted', 'trust');
      const manifest = parseManifest(definition.manifest);
      requireThat(samePin(manifest, admission.verifiedPin), 'pin');
      requireThat(!this.installations.has(manifest.id), 'Installed');
      const active = new Set<() => RevokeTicket>();
      const installed = {
        pin: frozen(admission.verifiedPin),
        revoke: () => {
          for (const revoke of [...active]) revoke();
        },
      };
      this.installations.set(manifest.id, installed);
      return {
        pin: installed.pin,
        open: (binding: Binding<T, Ref>): OpenResult<T, Ref> =>
          this.transition(() => {
            requireThat(this.installations.get(manifest.id) === installed, 'Uninstalled');
            if (
              binding.artifactKind !== manifest.artifactKind ||
              binding.schemaVersion !== manifest.schemaVersion
            )
              return { state: 'refused', code: 'schema' };
            const grants = new Set(manifest.permissions.filter((grant) => binding.allowed(grant)));
            if (!grants.has('artifact:read')) return { state: 'refused', code: 'grant' };
            const policy = binding.recovery;
            if (policy)
              for (const value of [policy.perBoundaryBytes, policy.totalBytes, policy.ttlMs])
                requireThat(finite(value), 'RecoveryPolicy');
            const reasons = negotiate(manifest, definition, {
              supported: this.supported,
              grants,
              recovery: !!policy,
              storage: !!binding.storage,
              resources: !!binding.resources,
            });
            for (const id of ADDONS)
              if (reasons[id] && manifest.addons[id]?.requirement === 'required')
                return { state: 'refused', code: 'required-addon', addon: id };
            const handle = openScoped({
              owner: this,
              binding,
              grants,
              inputsAvailable: !reasons.inputs,
              validate: (content) => requireThat(definition.validate(content), 'InvalidContent'),
              surface: manifest.surface,
              // draft.2 methods historically run with the definition as receiver.
              mount: (container, context: Context<T, Ref>) => definition.mount!(container, context),
              contextFor: (basic, apis) => {
                const slots = Object.fromEntries(
                  ADDONS.map((id) => [
                    id,
                    reasons[id]
                      ? Object.freeze({ state: 'unavailable', reason: reasons[id] })
                      : Object.freeze({ state: 'granted', api: Object.freeze(apis[id]) }),
                  ]),
                ) as unknown as Slots<T, Ref>;
                return Object.freeze({ basic, addons: Object.freeze(slots) });
              },
              transition: (work) => this.transition(work),
              isTransitioning: () => this.transitioning,
              onActive: (revoke) => active.add(revoke),
              onRevoke: (revoke) => {
                active.delete(revoke);
              },
            });
            return { state: 'opened', handle };
          }),
      };
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
export { adaptLegacy, LegacySaveError } from './draft2/legacy';
