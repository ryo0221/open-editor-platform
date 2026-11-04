/**
 * Story Timeline T1 capabilities: no hypotheses (T3a), no reading premise (T3b) and no shared
 * reading. A shared request is refused before anything is read or mounted (TL29b).
 */
import { describe, expect, it } from 'vitest';
import { mountStoryTimeline } from './browser';
import { SHARED_UNSUPPORTED, STORY_TIMELINE_CAPABILITIES } from './host';

describe('T1 capabilities (acceptance TL29b)', () => {
  it('declares reference T3 while refusing reading premises and shared', () => {
    expect(STORY_TIMELINE_CAPABILITIES).toEqual({
      t3a: true,
      t3b: true,
      readingPremise: false,
      shared: false,
    });
  });
  it('refuses a shared mount without reading storage or the page', async () => {
    // No document or IndexedDB exists here: reaching either would throw a different error.
    await expect(mountStoryTimeline({ shared: true })).rejects.toThrow(SHARED_UNSUPPORTED);
  });
});
