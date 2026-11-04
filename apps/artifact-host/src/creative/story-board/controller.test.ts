import { expect, it } from 'vitest';
import {
  canonicalJson,
  commitVersion,
  MemoryStorage,
  updateDraft,
  type Artifact,
} from '@editor-platform/artifact-core';
import { command } from '@editor-platform/editor-core';
import { updateNode } from '@editor-platform/whiteboard/model';
import { timelineCommand } from '../timeline/commands';
import { StoryBoardController } from './controller';
import { createStoryBoardSample } from './sample';
import type { BoardReading } from './reading';
import { BOARD_LIMITS, createBoardSettingsData } from './settings';

async function fixture() {
  const storage = new MemoryStorage<Artifact<unknown>>(),
    sample = await createStoryBoardSample(storage);
  const hidden = new Set<string>(),
    readonly = new Set<string>();
  const c = await StoryBoardController.open(storage, sample.settingsId, sample.links, {
    namespace: 'local-test',
    mayRead: (id) => !hidden.has(id),
    mayEdit: (id) => !readonly.has(id),
  });
  const r = await c.read();
  expect(r.state).toBe('ready');
  return { c, storage, hidden, readonly, reading: r as BoardReading };
}
it('SB01/06/10: presets and layout save/reopen, with independent native owner Undo', async () => {
  const f = await fixture(),
    initial = f.c.boardSnapshot.content;
  f.c.executeBoard(updateNode('author-note', { text: '作者のメモ' }));
  expect(await f.c.saveBoard()).toBe(true);
  const filter = f.reading.opened.settings.presets[1].filter;
  expect(await f.c.savePreset('三人を見る', filter)).toBe(true);
  const reopened = await StoryBoardController.open(
    f.storage,
    f.c.settingsId,
    f.c.workbench.links,
    f.c.access,
  );
  const r = await reopened.read();
  expect(r.state).toBe('ready');
  expect((r as BoardReading).opened.settings.presets.some((p) => p.name === '三人を見る')).toBe(
    true,
  );
  expect(reopened.boardSnapshot.content.nodes.find((n) => n.id === 'author-note')!.text).toBe(
    '作者のメモ',
  );
  f.c.history('settings', 'undo');
  expect(f.c.settingsSnapshot.content.rows[0].values['sb1.payload']).not.toContain('三人を見る');
  expect(f.c.boardSnapshot.content.nodes.find((n) => n.id === 'author-note')!.text).toBe(
    '作者のメモ',
  );
  f.c.history('board', 'undo');
  expect(f.c.boardSnapshot.content).toEqual(initial);
});

it('SB14: board save then settings failure retries only captured settings, without duplicate frame/command/version', async () => {
  const f = await fixture(),
    before = f.c.boardSnapshot.content.nodes.length;
  const original = f.storage.put.bind(f.storage);
  let fail = true,
    writes = 0;
  f.storage.put = async (a) => {
    if (a.id === f.c.settingsId) {
      writes++;
      if (fail) throw Error('quota');
    }
    await original(a);
  };
  const event = f.reading.events.find((e) => e.ref.itemId === 'EV-400')!.ref;
  expect(await f.c.addCard(event)).toBe(false);
  expect(f.c.operationState).toMatchObject({ status: 'failed', phase: 'settings', settled: true });
  expect(f.c.boardSnapshot.content.nodes).toHaveLength(before + 1);
  expect((await f.storage.get(f.c.boardArtifactId))!.draft.content).toEqual(
    f.c.boardSnapshot.content,
  );
  const revision = f.c.settingsSnapshot.revision;
  expect(() => f.c.executeBoard(updateNode('author-note', { text: 'blocked' }))).toThrow();
  expect(() => f.c.history('board', 'undo')).toThrow();
  expect(() => f.c.guard()).toThrow();
  fail = false;
  expect(await f.c.retry()).toBe(true);
  expect(f.c.settingsSnapshot.revision).toEqual(revision);
  expect(f.c.boardSnapshot.content.nodes).toHaveLength(before + 1);
  expect(writes).toBe(2);
  const r = await f.c.read();
  expect(r.state).toBe('ready');
  expect((r as BoardReading).opened.panels).toHaveLength(f.reading.opened.panels.length + 1);
});

