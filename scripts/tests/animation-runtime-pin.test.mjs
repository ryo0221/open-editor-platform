import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnimationRuntimePin } from '../animation-runtime-pin.mjs';
test('registered Animation pins its transitive executable closure and changes on renderer dependencies', async () => {
  const initial = await buildAnimationRuntimePin();
  assert.equal((await buildAnimationRuntimePin()).hash, initial.hash);
  for (const dependency of [
    'packages/animation/src/scene2/viewer.tsx',
    'packages/animation-player/src/transport.ts',
    'packages/animation-core/src/scene2/validate.ts',
    'packages/animation-player/src/scene2.ts',
    'apps/animation-reference/src/registered-native.ts',
  ]) {
    assert.ok(initial.inputs.includes(dependency), dependency);
    const changed = await buildAnimationRuntimePin({
      [dependency]: 'console.info("reviewed-runtime-mutation");',
    });
    assert.notEqual(changed.hash, initial.hash, dependency);
  }
});

test('dev source updates invalidate the pinned closure and reload consumers', async () => {
  const { animationRuntimePin } = await import('../animation-runtime-pin.mjs');
  const plugin = animationRuntimePin(),
    watched = [],
    events = [],
    invalidated = [];
  await plugin.load.call(
    { addWatchFile: (file) => watched.push(file) },
    '\0virtual:animation-runtime-pin',
  );
  const transport = watched.find((file) => file.endsWith('/animation-player/src/transport.ts'));
  assert.ok(transport);
  const module = {};
  const server = {
    moduleGraph: {
      getModuleById: () => module,
      invalidateModule: (value) => invalidated.push(value),
    },
    ws: { send: (event) => events.push(event) },
  };
  assert.equal(plugin.handleHotUpdate({ file: '/unrelated-file.ts', server }), undefined);
  assert.deepEqual(events, []);
  assert.deepEqual(plugin.handleHotUpdate({ file: transport, server }), []);
  assert.deepEqual(invalidated, [module]);
  assert.deepEqual(events, [{ type: 'full-reload' }]);
});
