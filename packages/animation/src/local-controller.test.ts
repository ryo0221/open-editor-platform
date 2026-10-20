import { expect, expectTypeOf, it } from 'vitest';
import { EditorSession, EditorInputs, command } from '@editor-platform/editor-core';
import {
  createRectangleAnimation,
  readAnimationV1,
  type AnimationContent,
  type AnimationContentV1,
} from '@editor-platform/animation-core';
import type { AnimationSurfaceProps } from '@editor-platform/animation/local';
import { createLocalAnimationController } from './local-controller';

it('uses one Host history and protects stale, rejected, read-only and composing input', async () => {
  const session = new EditorSession<AnimationContentV1>(createRectangleAnimation()),
    inputs = new EditorInputs();
  let editable = true,
    accept = true,
    dirty = true,
    composing = false,
    committed = 0;
  const bridge = createLocalAnimationController({
    artifactId: 'a',
    session,
    inputs,
    canEdit: () => editable,
    execute: (cmd) => {
      if (!accept) return false;
      session.execute(cmd);
      return true;
    },
    history: (d) => {
      if (d === 'undo') session.undo();
      else session.redo();
    },
    beforeMutation() {},
  });
  const baseRevision = session.revision;
  const edit = command<AnimationContentV1>('animation.test', 'Edit', (content) => {
    const native = readAnimationV1(content);
    return { ...native, compositions: native.compositions.map((c) => ({ ...c, width: 700 })) };
  });
  const binding = bridge.controller.bindInputs({
    label: 'Animation test',
    read: () => ({ dirty, composing }),
    prepare: () => ({ baseRevision, command: edit }),
    committed: () => {
      dirty = false;
      committed++;
    },
    focus() {},
  });
  expect(bridge.controller.getSnapshot()).toBe(bridge.controller.getSnapshot());
  accept = false;
  expect(() => inputs.flush()).toThrow();
  expect(dirty).toBe(true);
  expect(committed).toBe(0);
  expect(session.canUndo).toBe(false);
  accept = true;
  composing = true;
  expect(() => inputs.flush()).toThrow();
  composing = false;
  editable = false;
  expect(() => inputs.flush()).toThrow();
  expect(session.canUndo).toBe(false);
  editable = true;
  inputs.flush();
  expect(session.content.compositions[0].width).toBe(700);
  expect(committed).toBe(1);
  expect(bridge.controller.execute({ baseRevision, command: edit }).state).toBe('refused');
  binding.unregister();
  expect(bridge.controller.undo().state).toBe('applied');
  expect(session.content.compositions[0].width).toBe(640);
  expect(bridge.controller.redo().state).toBe('applied');
  expect(session.content.compositions[0].width).toBe(700);
  await bridge.dispose();
  expect(bridge.controller.getSnapshot().state).toBe('revoked');
  expect(bridge.controller.execute({ baseRevision: session.revision, command: edit }).state).toBe(
    'refused',
  );
});

it('limits the local Surface to native v1 and rejects a non-v1 command result', async () => {
  expectTypeOf<AnimationSurfaceProps['content']>().toEqualTypeOf<AnimationContentV1>();
  expectTypeOf<EditorSession<AnimationContent>>().not.toMatchTypeOf<
    AnimationSurfaceProps['session']
  >();
  const session = new EditorSession(createRectangleAnimation());
  const before = session.content;
  const revision = session.revision;
  const bridge = createLocalAnimationController({
    artifactId: 'v1-only',
    session,
    inputs: new EditorInputs(),
    canEdit: () => true,
    execute: (cmd) => {
      session.execute(cmd);
    },
    history() {},
    beforeMutation() {},
  });
  const result = bridge.controller.execute({
    baseRevision: session.revision,
    command: command<AnimationContent>(
      'invalid',
      'Return non-v1',
      () => ({ ...before, schemaVersion: 'animation-prototype-0' }) as never,
    ),
  });
  expect(result.state).toBe('refused');
  expect(session.content).toEqual(before);
  expect(session.revision).toEqual(revision);
  expect(session.canUndo).toBe(false);
  await bridge.dispose();
});

it('reports live saving state and refuses previously prepared mutations until the Host finishes saving', async () => {
  const session = new EditorSession<AnimationContentV1>(createRectangleAnimation());
  let saving = false;
  const bridge = createLocalAnimationController({
    artifactId: 'saving',
    session,
    inputs: new EditorInputs(),
    canEdit: () => true,
    isSaving: () => saving,
    execute: (command) => {
      session.execute(command);
    },
    history() {},
    beforeMutation() {},
  });
  const prepared = {
    baseRevision: session.revision,
    command: command<AnimationContentV1>('test', 'Width', (content) => ({
      ...readAnimationV1(content),
      compositions: content.compositions.map((c) => ({ ...c, width: 700 })),
    })),
  };
  saving = true;
  bridge.notify();
  expect(bridge.controller.getSnapshot()).toMatchObject({
    state: 'open',
    saving: true,
    canEdit: false,
  });
  expect(bridge.controller.execute(prepared).state).toBe('refused');
  expect(session.content.compositions[0].width).toBe(640);
  saving = false;
  bridge.notify();
  expect(bridge.controller.execute(prepared).state).toBe('applied');
  expect(session.content.compositions[0].width).toBe(700);
  await bridge.dispose();
});
