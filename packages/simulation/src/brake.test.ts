import { describe, expect, it } from 'vitest';
import {
  amplitudeAt,
  brakeFilmAmplitude,
  amplitudeIntegral,
  brakePowerAmplitude,
  brakeSpeedAt,
  brakeTimes,
  discFilm,
  kmh,
  lumpedBrake,
  nagiBrakeCycle,
  stillFilm,
} from './brake';

/** The area under a time table (trapezoids: exact for a linear one). */
const area = (a: { times: number[]; factors: number[] }) => {
  let s = 0;
  for (let i = 1; i < a.times.length; i++)
    s += 0.5 * (a.factors[i]! + a.factors[i - 1]!) * (a.times[i]! - a.times[i - 1]!);
  return s;
};

describe('a brake test’s heat on a front disc (VS12a, TS-2285, ST-638)', () => {
  it('gives each stop’s share of the kinetic energy as a time table of the peak power', () => {
    const c = nagiBrakeCycle;
    const t = brakeTimes(c);
    expect(kmh(100)).toBeCloseTo(27777.78, 2);
    // 27 778 mm/s at 0.6 g: 4.72 s to stand.
    expect(t.brake).toBeCloseTo(4.7206, 3);
    expect(t.end).toBe(600);
    // ½ m v² = 405 kJ; 0.7 / 2 × 0.9 of it into one front disc: 127.6 kJ (mJ here).
    expect(t.energyPerStop / 1e6).toBeCloseTo(127.6, 1);
    const a = brakePowerAmplitude(c);
    for (let i = 1; i < a.times.length; i++) expect(a.times[i]!).toBeGreaterThan(a.times[i - 1]!);
    // The area under the table is each stop’s energy (the 1 ms jumps add 2e-4 of it).
    expect((t.peakPower * area(a)) / (c.stops * t.energyPerStop)).toBeCloseTo(1, 3);
    expect(amplitudeAt(a, 0)).toBe(1);
    expect(amplitudeAt(a, t.brake / 2)).toBeCloseTo(0.5, 9);
    expect(amplitudeAt(a, 30)).toBe(0);
    expect(amplitudeAt(a, 60)).toBe(1);
    expect(amplitudeAt(a, 600)).toBe(0);
    // The speed: falling, standing, back up, running.
    expect(brakeSpeedAt(c, t.brake / 2)).toBeCloseTo(c.speed / 2, 6);
    expect(brakeSpeedAt(c, t.brake + 1)).toBe(0);
    expect(brakeSpeedAt(c, 30)).toBe(c.speed);
  });

  it('refuses a cycle that cannot run', () => {
    const c = nagiBrakeCycle;
    expect(() => brakeTimes({ ...c, period: 10 })).toThrow(/more than the 10 s period/);
    expect(() => brakeTimes({ ...c, stops: 0 })).toThrow(/stops/);
    expect(() => brakeTimes({ ...c, frontShare: 1.2 })).toThrow(/frontShare/);
    expect(() => brakeTimes({ ...c, mass: Number.NaN })).toThrow(/mass/);
    expect(() => brakeTimes({ ...c, stand: -1 })).toThrow(/stand/);
  });

  it('cools the disc with Limpert’s film coefficient, still air when standing', () => {
    // Re = 27 778 × 258 / 15.7 = 4.56e5 (turbulent): Nu = 0.04 Re^0.8 = 1 348, h = 0.137.
    expect(discFilm(kmh(100), 258)).toBeCloseTo(0.1374, 3);
    // Laminar at 30 km/h: Re 1.37e5, Nu = 0.70 Re^0.55 = 467, h = 0.0476.
    expect(discFilm(kmh(30), 258)).toBeCloseTo(0.0476, 3);
    expect(discFilm(0, 258)).toBe(stillFilm);
    expect(() => discFilm(1, 0)).toThrow(/diameter/);
    const c = nagiBrakeCycle;
    const film = brakeFilmAmplitude(c, 258);
    for (let i = 1; i < film.times.length; i++)
      expect(film.times[i]!).toBeGreaterThan(film.times[i - 1]!);
    expect(film.times.length).toBeLessThan(10_000);
    expect(amplitudeAt(film, 30)).toBeCloseTo(1, 12);
    expect(amplitudeAt(film, brakeTimes(c).brake + 1)).toBeCloseTo(
      stillFilm / discFilm(c.speed, 258),
      12,
    );
  });

  it('heats a disc of one temperature by each stop’s energy when nothing cools it', () => {
    const c = nagiBrakeCycle;
    const t = brakeTimes(c);
    const disc = {
      capacity: 7.2e-9 * 5.0e8 * 1.0e6,
      filmArea: 1e5,
      film: 0,
      radiantArea: 1e5,
      emissivity: 0,
      ambient: 293.15,
      start: 293.15,
    };
    const film = brakeFilmAmplitude(c, 258);
    // Every step puts in its share exactly, also a step a stop starts inside (Codex on #1282).
    for (const step of [0.5, 1, 0.7]) {
      const coarse = lumpedBrake(c, disc, film, step);
      const rise = coarse.temperature.at(-1)! - 293.15;
      expect(rise / ((c.stops * t.energyPerStop) / disc.capacity)).toBeCloseTo(1, 3);
      const table = brakePowerAmplitude(c, step);
      expect(t.peakPower * amplitudeIntegral(brakePowerAmplitude(c), t.end)).toBeCloseTo(
        t.peakPower *
          table.factors
            .slice(1)
            .reduce((x, f, i) => x + f * (table.times[i + 1]! - table.times[i]!), 0),
        3,
      );
    }
    const fine = lumpedBrake(c, disc, film, 0.01);
    const rise = fine.temperature.at(-1)! - 293.15;
    expect(rise / ((c.stops * t.energyPerStop) / disc.capacity)).toBeCloseTo(1, 2);
    // Cooled, it ends lower, and each stop’s peak is above the last.
    const cooled = lumpedBrake(c, { ...disc, film: 0.137, emissivity: 0.55 }, film, 0.5);
    expect(cooled.temperature.at(-1)!).toBeLessThan(fine.temperature.at(-1)!);
    const peaks = Array.from({ length: c.stops }, (_, k) => {
      let hi = 0;
      cooled.time.forEach((s, i) => {
        if (s > k * 60 && s <= k * 60 + 10) hi = Math.max(hi, cooled.temperature[i]!);
      });
      return hi;
    });
    for (let k = 1; k < c.stops; k++) expect(peaks[k]!).toBeGreaterThan(peaks[k - 1]!);
  });
});