it('SB14: lost settings response retries exactly the same immutable version', async () => {
  const f = await fixture(),
    original = f.storage.put.bind(f.storage),
    attempts: Artifact<unknown>[] = [];
  let lost = true;
  f.storage.put = async (a) => {
    await original(a);
    if (a.id === f.c.settingsId) {
      attempts.push(structuredClone(a));
      if (lost) {
        lost = false;
        throw Error('lost response');
      }
    }
  };
  expect(await f.c.savePreset('保存確認', f.reading.opened.settings.presets[0].filter)).toBe(false);
  expect(await f.c.retry()).toBe(true);
  expect(attempts).toHaveLength(2);
  expect(canonicalJson(attempts[0])).toBe(canonicalJson(attempts[1]));
});

it('SB11/14: cancel during async verification makes no native/storage change', async () => {
  const f = await fixture(),
    before = canonicalJson(await f.storage.list()),
    native = f.c.boardSnapshot.content;
  const original = f.storage.get.bind(f.storage);
  let release!: () => void, started!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.storage.get = async (id) => {
    const a = await original(id);
    if (id === 'sb660-map') {
      started();
      await blocked;
    }
    return a;
  };
  const promise = f.c.addCard(f.reading.events[0].ref);
  await began;
  const sourceOwner = f.c.workbench.owner('sb660-story-ledger-A')!;
  const sourceBefore = sourceOwner.editor.content;
  expect(
    f.c.workbench.run(sourceOwner.id, () =>
      timelineCommand('ledger', 'pending-source', 'Refused', (draft) => {
        draft.rows[0].values['tl1.label'] = '保存中の別編集';
      }),
    ).ok,
  ).toBe(false);
  expect(sourceOwner.editor.content).toEqual(sourceBefore);
  expect(() => f.c.history('board', 'undo')).toThrow();
  expect(() => f.c.guard()).toThrow();
  f.c.cancel();
  release();
  expect(await promise).toBe(false);
  expect(f.c.boardSnapshot.content).toEqual(native);
  expect(canonicalJson(await f.storage.list())).toBe(before);
  expect(f.c.boardSnapshot.canUndo).toBe(false);
  await f.c.resumeAfterCancel();
  expect(f.c.busy).toBe(false);
});

it('SB12/14: permission loss during settings I/O never activates a late completed binding', async () => {
  const f = await fixture(),
    original = f.storage.put.bind(f.storage);
  let release!: () => void, started!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.storage.put = async (a) => {
    if (a.id === f.c.settingsId) {
      started();
      await blocked;
    }
    await original(a);
  };
  const promise = f.c.savePreset('遅延保存', f.reading.opened.settings.presets[0].filter);
  await began;
  f.hidden.add('sb660-map');
  f.c.invalidate();
  f.c.cancel();
  release();
  expect(await promise).toBe(false);
  expect(f.c.operationState).toMatchObject({ status: 'cancelled', settled: true });
  const r = await f.c.read();
  expect(r.state).toBe('partial');
  expect(Object.keys(r).sort()).toEqual(['current', 'state']);
});

it('SB07/10/13: dirty native input guards transitions, deleted IDs cannot be recycled, and read-only is checked in commands', async () => {
  const f = await fixture();
  const stop = f.c.inputs.register({
    label: 'IME',
    read: () => ({ dirty: true, composing: true }),
    prepare: () => {
      throw Error('pending');
    },
    focus() {},
  });
  expect(() => f.c.guard()).toThrow();
  stop();
  const note = f.c.boardSnapshot.content.nodes.find((n) => n.id === 'author-note')!;
  f.c.executeBoard(
    command('delete-note', 'Delete', (b) => ({
      ...b,
      nodes: b.nodes.filter((n) => n.id !== note.id),
    })),
  );
  expect(() =>
    f.c.executeBoard(
      command('recycle', 'Invalid new note', (b) => ({
        ...b,
        nodes: [...b.nodes, { ...note, text: '別の項目' }],
      })),
    ),
  ).toThrow();
  f.c.history('board', 'undo');
  expect(f.c.boardSnapshot.content.nodes.some((n) => n.id === note.id)).toBe(true);
  f.readonly.add(f.c.boardArtifactId);
  expect(() => f.c.executeBoard(updateNode('author-note', { text: 'forbidden' }))).toThrow();
  expect(await f.c.saveBoard()).toBe(false);
});

