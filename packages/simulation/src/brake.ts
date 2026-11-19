import { topologyRefOf, type CadDocument, type CadTopologyTable } from '@editor-platform/cad-core';
import {
  emptySimulation,
  simulationMaterialPresets,
  transientStudy,
  type SimulationAmplitude,
  type SimulationDocument,
  type SimulationTarget,
  type SimulationTransientStudy,
} from '@editor-platform/simulation-core';

/**
 * VS12a (docs/cad/vehicle-simulation.md, VS12): a brake test's heat on one front disc. The car
 * stops from `speed` at `decel`, stands, speeds up again at `accel` and runs at `speed` until the
 * next stop, `stops` times, one stop every `period` seconds. All of the car's kinetic energy goes
 * into the brakes (aero and rolling drag are left out, which is the hot side); the front axle
 * takes `frontShare` of it, split over its `discs`, and the disc keeps `partition` of its share
 * (the pads take the rest). Units mm–t–s: speeds mm/s, energies mJ, powers mW.
 */
export interface BrakeCycle {
  /** Car mass (t). */
  mass: number;
  /** Speed before each stop (mm/s). */
  speed: number;
  /** Deceleration while braking (mm/s²). */
  decel: number;
  /** Acceleration back to `speed` after the stand (mm/s²). */
  accel: number;
  /** Standing time after each stop (s). */
  stand: number;
  /** Time from one stop's start to the next (s). */
  period: number;
  stops: number;
  /** The front axle's share of the braking energy (0–1). */
  frontShare: number;
  /** Discs on the front axle. */
  discs: number;
  /** The disc's share of its brake's heat, the pads having the rest (0–1). */
  partition: number;
}

/** 100 km/h in mm/s. */
export const kmh = (v: number) => (v * 1e6) / 3600;
/** Standard gravity (mm/s²). */
export const gravity = 9806.65;

/**
 * The fade test of VS12 on 凪 (F95): 1 050 kg, ten stops from 100 km/h at 0.6 g, one a minute,
 * 2 s standing, back up at 0.3 g; 70 % of the braking on the front, 90 % of a brake's heat into
 * its disc. The car's mass and shares are this fixture's choice (F95 has no mass).
 */
export const nagiBrakeCycle: Readonly<BrakeCycle> = Object.freeze({
  mass: 1.05,
  speed: kmh(100),
  decel: 0.6 * gravity,
  accel: 0.3 * gravity,
  stand: 2,
  period: 60,
  stops: 10,
  frontShare: 0.7,
  discs: 2,
  partition: 0.9,
});

export interface BrakeTimes {
  /** Braking time of a stop (s). */
  brake: number;
  /** Time back up to speed (s). */
  speedUp: number;
  /** End of the test (s). */
  end: number;
  /** Heat into the disc per stop (mJ). */
  energyPerStop: number;
  /** Heat into the disc when braking starts (mW). */
  peakPower: number;
}

/** Checks a cycle and gives its times and the disc's heat; throws on a cycle that cannot run. */
export function brakeTimes(c: BrakeCycle): BrakeTimes {
  const positive = {
    mass: c.mass,
    speed: c.speed,
    decel: c.decel,
    accel: c.accel,
    period: c.period,
  };
  for (const [k, v] of Object.entries(positive))
    if (!(Number.isFinite(v) && v > 0)) throw new RangeError(`brake cycle ${k} must be > 0`);
  if (!(Number.isFinite(c.stand) && c.stand >= 0))
    throw new RangeError('brake cycle stand must be ≥ 0');
  if (!(Number.isInteger(c.stops) && c.stops >= 1 && c.stops <= 1000))
    throw new RangeError('brake cycle stops must be a whole number 1–1000');
  if (!(Number.isInteger(c.discs) && c.discs >= 1))
    throw new RangeError('brake cycle discs must be a whole number ≥ 1');
  for (const [k, v] of [
    ['frontShare', c.frontShare],
    ['partition', c.partition],
  ] as const)
    if (!(v > 0 && v <= 1)) throw new RangeError(`brake cycle ${k} must be in (0, 1]`);
  const brake = c.speed / c.decel;
  const speedUp = c.speed / c.accel;
  if (brake + c.stand + speedUp > c.period)
    throw new RangeError(
      `a stop, the stand and speeding up take ${brake + c.stand + speedUp} s, more than the ${c.period} s period`,
    );
  const share = (c.frontShare / c.discs) * c.partition;
  return {
    brake,
    speedUp,
    end: c.stops * c.period,
    energyPerStop: share * 0.5 * c.mass * c.speed * c.speed,
    peakPower: share * c.mass * c.decel * c.speed,
  };
}

