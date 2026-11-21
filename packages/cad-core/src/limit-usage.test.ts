import { describe, expect, it } from 'vitest';
import { f01Empty, f15Loft } from './fixtures';
import { cadLimitLevel, cadLimitUsage, cadLimitWarnings, cadLimitWarnRatio } from './limit-usage';
import { cadLimits, cadLoftSections } from './model';
import { cadSketchLimits } from './sketch';

describe('limit usage (#14)', () => {
  it('raises the limits to whole-vehicle sizes', () => {
    expect(cadLimits).toMatchObject({
      bodies: 512,
      allBodies: 4_096,
      features: 2_048,
      profiles: 512,
    });
    expect(cadSketchLimits.sketches).toBe(2_048);
    expect(cadLoftSections).toBe(128);
  });

  it('is near at 80 % and over past the limit', () => {
    expect(cadLimitWarnRatio).toBe(0.8);
    expect(cadLimitLevel(409, 512)).toBe('ok');
    expect(cadLimitLevel(410, 512)).toBe('near');
    expect(cadLimitLevel(512, 512)).toBe('near');
    expect(cadLimitLevel(513, 512)).toBe('over');
  });

  it('counts every limit of a document and names the loft with the most sections', () => {
    const usage = cadLimitUsage(f15Loft());
    expect(usage.map((u) => u.key)).toEqual([
      'bodies',
      'allBodies',
      'features',
      'profiles',
      'sketches',
      'parameters',
      'loftSections',
      'contentBytes',
    ]);
    const loft = usage.find((u) => u.key === 'loftSections')!;
    expect(loft).toMatchObject({
      used: 2,
      max: cadLoftSections,
      level: 'ok',
      featureId: 'loft-feature',
    });
    expect(cadLimitWarnings(usage)).toEqual([]);
    expect(cadLimitUsage(f01Empty(), { bytes: false }).map((u) => u.key)).not.toContain(
      'contentBytes',
    );
  });

  it('warns, worst first, before the limit is reached', () => {
    const doc = f01Empty();
    const profiles = Array.from({ length: cadLimits.profiles }, () => ({}) as never);
    const features = Array.from(
      { length: Math.ceil(cadLimits.features * 0.85) },
      (_, i) => ({ id: `f${i}`, type: 'box', args: {} }) as never,
    );
    const warnings = cadLimitWarnings(
      cadLimitUsage({ ...doc, profiles, features }, { bytes: false }),
    );
    expect(warnings.map((w) => [w.key, w.level])).toEqual([
      ['profiles', 'near'],
      ['features', 'near'],
    ]);
  });
});
