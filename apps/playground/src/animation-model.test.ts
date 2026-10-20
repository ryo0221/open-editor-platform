import { expect, it, vi } from 'vitest';
import { command } from '@editor-platform/editor-core';
import * as animation from '@editor-platform/animation-core';
import * as animation2 from '@editor-platform/animation-core/v2';
import {
  createLocalSession,
  hasUnsupportedSharedAnimation,
  kinds,
  makeArtifact,
  validContent,
  type Kind,
} from './model';
import { commitVersion, contentHash, updateDraft } from '@editor-platform/artifact-core';
import { createDeck, placeSlideAnimation } from '@editor-platform/slide/model';

it('checks draft and every retained version before admitting a shared Slide', async () => {
  const content = animation.createRectangleAnimation(),
    deck = createDeck();
  const embed = animation.createAnimationEmbed(
    {
      artifactId: 'source',
      versionId: 'v1',
      contentHash: await contentHash(content),
      compositionId: 'root',
    },
    content,
    'Motion',
  );
  const staticRecord = makeArtifact('slide', 1);
  expect(hasUnsupportedSharedAnimation(staticRecord)).toBe(false);
  const animated = updateDraft(
    staticRecord,
    placeSlideAnimation(deck.slides[0].id, embed, 'motion').apply(deck),
  );
  expect(hasUnsupportedSharedAnimation(animated)).toBe(true);
  const saved = await commitVersion(animated, 'test', 'Motion');
  const staticAgain = await commitVersion(updateDraft(saved, deck), 'test', 'Static');
  expect(hasUnsupportedSharedAnimation(staticAgain)).toBe(true);
  expect(staticAgain.versions).toHaveLength(2);
  expect(
    hasUnsupportedSharedAnimation(await commitVersion(staticRecord, 'test', 'Static only')),
  ).toBe(false);
  expect(hasUnsupportedSharedAnimation(makeArtifact('animation', 1))).toBe(false);
  expect(hasUnsupportedSharedAnimation(updateDraft(makeArtifact('animation', 1), content))).toBe(
    true,
  );
  expect(hasUnsupportedSharedAnimation(makeArtifact('document', 1))).toBe(false);
});
it('admits current Animation and guards non-UI commands without accepting prototypes', () => {
  const artifact = makeArtifact('animation', 1),
    before = structuredClone(artifact.draft.content);
  expect(validContent('animation', before)).toBe(true);
  const session = createLocalSession(before);
  expect(() =>
    session.execute(
      command('malformed', 'Malformed Animation', () => ({ ...before, schemaVersion: 0 }) as never),
    ),
  ).toThrow();
  expect(session.content).toEqual(before);
  expect(session.canUndo).toBe(false);
  expect(validContent('animation', { ...before, schemaVersion: 'animation-prototype-0' })).toBe(
    false,
  );
});

it('retains the session domain instead of parsing other domains as Animation on every command', () => {
  const read = vi.spyOn(animation2, 'readAnimation2');
  try {
    for (const kind of ['document', 'slide', 'design', 'whiteboard'] as const) {
      const session = createLocalSession(makeArtifact(kind, 1).draft.content);
      read.mockClear();
      session.execute(command('native.no-op', 'Native no-op', (content) => content));
      session.execute(command('native.no-op', 'Native no-op', (content) => content));
      expect(read).not.toHaveBeenCalled();
    }
    const session = createLocalSession(makeArtifact('animation', 1).draft.content);
    read.mockClear();
    session.execute(command('native.no-op', 'Native no-op', (content) => content));
    expect(read).toHaveBeenCalled();
    expect(() =>
      session.execute(
        command('invalid', 'Invalid result', () => makeArtifact('slide', 1).draft.content),
      ),
    ).toThrow();
  } finally {
    read.mockRestore();
  }
});

it('rejects other native domains before the full Animation reader while still validating candidates', () => {
  const read = vi.spyOn(animation2, 'readAnimation2');
  try {
    for (const kind of Object.keys(kinds) as Kind[]) {
      if (kind === 'animation') continue;
      expect(validContent('animation', makeArtifact(kind, 1).draft.content)).toBe(false);
    }
    expect(read).not.toHaveBeenCalled();
    const candidate = makeArtifact('animation', 1).draft.content;
    expect(validContent('animation', candidate)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(validContent('animation', { ...candidate, compositions: [] })).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    read.mockRestore();
  }
});
