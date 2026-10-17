import {
  CAPABILITIES,
  CONTRACT_VERSION,
  PERMISSIONS,
  type ExtensionDefinition,
  type ExtensionManifest,
  type HostAdapter,
  type Permission,
  type ScopedHost,
} from '@editor-platform/extension-contract';

export function parseManifest(input: unknown): ExtensionManifest {
  if (!input || typeof input !== 'object') throw new Error('Invalid manifest');
  const m = input as Record<string, unknown>;
  if (m.contractVersion !== CONTRACT_VERSION) throw new Error('Unsupported contract version');
  for (const field of ['id', 'artifactKind']) {
    if (typeof m[field] !== 'string' || !/^[a-z][a-z0-9.-]{0,127}$/.test(m[field]))
      throw new Error(`Invalid ${field}`);
  }
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(m.version))
    throw new Error('Invalid package version');
  if (!Number.isSafeInteger(m.schemaVersion) || (m.schemaVersion as number) < 1)
    throw new Error('Invalid schema version');
  if (typeof m.packageHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(m.packageHash))
    throw new Error('Invalid package hash');
  for (const [field, supported] of [
    ['capabilities', CAPABILITIES],
    ['permissions', PERMISSIONS],
  ] as const) {
    const values = m[field];
    if (
      !Array.isArray(values) ||
      new Set(values).size !== values.length ||
      !values.every((v) => typeof v === 'string' && (supported as readonly string[]).includes(v))
    )
      throw new Error(`Unsupported ${field}`);
  }
  if (
    !Array.isArray(m.licenseNotices) ||
    !m.licenseNotices.every((v) => typeof v === 'string' && v.length <= 4096)
  )
    throw new Error('Invalid license notices');
  // Copy only defined data fields; never preserve arbitrary manifest properties.
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    id: m.id as string,
    version: m.version,
    artifactKind: m.artifactKind as string,
    schemaVersion: m.schemaVersion as number,
    packageHash: m.packageHash,
    capabilities: Object.freeze([...(m.capabilities as ExtensionManifest['capabilities'])]),
    permissions: Object.freeze([...(m.permissions as ExtensionManifest['permissions'])]),
    licenseNotices: Object.freeze([...m.licenseNotices]),
  });
}
export interface Admission {
  trust: 'trusted' | 'untrusted';
  /** Verified externally before importing executable code. Not a manifest self-assertion. */
  verifiedPackageHash: string;
  replace?: boolean;
}
export interface ExtensionHandle<T> {
  api: ScopedHost<T>;
  mount(container: HTMLElement): void;
  close(): void;
}
export interface Registration<T> {
  readonly manifest: ExtensionManifest;
  open(host: HostAdapter<T>): ExtensionHandle<T>;
  uninstall(): void;
}

