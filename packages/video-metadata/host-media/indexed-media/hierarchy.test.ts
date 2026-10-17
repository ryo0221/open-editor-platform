import { describe, expect, it } from 'vitest';
import { assertChildKinds } from './hierarchy.mjs';
// Plain grammar inputs only: no external demuxer, allocation or rejected repro payload.
describe('pre-demuxer MP4 hierarchy grammar', () => {
  const valid: Record<string, string[]> = {
    root: ['moov'],
    moov: ['mvhd', 'trak', 'trak', 'udta'],
    trak: ['tkhd', 'edts', 'mdia'],
    edts: ['elst'],
    mdia: ['mdhd', 'hdlr', 'minf'],
    minf: ['vmhd', 'dinf', 'stbl'],
    dinf: ['dref'],
    stbl: ['stsd', 'stts', 'stsz', 'stsc', 'stco'],
    stsd: ['avc1'],
    avc1: ['avcC', 'colr'],
    mp4a: ['wave', 'chan'],
    wave: ['frma', 'mp4a', 'esds', '\0\0\0\0'],
    udta: ['meta'],
    meta: ['hdlr', 'ilst'],
  };
  it('admits the documented canonical container paths', () => {
    for (const [parent, kinds] of Object.entries(valid))
      expect(() => assertChildKinds(parent, kinds)).not.toThrow();
  });
  it('rejects off-path declarations at every traversed container', () => {
    for (const parent of Object.keys(valid))
      for (const kind of ['stbl', 'stts', 'stz2', 'senc', 'mvex', 'mdia', 'wave']) {
        if (valid[parent].includes(kind)) continue;
        expect(
          () => assertChildKinds(parent, [...valid[parent], kind]),
          `${parent}/${kind}`,
        ).toThrow('hierarchy');
      }
  });
  it('admits the ordinary QuickTime dependency table only in the explicit v1 profile', () => {
    expect(() => assertChildKinds('stbl', [...valid.stbl, 'sdtp'])).toThrow();
    expect(() => assertChildKinds('stbl', [...valid.stbl, 'sdtp'], 'iphone-sdr-v1')).not.toThrow();
    expect(() => assertChildKinds('stbl', [...valid.stbl, 'stz2'], 'iphone-sdr-v1')).toThrow();
  });
  it('rejects duplicate singleton definitions and competing alternatives', () => {
    for (const [parent, kinds] of Object.entries(valid))
      for (const kind of kinds) {
        if (parent === 'moov' && kind === 'trak') continue;
        expect(() => assertChildKinds(parent, [...kinds, kind])).toThrow();
      }
    expect(() => assertChildKinds('stbl', [...valid.stbl, 'co64'])).toThrow();
    expect(() => assertChildKinds('mp4a', ['wave', 'esds'])).toThrow();
    expect(() => assertChildKinds('minf', [...valid.minf, 'smhd'])).toThrow();
  });
});
