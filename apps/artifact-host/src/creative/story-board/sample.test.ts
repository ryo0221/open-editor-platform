import { expect, it } from 'vitest';
import {
  canonicalJson,
  contentHash,
  MemoryStorage,
  type Artifact,
} from '@editor-platform/artifact-core';
import { isWhiteboard } from '@editor-platform/whiteboard/model';
import { validateFictionMap } from '@editor-platform/fiction-map/model';
import { buildF0Sample } from '../timeline/sample';
import { resolveTimelineProjection } from '../timeline/projection';
import { readBoardSettings } from './settings';
import { buildStoryBoardSample, createStoryBoardSample } from './sample';

it('SB01/02/04/08: deterministic ten-character fixture retains exact references, same-SC occurrences and distinct manuscript addresses', async () => {
  const sample = await buildStoryBoardSample();
  expect(canonicalJson(await buildStoryBoardSample())).toBe(canonicalJson(sample));
  const storage = new MemoryStorage<Artifact<unknown>>();
  for (const artifact of sample.artifacts) {
    expect(artifact.id).toMatch(/^sb660-/);
    expect(artifact.versions[0].contentHash).toBe(await contentHash(artifact.versions[0].content));
    await storage.put(artifact);
  }
  const settings = readBoardSettings((await storage.get(sample.settingsId))!.draft.content);
  expect(isWhiteboard((await storage.get(settings.boardArtifactId))!.draft.content)).toBe(true);
  expect(validateFictionMap((await storage.get(settings.map.artifactId))!.draft.content).ok).toBe(
    true,
  );
  const projection = await resolveTimelineProjection(
    storage,
    sample.links,
    { world: settings.world },
    () => true,
  );
  expect(projection.scope).toBe('complete');
  expect(projection.events.filter((e) => /^EV-40\d$/.test(e.id))).toHaveLength(10);
  const first = projection.occurrences.find((o) => o.id === 'OC-001')!;
  const again = projection.occurrences.find((o) => o.id === 'OC-006')!;
  expect(first.sceneKey).toBe(again.sceneKey);
  expect(first.manuscript).not.toEqual(again.manuscript);
});

it('SB14: partial creation retries the same owners and refuses to overwrite any differing owner', async () => {
  const storage = new MemoryStorage<Artifact<unknown>>();
  let fail = true;
  const original = storage.putIfAbsent.bind(storage);
  storage.putIfAbsent = async (artifact) => {
    if (artifact.id === 'sb660-settings' && fail) throw Error('quota');
    return original(artifact);
  };
  await expect(createStoryBoardSample(storage)).rejects.toThrow('quota');
  const before = (await storage.get('sb660-board'))!;
  fail = false;
  await createStoryBoardSample(storage);
  expect(await storage.get('sb660-board')).toEqual(before);
  await storage.put({ ...before, name: '作者のボード' });
  await expect(createStoryBoardSample(storage)).rejects.toThrow('上書きしません');
  expect((await storage.get(before.id))!.name).toBe('作者のボード');
});

it('SB09/13: creating the separate demo never mutates the existing F0 owners', async () => {
  const storage = new MemoryStorage<Artifact<unknown>>(),
    f0 = await buildF0Sample();
  for (const a of f0.artifacts) await storage.put(a);
  const before = await storage.list();
  await createStoryBoardSample(storage);
  for (const a of before) expect(await storage.get(a.id)).toEqual(a);
});

it('P2 4455222890: a forbidden sample owner rejects all creation before the first write', async () => {
  const storage = new MemoryStorage<Artifact<unknown>>();
  let calls = 0;
  const original = storage.putIfAbsent.bind(storage);
  storage.putIfAbsent = async (artifact) => {
    calls++;
    return original(artifact);
  };
  await expect(createStoryBoardSample(storage, (id) => id !== 'sb660-settings')).rejects.toThrow();
  expect(calls).toBe(0);
  expect(await storage.list()).toEqual([]);
});

it('P2 4455222890: revocation during accepted creation does not submit the next owner', async () => {
  const storage = new MemoryStorage<Artifact<unknown>>();
  const original = storage.putIfAbsent.bind(storage);
  let allowed = true,
    calls = 0;
  storage.putIfAbsent = async (artifact) => {
    calls++;
    const stored = await original(artifact);
    allowed = false;
    return stored;
  };
  await expect(createStoryBoardSample(storage, () => allowed)).rejects.toThrow();
  expect(calls).toBe(1);
  expect(await storage.list()).toHaveLength(1);
});
