import { describe, expect, it } from 'vitest';
import { time } from '@editor-platform/video-core';
import { checkRetainedProbesV1 } from './retained-probe-v1';
import type { ImportSetV1 } from './import-v1';
const plan = (end = 1): ImportSetV1 => ({
  format: 'video-media-interpretation-v1',
  streams: [
    {
      id: 'v',
      kind: 'video',
      destination: 'visual',
      mediaStart: time(0),
      mediaEnd: time(end),
      presentationStart: time(0),
    },
  ],
});
const history = (hashes: string[]) => ({
  versions: hashes.map((sha256) => ({
    content: { sources: [{ id: 'same-source', asset: { sha256 } }] },
  })),
  plans: [{ sourceId: 'same-source', plan: plan() }],
});
const originals = new Map(['a', 'b'].map((id) => [id, { blob: () => new Blob([id]) }]));
describe('retained compressed-source probe coverage', () => {
  it('checks a later different original even when the source ID is reused', async () => {
    const seen: string[] = [];
    await expect(
      checkRetainedProbesV1(history(['a', 'b']), originals, async (blob) => {
        const id = await blob.text();
        seen.push(id);
        return plan(id === 'b' ? 2 : 1);
      }),
    ).rejects.toThrow('Original probe disagrees');
    expect(seen).toEqual(['a', 'b']);
  });
  it('accepts matching independent originals and only probes a repeated hash once', async () => {
    const seen: string[] = [];
    await expect(
      checkRetainedProbesV1(history(['a', 'b', 'a']), originals, async (blob) => {
        seen.push(await blob.text());
        return plan();
      }),
    ).resolves.toBe(2);
    expect(seen).toEqual(['a', 'b']);
  });
});
