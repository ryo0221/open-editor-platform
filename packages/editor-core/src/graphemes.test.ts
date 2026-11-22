import { afterEach, describe, expect, it, vi } from 'vitest';

describe('grapheme segmenter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('lets editor-core load in a runtime without Intl', async () => {
    vi.resetModules();
    vi.stubGlobal('Intl', undefined);
    const core = await import('./index');
    expect(typeof core.breakJapaneseLines).toBe('function');
  });

  it('still segments graphemes once used', async () => {
    const { graphemeSegmenter } = await import('./graphemes');
    expect([...graphemeSegmenter().segment('が👍🏽あ')].map((s) => s.segment)).toEqual([
      'が',
      '👍🏽',
      'あ',
    ]);
    expect(graphemeSegmenter()).toBe(graphemeSegmenter());
  });
});
