import { afterEach, expect, it, vi } from 'vitest';
import type { AnimationContentV1 } from '@editor-platform/animation-core';
import { ReferenceRegistry } from '@editor-platform/extension-runtime/draft2';
import { ManualClock, referenceBinding } from '@editor-platform/extension-runtime/reference';
import { createControlledSurfaceController } from '@editor-platform/extension-runtime/controlled';
import type { DefinitionD2 } from '@editor-platform/extension-contract/draft2';
import { createPlayback } from './playback';
const hooks = vi.hoisted(() => ({ wait: Promise.resolve(), mounts: 0, disposals: 0 }));
vi.mock('@editor-platform/animation-core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@editor-platform/animation-core')>();
  return {
    ...original,
    prepareRectangleAnimationV1: async (
      ...args: Parameters<typeof original.prepareRectangleAnimationV1>
    ) => {
      await hooks.wait;
      return original.prepareRectangleAnimationV1(...args);
    },
  };
});
vi.mock('@editor-platform/animation-player/v1', () => ({
  mountRectanglePlayerV1: () => {
    hooks.mounts++;
    return {
      tick: 0,
      playing: false,
      seek() {},
      play() {
        this.playing = true;
      },
      pause() {
        this.playing = false;
      },
      setRate() {},
      dispose() {
        hooks.disposals++;
      },
    };
  },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  hooks.wait = Promise.resolve();
  hooks.mounts = 0;
  hooks.disposals = 0;
});
it.each(['after-attach', 'synchronous-subscriber'] as const)(
  'owns deferred preparation when revoked by %s',
  async (revokeAt) => {
    let release!: () => void;
    hooks.wait = new Promise((resolve) => {
      release = resolve;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const requestFrame = vi.fn(() => 1);
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    const content: AnimationContentV1 = {
      schemaVersion: 1,
      ticksPerSecond: 240000,
      rootCompositionId: 'root',
      assets: [],
      compositions: [
        {
          id: 'root',
          width: 10,
          height: 10,
          duration: 240000,
          frameRate: { numerator: 1, denominator: 1 },
          layers: [],
          tracks: [],
        },
      ],
    };
    const binding = referenceBinding(content);
    binding.artifactKind = 'animation';
    binding.setGrants(['artifact:read']);
    const definition: DefinitionD2<AnimationContentV1, never> = {
      manifest: {
        id: 'unit-animation',
        version: '0',
        packageHash: 'a'.repeat(64),
        contractVersion: '1.0.0-draft.2',
        artifactKind: 'animation',
        schemaVersion: 1,
        surface: false,
        permissions: ['artifact:read'],
        addons: { lifecycle: { version: 'lifecycle@0-draft', requirement: 'required' } },
        licenseNotices: [],
      },
      validate: (value): value is AnimationContentV1 => !!value,
    };
    const clock = new ManualClock(),
      registry = new ReferenceRegistry(clock),
      installed = registry.install(definition, {
        trust: 'trusted',
        verifiedPin: definition.manifest,
      });
    const opened = installed.open({ ...binding, resources: undefined });
    if (opened.state !== 'opened') throw Error(opened.code);
    const errors: unknown[] = [];
    const editor = createControlledSurfaceController(opened.handle.context, {
      onError: (error) => errors.push(error),
    });
    const playback = createPlayback(editor, opened.handle.context, (error) => errors.push(error));
    if (revokeAt === 'synchronous-subscriber')
      playback.subscribe(() => {
        const snapshot = playback.getSnapshot();
        if (!snapshot.ready && !snapshot.error) opened.handle.revoke('host-close');
      });
    playback.attach({} as HTMLElement);
    if (revokeAt === 'after-attach') opened.handle.revoke('host-close');
    // Allow disposal's already-resolved empty snapshot to settle before observing drain.
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
    expect(await opened.handle.drain({ deadlineMs: 0 })).toMatchObject({
      state: 'incomplete',
      pending: expect.arrayContaining(['extension:animation-player']),
    });
    // A new scope may mount while the retired scope still owns deferred preparation.
    hooks.wait = Promise.resolve();
    const fresh = installed.open({ ...binding, resources: undefined });
    if (fresh.state !== 'opened') throw Error(fresh.code);
    const freshEditor = createControlledSurfaceController(fresh.handle.context, {
      onError: (error) => errors.push(error),
    });
    const freshPlayback = createPlayback(freshEditor, fresh.handle.context, (error) =>
      errors.push(error),
    );
    freshPlayback.attach({} as HTMLElement);
    await vi.waitFor(() => expect(freshPlayback.getSnapshot().ready).toBe(true));
    release();
    expect(await opened.handle.drain({ deadlineMs: 1000 })).toMatchObject({ state: 'drained' });
    expect(hooks.mounts).toBe(1);
    expect(hooks.disposals).toBe(0);
    expect(freshPlayback.getSnapshot()).toMatchObject({ ready: true, error: undefined });
    freshPlayback.subscribe(() => {
      if (freshPlayback.getSnapshot().playing) fresh.handle.revoke('host-close');
    });
    freshPlayback.play();
    expect(requestFrame).not.toHaveBeenCalled();
    expect(await fresh.handle.drain({ deadlineMs: 1000 })).toMatchObject({ state: 'drained' });
    expect(hooks.disposals).toBe(1);
    expect(errors).toEqual([]);
    expect(playback.getSnapshot()).toMatchObject({
      ready: false,
      playing: false,
      error: 'ScopeRevoked',
    });
  },
);
