import { deepFreeze } from '@editor-platform/artifact-core';
import {
  EVALUATOR_V1,
  SCHEMA,
  TICKS_PER_SECOND_V1,
  inspectPreparedComposition,
  prepareRectangleAnimationV1,
  readAnimationV1,
  type AnimationContentV1,
} from '@editor-platform/animation-core';
import {
  mountRectanglePlayerV1,
  RECTANGLE_PLAYER_CONTRACT_V1,
  type RectanglePlayerV1,
} from '@editor-platform/animation-player/v1';
import { sameLocalRevision } from '@editor-platform/editor-core';
import type {
  Context,
  DefinitionD2,
  LocalReadSnapshot,
} from '@editor-platform/extension-contract/draft2';

/** Sample-local migration evidence, supplied by the trusted Host after explicit migration.
 * Hash comparison is not a retained-version catalog or independent provenance verification. */
export interface RectangleViewerProvenance {
  artifactId: string;
  compositionId: string;
  baseVersionId: string;
  sourceContentHash: string;
  targetContentHash: string;
  sourceSchema: typeof SCHEMA;
  schemaVersion: 1;
  ticksPerSecond: typeof TICKS_PER_SECOND_V1;
  evaluatorVersion: typeof EVALUATOR_V1;
  playerVersion: typeof RECTANGLE_PLAYER_CONTRACT_V1;
}
/** Controlled fault gates for this independent sample, not a production Host API. */
export interface ViewerTestGates {
  beforePrepare?(): void | Promise<void>;
  beforeMount?(): void | Promise<void>;
  afterMount?(): void | Promise<void>;
  afterDispose?(): void | Promise<void>;
}
export interface ViewerMount {
  /** No native content/player object is delivered to a consumer. */
  readonly ready: Promise<'ready'>;
  dispose(): Promise<void>;
}
function requireViewer(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
function checkedProvenance(value: RectangleViewerProvenance): RectangleViewerProvenance {
  const pin = deepFreeze(structuredClone(value));
  requireViewer(
    [pin.artifactId, pin.compositionId, pin.baseVersionId].every(
      (value) => typeof value === 'string' && value.length > 0 && value.length <= 256,
    ),
    'ViewerProvenance',
  );
  requireViewer(
    [pin.sourceContentHash, pin.targetContentHash].every((value) => /^[a-f0-9]{64}$/.test(value)),
    'ViewerProvenance',
  );
  requireViewer(
    pin.sourceSchema === SCHEMA &&
      pin.schemaVersion === 1 &&
      pin.ticksPerSecond === TICKS_PER_SECOND_V1 &&
      pin.evaluatorVersion === EVALUATOR_V1 &&
      pin.playerVersion === RECTANGLE_PLAYER_CONTRACT_V1,
    'ViewerContractPin',
  );
  return pin;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
/** Exact rectangle Player over actual Basic/Lifecycle; no edit/save/resources access. */
export function mountReadOnlyRectangleViewer(
  container: HTMLElement,
  context: Context<AnimationContentV1, never>,
  provenance: RectangleViewerProvenance,
  gates: ViewerTestGates = {},
): ViewerMount {
  const pin = checkedProvenance(provenance);
  requireViewer(context.addons.lifecycle.state === 'granted', 'ViewerLifecycleRequired');
  const lifecycle = context.addons.lifecycle.api;
  lifecycle.assertCurrent();
  const root = container.ownerDocument.createElement('section');
  root.setAttribute('aria-label', 'Scoped Animation viewer');
  const stage = container.ownerDocument.createElement('div');
  stage.setAttribute('aria-label', 'Rectangle stage');
  stage.style.height = '240px';
  root.append(stage);
  const ready = deferred<'ready'>();
  // Lifecycle owns readiness even if a surface caller does not await it.
  void ready.promise.catch(() => {});
  const acquired = deferred<void>();
  const localAbort = new AbortController();
  let closed = false;
  let player: RectanglePlayerV1 | undefined;
  let cleanup: Promise<void> | undefined;
  let capture: LocalReadSnapshot<AnimationContentV1> | undefined;
  const listeners: (() => void)[] = [];
  const current = () => {
    requireViewer(!closed && !lifecycle.signal.aborted, 'ScopeRevoked');
    lifecycle.assertCurrent();
    const next = context.basic.read();
    requireViewer(
      next.scope.artifactId === pin.artifactId &&
        next.scope.artifactId === context.basic.scope.artifactId &&
        next.scope.sessionId === context.basic.scope.sessionId &&
        next.scope.generation === context.basic.scope.generation,
      'ViewerScope',
    );
    if (capture)
      requireViewer(sameLocalRevision(capture.revision, next.revision), 'ViewerSourceChanged');
    // Recheck after Basic read in case trusted Host callbacks revoked synchronously.
    lifecycle.assertCurrent();
    requireViewer(!closed && !lifecycle.signal.aborted, 'ScopeRevoked');
    return next;
  };
  const dispose = (): Promise<void> => {
    if (!closed) {
      closed = true;
      ready.reject(new Error('ScopeRevoked'));
      root.remove();
      for (const stop of listeners) stop();
      localAbort.abort();
    }
    if (!cleanup) {
      cleanup = (async () => {
        await acquired.promise;
        player?.dispose();
        await gates.afterDispose?.();
      })();
      void cleanup.catch(() => {}); // Returned to lifecycle; failures remain in drain.
    }
    return cleanup;
  };
  const revoked = () => {
    void dispose();
  };
  // Own the acquisition before any Basic read or asynchronous callback can start it.
  lifecycle.registerDisposable(`rectangle-viewer:${crypto.randomUUID()}`, dispose);
  lifecycle.signal.addEventListener('abort', revoked, { once: true });
  listeners.push(() => lifecycle.signal.removeEventListener('abort', revoked));
  const fail = (error: unknown) => {
    ready.reject(error);
    void dispose();
  };
  const guarded = (operation: () => void) => {
    if (closed) return;
    try {
      current();
      operation();
      current();
    } catch (error) {
      fail(error);
    }
  };
  const listen = (element: HTMLElement, type: string, operation: () => void) => {
    const handler = () => guarded(operation);
    element.addEventListener(type, handler);
    listeners.push(() => element.removeEventListener(type, handler));
  };
  const work = async () => {
    try {
      capture = current();
      await gates.beforePrepare?.();
      current();
      const prepared = await prepareRectangleAnimationV1(capture.content);
      current();
      requireViewer(
        prepared.contentHash === pin.targetContentHash &&
          prepared.evaluatorVersion === pin.evaluatorVersion,
        'ViewerSourcePin',
      );
      const metadata = inspectPreparedComposition(prepared, pin.compositionId);
      requireViewer(
        metadata.schemaVersion === 1 &&
          metadata.ticksPerSecond === TICKS_PER_SECOND_V1 &&
          !metadata.hasAssets,
        'ViewerContractPin',
      );
      await gates.beforeMount?.();
      current();
      const win = container.ownerDocument.defaultView;
      requireViewer(win, 'ViewerWindow');
      // Every scheduled rendering callback checks the original scope/revision. No follow mode.
      player = mountRectanglePlayerV1(stage, {
        source: prepared,
        compositionId: pin.compositionId,
        label: 'Read-only rectangle animation',
        signal: localAbort.signal,
        autoPlay: false,
        clock: {
          now: () => win.performance.now(),
          request: (callback) => win.requestAnimationFrame(() => guarded(callback)),
          cancel: (id) => win.cancelAnimationFrame(id),
        },
      });
      await gates.afterMount?.();
      current();
      const seek = container.ownerDocument.createElement('input');
      seek.type = 'range';
      seek.min = '0';
      seek.max = String(metadata.duration);
      seek.step = '1';
      seek.value = '0';
      seek.setAttribute('aria-label', 'Seek Animation tick');
      listen(seek, 'input', () => player!.seek(Number(seek.value)));
      root.append(seek);
      for (const [label, action] of [
        ['Play Animation', () => player!.play()],
        ['Pause Animation', () => player!.pause()],
      ] as const) {
        const button = container.ownerDocument.createElement('button');
        button.textContent = label;
        listen(button, 'click', action);
        root.append(button);
      }
      current();
      container.append(root);
      current(); // Includes synchronous reentry through trusted DOM/mount hooks.
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
export function rectangleViewerExtension(
  packageHash: string,
  provenance: RectangleViewerProvenance,
  options: { gates?: ViewerTestGates; observe?: (mount: ViewerMount) => void } = {},
): DefinitionD2<AnimationContentV1, never> {
  const pin = checkedProvenance(provenance);
  return {
    manifest: {
      id: 'example.animation-rectangle-viewer',
      version: '0.0.1-draft.1',
      packageHash,
      contractVersion: '1.0.0-draft.2',
      artifactKind: 'animation',
      schemaVersion: 1,
      surface: true,
      permissions: ['artifact:read'],
      addons: { lifecycle: { version: 'lifecycle@0-draft', requirement: 'required' } },
      licenseNotices: ['Independent trusted sample; repository license terms remain unchanged.'],
    },
    validate(value): value is AnimationContentV1 {
      try {
        readAnimationV1(value);
        return true;
      } catch {
        return false;
      }
    },
    mount(container, context) {
      const mounted = mountReadOnlyRectangleViewer(container, context, pin, options.gates);
      // The observer is Host-owned sample instrumentation, not a content/player capability.
      options.observe?.(mounted);
    },
  };
}
export { rectanglePrototypeFixture } from './fixture';
