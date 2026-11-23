import { describe, expect, it } from 'vitest';
import { createDeck, type Slide, type SlideContent, type SlideStep } from './model';
import { slideExportRenderer } from './export-drawing';
import { planSlideMp4, slideMp4Frame, slideMp4Refusal, slidePdfPoses } from './export-playback';

const steps: SlideStep[] = (['enter', 'exit'] as const).map((phase) => ({
  id: phase,
  effects: [
    {
      id: `effect-${phase}`,
      targetId: 'box',
      phase,
      effect: 'fade',
      trigger: 'on-click',
      delayMs: 20,
      durationMs: 80,
    },
  ],
}));
function deckWithMotion(): SlideContent {
  const deck = createDeck();
  const page = {
    ...deck.slides[0],
    transition: { kind: 'fade', durationMs: 1000 } as const,
    steps,
    objects: [
      {
        id: 'box',
        type: 'shape' as const,
        bounds: { x: 100, y: 100, width: 10, height: 10 },
        text: '',
        fill: '#ff0000',
      },
    ],
  };
  const end: Slide = {
    id: 'end',
    title: 'End',
    background: '#00ff00',
    objects: [],
    transition: { kind: 'push', direction: 'left', durationMs: 200 },
  };
  return {
    ...deck,
    schemaVersion: 3,
    width: 3841,
    height: 2161,
    slides: [page, { ...end, id: 'hidden', hidden: true }, end],
  };
}

describe('PDF and MP4 sampling', () => {
  it('exports initial and completed poses in order and removes the exited object', () => {
    const deck = deckWithMotion();
    const render = slideExportRenderer(deck);
    const each = slidePdfPoses(deck, 'steps').map((pose) => render.pdf(pose));
    expect(each.map((svg) => svg.includes('#ff0000'))).toEqual([false, true, false, false]);
    expect(slidePdfPoses(deck, 'final').map((pose) => render.pdf(pose))).toEqual(each.slice(-2));
    const page = deck.slides[0];
    const max = {
      ...deck,
      slides: Array.from({ length: 500 }, (_, i) => ({ ...page, id: String(i) })),
    };
    expect(slidePdfPoses(max, 'final')).toHaveLength(500);
    expect(() => slidePdfPoses(max, 'steps')).toThrow(/500/);
    expect(() => slidePdfPoses({ ...deck, slides: [] }, 'final')).toThrow(/500/);
  });

  it('samples delays, effects, overrides and the incoming transition on one clock', () => {
    const deck = deckWithMotion();
    const plan = planSlideMp4(deck, {
      defaultHoldSeconds: 0.05,
      holds: [
        { slideId: deck.slides[0].id, stepId: 'enter', holdSeconds: 0.075 },
        { slideId: 'end', holdSeconds: 0.11 },
        { slideId: 'hidden', holdSeconds: 60 },
      ],
    });
    expect(plan).toMatchObject({ durationMs: 685, frames: 21, width: 1918, height: 1080 });
    expect(plan.segments.map(({ endMs }) => endMs)).toEqual([50, 150, 225, 325, 375, 575, 685]);
    expect(slideMp4Frame(plan, 2)).toMatchObject({ segment: { kind: 'step' }, elapsedMs: 50 / 3 });
    const render = slideExportRenderer(deck);
    expect(render.video(plan, 2)).not.toContain('#ff0000');
    expect(render.video(plan, 3)).toContain('opacity="0.375"');
    expect(render.video(plan, 5)).toContain('#ff0000');
    expect(render.video(plan, 10)).not.toContain('#ff0000');
    expect(render.video(plan, 15)).toContain('translate(-2400.625 0)');
    expect(render.video(plan, 20)).toContain('#00ff00');
  });

  it('enforces the frame limit and rejects invalid waits and unencodable dimensions', () => {
    const deck = deckWithMotion();
    const staticPage = deck.slides[2];
    const many = {
      ...deck,
      slides: Array.from({ length: 10 }, (_, i) => ({
        ...staticPage,
        id: String(i),
        transition: undefined,
      })),
    };
    const atLimit = planSlideMp4(many, { defaultHoldSeconds: 60 });
    expect(atLimit.frames).toBe(18_000);
    expect(slideMp4Refusal(atLimit)).toBeUndefined();
    expect(
      slideMp4Refusal(
        planSlideMp4({ ...many, slides: [...many.slides, staticPage] }, { defaultHoldSeconds: 60 }),
      ),
    ).toContain('18,000');
    expect(slideMp4Refusal(planSlideMp4(many, { defaultHoldSeconds: 0 }))).toContain('18,000');
    expect(slideMp4Refusal(planSlideMp4({ ...many, width: 1 }, undefined))).toContain('偶数');
    expect(() => planSlideMp4(many, { defaultHoldSeconds: 0.0001 })).toThrow('invalid-hold');
  });
});
