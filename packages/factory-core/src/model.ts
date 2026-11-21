/**
 * FT1 (docs/cad/factory-twin.md): a production line as a discrete-event material-flow model.
 * Objects (sources, stations, parallel stations, assembly stations, buffers, conveyors, drains)
 * joined by links; parts of product types flow through them. Pure data: no React, no kernel.
 *
 * Times are whole milliseconds, lengths whole millimetres.
 */

import type { LadderDocument } from '@editor-platform/ladder-core';

export const FACTORY_SCHEMA = 1;

/** A random duration in milliseconds. Every sample is rounded to a whole millisecond, never < 0. */
export type FactoryDistribution =
  | { type: 'const'; value: number }
  | { type: 'uniform'; min: number; max: number }
  | { type: 'triangular'; min: number; mode: number; max: number }
  /** Truncated to [min, max] by resampling (at most 100 draws, then clamped). */
  | { type: 'normal'; mean: number; sd: number; min?: number; max?: number }
  /** `mean` and `sd` of the value itself (not of its logarithm). */
  | { type: 'lognormal'; mean: number; sd: number }
  | { type: 'exponential'; mean: number }
  /** One of the values, with probability proportional to its weight. */
  | { type: 'empirical'; values: { value: number; weight: number }[] };
export type FactoryDistributionType = FactoryDistribution['type'];
export const factoryDistributionTypes: readonly FactoryDistributionType[] = Object.freeze([
  'const',
  'uniform',
  'triangular',
  'normal',
  'lognormal',
  'exponential',
  'empirical',
]);

export interface FactoryProduct {
  id: string;
  name: string;
}

/** Which successor a finished part goes to when an object has several outgoing links. */
export type FactoryExitStrategy =
  /** Links in document order, starting after the last one used (round robin, skipping full ones). */
  | 'cyclic'
  /** The first link in document order whose target accepts the part. */
  | 'first-free'
  /** The accepting target holding the fewest parts (ties: document order). */
  | 'least-busy';
export const factoryExitStrategies: readonly FactoryExitStrategy[] = Object.freeze([
  'cyclic',
  'first-free',
  'least-busy',
]);

/**
 * FT2: where the object stands on the floor plan, in mm (x east, y north, seen from above), and
 * its turn in degrees anticlockwise. The same coordinates place it in 3D (FT4). Without it the
 * Surface lays the object out by its links.
 */
export interface FactoryPlacement {
  x: number;
  y: number;
  angle?: number;
}

/**
 * FT4: the box an object takes on the floor, in mm: `widthMm` along its own x (turned by
 * `at.angle`), `depthMm` across, `heightMm` up from the floor, centred on `at`. Without it the
 * object has the size of its kind (`factoryObjectSize`).
 */
export interface FactorySize {
  widthMm: number;
  depthMm: number;
  heightMm: number;
}

interface ObjectBase {
  id: string;
  name: string;
  /**
   * FT3: the shift calendar (by ID) the object works to. Only sources, stations, parallel
   * stations and assemblies have one; without it they work around the clock.
   */
  calendarId?: string;
  /** FT3c: the node of the path network where vehicles load and unload at this object. */
  pathNodeId?: string;
  /** Default `first-free`. Only objects with outgoing links use it. */
  exit?: FactoryExitStrategy;
  at?: FactoryPlacement;
  /** FT4. */
  size?: FactorySize;
  /**
   * FT4c: a saved CAD part version that gives the object its look in 3D, fixed by version and
   * content hash (only looked at, never changed). The Host keeps its content beside the record.
   */
  look?: FactoryLookRef;
}

/** FT4c: a saved version of a CAD Artifact (part or assembly). */
export interface FactoryLookRef {
  artifactId: string;
  versionId: string;
  contentHash: string;
}

/** A processing time for one product type, overriding the object's default. */
export interface FactoryProductTime {
  productId: string;
  time: FactoryDistribution;
}

/**
 * FT3: breakdowns of a processing object, each place on its own. The time to the next failure
 * is drawn from `uptime` and counted in `operating` time (setting up and processing) by default,
 * or in `calendar` time (wall-clock, so a place can fail while idle). Repair takes `repair`;
 * a failed place neither takes nor hands on parts and its processing waits.
 */
export interface FactoryFailures {
  uptime: FactoryDistribution;
  repair: FactoryDistribution;
  basis?: 'operating' | 'calendar';
}

/**
 * FT3: a setup when a place takes a part of another product than its last one (the first part
 * of a run needs none). `productTimes` overrides the time by the product set up for.
 */
