import { describe, expect, it } from 'vitest';
import { parameterValues } from './graph';
import { checkCadInterferenceAlong, type CadSweepSample } from './interference';
import { solveJoints } from './joints';
import { identityQuaternion, mm, position } from './model';
import { f156HandsOnDial } from './motion-coverage-fixtures';
import {
  cadCoverageLimits,
  checkCadMotionCoverage,
  planMotionCoverage,
  type CadMotionDriver,
} from './motion-coverage';

const deg = Math.PI / 180;
const turn = 2 * Math.PI;
const hourDriver = (hours: number) => ({
  joint: 'hour-arbor',
  of: 'angle' as const,
  from: 0,
  to: (turn * hours) / 12,
});

describe('motion interference with a bounded step per part (PD6, ST-766)', () => {
  it('reproduces the aliasing an even split gives a fast hand (TS-2544)', () => {
    const { doc, lookup, joints, meshesOf } = f156HandsOnDial();
    // 12 hours in 48 samples: the second hand turns 15 times between samples, so it is at 0 rad
    // at every one and never meets the pin near 90°.
    const samples: CadSweepSample[] = Array.from({ length: 49 }, (_, tick) => ({
      tick,
      values: new Map([['hour-arbor', { angle: (turn * tick) / 48 }]]),
    }));
    const even = checkCadInterferenceAlong({ doc, lookup, meshesOf, joints }, samples);
    if (even.status !== 'ok') throw new Error(even.code);
    expect(even.hits).toEqual([]);
    // The bounds ask for 720 turns at 1° a step: more samples than the limit, refused with the
    // count they need instead of a sparser sweep.
    const plan = planMotionCoverage({ doc, lookup, meshesOf, joints }, hourDriver(12), {
      stepMm: 0.5,
      stepRad: deg,
    });
    expect(plan).toEqual({ status: 'refused', code: 'coverage-samples', needed: 720 * 360 + 1 });
  });

  it('finds the pin on every turn of the second hand within the bounds (TS-2545)', () => {
    const { doc, lookup, joints, meshesOf } = f156HandsOnDial();
    const r = checkCadMotionCoverage({ doc, lookup, meshesOf, joints }, hourDriver(1), {
      stepMm: 2,
      stepRad: 6 * deg,
    });
    if (r.status !== 'ok') throw new Error(r.code);
    // 60 turns of the second hand at 6° a step.
    expect(r.steps).toBe(3600);
    expect(r.values).toHaveLength(3601);
    expect(r.values[0]).toBe(0);
    expect(r.values.at(-1)).toBe(turn / 12);
    const step = Object.fromEntries(
      r.joints.map((j) => [j.joint.replace('-arbor', ''), j.step / deg]),
    );
    expect(step.second).toBeCloseTo(6, 9);
    expect(step.minute).toBeCloseTo(0.1, 9);
    expect(step.hour).toBeCloseTo(1 / 120, 9);
    // Every hand moves; the dial and pin do not. The second hand's far corner (16.008 mm out)
    // travels its 6° arc per step.
    expect(r.parts.map((p) => p.path)).toEqual([['hour'], ['minute'], ['second']]);
    const second = r.parts.find((p) => p.path[0] === 'second')!;
    expect(second.stepRad / deg).toBeCloseTo(6, 6);
    expect(second.stepMm).toBeCloseTo(Math.hypot(16, 0.5) * 6 * deg, 3);
    expect(r.unmeasured).toEqual([]);
    // The pin is met on each of the 60 turns, only by the second hand, near 90°.
    const turns = new Set(r.hits.map((h) => Math.floor((r.values[h.tick]! * 720) / turn)));
    expect(turns.size).toBe(60);
    for (const h of r.hits) {
      expect(h.findings.map((f) => [f.a, f.b])).toEqual([[['pin'], ['second']]]);
      const a = ((r.values[h.tick]! * 720) % turn) / deg;
      expect(Math.abs(a - 90)).toBeLessThan(10);
    }
  });

  it('adds steps until every point of a part stays within the length bound (TS-2546)', () => {
    const { doc, lookup, joints, meshesOf } = f156HandsOnDial();
    // One minute: one turn of the second hand. 6° alone gives 60 steps, but its tip would then
    // move 1.68 mm; 1 mm a step needs about 101.
    const plan = planMotionCoverage({ doc, lookup, meshesOf, joints }, hourDriver(1 / 60), {
      stepMm: 1,
      stepRad: 6 * deg,
    });
    if (plan.status !== 'ok') throw new Error(plan.code);
    expect(plan.steps).toBeGreaterThanOrEqual(Math.ceil(Math.hypot(16, 0.5) * turn));
    expect(plan.steps).toBeLessThan(110);
    for (const p of plan.parts) expect(p.stepMm!).toBeLessThanOrEqual(1);
    expect(plan.samples).toHaveLength(plan.steps + 1);
  });

  it('bounds a part a joint moves on a moving parent by its path, not its net turn (TS-2546)', () => {
    const f = f156HandsOnDial();
    // The minute hand on the hour hand's tip (8 mm out), turning back as much as the hour hand
    // turns: its orientation never changes while it swings round the arbor on an 8 mm arm.
    const doc = structuredClone(f.doc);
    const minute = doc.joints.find((j) => j.id === 'minute-arbor')!;
    minute.parent = {
      componentPath: ['hour'],
      ref: { origin: true },
      flip: false,
      offset: { translation: position(8, 0.5, 0.4), rotation: identityQuaternion() },
    };
    minute.couplings = [
      { of: 'angle', from: { joint: 'hour-arbor', of: 'angle' }, ratio: -1, offset: 0 },
    ];
    doc.joints = doc.joints.filter((j) => j.id !== 'second-arbor');
    const { joints } = solveJoints(
      doc,
      parameterValues(doc),
      f.lookup,
      () => undefined,
      () => true,
    );
    doc.solvedPoses = solveJoints(
      doc,
      parameterValues(doc),
      f.lookup,
      () => undefined,
      () => true,
    ).poses;
    const input = { doc, lookup: f.lookup, meshesOf: f.meshesOf, joints };
    // One 30° step: every point of the minute hand travels 8 mm × 30° (4.19 mm), more than the
    // 4.14 mm chord its unchanged orientation would suggest.
    const plan = planMotionCoverage(input, hourDriver(1), { stepMm: 1000, stepRad: 30 * deg });
    if (plan.status !== 'ok') throw new Error(plan.code);
    expect(plan.steps).toBe(1);
    const m = plan.parts.find((p) => p.path[0] === 'minute')!;
    expect(m.stepRad).toBeCloseTo(0, 9);
    expect(m.stepMm!).toBeGreaterThanOrEqual(8 * 30 * deg);
    // A bound between the travel and the chord is refused: more steps are added until it holds.
    const tight = planMotionCoverage(input, hourDriver(1), { stepMm: 4.18, stepRad: 30 * deg });
    if (tight.status !== 'ok') throw new Error(tight.code);
    expect(tight.steps).toBeGreaterThan(1);
    for (const p of tight.parts) expect(p.stepMm!).toBeLessThanOrEqual(4.18);
  });

  it('follows a joint on a pattern copy through the copy’s seed (TS-2546)', () => {
    const f = f156HandsOnDial();
    // A copy of the hour hand 50 mm along x moves with the seed's joint; the minute hand sits on
    // the copy's tip, turning back as much: it swings 8 mm × 30° round the copy's arbor.
    const doc = structuredClone(f.doc);
    doc.componentPatterns = [
      {
        id: 'p-hour',
        name: 'Hour copies',
        seedComponentId: 'hour',
        layout: { type: 'linear', direction: [1, 0, 0], count: { literal: 2 }, spacing: mm(50) },
      },
    ];
    const minute = doc.joints.find((j) => j.id === 'minute-arbor')!;
    minute.parent = {
      componentPath: ['copy:p-hour:1'],
      ref: { origin: true },
      flip: false,
      offset: { translation: position(8, 0.5, 0.4), rotation: identityQuaternion() },
    };
    minute.couplings = [
      { of: 'angle', from: { joint: 'hour-arbor', of: 'angle' }, ratio: -1, offset: 0 },
    ];
    doc.joints = doc.joints.filter((j) => j.id !== 'second-arbor');
    const solved = solveJoints(
      doc,
      parameterValues(doc),
      f.lookup,
      () => undefined,
      () => true,
    );
    doc.solvedPoses = solved.poses;
    const input = { doc, lookup: f.lookup, meshesOf: f.meshesOf, joints: solved.joints };
    const plan = planMotionCoverage(input, hourDriver(1), { stepMm: 1000, stepRad: 30 * deg });
    if (plan.status !== 'ok') throw new Error(plan.code);
    const m = plan.parts.find((p) => p.path[0] === 'minute')!;
    expect(m.stepRad).toBeCloseTo(0, 9);
    expect(m.stepMm!).toBeGreaterThanOrEqual(8 * 30 * deg);
  });

  it('reports parts without meshes as bounded by their joints only (TS-2547)', () => {
    const { doc, lookup, joints, meshesOf, hashOf } = f156HandsOnDial();
    const r = checkCadMotionCoverage(
      { doc, lookup, joints, meshesOf: (h) => (h === hashOf.second ? undefined : meshesOf(h)) },
      hourDriver(1 / 60),
      { stepMm: 1, stepRad: 6 * deg },
    );
    if (r.status !== 'ok') throw new Error(r.code);
    expect(r.unmeasured).toEqual([['second']]);
    expect(r.unchecked).toEqual([['second']]);
    const second = r.parts.find((p) => p.path[0] === 'second')!;
    expect(second.stepMm).toBeUndefined();
    expect(second.stepRad / deg).toBeCloseTo(6, 6);
    // The other hands alone set the count: 60 steps of 6°.
    expect(r.steps).toBe(60);
    expect(r.hits).toEqual([]);
  });

  it('lists a part without meshes that only slides (TS-2547)', () => {
    const { doc, lookup, joints, meshesOf, hashOf } = f156HandsOnDial();
    // The hour hand on a cylindrical joint, slid 1 mm along its arbor without turning.
    const sliding = {
      ...doc,
      joints: doc.joints.map((j) =>
        j.id === 'hour-arbor' ? { ...j, type: 'cylindrical' as const } : j,
      ),
    };
    const plan = planMotionCoverage(
      {
        doc: sliding,
        lookup,
        joints,
        meshesOf: (h) => (h === hashOf.hour ? undefined : meshesOf(h)),
      },
      { joint: 'hour-arbor', of: 'distance', from: 0, to: 1 },
      { stepMm: 0.25, stepRad: deg },
    );
    if (plan.status !== 'ok') throw new Error(plan.code);
    expect(plan.steps).toBe(4);
    expect(plan.parts).toEqual([{ path: ['hour'], stepRad: 0 }]);
    expect(plan.unmeasured).toEqual([['hour']]);
  });

  it('refuses what it cannot cover (TS-2548)', () => {
    const { doc, lookup, joints, meshesOf } = f156HandsOnDial();
    const input = { doc, lookup, joints, meshesOf };
    const b = { stepMm: 1, stepRad: deg };
    const plan = (d: Partial<CadMotionDriver>, bounds = b) =>
      planMotionCoverage(input, { ...hourDriver(1 / 60), ...d }, bounds);
    expect(plan({ joint: 'gone' })).toEqual({ status: 'refused', code: 'target-missing' });
    expect(plan({ joint: 'second-arbor' })).toEqual({ status: 'refused', code: 'range-coupled' });
    expect(plan({ of: 'distance' })).toEqual({ status: 'refused', code: 'range-value' });
    expect(plan({ to: 0 })).toEqual({ status: 'refused', code: 'coverage-span' });
    expect(plan({ to: Number.NaN })).toEqual({ status: 'refused', code: 'coverage-span' });
    expect(plan({}, { stepMm: 0, stepRad: deg })).toEqual({
      status: 'refused',
      code: 'coverage-bounds',
    });
    expect(plan({}, { stepMm: 1, stepRad: Infinity })).toEqual({
      status: 'refused',
      code: 'coverage-bounds',
    });
    // A turn as large as a revolution per step would leave the endpoints alike: refused.
    expect(plan({}, { stepMm: 0.001, stepRad: 2 * Math.PI })).toEqual({
      status: 'refused',
      code: 'coverage-bounds',
    });
    // The second hand past the continuous joints' safety bound.
    expect(plan({ to: 2000 })).toEqual({ status: 'refused', code: 'joint-limit' });
    // An unsolved joint would leave its hand where it was (a mixed pose).
    const { 'second-arbor': _s, ...rest } = joints;
    expect(planMotionCoverage({ ...input, joints: rest }, hourDriver(1 / 60), b)).toEqual({
      status: 'refused',
      code: 'joint-part-unavailable',
    });
    expect(cadCoverageLimits.samples).toBe(4096);
  });
});
