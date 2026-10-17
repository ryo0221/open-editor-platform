import { expect, it } from 'vitest';
import { command } from '@editor-platform/editor-core';
import { SchemaEditExperimentRegistry } from '../schema-edit-experiment';
import { granted } from '../draft2/harness';
import { setup, definition, type Native } from './fixture';
const snapshot = (h: ReturnType<typeof setup>) => ({
  content: h.session.content,
  revision: h.session.revision,
  undo: h.session.canUndo,
  redo: h.session.canRedo,
});
it.each([
  { kind: 'numeric', value: 1 } as const,
  { kind: 'literal', value: 'test-native-v0' } as const,
])('tagged $kind controller Undo/Redo uses one existing history', (identity) => {
  const h = setup({ identity });
  expect(
    h.controller.execute({
      baseRevision: h.session.revision,
      command: command<Native>('set', 'set', (v) => ({ ...v, value: 7 })),
    }).state,
  ).toBe('applied');
  expect(h.controller.undo().state).toBe('applied');
  expect(h.session.content.value).toBe(0);
  expect(h.controller.redo().state).toBe('applied');
  expect(h.session.content.value).toBe(7);
  expect(h.session.revision.sequence).toBe(3);
});
for (const direction of ['undo', 'redo'] as const) {
  for (const field of ['value', 'schemaVersion', 'format'] as const) {
    it(`${direction} refuses invalid native ${field} candidate before commit`, () => {
      const h = setup(
        field === 'format' ? { identity: { kind: 'literal', value: 'test-native-v0' } } : {},
      );
      h.session.execute(
        command('bad-host', 'bad-host', (v) => ({
          ...v,
          [field]: field === 'format' ? 'bad' : -1,
        })),
      );
      if (direction === 'undo')
        h.session.execute(
          command('valid-host', 'valid-host', () => ({
            schemaVersion: 1,
            format: 'test-native-v0',
            value: 3,
          })),
        );
      else h.session.undo();
      const before = snapshot(h);
      expect(() => granted(h.handle.context.addons.edit)[direction]()).toThrow();
      expect(snapshot(h)).toEqual(before);
    });
  }
  for (const effect of ['revoke', 'grant', 'core-reentry', 'runtime-reentry'] as const) {
    it(`${direction} rechecks or refuses validator callback ${effect}`, () => {
      const h = setup();
      h.session.execute(command('one', 'one', (v) => ({ ...v, value: 1 })));
      if (direction === 'redo') h.session.undo();
      const d = definition();
      let callback = () => {};
      const validate = d.validate;
      d.validate = (v: unknown): v is Native => {
        callback();
        return validate(v);
      };
      const registry = new SchemaEditExperimentRegistry(h.owner, [
        { artifactKind: 'test', schemaIdentity: d.manifest.schemaIdentity },
      ]);
      const result = registry
        .install(d, {
          trust: 'trusted',
          verifiedPin: {
            id: d.manifest.id,
            version: d.manifest.version,
            packageHash: d.manifest.packageHash,
          },
        })
        .open(h.binding);
      if (result.state !== 'opened') throw Error(result.code);
      const edit = granted(result.handle.context.addons.edit);
      callback = () => {
        if (effect === 'revoke') result.handle.revoke('host-close');
        if (effect === 'grant') h.grants(['artifact:read']);
        if (effect === 'core-reentry')
          h.session.execute(command('bad', 'bad', (v) => ({ ...v, value: 99 })));
        if (effect === 'runtime-reentry') edit[direction]();
      };
      const before = snapshot(h);
      expect(() => edit[direction]()).toThrow(
        effect === 'core-reentry'
          ? 'HistoryValidationReentrancy'
          : effect === 'runtime-reentry'
            ? 'EditReentrancy'
            : 'ScopeRevoked',
      );
      expect(snapshot(h)).toEqual(before);
    });
  }
}
