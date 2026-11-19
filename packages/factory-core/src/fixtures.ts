import type { LadderDocument } from '@editor-platform/ladder-core';
import { newFactory, type FactoryDocument } from './model';

const s = (seconds: number) => seconds * 1000;

/**
 * F170 (FT1): a small e-Axle assembly line. Housings come in every 60 s and are machined in a
 * cell of two machines (100–130 s each); a buffer of 5 and a 6 m accumulating conveyor take them
 * to the assembly, where a gear set (from its own buffer) is fitted (50 ± 5 s). An end-of-line
 * test (lognormal, mean 55 s) checks each unit before it leaves. One hour of warm-up, then an
 * eight-hour shift. Seed 1.
 */
export function f170SmallLine(): FactoryDocument {
  const doc = newFactory('Small e-Axle line');
  doc.products = [
    { id: 'housing', name: 'Housing' },
    { id: 'gearset', name: 'Gear set' },
    { id: 'eaxle', name: 'e-Axle' },
  ];
  doc.objects = [
    {
      id: 'in-housing',
      name: 'Housing supply',
      kind: 'source',
      interval: { type: 'const', value: s(60) },
      mix: [{ productId: 'housing', weight: 1 }],
    },
    {
      id: 'machining',
      name: 'Machining cell',
      kind: 'parallel',
      count: 2,
      processTime: { type: 'triangular', min: s(100), mode: s(110), max: s(130) },
    },
    { id: 'buffer-1', name: 'Buffer', kind: 'buffer', capacity: 5 },
    {
      id: 'conveyor-1',
      name: 'Conveyor',
      kind: 'conveyor',
      lengthMm: 6000,
      speedMmS: 200,
      partLengthMm: 500,
      accumulating: true,
    },
    {
      id: 'in-gearset',
      name: 'Gear set supply',
      kind: 'source',
      interval: { type: 'const', value: s(60) },
      mix: [{ productId: 'gearset', weight: 1 }],
      startMs: s(30),
    },
    { id: 'buffer-gear', name: 'Gear set buffer', kind: 'buffer', capacity: 10 },
    {
      id: 'assembly',
      name: 'Assembly',
      kind: 'assembly',
      mainProductId: 'housing',
      components: [{ productId: 'gearset', count: 1 }],
      processTime: { type: 'normal', mean: s(50), sd: s(5) },
      outputProductId: 'eaxle',
    },
    {
      id: 'test',
      name: 'End-of-line test',
      kind: 'station',
      processTime: { type: 'lognormal', mean: s(55), sd: s(8) },
    },
    { id: 'out', name: 'Shipping', kind: 'drain' },
  ];
  const link = (from: string, to: string) => ({ id: `${from}>${to}`, from, to });
  doc.links = [
    link('in-housing', 'machining'),
    link('machining', 'buffer-1'),
    link('buffer-1', 'conveyor-1'),
    link('conveyor-1', 'assembly'),
    link('in-gearset', 'buffer-gear'),
    link('buffer-gear', 'assembly'),
    link('assembly', 'test'),
    link('test', 'out'),
  ];
  doc.run = { warmupMs: 3_600_000, durationMs: 8 * 3_600_000, seed: 1 };
  return doc;
}

/**
 * F172 (FT5): F170 pushed harder, with an experiment. Housings and gear sets come every 45 s, so
 * the machining cell (two machines) is the bottleneck. The experiment runs the cell with 2 or 3
 * machines, the end-of-line test at 80 or 100% of its time and the buffer before the conveyor
 * holding 1 or 5 parts; 10 seeds each (80 runs).
 */
export function f172SmallLineExperiment(): FactoryDocument {
  const doc = f170SmallLine();
  doc.name = 'Small e-Axle line experiment';
  for (const o of doc.objects)
    if (o.kind === 'source') o.interval = { type: 'const', value: s(45) };
  doc.experiment = {
    replications: 10,
    factors: [
      { kind: 'parallel-count', targetId: 'machining', values: [2, 3] },
      { kind: 'time-scale', targetId: 'test', values: [80, 100] },
      { kind: 'buffer-capacity', targetId: 'buffer-1', values: [1, 5] },
    ],
  };
  return doc;
}

/**
 * The ladder program of F174: the conveyor's motor stops while its head part waits at the end
 * and the inspection is busy (`C1_HOLD`, set and reset), and the stopper at its end lets a part
 * through only while the inspection is free. With `withReset` false the hold is never reset
 * (F175, a deliberate bug).
 */
