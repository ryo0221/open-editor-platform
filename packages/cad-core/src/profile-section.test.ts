import { describe, expect, it } from 'vitest';
import { f48ProfileSweep } from './fixtures';
import { featureKind, featureReads } from './graph';
import { mm, type CadDocument } from './model';
import { profileOutline, profileReach, type CadProfileSegment } from './profile-section';
import { validateCad } from './validation';

const codes = (doc: unknown) => validateCad(doc).map((d) => `${d.code}@${d.path}`);
type Loose = { features: { args: Record<string, unknown> }[] };
const changed = (doc: CadDocument, change: (d: Loose) => void) => {
  const copy = structuredClone(doc) as unknown as Loose;
  change(copy);
  return copy;
};
const length = (segments: CadProfileSegment[]) =>
  segments.reduce(
    (s, g) =>
      s +
      (g.kind === 'line'
        ? Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1])
        : Math.hypot(g.a[0] - g.centre[0], g.a[1] - g.centre[1]) * (Math.PI / 2)),
    0,
  );

// TS-1541, ST-264.
describe('profile sections (CR4d)', () => {
  it('draws a hat, Z, channel and flat plate, bent at R where it fits', () => {
    const hat = profileOutline('hat', 30, 40, 15, 3);
    if ('code' in hat) throw new Error(hat.code);
    expect(hat.segments.map((s) => s.name)).toEqual([
      'flange:l',
      'bend:1',
      'wall:l',
      'bend:2',
      'top',
      'bend:3',
      'wall:r',
      'bend:4',
      'flange:r',
    ]);
    expect(length(hat.segments)).toBeCloseTo(2 * 12 + 2 * 24 + 34 + 4 * ((Math.PI / 2) * 3), 9);
    // End to end, each bend a quarter turn about a centre R from both its ends.
    hat.segments.forEach((s, i) => {
      if (i) expect(s.a).toEqual(hat.segments[i - 1]!.b);
      if (s.kind === 'arc')
        for (const p of [s.a, s.b])
          expect(Math.hypot(p[0] - s.centre[0], p[1] - s.centre[1])).toBeCloseTo(3, 12);
    });
    // The bends lie inside the hat: the first one's centre above the flange, right of the wall.
    const bend = hat.segments[1] as Extract<CadProfileSegment, { kind: 'arc' }>;
    expect(bend.centre).toEqual([-23, 3]);
    expect(profileReach(hat.segments)).toBeCloseTo(Math.hypot(35, 0), 9);
    const z = profileOutline('z', 30, 40, 15, 0);
    if ('code' in z) throw new Error(z.code);
    expect(length(z.segments)).toBeCloseTo(85, 12);
    const channel = profileOutline('channel', 30, 40, 0, 2);
    if ('code' in channel) throw new Error(channel.code);
    expect(channel.segments.map((s) => s.name)).toEqual([
      'wall:l',
      'bend:1',
      'top',
      'bend:2',
      'wall:r',
    ]);
    expect(profileOutline('flat', 30, 40, 15, 3)).toEqual({
      segments: [{ name: 'plate', kind: 'line', a: [-35, 0], b: [35, 0] }],
    });
    // Refused: a hat or Z without a flange, a bend larger than a side.
    expect(profileOutline('hat', 30, 40, 0, 3)).toEqual({ code: 'profile-flange' });
    expect(profileOutline('hat', 30, 40, 2, 3)).toEqual({ code: 'profile-radius' });
    expect(profileOutline('hat', 30, 5, 10, 3)).toEqual({ code: 'profile-radius' });
  });

  it('admits a profile sweep and checks its section, up and flip', () => {
    const doc = f48ProfileSweep({ closure: 'hat' });
    expect(codes(doc)).toEqual([]);
    expect(featureKind(doc, 'member')).toBe('sheet');
    expect(featureReads(doc.features[0]!).sketches).toEqual(['member-path']);
    const set = (patch: Record<string, unknown>, profile: Record<string, unknown> = {}) =>
      codes(
        changed(doc, (d) => {
          const a = d.features[0]!.args;
          Object.assign(a, patch);
          Object.assign(a.profile as object, profile);
        }),
      );
    const at = (k: string) => `$.features[0].args.${k}`;
    expect(set({}, { kind: 'box' })).toEqual([`profile-kind@${at('profile.kind')}`]);
    expect(set({}, { height: mm(501) })).toEqual([`profile-height@${at('profile.height')}`]);
    expect(set({}, { width: mm(0.5) })).toEqual([`profile-width@${at('profile.width')}`]);
    expect(set({}, { flange: mm(201) })).toEqual([`profile-flange-range@${at('profile.flange')}`]);
    expect(set({}, { radius: mm(51) })).toEqual([`profile-radius-range@${at('profile.radius')}`]);
    expect(set({}, { radius: mm(0), flange: mm(0) })).toEqual([
      `profile-flange@${at('profile.flange')}`,
    ]);
    expect(set({}, { kind: 'channel', flange: mm(0) })).toEqual([]);
    expect(set({}, { radius: mm(20) })).toEqual([`profile-radius@${at('profile.radius')}`]);
    expect(set({ up: [0, 0, 1] })).toEqual([]);
    expect(set({ up: [0, 0, 2] })).toEqual([`profile-up@${at('up')}`]);
    expect(set({ up: 'sideways' })).toEqual([`profile-up@${at('up')}`]);
    expect(set({ flip: 'yes' })).toEqual([`profile-flip@${at('flip')}`]);
    // An open path only.
    expect(
      codes(
        changed(doc, (d) => {
          (d.features[0]!.args.path as { sketchId: string }).sketchId = 'none';
        }),
      ),
    ).toContain(`sketch-missing@${at('path.sketchId')}`);
  });
});