/** The car's speed (mm/s) at time t (s). */
export function brakeSpeedAt(c: BrakeCycle, t: number): number {
  const { brake, speedUp, end } = brakeTimes(c);
  if (t <= 0) return c.speed;
  if (t >= end) return c.speed;
  const s = t - Math.floor(t / c.period) * c.period;
  if (s < brake) return c.speed * (1 - s / brake);
  if (s < brake + c.stand) return 0;
  if (s < brake + c.stand + speedUp) return (c.speed * (s - brake - c.stand)) / speedUp;
  return c.speed;
}

/** Jumps take this long in a time table (s): the table's times must strictly increase. */
export const brakeJump = 1e-3;

/**
 * The disc's heat over time as a time table of `peakPower`: 1 when a stop starts, falling with
 * the speed to 0 when the car stands, 0 until the next stop. Linear between points, so the area
 * under it is each stop's energy exactly.
 *
 * With `step` (s), the table a θ = 1 solver with that step takes: it reads a table at each step's
 * end only, so each step's end carries the table's mean over that step, and the steps together
 * put in each stop's energy exactly, a stop starting inside a step included (Codex on #1282).
 */
export function brakePowerAmplitude(c: BrakeCycle, step?: number): SimulationAmplitude {
  if (step !== undefined) return stepMeans(brakePowerAmplitude(c), brakeTimes(c).end, step);
  const { brake, end } = brakeTimes(c);
  const times: number[] = [];
  const factors: number[] = [];
  for (let k = 0; k < c.stops; k++) {
    const s = k * c.period;
    if (k > 0) {
      times.push(s - brakeJump);
      factors.push(0);
    }
    times.push(s, s + brake);
    factors.push(1, 0);
  }
  times.push(end);
  factors.push(0);
  return { times, factors };
}

/** Air near a warm disc (about 300 K): conductivity mW/(mm·K) and kinematic viscosity mm²/s. */
export const brakeAir = Object.freeze({ conductivity: 0.0263, viscosity: 15.7 });
/** Still air's film coefficient on a hot disc, natural convection (mW/(mm²·K) = kW/(m²·K)). */
export const stillFilm = 0.008;

/**
 * A solid disc's mean film coefficient (mW/(mm²·K)) at a car speed (mm/s) after Limpert (Brake
 * Design and Safety, 3rd ed., §3.5): Re = v D / ν, Nu = 0.70 Re^0.55 below Re 2.4 × 10⁵ and
 * 0.04 Re^0.8 above, h = Nu k / D; never below still air's `stillFilm`.
 */
export function discFilm(speed: number, diameter: number): number {
  if (!(diameter > 0)) throw new RangeError('disc diameter must be > 0');
  const re = (Math.max(speed, 0) * diameter) / brakeAir.viscosity;
  const nu = re < 2.4e5 ? 0.7 * re ** 0.55 : 0.04 * re ** 0.8;
  return Math.max((nu * brakeAir.conductivity) / diameter, stillFilm);
}

/**
 * The disc's film coefficient over the test as a time table of its value at `speed`, sampled
 * every `sample` seconds and at each change of the speed.
 */
export function brakeFilmAmplitude(
  c: BrakeCycle,
  diameter: number,
  sample = 0.5,
): SimulationAmplitude {
  const { brake, speedUp, end } = brakeTimes(c);
  if (!(sample > 0)) throw new RangeError('sample must be > 0');
  const corners = new Set<number>();
  for (let k = 0; k < c.stops; k++) {
    const s = k * c.period;
    for (const t of [s, s + brake, s + brake + c.stand, s + brake + c.stand + speedUp])
      corners.add(Math.round(t * 1e9) / 1e9);
  }
  for (let t = 0; t < end; t += sample) corners.add(Math.round(t * 1e9) / 1e9);
  corners.add(end);
  const times = [...corners].filter((t) => t >= 0 && t <= end).sort((a, b) => a - b);
  const top = discFilm(c.speed, diameter);
  return { times, factors: times.map((t) => discFilm(brakeSpeedAt(c, t), diameter) / top) };
}