export interface FactorySetup {
  time: FactoryDistribution;
  productTimes?: FactoryProductTime[];
}

/**
 * FT3b: the workers a place needs while it sets up and processes a part: `count` of them, each
 * from a pool that has `skill` (any pool without it). They walk from where they are to the
 * object (its `at`, or 0,0 without one) and are free again when the part is processed.
 */
export interface FactoryWorkerNeed {
  count: number;
  skill?: string;
}

/** Breakdowns, setups and workers of stations, parallel stations and assemblies. */
interface ProcessBase extends ObjectBase {
  failures?: FactoryFailures;
  setup?: FactorySetup;
  workers?: FactoryWorkerNeed;
}

/**
 * Creates parts. The next part is created `interval` after the previous one left the source
 * (a blocked source creates nothing); the first one at `startMs` (default 0).
 */
export interface FactorySource extends ObjectBase {
  kind: 'source';
  interval: FactoryDistribution;
  /** One entry: always that product. Several: drawn by weight. */
  mix: { productId: string; weight: number }[];
  /** Stops after this many parts. */
  limit?: number;
  startMs?: number;
}

/** One part at a time: takes it in, processes it, hands it on (blocked while it cannot). */
export interface FactoryStation extends ProcessBase {
  kind: 'station';
  processTime: FactoryDistribution;
  productTimes?: FactoryProductTime[];
}

/** `count` identical places, each like a station (a cell of identical machines). */
export interface FactoryParallel extends ProcessBase {
  kind: 'parallel';
  count: number;
  processTime: FactoryDistribution;
  productTimes?: FactoryProductTime[];
}

/**
 * Joins components to a main part. It holds one main part (`mainProductId`) and up to the
 * needed number of each component; processing starts when all are there. The components are
 * consumed; the main part leaves, renamed to `outputProductId` when given.
 */
export interface FactoryAssembly extends ProcessBase {
  kind: 'assembly';
  mainProductId: string;
  components: { productId: string; count: number }[];
  processTime: FactoryDistribution;
  outputProductId?: string;
}

/** Holds up to `capacity` parts without processing them. */
export interface FactoryBuffer extends ObjectBase {
  kind: 'buffer';
  capacity: number;
  /** Default `fifo`. */
  order?: 'fifo' | 'lifo';
}

/**
 * Carries parts `lengthMm` at `speedMmS`, `partLengthMm` apart (capacity
 * ⌊length ÷ part length⌋). An accumulating conveyor lets parts queue up behind a blocked head;
 * a non-accumulating one stops as a whole while its head part cannot leave.
 */
export interface FactoryConveyor extends ObjectBase {
  kind: 'conveyor';
  lengthMm: number;
  speedMmS: number;
  partLengthMm: number;
  accumulating: boolean;
}

/** Takes every part out of the model and records its lead time. */
export interface FactoryDrain extends ObjectBase {
  kind: 'drain';
}

export type FactoryObject =
  | FactorySource
  | FactoryStation
  | FactoryParallel
  | FactoryAssembly
  | FactoryBuffer
  | FactoryConveyor
  | FactoryDrain;
export type FactoryObjectKind = FactoryObject['kind'];
export const factoryObjectKinds: readonly FactoryObjectKind[] = Object.freeze([
  'source',
  'station',
  'parallel',
  'assembly',
  'buffer',
  'conveyor',
  'drain',
]);

/**
 * Parts move from `from` to `to`; with `productIds`, only parts of those types. FT3c: with
 * `transport`, a vehicle of the fleet carries each part (one at a time) along the path network
 * from `from`'s path node to `to`'s; the part waits at `from` until a vehicle has come.
 */
export interface FactoryLink {
  id: string;
  from: string;
  to: string;
  productIds?: string[];
  transport?: { fleetId: string };
}

/**
 * FT3c: the floor's path network for vehicles: points in mm and straight segments between them,
 * one way (`from` to `to`) unless `twoWay`. Only one vehicle may be on a segment at a time; a
 * vehicle keeps its segment until it has entered the next, so vehicles queue and can lock each
 * other (a deadlock, which stops the run and is reported).
 */
export interface FactoryPaths {
  nodes: { id: string; x: number; y: number }[];
  segments: { id: string; from: string; to: string; twoWay?: boolean }[];
}

/**
 * FT3c: `count` vehicles (AGVs) parked at `homeNodeId` at the start. Calls are served in order
 * by the nearest free vehicle (by path length). With `battery`, a vehicle drives `capacityMs` on
 * a full charge; when it is idle below `rechargeBelow` (0–1) it drives to `chargerNodeId` and
 * charges, the whole battery taking `chargeMs`.
 */