/** Trusted in-process prototype. This registry is not a sandbox or package loader. */
export class ExtensionRegistry {
  private entries = new Map<string, { manifest: ExtensionManifest; revoke(): void }>();
  private transitioning = false;
  private assertIdle() {
    if (this.transitioning) throw new Error('Registry transition in progress');
  }
  private transition<R>(action: () => R): R {
    this.assertIdle();
    this.transitioning = true;
    try {
      return action();
    } finally {
      this.transitioning = false;
    }
  }
  install<T>(definition: ExtensionDefinition<T>, admission: Admission): Registration<T> {
    return this.transition(() => this.installEntry(definition, admission));
  }
  private installEntry<T>(
    definition: ExtensionDefinition<T>,
    admission: Admission,
  ): Registration<T> {
    if (admission.trust !== 'trusted')
      throw new Error('Untrusted executable extensions are unsupported');
    const manifest = parseManifest(definition.manifest);
    if (admission.verifiedPackageHash !== manifest.packageHash)
      throw new Error('Package hash mismatch');
    if (typeof definition.validate !== 'function') throw new Error('Missing domain validator');
    if (manifest.capabilities.includes('surface') !== (typeof definition.mount === 'function'))
      throw new Error('Surface capability/adapter mismatch');
    const previous = this.entries.get(manifest.id);
    if (previous) {
      if (!admission.replace) throw new Error('Already installed; explicit replacement required');
      if (
        previous.manifest.version === manifest.version &&
        previous.manifest.packageHash !== manifest.packageHash
      )
        throw new Error('Immutable package version hash conflict');
      if (previous.manifest.artifactKind !== manifest.artifactKind)
        throw new Error('Artifact kind cannot change during replacement');
    }
    for (const entry of this.entries.values()) {
      if (
        entry.manifest.id !== manifest.id &&
        entry.manifest.artifactKind === manifest.artifactKind
      )
        throw new Error('Artifact kind already registered');
    }
    const validate = definition.validate;
    const mountSurface = definition.mount;
    let active = true;
    const closers = new Set<() => void>();
    const assertActive = () => {
      if (!active) throw new Error('Registration revoked');
    };
    const entry = {
      manifest,
      revoke: () => {
        active = false;
        // All handles are revoked even if trusted Surface cleanup throws.
        for (const close of [...closers]) {
          try {
            close();
          } catch {
            /* revocation must continue */
          }
        }
      },
    };
    previous?.revoke();
    this.entries.set(manifest.id, entry);
    return Object.freeze({
      manifest,
      uninstall: () =>
        this.transition(() => {
          entry.revoke();
          if (this.entries.get(manifest.id) === entry) this.entries.delete(manifest.id);
        }),
      open: (host: HostAdapter<T>): ExtensionHandle<T> => {
        this.assertIdle();
        assertActive();
        if (
          host.artifactKind !== manifest.artifactKind ||
          host.schemaVersion !== manifest.schemaVersion
        )
          throw new Error('Artifact kind/schema mismatch');
        let closed = false;
        let mounted = false;
        let cleanup: (() => void) | undefined;
        const guard = (permission: Permission, mutation = false) => {
          assertActive();
          if (closed) throw new Error('Handle closed');
          if (
            !manifest.permissions.includes(permission) ||
            !host.allowed(permission) ||
            (mutation && host.readOnly())
          )
            throw new Error('Permission denied');
        };
        const requireCapability = (capability: string) => {
          assertActive();
          if (closed) throw new Error('Handle closed');
          if (!(manifest.capabilities as readonly string[]).includes(capability))
            throw new Error(`Unsupported capability: ${capability}`);
        };
        const snapshot = () => {
          guard('artifact:read');
          const value = structuredClone(host.read());
          if (!validate(value)) throw new Error('Invalid domain content');
          return value;
        };
        const guardContentMutation = () => {
          // Retained handles must not reveal content through command.apply after read revocation.
          guard('artifact:read');
          guard('artifact:write', true);
        };
        const edit = () => {
          requireCapability('local-edit');
          guardContentMutation();
        };
        const api: ScopedHost<T> = Object.freeze({
          read: snapshot,
          requireCapability,
          execute: (command: Parameters<ScopedHost<T>['execute']>[0]) => {
            edit();
            // Validate inside the canonical execution path, before session history is committed.
            host.execute({
              ...command,
              readonlyInput: undefined,
              apply: (content) => {
                edit();
                const next = command.apply(structuredClone(content));
                if (!validate(next)) throw new Error('Invalid domain content');
                edit();
                return structuredClone(next);
              },
            });
          },
          undo: () => {
            edit();
            host.undo();
          },
          redo: () => {
            edit();
            host.redo();
          },
          save: async () => {
            requireCapability('persistence');
            guardContentMutation();
            await host.save();
          },
          select: (ids: readonly string[]) => {
            requireCapability('selection');
            guard('selection:write');
            if (
              !Array.isArray(ids) ||
              ids.length > 10000 ||
              !ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128)
            )
              throw new Error('Invalid selection');
            host.select([...ids]);
          },
        });
        snapshot();
        const close = () => {
          if (closed) return;
          closed = true;
          closers.delete(close);
          const dispose = cleanup;
          cleanup = undefined;
          dispose?.();
        };
        closers.add(close);
        return Object.freeze({
          api,
          close,
          mount: (container: HTMLElement) => {
            requireCapability('surface');
            guard('artifact:read');
            if (mounted) throw new Error('Already mounted');
            mounted = true;
            try {
              const dispose = mountSurface!(container, api);
              if (closed || !active) dispose();
              else cleanup = dispose;
            } catch (error) {
              close();
              throw error;
            }
          },
        });
      },
    });
  }
}
