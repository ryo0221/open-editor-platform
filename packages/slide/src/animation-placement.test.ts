import { expect, it } from 'vitest';
import { reuseHash } from '@editor-platform/reuse-core';
import { EditorSession } from '@editor-platform/editor-core';
import {
  createAnimation2,
  createPlayableAnimationEmbed,
  type AnimationContent2,
} from '@editor-platform/animation-core/v2';
import { animationPositionLabel2 } from '@editor-platform/animation/player-v2';
import { createDeck, placeSlideAnimation, resizeDeck, slideAnimationBounds } from './model';

function embed(width: number, height: number) {
  const content: AnimationContent2 = createAnimation2();
  Object.assign(content.compositions[0], { width, height });
  return createPlayableAnimationEmbed(
    {
      artifactId: 'motion',
      versionId: 'v1',
      compositionId: 'root',
      contentHash: reuseHash(content),
    },
    content,
    'Motion',
  );
}

it('places a saved Animation centred at the slide size with its own aspect ratio', () => {
  const deck = createDeck(),
    page = deck.slides[0];
  page.objects = [];
  const placed = placeSlideAnimation(page.id, embed(640, 360), 'motion').apply(deck),
    { bounds } = placed.slides[0].objects[0];
  // 960 × 540 with a 43 px margin: the 16:9 frame fills the height and is centred.
  expect(bounds).toEqual({ x: 77, y: 43, width: 807, height: 454 });
  // Centred to the nearest whole pixel.
  expect(Math.abs(bounds.x * 2 + bounds.width - deck.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(bounds.y * 2 + bounds.height - deck.height)).toBeLessThanOrEqual(1);
});

it('fits tall and wide compositions inside a resized slide without stretching them', () => {
  const deck = resizeDeck(1920, 1080).apply(createDeck());
  const tall = slideAnimationBounds(deck, embed(400, 800)),
    wide = slideAnimationBounds(createDeck(), embed(2000, 400));
  expect(tall.height).toBeLessThanOrEqual(1080 - 2 * 86);
  expect(tall.width / tall.height).toBeCloseTo(0.5, 2);
  expect(Math.abs(tall.x * 2 + tall.width - 1920)).toBeLessThanOrEqual(1);
  expect(wide.width).toBe(960 - 2 * 43);
  expect(wide.width / wide.height).toBeCloseTo(5, 1);
  expect(wide.y).toBeGreaterThan(43);
});

it('keeps extreme aspect ratios placeable with at least 1 px on each side', () => {
  const deck = createDeck();
  deck.slides[0].objects = [];
  for (const [w, h] of [
    [1, 1000],
    [1000, 1],
  ]) {
    const placed = placeSlideAnimation(deck.slides[0].id, embed(w, h), 'motion').apply(deck),
      { bounds } = placed.slides[0].objects[0];
    expect(Math.min(bounds.width, bounds.height)).toBe(1);
    expect(Math.max(bounds.width, bounds.height)).toBe(w > h ? 874 : 454);
  }
});

it('undoes the centred placement in one step', () => {
  const deck = createDeck();
  deck.slides[0].objects = [];
  const session = new EditorSession(deck);
  session.execute(placeSlideAnimation(deck.slides[0].id, embed(640, 360), 'motion'));
  expect(session.content.slides[0].objects).toHaveLength(1);
  session.undo();
  expect(session.content).toEqual(deck);
});

it('shows the playback position in seconds and frames instead of ticks', () => {
  // 30 fps: one frame is 8000 ticks; 240,000 ticks are one second.
  expect(animationPositionLabel2(95256, 960000, 8000)).toBe('0.40 s / 4.00 s · Frame 11');
  expect(animationPositionLabel2(0, 960000, 8000)).toBe('0.00 s / 4.00 s · Frame 0');
  expect(animationPositionLabel2(960000, 960000, 8000)).toBe('4.00 s / 4.00 s · Frame 120');
});