/** ∫₀ᵗ of a time table (linear between points, held past the ends). */
export function amplitudeIntegral(a: SimulationAmplitude, t: number): number {
  const { times, factors } = a;
  let sum = 0;
  if (t <= times[0]!) return factors[0]! * t;
  sum += factors[0]! * times[0]!;
  for (let i = 1; i < times.length; i++) {
    const t0 = times[i - 1]!;
    const t1 = Math.min(times[i]!, t);
    if (t1 <= t0) break;
    const f1 = amplitudeAt(a, t1);
    sum += 0.5 * (factors[i - 1]! + f1) * (t1 - t0);
    if (times[i]! >= t) return sum;
  }
  return sum + factors.at(-1)! * (t - times.at(-1)!);
}

/** A table of `a`'s mean over each step of `step` s up to `end`, at the steps' ends. */
function stepMeans(a: SimulationAmplitude, end: number, step: number): SimulationAmplitude {
  if (!(step > 0)) throw new RangeError('step must be > 0');
  const n = Math.max(1, Math.ceil(end / step - 1e-9));
  const times = [0];
  const factors: number[] = [];
  let before = 0;
  for (let s = 1; s <= n; s++) {
    const t = s === n ? end : s * step;
    const now = amplitudeIntegral(a, t);
    factors.push((now - before) / (t - times.at(-1)!));
    before = now;
    times.push(t);
  }
  return { times, factors: [factors[0]!, ...factors] };
}

/** A time table's value at t: linear between points, held past the ends. */
export function amplitudeAt(a: SimulationAmplitude, t: number): number {
  const { times, factors } = a;
  if (t <= times[0]!) return factors[0]!;
  if (t >= times.at(-1)!) return factors.at(-1)!;
  let lo = 0,
    hi = times.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (times[m]! <= t) lo = m;
    else hi = m;
  }
  const w = (t - times[lo]!) / (times[hi]! - times[lo]!);
  return factors[lo]! + w * (factors[hi]! - factors[lo]!);
}

const sigma = 5.670374419e-11;

export interface LumpedDisc {
  /** Heat capacity ρ c V (mJ/K). */
  capacity: number;
  /** Area that convects (mm²) and its film coefficient at the cycle's speed (mW/(mm²·K)). */
  filmArea: number;
  film: number;
  /** Area that radiates (mm²) and its emissivity. */
  radiantArea: number;
  emissivity: number;
  ambient: number;
  start: number;
}

/**
 * A disc of one temperature through the test, backward Euler with steps of `step` seconds, the
 * heat and film taken at each step's end as the θ = 1 solver takes them: the check on the
 * finite element disc's mean temperature (its stored heat over its capacity).
 */
export function lumpedBrake(
  c: BrakeCycle,
  disc: LumpedDisc,
  film: SimulationAmplitude,
  step: number,
): { time: Float64Array; temperature: Float64Array } {
  const { end, peakPower } = brakeTimes(c);
  const power = brakePowerAmplitude(c, step);
  const n = Math.ceil(end / step - 1e-9);
  const time = new Float64Array(n + 1);
  const temperature = new Float64Array(n + 1);
  temperature[0] = disc.start;
  let T = disc.start;
  for (let s = 1; s <= n; s++) {
    const t = Math.min(s * step, end);
    const dt = t - time[s - 1]!;
    const q = peakPower * amplitudeAt(power, t);
    const hA = disc.film * amplitudeAt(film, t) * disc.filmArea;
    const eA = disc.emissivity * sigma * disc.radiantArea;
    const old = T;
    for (let it = 0; it < 50; it++) {
      const r =
        (disc.capacity * (T - old)) / dt -
        q +
        hA * (T - disc.ambient) +
        eA * (T ** 4 - disc.ambient ** 4);
      const d = disc.capacity / dt + hA + 4 * eA * T ** 3;
      const dT = r / d;
      T -= dT;
      if (Math.abs(dT) < 1e-12 * Math.max(1, Math.abs(T))) break;
    }
    time[s] = t;
    temperature[s] = T;
  }
  return { time, temperature };
}