it('SB14: cancelled accepted I/O stays undisclosed until an explicit recheck', async () => {
  const f = await fixture(),
    original = f.storage.put.bind(f.storage);
  let release!: () => void, started!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.storage.put = async (a) => {
    await original(a);
    if (a.id === f.c.settingsId) {
      started();
      await blocked;
    }
  };
  const pending = f.c.savePreset('遅延応答', f.reading.opened.settings.presets[0].filter);
  await began;
  f.c.cancel();
  release();
  expect(await pending).toBe(false);
  const hidden = await f.c.read();
  expect(hidden.state).toBe('partial');
  expect(Object.keys(hidden).sort()).toEqual(['current', 'state']);
  await f.c.resumeAfterCancel();
  const rechecked = await f.c.read();
  expect(rechecked.state).toBe('ready');
  expect(
    (rechecked as BoardReading).opened.settings.presets.some((p) => p.name === '遅延応答'),
  ).toBe(true);
});

it('SB11: out-of-session adopted-source change is refused before native mutation', async () => {
  const f = await fixture(),
    original = f.storage.get.bind(f.storage);
  const world = (await original('sb660-world-S'))!;
  const newer = await commitVersion(world, null, 'another save');
  f.storage.get = async (id) => (id === world.id ? newer : original(id));
  expect(await f.c.savePreset('古いsource', f.reading.opened.settings.presets[0].filter)).toBe(
    false,
  );
  expect(f.c.settingsSnapshot.canUndo).toBe(false);
  expect(f.c.settingsSnapshot.dirty).toBe(false);
  expect((await f.c.read()).state).toBe('partial');
});

it('SB14: a refused first layout command cannot turn retry into a false card-creation success', async () => {
  const f = await fixture(),
    count = f.c.boardSnapshot.content.nodes.length;
  f.readonly.add(f.c.boardArtifactId);
  expect(await f.c.addCard(f.reading.events[0].ref)).toBe(false);
  expect(f.c.boardSnapshot.content.nodes).toHaveLength(count);
  f.readonly.clear();
  expect(await f.c.retry()).toBe(true);
  expect(f.c.boardSnapshot.content.nodes).toHaveLength(count + 1);
  const r = await f.c.read();
  expect(r.state).toBe('ready');
  expect((r as BoardReading).opened.panels).toHaveLength(f.reading.opened.panels.length + 1);
});

it('SB06/10: native settings Undo can be explicitly saved, while unsaved owner drafts refuse close', async () => {
  const f = await fixture();
  expect(await f.c.savePreset('保存する表示', f.reading.opened.settings.presets[0].filter)).toBe(
    true,
  );
  f.c.history('settings', 'undo');
  expect(() => f.c.close()).toThrow();
  expect(await f.c.saveSettings()).toBe(true);
  const r = await f.c.read();
  expect(r.state).toBe('ready');
  expect((r as BoardReading).opened.settings.presets.some((p) => p.name === '保存する表示')).toBe(
    false,
  );
  f.c.executeBoard(updateNode('author-note', { text: 'まだ保存しない' }));
  expect(() => f.c.close()).toThrow();
  expect(f.c.boardSnapshot.content.nodes.find((n) => n.id === 'author-note')!.text).toBe(
    'まだ保存しない',
  );
  f.c.history('board', 'undo');
  expect(
    f.c.workbench.run('sb660-story-ledger-A', () =>
      timelineCommand('ledger', 'source-draft', 'Draft', (data) => {
        data.rows[0].values['tl1.label'] = '未保存の資料';
      }),
    ).ok,
  ).toBe(true);
  expect(() => f.c.close()).toThrow();
});