export interface FactoryFleet {
  id: string;
  name: string;
  count: number;
  speedMmS: number;
  loadMs: number;
  unloadMs: number;
  homeNodeId: string;
  /** FT4: the width of the lane a vehicle needs, centred on the segment. Default 1000 mm. */
  widthMm?: number;
  battery?: {
    capacityMs: number;
    chargeMs: number;
    chargerNodeId: string;
    rechargeBelow: number;
  };
}

/**
 * FT3: working time that repeats every `cycleMs` (a day: 86,400,000; a week: 604,800,000), as
 * shifts `[startMs, endMs)` from the start of the cycle, in order and not overlapping. The run
 * starts at the start of a cycle. Outside its shifts an object takes, processes and hands on
 * nothing (a part being processed waits), and a source creates nothing.
 */
export interface FactoryCalendar {
  id: string;
  name: string;
  cycleMs: number;
  shifts: { name: string; startMs: number; endMs: number }[];
}

/**
 * FT3b: `count` interchangeable workers with the same skills. They start at `home` (default
 * 0,0) and walk in straight lines at `walkSpeedMmS`. Requests are served in the order they were
 * made; one that cannot be met yet does not hold back a later one that can.
 */
export interface FactoryWorkerPool {
  id: string;
  name: string;
  count: number;
  skills: string[];
  walkSpeedMmS: number;
  home?: { x: number; y: number };
}

/**
 * FT6 (virtual commissioning, FT-U6): what an object reports to the PLC, as a BOOL input of
 * the program. Read at every scan, after every event at that instant.
 * - `occupied`: holds at least one part.
 * - `ready`: a part would leave now if the object's release were on and a successor took it
 *   (a conveyor's head part at the end; a finished part of a station).
 * - `blocked`: a ready part cannot leave because no successor takes it (a jam).
 * - `full`: takes no more parts (every place busy, or a buffer or conveyor at capacity).
 * - `failed`: a place is broken down.
 */
export type FactorySensorSignal = 'occupied' | 'ready' | 'blocked' | 'full' | 'failed';
export const factorySensorSignals: readonly FactorySensorSignal[] = Object.freeze([
  'occupied',
  'ready',
  'blocked',
  'full',
  'failed',
]);
/**
 * FT6: what a BOOL output of the program does to an object while it is off (all are on while
 * the output is on).
 * - `run`: a conveyor's motor; off, the belt stands and nothing on it moves.
 * - `release`: off, no part leaves the object (it is `held`).
 * - `admit`: off, the object takes no part (its feeders are blocked).
 */
export type FactoryActuatorSignal = 'run' | 'release' | 'admit';
export const factoryActuatorSignals: readonly FactoryActuatorSignal[] = Object.freeze([
  'run',
  'release',
  'admit',
]);

/** FT6: one BOOL variable of the program wired to an object's sensor or actuator. */
export interface FactorySensor {
  id: string;
  objectId: string;
  signal: FactorySensorSignal;
  /** An `input` BOOL variable of the program. */
  variable: string;
}
export interface FactoryActuator {
  id: string;
  objectId: string;
  signal: FactoryActuatorSignal;
  /** An `output` BOOL variable of the program. */
  variable: string;
}

/**
 * FT6: the PLC that controls the line: a ladder program (`ladder-core` schema 1) scanned every
 * `program.scanMs` of simulated time, from 0. A scan reads the sensors, runs the program and
 * sets the actuators; between scans only the flow's events happen, so the actuators keep their
 * values. Before the first scan they take the outputs' initial values. Only BOOL variables are
 * wired. `stallMs` (default 60 s): an object held by the PLC for at least this long at the end
 * of the run is reported as a stall.
 */
export interface FactoryControl {
  program: LadderDocument;
  sensors: FactorySensor[];
  actuators: FactoryActuator[];
  stallMs?: number;
}

/** The default run of the model. */
export interface FactoryRunSettings {
  /** Simulated time after the warm-up. */
  durationMs: number;
  /** Simulated before the statistics start (they are reset at its end). Default 0. */
  warmupMs?: number;
  /** Unsigned 32-bit seed. The same document and seed give the same result. */
  seed: number;
}

/**
 * FT4: a saved version of a Building Artifact the factory stands in, fixed by version and content
 * hash (FT-U: the building is only looked at, never changed). The Host keeps that version's
 * content beside the record.
 */