function plcLineProgram(withReset: boolean): LadderDocument {
  const contact = (id: string, variable: string, kind: 'no' | 'nc' = 'no') => ({
    id,
    kind: 'contact' as const,
    variable,
    contact: kind,
  });
  return {
    schemaVersion: 1,
    name: withReset ? 'Transfer conveyor' : 'Transfer conveyor (no reset)',
    scanMs: 100,
    variables: [
      { name: 'C1_AT_END', type: 'BOOL', role: 'input', comment: 'Part at the conveyor end' },
      { name: 'ST2_BUSY', type: 'BOOL', role: 'input', comment: 'Inspection holds a part' },
      { name: 'C1_HOLD', type: 'BOOL', role: 'internal', comment: 'Conveyor stopped for a jam' },
      { name: 'C1_RUN', type: 'BOOL', role: 'output', initial: true, comment: 'Conveyor motor' },
      { name: 'C1_GATE', type: 'BOOL', role: 'output', comment: 'Stopper at the conveyor end' },
    ],
    rungs: [
      {
        id: 'r1',
        comment: 'A part waits at the end and the inspection is busy: hold the conveyor.',
        network: {
          id: 'r1n',
          kind: 'series',
          items: [contact('r1a', 'C1_AT_END'), contact('r1b', 'ST2_BUSY')],
        },
        coils: [{ id: 'r1c', variable: 'C1_HOLD', coil: 'set' }],
      },
      ...(withReset
        ? [
            {
              id: 'r2',
              comment: 'The inspection is free again: release the hold.',
              network: contact('r2a', 'ST2_BUSY', 'nc'),
              coils: [{ id: 'r2c', variable: 'C1_HOLD', coil: 'reset' as const }],
            },
          ]
        : []),
      {
        id: 'r3',
        comment: 'The motor runs unless held.',
        network: contact('r3a', 'C1_HOLD', 'nc'),
        coils: [{ id: 'r3c', variable: 'C1_RUN', coil: 'normal' }],
      },
      {
        id: 'r4',
        comment: 'Open the stopper for a part at the end while the inspection is free.',
        network: {
          id: 'r4n',
          kind: 'series',
          items: [contact('r4a', 'C1_AT_END'), contact('r4b', 'ST2_BUSY', 'nc')],
        },
        coils: [{ id: 'r4c', variable: 'C1_GATE', coil: 'normal' }],
      },
    ],
  };
}

/**
 * F174 (FT6): a PLC-controlled transfer. Housings every 40 s are pressed (30 s), carried on a
 * 4 m accumulating conveyor (200 mm/s) to an inspection (uniform 30–45 s) and shipped. A ladder
 * program scanned every 100 ms runs the conveyor's motor and the stopper at its end from two
 * sensors (part at the end, inspection busy). Eight hours, seed 1.
 */
export function f174PlcLine(): FactoryDocument {
  const doc = newFactory('PLC transfer line');
  doc.products = [{ id: 'housing', name: 'Housing' }];
  doc.objects = [
    {
      id: 'in',
      name: 'Housing supply',
      kind: 'source',
      interval: { type: 'const', value: s(40) },
      mix: [{ productId: 'housing', weight: 1 }],
    },
    { id: 'press', name: 'Press', kind: 'station', processTime: { type: 'const', value: s(30) } },
    {
      id: 'c1',
      name: 'Transfer conveyor',
      kind: 'conveyor',
      lengthMm: 4000,
      speedMmS: 200,
      partLengthMm: 500,
      accumulating: true,
    },
    {
      id: 'inspect',
      name: 'Inspection',
      kind: 'station',
      processTime: { type: 'uniform', min: s(30), max: s(45) },
    },
    { id: 'out', name: 'Shipping', kind: 'drain' },
  ];
  const link = (from: string, to: string) => ({ id: `${from}>${to}`, from, to });
  doc.links = [
    link('in', 'press'),
    link('press', 'c1'),
    link('c1', 'inspect'),
    link('inspect', 'out'),
  ];
  doc.control = {
    program: plcLineProgram(true),
    sensors: [
      { id: 'sn-c1-end', objectId: 'c1', signal: 'ready', variable: 'C1_AT_END' },
      { id: 'sn-inspect-busy', objectId: 'inspect', signal: 'occupied', variable: 'ST2_BUSY' },
    ],
    actuators: [
      { id: 'ac-c1-run', objectId: 'c1', signal: 'run', variable: 'C1_RUN' },
      { id: 'ac-c1-gate', objectId: 'c1', signal: 'release', variable: 'C1_GATE' },
    ],
  };
  doc.run = { durationMs: 8 * 3_600_000, seed: 1 };
  return doc;
}

/** F175 (FT6): F174 with the hold never reset (a ladder bug): the flow stops at the first jam. */
export function f175PlcLineBug(): FactoryDocument {
  const doc = f174PlcLine();
  doc.name = 'PLC transfer line (bug)';
  doc.control!.program = plcLineProgram(false);
  return doc;
}