it.each(['card', 'preset'] as const)(
  'SB14/15: known %s capacity refuses before any native mutation',
  async (kind) => {
    const f = await fixture(),
      settings = structuredClone(f.reading.opened.settings);
    if (kind === 'card')
      settings.panels = Array.from({ length: 64 }, (_, i) => ({
        nodeId: `orphan-${i}`,
        kind: 'timeline',
      }));
    else
      settings.presets = Array.from({ length: 32 }, (_, i) => ({
        id: `view-${i}`,
        name: `表示${i}`,
        filter: settings.presets[0].filter,
      }));
    const artifact = (await f.storage.get(f.c.settingsId))!;
    await f.storage.put(
      await commitVersion(updateDraft(artifact, createBoardSettingsData(settings)), null, null),
    );
    const c = await StoryBoardController.open(
      f.storage,
      f.c.settingsId,
      f.c.workbench.links,
      f.c.access,
    );
    const before = canonicalJson(await f.storage.list());
    const ok =
      kind === 'card'
        ? await c.addCard(f.reading.events[0].ref)
        : await c.savePreset('超過', settings.presets[0].filter);
    expect(ok).toBe(false);
    expect(c.boardSnapshot.canUndo).toBe(false);
    expect(c.settingsSnapshot.canUndo).toBe(false);
    expect(canonicalJson(await f.storage.list())).toBe(before);
  },
);

it('SB14 preflight: settings read-only refuses card creation before any frame command or write', async () => {
  const f = await fixture(),
    before = canonicalJson(await f.storage.list());
  f.readonly.add(f.c.settingsId);
  expect(await f.c.addCard(f.reading.events[0].ref)).toBe(false);
  expect(f.c.boardSnapshot.canUndo).toBe(false);
  expect(f.c.boardSnapshot.dirty).toBe(false);
  expect(canonicalJson(await f.storage.list())).toBe(before);
});

it('SB14 preflight: a valid near-limit payload refuses the complete added-card settings before layout changes', async () => {
  const f = await fixture(),
    settings = structuredClone(f.reading.opened.settings);
  const padding = {
    id: 'padding',
    name: '表示用の大きい集合',
    individuals: [] as string[],
    events: [],
  };
  settings.groups.push(padding);
  for (let i = 0; i < 200; i++) {
    const gap =
      BOARD_LIMITS.payloadBytes - 12 - new TextEncoder().encode(canonicalJson(settings)).length;
    if (gap < 20) break;
    const prefix = `padding-${i}-`;
    padding.individuals.push(
      prefix + 'x'.repeat(Math.max(0, Math.min(480, gap - 4) - prefix.length)),
    );
  }
  const data = createBoardSettingsData(settings);
  expect(
    BOARD_LIMITS.payloadBytes - new TextEncoder().encode(canonicalJson(settings)).length,
  ).toBeLessThan(40);
  const artifact = (await f.storage.get(f.c.settingsId))!;
  await f.storage.put(await commitVersion(updateDraft(artifact, data), null, null));
  const c = await StoryBoardController.open(
    f.storage,
    f.c.settingsId,
    f.c.workbench.links,
    f.c.access,
  );
  const before = canonicalJson(await f.storage.list());
  expect(await c.addCard(f.reading.events[0].ref)).toBe(false);
  expect(c.boardSnapshot.canUndo).toBe(false);
  expect(c.boardSnapshot.dirty).toBe(false);
  expect(canonicalJson(await f.storage.list())).toBe(before);
});

it.each([false, true])(
  'SB11 cancelled stale operation can close only with clean owner drafts (dirty=%s)',
  async (dirty) => {
    const f = await fixture();
    if (dirty) f.c.executeBoard(updateNode('author-note', { text: '保持する未保存メモ' }));
    const world = (await f.storage.get('sb660-world-S'))!;
    await f.storage.put(await commitVersion(world, null, 'outside save'));
    expect(await f.c.savePreset('古い参照', f.reading.opened.settings.presets[0].filter)).toBe(
      false,
    );
    f.c.cancel();
    if (dirty) {
      expect(() => f.c.close()).toThrow();
      expect(f.c.boardSnapshot.content.nodes.find((n) => n.id === 'author-note')!.text).toBe(
        '保持する未保存メモ',
      );
    } else expect(() => f.c.close()).not.toThrow();
  },
);
