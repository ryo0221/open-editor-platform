import {
  CAPABILITIES,
  CONTRACT_VERSION,
  PERMISSIONS,
  type ExtensionDefinition,
  type ExtensionManifest,
  type OperationDeclaration,
  type HostAdapter,
  type Permission,
  type ScopedHost,
} from '@editor-platform/extension-contract';
import { canonicalJson } from '@editor-platform/artifact-core';
import type { LocalCommandContext } from '@editor-platform/editor-core';
import { operationInputProblems, parseAddons } from './operations';

export {
  OPERATION_LIMITS,
  operationDeclarationProblems,
  operationInputProblems,
} from './operations';

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
  // Optional add-ons are exact-version opt-ins; an absent field stays absent (unchanged canonical form).
  const addons = m.addons === undefined ? undefined : parseAddons(m.addons);
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
    ...(addons ? { addons } : {}),
  });
}
export interface Admission {
  trust: 'trusted' | 'untrusted';
  /** Verified externally before importing executable code. Not a manifest self-assertion. */
  verifiedPackageHash: string;
  replace?: boolean;
  /** Live Host-owned pin verification, including retained operations. */
  assertTrusted?: () => void;
}
export interface ExtensionHandle<T> {
  api: ScopedHost<T>;
  mount(container: HTMLElement): void;
  close(): void;
  /** Present only when the manifest declares `operations@0-draft`. */
  operations?: ExtensionOperations<T>;
}
export type OperationRef = Readonly<{ id: string; version: string }>;
/** One operation checked against the current content, not yet in session history. */
export interface PreparedOperation<T> {
  /** Detached, frozen content the operation was built from. */
  readonly base: T;
  /** Detached, frozen result that passed the package validator. */
  readonly candidate: T;
  /**
   * Records exactly `candidate` through the Host's canonical execute path, once. The executed
   * command never calls the package again: its apply throws (leaving history untouched) unless
   * the content it receives still equals `base`. The Host passes its own context (for example
   * `origin: 'proposal'` with a Host-issued transaction id).
   */
  commit(context?: LocalCommandContext): void;
}
export interface ExtensionOperations<T> {
  readonly declarations: readonly OperationDeclaration[];
  /** Schema problems first, then the package's own checks against the current content. */
  check(operation: OperationRef, input: unknown): readonly string[];
  /** Throws with the problems, or when the result fails the package validator. */
  prepare(operation: OperationRef, input: unknown): PreparedOperation<T>;
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
    const operationsAdapter = definition.operations;
    if (
      !!manifest.addons?.operations !==
      (!!operationsAdapter &&
        typeof operationsAdapter.checkInput === 'function' &&
        typeof operationsAdapter.command === 'function')
    )
      throw new Error('Operations add-on/adapter mismatch');
    if (operationsAdapter && !manifest.capabilities.includes('local-edit'))
      throw new Error('Operations require local-edit');
    const checkInput = operationsAdapter?.checkInput,
      makeCommand = operationsAdapter?.command;
    const trusted = admission.assertTrusted;
    trusted?.();
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
    // Entries are keyed by Editor/package id. Several Editors may serve one artifactKind; the
    // Host chooses explicitly which Registration opens an artifact. kind/schema is checked at open.
    const validate = definition.validate;
    const mountSurface = definition.mount;
    let active = true;
    const closers = new Set<() => void>();
    const assertActive = () => {
      if (!active) throw new Error('Registration revoked');
      trusted?.();
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
        const declarations = manifest.addons?.operations?.declarations;
        const check = (operation: OperationRef, input: unknown, content: T): string[] => {
          const problems = operationInputProblems(declarations!, operation, input);
          if (problems.length) return problems;
          const own = checkInput!.call(
            operationsAdapter,
            operation.id,
            structuredClone(input),
            structuredClone(content),
          );
          if (!Array.isArray(own) || !own.every((p) => typeof p === 'string'))
            throw new Error('Invalid operation check result');
          return [...own];
        };
        const operations: ExtensionOperations<T> | undefined = declarations
          ? Object.freeze({
              declarations,
              check: (operation: OperationRef, input: unknown) => {
                requireCapability('local-edit');
                return Object.freeze(check(operation, input, snapshot()));
              },
              prepare: (operation: OperationRef, input: unknown): PreparedOperation<T> => {
                edit();
                const base = snapshot();
                const problems = check(operation, input, base);
                if (problems.length)
                  throw new Error(`Operation input refused: ${problems.join('; ')}`);
                const cmd = makeCommand!.call(
                  operationsAdapter,
                  operation.id,
                  structuredClone(input),
                  structuredClone(base),
                );
                if (!cmd || typeof cmd.apply !== 'function')
                  throw new Error('Invalid operation command');
                // The package's apply runs once, on a private copy. Only its checked result is kept.
                const result = structuredClone(cmd.apply(structuredClone(base)));
                if (!validate(result)) throw new Error('Invalid domain content');
                const frozenBase = deepFreeze(structuredClone(base));
                const candidate = deepFreeze(result);
                const baseJson = canonicalJson(frozenBase);
                // Single use: the first commit attempt consumes the prepared operation before the Host
                // executes, so a synchronous Host notification cannot re-enter and commit it twice. A failed
                // attempt (stale base, revoked access) is not retried; the Host prepares again.
                let used = false;
                return Object.freeze({
                  base: frozenBase,
                  candidate,
                  commit: (context?: LocalCommandContext) => {
                    edit();
                    if (used) throw new Error('Operation already committed');
                    used = true;
                    host.execute({
                      type: String(cmd.type),
                      label: String(cmd.label),
                      ...(context ? { context: { ...context, mergeKey: undefined } } : {}),
                      apply: (content: T) => {
                        edit();
                        if (canonicalJson(content) !== baseJson)
                          throw new Error('Operation base changed');
                        return structuredClone(candidate) as T;
                      },
                    });
                  },
                });
              },
            })
          : undefined;
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
          ...(operations ? { operations } : {}),
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
function deepFreeze<V>(value: V): V {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