export interface FactoryBuildingRef {
  artifactId: string;
  versionId: string;
  contentHash: string;
}

/**
 * FT5: what a factor of an experiment changes, by the ID of the object, fleet or worker pool:
 * - `buffer-capacity`: a buffer's capacity (parts).
 * - `parallel-count`: the number of places of a parallel station.
 * - `fleet-count`: the number of vehicles of a fleet.
 * - `pool-count`: the number of workers of a pool.
 * - `time-scale`: the processing times (default and per product, not setups) of a station,
 *   parallel station or assembly, in percent of the model's times (100 = unchanged).
 */
export type FactoryFactorKind =
  | 'buffer-capacity'
  | 'parallel-count'
  | 'fleet-count'
  | 'pool-count'
  | 'time-scale';
export const factoryFactorKinds: readonly FactoryFactorKind[] = Object.freeze([
  'buffer-capacity',
  'parallel-count',
  'fleet-count',
  'pool-count',
  'time-scale',
]);

/** FT5: one parameter of an experiment and the values it takes (whole numbers, each once). */
export interface FactoryFactor {
  kind: FactoryFactorKind;
  targetId: string;
  values: number[];
}

/**
 * FT5: every combination of the factors' values (all of them: a full table) is run
 * `replications` times with the seeds `run.seed`, `run.seed + 1`, … (the same seeds for every
 * combination, so they are compared on the same random numbers), with the model's run settings.
 * Without factors the model itself is repeated.
 */
export interface FactoryExperiment {
  replications: number;
  factors: FactoryFactor[];
}

export interface FactoryDocument {
  schemaVersion: typeof FACTORY_SCHEMA;
  name: string;
  products: FactoryProduct[];
  objects: FactoryObject[];
  links: FactoryLink[];
  /** FT3. */
  calendars?: FactoryCalendar[];
  workerPools?: FactoryWorkerPool[];
  paths?: FactoryPaths;
  fleets?: FactoryFleet[];
  /** FT4. */
  building?: FactoryBuildingRef;
  /** FT6. */
  control?: FactoryControl;
  run: FactoryRunSettings;
  /** FT5: the experiment run on demand (repeated runs over a table of parameter values). */
  experiment?: FactoryExperiment;
  /** IDs removed before (products, objects, links); never reused. */
  retiredIds?: string[];
}

export interface FactoryDiagnostic {
  code: string;
  /** JSON path, such as `$.objects.2.processTime.mean`. */
  path: string;
  message: string;
}

/** Initial safety limits (not performance promises). */
export const factoryLimits = Object.freeze({
  products: 50,
  objects: 500,
  links: 2000,
  productTimes: 50,
  mix: 50,
  components: 20,
  componentCount: 100,
  empiricalValues: 1000,
  parallelCount: 100,
  bufferCapacity: 100_000,
  /** One year. */
  maxTimeMs: 31_536_000_000,
  maxLengthMm: 10_000_000,
  maxSpeedMmS: 100_000,
  /**
   * One simulation run stops with `event-limit` after this many events. #17: a year of a busy
   * line takes hundreds of millions; such a run is handled in slices (`startFactoryRun`).
   */
  events: 1_000_000_000,
  calendars: 20,
  workerPools: 50,
  pathNodes: 2000,
  pathSegments: 4000,
  fleets: 20,
  vehiclesPerFleet: 200,
  workersPerPool: 1000,
  skills: 20,
  shifts: 50,
  /** FT6: wired signals of each kind, and scans in one run. */
  signals: 500,
  scans: 5_000_000,
  /** FT5: initial safety limits of an experiment. */
  replications: 100,
  experimentCombinations: 200,
  experimentFactors: 5,
  factorValues: 20,
  timeScalePercent: 1000,
  idCodePoints: 128,
  nameCodePoints: 256,
  retiredIds: 10_000,
  /** FT6: deep enough for a ladder program at its own nesting limit (16) under `control`. */
  jsonDepth: 40,
});

export class FactoryValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly diagnostics: FactoryDiagnostic[] = [],
  ) {
    super(message);
    this.name = 'FactoryValidationError';
  }
}

/** An empty model: one product type, no objects, an 8-hour run with seed 1. */
export function newFactory(name: string): FactoryDocument {
  return {
    schemaVersion: FACTORY_SCHEMA,
    name,
    products: [{ id: 'part', name: 'Part' }],
    objects: [],
    links: [],
    run: { durationMs: 8 * 3_600_000, seed: 1 },
  };
}
