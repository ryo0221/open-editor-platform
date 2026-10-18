import { expect, it } from 'vitest';
import { EditorInputs, EditorSession, command } from '@editor-platform/editor-core';
import { emptyGeo, type GeoDocument } from '@editor-platform/geo-core';
import { geoController } from './controller';
it('uses the Host history, commits one aggregate input, refuses stale and revoked submissions without clearing buffers', () => {
  const session = new EditorSession(emptyGeo()),
    inputs = new EditorInputs();
  let writable = true,
    dirty = true,
    commits = 0;
  const bridge = geoController({
    id: 'geo',
    session,
    inputs,
    canEdit: () => writable,
    execute(cmd) {
      session.executeView(cmd);
      return true;
    },
    history(d) {
      session[d]();
    },
    async save() {},
  });
  const make = () => ({
    baseRevision: { ...session.revision },
    command: command<GeoDocument>('test', 'Atomic Geo update', (d) => ({
      ...d,
      workspace: {
        schemaVersion: 1,
        styles: [],
        annotations: [],
        views: [],
        joins: [],
        assets: [],
        comparisons: [],
      },
    })),
  });
  const stale = make();
  bridge.controller.bindInputs({
    label: 'Geo',
    read: () => ({ dirty, composing: false }),
    prepare: make,
    committed() {
      dirty = false;
      commits++;
    },
    focus() {},
  });
  inputs.flush();
  expect(commits).toBe(1);
  expect(session.canUndo).toBe(true);
  expect(bridge.controller.execute(stale).state).toBe('refused');
  expect(bridge.controller.undo().state).toBe('applied');
  expect(session.content).toEqual(emptyGeo());
  expect(session.canUndo).toBe(false);
  dirty = true;
  inputs.changed();
  writable = false;
  expect(() => inputs.flush()).toThrow('GeoAuthorityChanged');
  expect(dirty).toBe(true);
  expect(session.content).toEqual(emptyGeo());
  bridge.dispose();
  expect(bridge.controller.getSnapshot().state).toBe('revoked');
});