export interface BrakeAnalysisOptions {
  cycle: BrakeCycle;
  /** The disc's outer diameter for its film coefficient (mm). */
  diameter: number;
  /** The rubbed faces (indices into the body's table): the brake's heat goes in through them. */
  friction: number[];
  /** Faces that convect and radiate (default every face). */
  cooled?: number[];
  /** Emissivity of the iron (default 0.55, oxidised grey iron); 0 leaves radiation out. */
  emissivity?: number;
  /** Leave the film out (an adiabatic disc but for radiation). */
  film?: boolean;
  /**
   * VS12c: Limpert's film times this (default 1), e.g. a Host wind tunnel's film near the wheel
   * over Limpert's at the same speed (`aeroRegionFilm`).
   */
  filmScale?: number;
  ambient?: number;
  /** Time step (s, default 0.5) and fields kept (every `outputEvery` steps, default 120). */
  step?: number;
  outputEvery?: number;
  /** Mesh size (mm, default 18: F99 then fits the browser's 20 000 elements; the smallest 3/4 of it). */
  meshSize?: number;
}

/**
 * VS12a: a brake test as an analysis of the disc body `bodyId` of `cad`: grey cast iron, the
 * disc's share of each stop as a heat flux on the rubbed faces (`brakePowerAmplitude`), Limpert's
 * film at the car's speed and gray radiation on the cooled faces, one transient study over the
 * whole test. `contentHash` is `cad`'s.
 */
export function brakeDiscAnalysis(
  cad: CadDocument,
  contentHash: string,
  bodyId: string,
  table: CadTopologyTable,
  o: BrakeAnalysisOptions,
): { doc: SimulationDocument; study: SimulationTransientStudy; frictionArea: number } {
  const body = cad.bodies.find((b) => b.id === bodyId);
  if (!body) throw new RangeError(`no body ${bodyId}`);
  const t = brakeTimes(o.cycle);
  const ambient = o.ambient ?? 293.15;
  const emissivity = o.emissivity ?? 0.55;
  const step = o.step ?? 0.5;
  const at = (faces: number[]): SimulationTarget[] =>
    faces.map((i) => ({
      kind: 'face',
      ref: topologyRefOf(table, 'face', i, body.resultFeatureId),
    }));
  const cooled = o.cooled ?? table.faces.map((_, i) => i);
  const frictionArea = o.friction.reduce((a, i) => a + table.faces[i]!.area, 0);
  if (!(frictionArea > 0)) throw new RangeError('the rubbed faces have no area');
  const doc = emptySimulation(
    { artifactId: 'brake-disc', versionId: 'v1', contentHash, bodyId },
    'Brake test',
  );
  const iron = simulationMaterialPresets.find((m) => m.name === 'Grey cast iron')!;
  doc.materials.push({ id: 'iron', ...iron });
  doc.materialId = 'iron';
  const size = o.meshSize ?? 18;
  // The smallest size near the size: the mesher would otherwise refine every round edge.
  doc.mesh = { ...doc.mesh, size, minSize: 0.75 * size, grading: 1.5 };
  doc.loads.push({
    id: 'brake',
    name: 'Brake heat',
    kind: 'heat-flux',
    targets: at(o.friction),
    flux: t.peakPower / frictionArea,
    amplitude: brakePowerAmplitude(o.cycle, step),
  });
  if (o.film ?? true)
    doc.loads.push({
      id: 'air',
      name: 'Air',
      kind: 'convection',
      targets: at(cooled),
      coefficient: discFilm(o.cycle.speed, o.diameter) * (o.filmScale ?? 1),
      ambient,
      amplitude: brakeFilmAmplitude(o.cycle, o.diameter, step),
    });
  if (emissivity > 0)
    doc.loads.push({
      id: 'glow',
      name: 'Glow',
      kind: 'radiation',
      targets: at(cooled),
      emissivity,
      ambient,
    });
  const study = transientStudy('brake-test', 'Brake test');
  study.loadIds = doc.loads.map((l) => l.id);
  study.transient = {
    ...study.transient,
    endS: t.end,
    stepS: step,
    initialTemperature: ambient,
    outputEvery: o.outputEvery ?? 120,
  };
  doc.studies.push(study);
  return { doc, study, frictionArea };
}
