import { sameLocalRevision } from '@editor-platform/editor-core';
import type {
  Context,
  DefinitionD2,
  LocalReadSnapshot,
  Scope,
} from '@editor-platform/extension-contract/draft2';
import { assertGeo, type Budgets, type GeoDocument } from '@editor-platform/geo-core';
import { createGeoInspectorSurface, prepareGeoInspection } from './surface';
/** Host-owned test synchronization, not new platform capabilities or a subscription API. */
export interface InspectorTestGates {
  beforePrepare?(): void | Promise<void>;
  beforeMount?(): void | Promise<void>;
  afterMount?(): void | Promise<void>;
  afterDispose?(): void | Promise<void>;
}
export interface GeoInspectorMount {
  readonly ready: Promise<'ready'>;
  dispose(): Promise<void>;
}
function requireInspector(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
const sameScope = (a: Scope, b: Scope) =>
  a.artifactId === b.artifactId && a.sessionId === b.sessionId && a.generation === b.generation;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Fixed Basic capture with exactly read + required lifecycle. No live-follow API is invented. */
export function mountGeoInspector(
  container: HTMLElement,
  context: Context<GeoDocument, never>,
  packageHash: string,
  budgets: Budgets,
  gates: InspectorTestGates = {},
): GeoInspectorMount {
  requireInspector(
    typeof packageHash === 'string' && /^[a-f0-9]{64}$/.test(packageHash),
    'GeoInspectorPackagePin',
  );
  requireInspector(context.addons.lifecycle.state === 'granted', 'GeoInspectorLifecycleRequired');
  for (const addon of ['edit', 'save', 'inputs', 'resources'] as const)
    requireInspector(context.addons[addon].state === 'unavailable', 'GeoInspectorReadOnlyScope');
  const lifecycle = context.addons.lifecycle.api;
  lifecycle.assertCurrent();
  const ready = deferred<'ready'>(),
    acquired = deferred<void>();
  void ready.promise.catch(() => {});
  let closed = false,
    cleanup: Promise<void> | undefined,
    capture: LocalReadSnapshot<GeoDocument> | undefined;
  let surface: ReturnType<typeof createGeoInspectorSurface> | undefined;
  const removers: (() => void)[] = [];
  const current = () => {
    requireInspector(!closed && !lifecycle.signal.aborted, 'ScopeRevoked');
    lifecycle.assertCurrent();
    const next = context.basic.read();
    requireInspector(
      sameScope(next.scope, context.basic.scope) &&
        sameScope(next.scope, lifecycle.scope) &&
        next.revision.sessionId === next.scope.sessionId,
      'GeoInspectorScope',
    );
    if (capture)
      requireInspector(
        sameLocalRevision(next.revision, capture.revision),
        'GeoInspectorSourceChanged',
      );
    assertGeo(next.content, budgets);
    lifecycle.assertCurrent();
    requireInspector(!closed && !lifecycle.signal.aborted, 'ScopeRevoked');
    return next;
  };
  const dispose = (): Promise<void> => {
    if (!closed) {
      closed = true;
      ready.reject(new Error('ScopeRevoked'));
      surface?.dispose();
      for (const stop of removers.splice(0)) stop();
    }
    if (!cleanup) {
      cleanup = (async () => {
        await acquired.promise;
        surface?.dispose();
        await gates.afterDispose?.();
      })();
      void cleanup.catch(() => {});
    }
    return cleanup;
  };
  const fail = (error: unknown) => {
    ready.reject(error);
    void dispose();
  };
  const revoked = () => {
    void dispose();
  };
  // Own eventual acquisition before Basic.read or any async test/prepare work can begin.
  try {
    lifecycle.registerDisposable(`geo-inspector:${crypto.randomUUID()}`, dispose);
  } catch (error) {
    acquired.resolve();
    ready.reject(error);
    throw error;
  }
  lifecycle.signal.addEventListener('abort', revoked, { once: true });
  removers.push(() => lifecycle.signal.removeEventListener('abort', revoked));
  if (lifecycle.signal.aborted) revoked();
  const work = async () => {
    try {
      capture = current();
      await gates.beforePrepare?.();
      current();
      const prepared = await prepareGeoInspection(capture.content, budgets);
      current();
      await gates.beforeMount?.();
      current();
      surface = createGeoInspectorSurface(container.ownerDocument, prepared, {
        artifactId: capture.scope.artifactId,
        sequence: capture.revision.sequence,
        packageHash,
      });
      const guarded = (event: Event) => {
        try {
          current();
        } catch (error) {
          event.preventDefault();
          event.stopImmediatePropagation();
          fail(error);
        }
      };
      for (const type of ['click', 'keydown']) {
        surface.element.addEventListener(type, guarded, true);
        const element = surface.element;
        removers.push(() => element.removeEventListener(type, guarded, true));
      }
      current();
      container.append(surface.element);
      current();
      await gates.afterMount?.();
      current();
      ready.resolve('ready');
    } catch (error) {
      fail(error);
    } finally {
      acquired.resolve();
    }
  };
  void work();
  return Object.freeze({ ready: ready.promise, dispose });
}
export function geoInspectorExtension(
  packageHash: string,
  budgets: Budgets,
  options: { gates?: InspectorTestGates; observe?: (mount: GeoInspectorMount) => void } = {},
): DefinitionD2<GeoDocument, never> {
  requireInspector(
    typeof packageHash === 'string' && /^[a-f0-9]{64}$/.test(packageHash),
    'GeoInspectorPackagePin',
  );
  // Host-owned policy snapshot; the facade's lower fixed copyData bounds still apply.
  assertGeo({ schemaVersion: 1, layers: [], sources: [] }, budgets);
  const limits = Object.freeze({ ...budgets });
  return {
    manifest: {
      id: 'example.geo-inspector',
      version: '0.0.0-experiment.1',
      packageHash,
      contractVersion: '1.0.0-draft.2',
      artifactKind: 'geo',
      schemaVersion: 1,
      surface: true,
      permissions: ['artifact:read'],
      addons: { lifecycle: { version: 'lifecycle@0-draft', requirement: 'required' } },
      licenseNotices: [
        'Trusted local experimental Geo inspector; existing repository license scope is unchanged.',
      ],
    },
    validate(value): value is GeoDocument {
      try {
        assertGeo(value, limits);
        return true;
      } catch {
        return false;
      }
    },
    mount(container, context) {
      const mounted = mountGeoInspector(container, context, packageHash, limits, options.gates);
      options.observe?.(mounted);
    },
  };
}
