import { describe, it, expect } from 'vitest';
import { createFrameBudgetRealm } from './frame-budget';
const cap = (pixels: number, bytes = pixels * 4) => ({ pixels, bytes });
describe('private decoded-frame reservations', () => {
  it('checks both dimensions and scopes atomically, including competing sources', () => {
    const realm = createFrameBudgetRealm(cap(10));
    const a = realm.session(cap(8)),
      b = realm.session(cap(8));
    const held = a.reserve(cap(6));
    expect(() => a.reserve(cap(3))).toThrow('session budget');
    expect(() => b.reserve(cap(5))).toThrow('realm budget');
    expect(() => b.reserve(cap(1, 17))).toThrow('realm budget');
    expect(realm.snapshot()).toEqual(cap(6));
    const next = b.reserve(cap(4));
    expect(() => a.close()).toThrow('outstanding');
    held.release();
    held.release();
    expect(realm.snapshot()).toEqual(cap(4));
    a.close();
    expect(() => a.reserve(cap(1))).toThrow('closed');
    next.release();
    b.close();
    expect(realm.snapshot()).toEqual(cap(0));
  });
  it('does not retain caller-owned mutable limits or charges', () => {
    const limit = cap(4),
      cost = cap(3),
      realm = createFrameBudgetRealm(limit);
    const owner = realm.session(limit),
      reservation = owner.reserve(cost);
    limit.pixels = 999;
    limit.bytes = 9999;
    cost.pixels = 999;
    cost.bytes = 9999;
    expect(() => owner.reserve(cap(2))).toThrow('budget');
    reservation.release();
    expect(realm.snapshot()).toEqual(cap(0));
    owner.close();
  });
  it('rejects nonfinite, fractional, zero and unsafe charges without accounting changes', () => {
    const realm = createFrameBudgetRealm(cap(10)),
      owner = realm.session(cap(10));
    for (const value of [NaN, Infinity, -1, 0, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => owner.reserve(cap(value))).toThrow('Invalid');
      expect(() => owner.reserve({ pixels: 1, bytes: value })).toThrow('Invalid');
    }
    expect(realm.snapshot()).toEqual(cap(0));
    owner.close();
  });
});
