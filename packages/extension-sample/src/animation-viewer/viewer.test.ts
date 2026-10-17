import { beforeEach, expect, it, vi } from 'vitest';
import { canonicalJson, commitVersion, createArtifact } from '@editor-platform/artifact-core';
import {
  EVALUATOR_V1,
  SCHEMA,
  migratePrototypeDraftToV1,
  type AnimationContentV1,
} from '@editor-platform/animation-core';
import {
  RECTANGLE_PLAYER_CONTRACT_V1,
  mountRectanglePlayerV1,
  type RectanglePlayerOptionsV1,
} from '@editor-platform/animation-player/v1';
import { command } from '@editor-platform/editor-core';
import { ReferenceRegistry } from '@editor-platform/extension-runtime/draft2';
import {
  ManualClock,
  deferred,
  referenceBinding,
} from '@editor-platform/extension-runtime/reference';
import {
  rectangleViewerExtension,
  rectanglePrototypeFixture,
  type RectangleViewerProvenance,
  type ViewerMount,
  type ViewerTestGates,
} from './index';
vi.mock('@editor-platform/animation-player/v1', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@editor-platform/animation-player/v1')>()),
  mountRectanglePlayerV1: vi.fn(),
}));
class Element extends EventTarget {
  children: Element[] = [];
  parent?: Element;
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  textContent = '';
  type = '';
  min = '';
  max = '';
  step = '';
  value = '';
  onAppend?: () => void;
  constructor(
    readonly ownerDocument: Doc,
    readonly tag: string,
  ) {
    super();
  }
  append(child: Element) {
    child.parent = this;
    this.children.push(child);
    this.onAppend?.();
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = undefined;
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  find(tag: string): Element | undefined {
    return this.tag === tag ? this : this.children.map((child) => child.find(tag)).find(Boolean);
  }
}
class Doc {
  frames: (() => void)[] = [];
  defaultView = {
    performance: { now: () => 0 },
    requestAnimationFrame: (callback: () => void) => {
      this.frames.push(callback);
      return this.frames.length;
    },
    cancelAnimationFrame: vi.fn(),
  };
  createElement(tag: string) {
    return new Element(this, tag);
  }
}
const players: {
  seek: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  disposed: boolean;
  options: RectanglePlayerOptionsV1;
}[] = [];
let mountHook: (() => void) | undefined;
beforeEach(() => {
  players.length = 0;
  mountHook = undefined;
  vi.mocked(mountRectanglePlayerV1)
    .mockReset()
    .mockImplementation((container, options) => {
      mountHook?.();
      const state = { disposed: false, options, seek: vi.fn(), dispose: vi.fn() };
      const svg = (container as unknown as Element).ownerDocument.createElement('svg');
      (container as unknown as Element).append(svg);
      state.dispose.mockImplementation(() => {
        if (!state.disposed) {
          state.disposed = true;
          svg.remove();
        }
      });
      options.signal?.addEventListener('abort', state.dispose, { once: true });
      players.push(state);
      return {
        tick: 0,
        playing: false,
        seek: state.seek,
        dispose: state.dispose,
        play: () => {
          options.clock!.request(() => state.seek(10));
        },
        pause: vi.fn(),
        setRate: vi.fn(),
      };
    });
});
async function fixture(
  gates: ViewerTestGates = {},
  pinPatch: Partial<RectangleViewerProvenance> = {},
) {
  const original = await commitVersion(
    createArtifact('animation', 'Retained', rectanglePrototypeFixture()),
    null,
    'original',
  );
  const oldBytes = canonicalJson(original);
  const oldHash = original.versions[0].contentHash;
  const migrated = await migratePrototypeDraftToV1(
    original.draft,
    oldHash,
    '2026-10-12T00:00:00.000Z',
  );
  const provenance: RectangleViewerProvenance = {
    artifactId: original.id,
    compositionId: 'root',
    baseVersionId: migrated.draft.baseVersionId!,
    sourceContentHash: migrated.sourceContentHash,
    targetContentHash: migrated.targetContentHash,
    sourceSchema: SCHEMA,
    schemaVersion: 1,
    ticksPerSecond: 240000,
    evaluatorVersion: EVALUATOR_V1,
    playerVersion: RECTANGLE_PLAYER_CONTRACT_V1,
    ...pinPatch,
  };
  const binding = referenceBinding(migrated.draft.content, original.id);
  binding.artifactKind = 'animation';
  binding.setGrants(['artifact:read']);
  const clock = new ManualClock(),
    registry = new ReferenceRegistry(clock),
    observed: ViewerMount[] = [];
  const definition = rectangleViewerExtension('e'.repeat(64), provenance, {
    gates,
    observe: (value) => observed.push(value),
  });
  const installed = registry.install(definition, {
    trust: 'trusted',
    verifiedPin: definition.manifest,
  });
  const doc = new Doc(),
    target = doc.createElement('main');
  const open = () => {
    const result = installed.open({ ...binding, resources: undefined });
    if (result.state !== 'opened') throw new Error(result.code);
    result.handle.mount(target as unknown as HTMLElement);
    return { handle: result.handle, mount: observed.at(-1)! };
  };
  return {
    original,
    oldBytes,
    oldHash,
    migrated,
    provenance,
    binding,
    registry,
    clock,
    definition,
    doc,
    target,
    open,
  };
}
it('real Basic/Lifecycle grants only read; pins migrated source and preserves original bytes/hash', async () => {
  const h = await fixture();
  const a = h.open();
  await expect(a.mount.ready).resolves.toBe('ready');
  expect(h.definition.manifest.permissions).toEqual(['artifact:read']);
  for (const name of ['edit', 'save', 'inputs', 'resources'] as const)
    expect(a.handle.context.addons[name]).toEqual({
      state: 'unavailable',
      reason: 'not-requested',
    });
  expect(players[0].options.source.contentHash).toBe(h.migrated.targetContentHash);
  expect(players[0].options.source.evaluatorVersion).toBe(EVALUATOR_V1);
  expect(h.target.find('svg')).toBeDefined();
  expect(h.binding.session.canUndo).toBe(false);
  expect(canonicalJson(h.original)).toBe(h.oldBytes);
  expect(h.original.versions[0].contentHash).toBe(h.oldHash);
  a.handle.revoke('host-close');
  await a.mount.dispose();
});
it.each(['beforePrepare', 'beforeMount', 'afterMount'] as const)(
  'close/reopen during %s never presents or delivers late A over B',
  async (phase) => {
    const entered = deferred<void>(),
      gate = deferred<void>();
    let first = true;
    const h = await fixture({
      [phase]: () => {
        if (first) {
          first = false;
          entered.resolve();
          return gate.promise;
        }
      },
    });
    const a = h.open();
    const result = a.mount.ready.catch((error) => error);
    await entered.promise;
    a.handle.revoke('replace');
    expect((await result).message).toBe('ScopeRevoked');
    expect((await a.handle.drain({ deadlineMs: 0 })).state).toBe('incomplete');
    const b = h.open();
    await b.mount.ready;
    const rootB = h.target.children[0];
    gate.resolve();
    await a.mount.dispose();
    expect(h.target.children).toEqual([rootB]);
    expect((await a.handle.drain({ deadlineMs: 0 })).state).toBe('drained');
    expect(b.handle.scope.generation).not.toBe(a.handle.scope.generation);
    b.handle.revoke('host-close');
    await b.mount.dispose();
  },
);
it('read revocation is immediate; restoring grants never resurrects old work', async () => {
  const entered = deferred<void>(),
    gate = deferred<void>();
  const h = await fixture({
    beforePrepare: () => {
      entered.resolve();
      return gate.promise;
    },
  });
  const a = h.open();
  const result = a.mount.ready.catch((error) => error);
  await entered.promise;
  h.binding.setGrants([]);
  expect((await result).message).toBe('ScopeRevoked');
  h.binding.setGrants(['artifact:read']);
  gate.resolve();
  await a.mount.dispose();
  expect(mountRectanglePlayerV1).not.toHaveBeenCalled();
  expect(h.target.children).toEqual([]);
  expect(() => a.handle.context.basic.read()).toThrow('ScopeRevoked');
});
it('delayed cleanup and queued old frame/control cannot touch reopened B', async () => {
  const entered = deferred<void>(),
    gate = deferred<void>();
  let first = true;
  const h = await fixture({
    afterDispose: () => {
      if (first) {
        first = false;
        entered.resolve();
        return gate.promise;
      }
    },
  });
  const a = h.open();
  await a.mount.ready;
  const oldRoot = h.target.children[0],
    oldSeek = oldRoot.find('input')!;
  oldRoot.children
    .find((child) => child.textContent === 'Play Animation')!
    .dispatchEvent(new Event('click'));
  const queued = h.doc.frames[0];
  a.handle.revoke('replace');
  await entered.promise;
  expect(h.target.children).toEqual([]);
  expect((await a.handle.drain({ deadlineMs: 0 })).state).toBe('incomplete');
  const b = h.open();
  await b.mount.ready;
  const rootB = h.target.children[0];
  oldSeek.value = '240000';
  oldSeek.dispatchEvent(new Event('input'));
  queued();
  expect(players[0].seek).not.toHaveBeenCalled();
  expect(players[1].seek).not.toHaveBeenCalled();
  gate.resolve();
  await a.mount.dispose();
  expect(h.target.children).toEqual([rootB]);
  b.handle.revoke('host-close');
  await b.mount.dispose();
});
it.each(['mount', 'afterMount', 'present'] as const)(
  'synchronous revoke at %s cannot publish stale source',
  async (phase) => {
    let revoke = () => {};
    const h = await fixture(phase === 'afterMount' ? { afterMount: () => revoke() } : {});
    if (phase === 'mount') mountHook = () => revoke();
    if (phase === 'present') h.target.onAppend = () => revoke();
    const a = h.open();
    revoke = () => a.handle.revoke('host-close');
    await expect(a.mount.ready).rejects.toThrow('ScopeRevoked');
    await a.mount.dispose();
    expect(h.target.children).toEqual([]);
    expect(players.every((player) => player.disposed)).toBe(true);
  },
);
it('revision advancement during preparation rejects without automatic source follow', async () => {
  const entered = deferred<void>(),
    gate = deferred<void>();
  const h = await fixture({
    beforePrepare: () => {
      entered.resolve();
      return gate.promise;
    },
  });
  const a = h.open();
  const result = a.mount.ready.catch((error) => error);
  await entered.promise;
  h.binding.session.execute(
    command<AnimationContentV1>('host-edit', 'Host edit', (content) => content),
  );
  gate.resolve();
  expect((await result).message).toBe('ViewerSourceChanged');
  await a.mount.dispose();
  expect(mountRectanglePlayerV1).not.toHaveBeenCalled();
  expect(h.target.children).toEqual([]);
  a.handle.revoke('host-close');
});
it('wrong migrated hash refuses display and prototype is never silently migrated', async () => {
  const h = await fixture({}, { targetContentHash: 'f'.repeat(64) });
  expect(h.definition.validate(h.original.draft.content)).toBe(false);
  const a = h.open();
  await expect(a.mount.ready).rejects.toThrow('ViewerSourcePin');
  await a.mount.dispose();
  expect(mountRectanglePlayerV1).not.toHaveBeenCalled();
  expect(canonicalJson(h.original)).toBe(h.oldBytes);
  a.handle.revoke('host-close');
});
it('cleanup rejection stays observable in bounded drain without retaining visible DOM', async () => {
  const h = await fixture({
    afterDispose: async () => {
      throw new Error('cleanup acknowledgment failed');
    },
  });
  const a = h.open();
  await a.mount.ready;
  a.handle.revoke('host-close');
  await expect(a.mount.dispose()).rejects.toThrow('cleanup acknowledgment failed');
  expect(h.target.children).toEqual([]);
  expect(await a.handle.drain({ deadlineMs: 0 })).toMatchObject({
    state: 'incomplete',
    failed: [expect.objectContaining({ reason: 'Error: cleanup acknowledgment failed' })],
  });
});
it('read revocation removes a ready playing view before queued work can render again', async () => {
  const h = await fixture();
  const a = h.open();
  await a.mount.ready;
  h.target.children[0].children
    .find((child) => child.textContent === 'Play Animation')!
    .dispatchEvent(new Event('click'));
  const queued = h.doc.frames[0];
  h.binding.setGrants([]);
  expect(h.target.children).toEqual([]);
  queued();
  expect(players[0].seek).not.toHaveBeenCalled();
  h.binding.setGrants(['artifact:read']);
  await a.mount.dispose();
  expect(h.target.children).toEqual([]);
  expect(() => a.handle.context.basic.read()).toThrow('ScopeRevoked');
});
it('later mutation of Host provenance does not silently follow another target hash', async () => {
  const h = await fixture();
  h.provenance.targetContentHash = 'f'.repeat(64);
  const a = h.open();
  await a.mount.ready;
  expect(players[0].options.source.contentHash).toBe(h.migrated.targetContentHash);
  a.handle.revoke('host-close');
  await a.mount.dispose();
});
