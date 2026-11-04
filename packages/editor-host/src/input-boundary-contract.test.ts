/** Independent Host example: compose existing APIs, without Timeline or a second history. */
import { expect, it } from 'vitest';
import { createArtifact, MemoryStorage, type Artifact } from '@editor-platform/artifact-core';
import {
  command,
  EditorInputs,
  sameLocalRevision,
  transaction,
  type EditorCommand,
} from '@editor-platform/editor-core';
import { ArtifactEditor, type EditorHostAdapter } from './index';
type Content = { text: string };
const adapter: EditorHostAdapter<Content> = {
  kind: 'boundary-example',
  validate: (v: unknown): v is Content =>
    !!v && typeof v === 'object' && 'text' in v && typeof v.text === 'string',
  capabilities: { undo: true, nativeJson: true, formats: [], preview: 'none', shared: false },
};
const append = (text: string) =>
  command<Content>('append', 'Append', (c) => ({ text: c.text + text }));
const setup = (mayEdit = () => true) => {
  const storage = new MemoryStorage<Artifact<Content>>();
  const host = new ArtifactEditor(
    createArtifact(adapter.kind, 'Example', { text: '' }),
    adapter,
    storage,
    mayEdit,
  );
  const inputs = new EditorInputs();
  host.registerInputBoundary(() => inputs.flush());
  return { host, inputs, storage };
};

it('one owner aggregates dirty inputs into a pure native transaction and consumes successful input once', async () => {
  const { host, inputs, storage } = setup();
  let invalid = true,
    dirty = true,
    finalized = 0;
  let explicit!: () => void;
  inputs.register({
    label: 'two fields',
    read: () => ({ dirty }),
    focus() {},
    prepare: () => {
      const commands: EditorCommand<Content>[] = [
        append('A'),
        command('second', 'Second', (c) => {
          if (invalid) throw Error('invalid second field');
          return { text: c.text + 'B' };
        }),
      ];
      const batch = transaction('Confirm fields', commands);
      batch.apply(host.content); // private candidate only; no execute or persistence in prepare.
      let consumed = false;
      explicit = () => {
        if (consumed) return;
        host.execute(batch);
        consumed = true;
        dirty = false;
        // Host owns UI finalization; an observer failure cannot unconsume native success.
        try {
          finalized++;
          throw Error('UI notification');
        } catch {
          /* report separately */
        }
      };
      return explicit;
    },
  });
  const original = host.revision;
  await expect(host.save()).rejects.toThrow('invalid second field');
  expect(host.content.text).toBe('');
  expect(host.revision).toEqual(original);
  expect(host.canUndo).toBe(false);
  expect(await storage.get(host.id)).toBeUndefined();
  invalid = false;
  const reentryErrors: string[] = [];
  let notified = false;
  const detach = host.attach(() => {
    if (notified) return;
    notified = true;
    for (const attempt of [() => inputs.flush(), () => inputs.history('undo')]) {
      try {
        attempt();
      } catch (e) {
        reentryErrors.push(String(e));
      }
    }
  });
  inputs.flush();
  detach();
  expect(reentryErrors).toHaveLength(2);
  expect(reentryErrors.every((e) => e.includes('進行中'))).toBe(true);
  explicit(); // explicit button after automatic flush: no duplicate append/history.
  inputs.flush();
  expect(host.content.text).toBe('AB');
  expect(finalized).toBe(1);
  expect(host.revision.sequence).toBe(original.sequence + 1);
  await host.save({ commitVersion: true });
  expect(host.artifact.versions[0].content.text).toBe('AB');
  host.undo();
  expect(host.content.text).toBe('');
  expect(host.canUndo).toBe(false);
  expect(host.artifact.versions[0].content.text).toBe('AB');
});

it.each(['cancel', 'revision ABA', 'permission'] as const)(
  'async validation leaves no input effects after %s; commit guards use existing APIs',
  async (reason) => {
    let writable = true,
      generation = 0,
      pending = true;
    const { host, inputs, storage } = setup(() => writable);
    const revision = host.revision,
      capturedGeneration = generation;
    let release!: () => void;
    const validation = new Promise<void>((r) => {
      release = r;
    });
    let ready: EditorCommand<Content> | undefined;
    inputs.register({
      label: 'reference',
      read: () => ({ dirty: true }),
      focus() {},
      prepare: () => {
        if (pending || !ready) throw Error('validation pending');
        return () => {
          if (generation !== capturedGeneration || !sameLocalRevision(revision, host.revision))
            throw Error('stale input');
          host.execute(ready!); // permission is rechecked by ArtifactEditor.
        };
      },
    });
    const complete = validation.then(() => {
      ready = append('verified');
      pending = false;
    });
    await expect(host.save()).rejects.toThrow('validation pending');
    expect(() => inputs.flush()).toThrow('validation pending'); // navigation
    expect(host.content.text).toBe('');
    expect(host.revision).toEqual(revision);
    expect(await storage.get(host.id)).toBeUndefined();
    if (reason === 'cancel') generation++;
    if (reason === 'permission') writable = false;
    if (reason === 'revision ABA') {
      host.execute(append('intervening'));
      expect(() => host.undo()).toThrow('validation pending');
      host.execute(command('restore', 'Restore same content', () => ({ text: '' })));
    }
    const before = host.revision;
    release();
    await complete;
    expect(() => inputs.flush()).toThrow();
    expect(host.content.text).toBe('');
    expect(host.revision).toEqual(before);
    expect(await storage.get(host.id)).toBeUndefined();
  },
);
