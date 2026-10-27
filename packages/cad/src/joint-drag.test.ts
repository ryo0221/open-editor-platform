import { describe, expect, it } from 'vitest';
import {
  mm,
  r2bJoints,
  type CadJoint,
  type CadJointSolution,
  type Vec3,
} from '@editor-platform/cad-core';
import {
  dragKeys,
  moveJointDrag,
  releasedJointValues,
  startJointDrag,
  type CadDragRay,
} from './joint-drag';

const solved = (at: Vec3, rotation: [number, number, number, number] = [0, 0, 0, 1]) =>
  ({
    status: 'solved',
    parent: { translationMm: at, rotation },
    child: { translationMm: [0, 0, 0], rotation: [0, 0, 0, 1] },
  }) satisfies CadJointSolution;
/** A ray straight down onto (x, y). */
const down = (x: number, y: number): CadDragRay => ({ origin: [x, y, 100], direction: [0, 0, -1] });
const deg = (rad: number | undefined) => Math.round((((rad ?? 0) * 180) / Math.PI) * 1e6) / 1e6;

describe('joint drag (R2b-2c, CAD47)', () => {
  const { assembly } = r2bJoints();
  const joint = (id: string, change?: (j: CadJoint) => void) => {
    const j = structuredClone(assembly.joints.find((x) => x.id === id)!);
    change?.(j);
    return j;
  };

  it('drags along each type’s freedoms, Shift for the other one', () => {
    expect(dragKeys('revolute', false)).toEqual(['angle']);
    expect(dragKeys('slider', true)).toEqual(['distance']);
    expect(dragKeys('cylindrical', false)).toEqual(['angle']);
    expect(dragKeys('cylindrical', true)).toEqual(['distance']);
    expect(dragKeys('planar', false)).toEqual(['u', 'v']);
    expect(dragKeys('planar', true)).toEqual(['angle']);
    expect(dragKeys('fastened', false)).toEqual([]);
  });

  it('turns a revolute joint about its parent connector’s z, unwrapped, and stops at its limit', () => {
    const turn = joint('j-turn', (j) => (j.values.angle = { literalRad: Math.PI / 6 }));
    const s = startJointDrag(
      assembly,
      turn,
      solved([40, 25, 5]),
      down(50, 25),
      [50, 25, 10],
      false,
    );
    if (s.status !== 'ok') throw new Error(s.status);
    // A quarter turn counter-clockwise seen from +z, from the 30° it had.
    expect(deg(moveJointDrag(s.drag, down(40, 35))!.angle)).toBe(120);
    // On past half a turn: the limit (±180°) stops it instead of wrapping to −150°.
    expect(deg(moveJointDrag(s.drag, down(30, 25))!.angle)).toBe(180);
    expect(deg(moveJointDrag(s.drag, down(40, 15))!.angle)).toBe(180);
    // Back again below the limit.
    expect(deg(moveJointDrag(s.drag, down(30, 25.0001))!.angle)).toBeCloseTo(180, 2);
    const back = moveJointDrag(s.drag, down(40, 35))!;
    expect(deg(back.angle)).toBe(120);
    // Released: rounded to 0.01° and stored as a literal.
    expect(releasedJointValues(s.drag, back)).toEqual({
      angle: { literalRad: (120 * Math.PI) / 180 },
    });
  });

  it('refuses a value that a parameter or an expression sets, a fixed joint, and an unsolved one', () => {
    const ray = down(50, 25);
    expect(
      startJointDrag(assembly, joint('j-turn'), solved([40, 25, 5]), ray, [50, 25, 10], false),
    ).toEqual({ status: 'bound' });
    expect(
      startJointDrag(assembly, joint('j-fasten'), solved([0, 0, 0]), ray, [1, 0, 0], false),
    ).toEqual({ status: 'fixed' });
    expect(
      startJointDrag(assembly, joint('j-slide'), { status: 'unavailable' }, ray, [1, 0, 0], false),
    ).toEqual({ status: 'unsolved' });
  });

  it('refuses a view along the turning plane, or along a slider’s axis', () => {
    const turn = joint('j-turn', (j) => (j.values.angle = { literalRad: 0 }));
    const flat: CadDragRay = { origin: [200, 25, 10], direction: [-1, 0, 0] };
    expect(startJointDrag(assembly, turn, solved([40, 25, 5]), flat, [50, 25, 10], false)).toEqual({
      status: 'edge-on',
    });
    const slide = joint('j-slide');
    expect(
      startJointDrag(assembly, slide, solved([0, 0, 0]), down(0, 0), [0, 0, 1], false),
    ).toEqual({ status: 'edge-on' });
  });

  it('moves a slider along its axis within its range, and rounds to 0.01 mm', () => {
    const slide = joint('j-slide');
    const side = (z: number): CadDragRay => ({ origin: [0, 100, z], direction: [0, -1, 0] });
    const s = startJointDrag(assembly, slide, solved([0, 0, 0]), side(14), [0, 5, 14], false);
    if (s.status !== 'ok') throw new Error(s.status);
    expect(moveJointDrag(s.drag, side(17.123))!.distance).toBeCloseTo(15.123, 9);
    expect(releasedJointValues(s.drag, moveJointDrag(s.drag, side(17.123))!)).toEqual({
      distance: mm(15.12),
    });
    // 0–20 mm: past the end it stops there.
    expect(moveJointDrag(s.drag, side(40))!.distance).toBe(20);
    expect(moveJointDrag(s.drag, side(-40))!.distance).toBe(0);
    // Not moved: nothing to write.
    expect(releasedJointValues(s.drag, moveJointDrag(s.drag, side(14))!)).toBeUndefined();
  });

  it('moves a planar joint in its frame’s x and y, and keeps the values it does not drag', () => {
    const plane = joint('j-plane');
    // The parent frame turned a quarter about z: its x is the world's y.
    const q: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    const s = startJointDrag(
      assembly,
      plane,
      solved([0, 0, 0], q),
      down(10, 10),
      [10, 10, 2],
      false,
    );
    if (s.status !== 'ok') throw new Error(s.status);
    const moved = moveJointDrag(s.drag, down(13, 15))!;
    expect(moved.u).toBeCloseTo(-120 + 5, 9);
    expect(moved.v).toBeCloseTo(10 - 3, 9);
    expect(releasedJointValues(s.drag, moved)).toEqual({
      u: mm(-115),
      v: mm(7),
      angle: { literalRad: Math.PI / 2 },
    });
    // Shift turns it about the child's connector, moved by (u, v) = (-120, 10) in the plane.
    const t = startJointDrag(
      assembly,
      plane,
      solved([0, 0, 0]),
      down(-110, 10),
      [-110, 10, 2],
      true,
    );
    if (t.status !== 'ok') throw new Error(t.status);
    expect(deg(moveJointDrag(t.drag, down(-120, 20))!.angle)).toBe(180);
    // A ray that never meets the plane keeps the last values.
    expect(moveJointDrag(s.drag, { origin: [0, 0, 100], direction: [0, 0, 1] })).toBeUndefined();
    const ride = joint('j-ride');
    const c = startJointDrag(assembly, ride, solved([0, 0, 0]), down(10, 0), [10, 0, 1], false);
    if (c.status !== 'ok') throw new Error(c.status);
    expect(releasedJointValues(c.drag, moveJointDrag(c.drag, down(0, 10))!)).toEqual({
      distance: mm(5),
      angle: { literalRad: Math.PI / 2 },
    });
  });
});
