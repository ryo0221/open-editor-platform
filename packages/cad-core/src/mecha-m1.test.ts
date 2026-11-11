import { describe, expect, it } from 'vitest';
import { m1InterferenceCases, m1Robot } from './mecha-fixtures';
import { check, set } from './mecha-test-kit';

describe('M1 sample robot (TS-1710)', () => {
  it('stands and flies clear: the elbow and wrist pins are allowed near their joints only', () => {
    const f = m1Robot();
    expect(check(f)).toEqual([]);
    expect(check(f, f.assembly, 1)).toEqual([]);
    // Without the allowances each pin is reported.
    const bare = structuredClone(f.assembly);
    delete bare.interferenceAllowances;
    expect(check(f, bare).length).toBe(9);
  });
  it('reports an elbow folded into its upper arm, and an arm swung into the torso', () => {
    const f = m1Robot();
    // Folded to 150°: the forearm lies along the upper arm, far outside the elbow's sphere.
    expect(check(f, set(f, f.assembly, 'j-elbow-r', { angle: 150 }))).toEqual([
      'c-upper-r–c-fore-r:intersect',
    ]);
    // Turned half round: the right arm swings through the torso.
    const swung = set(f, f.assembly, 'j-shoulder-r', { angle: 180, angle2: 0, angle3: 0 });
    expect(check(f, swung)).toEqual(expect.arrayContaining(['c-torso–c-upper-r:intersect']));
  });
});

describe('M1 interference cases (c)–(e) (TS-1710)', () => {
  it('finds the stray solid, the arm past its shoulder sphere and the rod inside the torso', () => {
    const f = m1InterferenceCases();
    expect(check(f as never)).toEqual([
      'c-torso–c-pack:contain',
      'c-torso–c-arm:intersect',
      'c-torso–c-rod:contain',
    ]);
    // Turned out of the torso, the arm's pin is in the shoulder sphere: allowed.
    const out = set(f, f.assembly, 'j-shoulder', { angle: 0 });
    expect(check(f as never, out)).toEqual(['c-torso–c-pack:contain', 'c-torso–c-rod:contain']);
  });
});
