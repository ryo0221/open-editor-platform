import { f37Office, type BimDocument } from '@editor-platform/bim-core';
import { newConstruction, type ConstructionDocument, type ConstructionTask } from './model';

/**
 * F85 (CS1): the F37 five-storey office built storey by storey. Site preparation, the ground
 * slab, then on each storey columns → beams → the slab above (the roof on the top storey) →
 * walls → doors and windows; walls of a storey start when the frame two storeys up is up. A
 * completion milestone closes it. Spaces are left out (they stand throughout).
 */
export function f85OfficeSchedule(bim: BimDocument = f37Office()): ConstructionDocument {
  const doc = newConstruction(
    'Office construction',
    { artifactId: 'bim-office', versionId: 'v1', contentHash: 'a'.repeat(64) },
    '2027-04-01',
  );
  doc.calendar.holidays = ['2027-04-29', '2027-05-03', '2027-05-04', '2027-05-05'];
  const ids = (test: (id: string, kind: string) => boolean) =>
    bim.elements.filter((e) => test(e.id, e.kind)).map((e) => e.id);
  const tasks: ConstructionTask[] = [];
  const add = (
    id: string,
    name: string,
    durationDays: number,
    after: (string | [string, number])[],
    elementIds: string[] = [],
  ) =>
    tasks.push({
      id,
      name,
      durationDays,
      predecessors: after.map((a) =>
        typeof a === 'string' ? { taskId: a, lagDays: 0 } : { taskId: a[0], lagDays: a[1] },
      ),
      action: 'construct',
      elementIds,
    });
  add('site', 'Site preparation', 5, []);
  add('ground', 'Ground slab', 10, ['site'], ['s-1f']);
  let below = 'ground';
  for (let s = 1; s <= 5; s++) {
    add(
      `col-${s}`,
      `Columns ${s}F`,
      6,
      [below],
      ids((id) => id.startsWith(`c-${s}-`)),
    );
    add(
      `beam-${s}`,
      `Beams ${s + 1 === 6 ? 'RF' : `${s + 1}F`}`,
      6,
      [`col-${s}`],
      ids((id) => id.startsWith(`b-${s + 1}-`)),
    );
    const top = s < 5 ? `slab-${s + 1}` : 'roof';
    add(
      top,
      s < 5 ? `Slab ${s + 1}F` : 'Roof',
      s < 5 ? 5 : 6,
      [`beam-${s}`],
      s < 5 ? [`s-${s + 1}`] : ['r-roof'],
    );
    below = top;
  }
  for (let s = 1; s <= 5; s++) {
    const frame = s + 1 <= 4 ? `slab-${s + 2}` : 'roof';
    const prev = s > 1 ? [`walls-${s - 1}`] : [];
    add(
      `walls-${s}`,
      `Walls ${s}F`,
      8,
      [frame, ...prev],
      ids((id, k) => k === 'wall' && id.endsWith(`-${s}`)),
    );
    add(
      `openings-${s}`,
      `Doors and windows ${s}F`,
      5,
      [[`walls-${s}`, 2]],
      ids(
        (id, k) =>
          (k === 'window' && id.startsWith('win-w-') && id.split('-')[3] === String(s)) ||
          (k === 'door' && id.startsWith(`d-${s}-`)),
      ),
    );
  }
  add('complete', 'Completion', 0, [
    'openings-5',
    'openings-4',
    'openings-3',
    'openings-2',
    'openings-1',
  ]);
  doc.tasks = tasks;
  return doc;
}

/**
 * F86 (CS2): F85 with its site. A 75 m × 60 m plot on ground falling 2 % to the west with a
 * gentle swell (5 m survey grid); the building's pit dug during site preparation to 1.5 m below
 * the ground floor (sides 1 : 0.5); a materials yard filled level; hoarding, gate and site office
 * from site preparation to completion, scaffolding from the first walls to the last openings.
 */
export function f86OfficeSite(bim: BimDocument = f37Office()): ConstructionDocument {
  const doc = f85OfficeSchedule(bim);
  const terrain: [number, number, number][] = [];
  for (let x = -20000; x <= 65000; x += 5000)
    for (let y = -20000; y <= 50000; y += 5000)
      terrain.push([
        x,
        y,
        Math.round(0.02 * x - 500 + 300 * Math.sin(x / 15000) * Math.cos(y / 12000)),
      ]);
  const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  doc.site = {
    boundary: rect(-15000, -15000, 60000, 45000),
    terrain,
    earthworks: [
      {
        id: 'pit',
        name: 'Building pit',
        kind: 'cut',
        outline: rect(-1000, -1000, 44200, 29800),
        levelZ: -1500,
        slope: 0.5,
        taskId: 'site',
      },
      {
        id: 'yard-fill',
        name: 'Yard platform',
        kind: 'fill',
        outline: rect(47000, 2000, 57000, 20000),
        levelZ: 900,
        slope: 1.5,
        taskId: 'site',
      },
    ],
    temporaries: [
      {
        id: 'hoarding',
        name: 'Hoarding',
        kind: 'hoarding',
        outline: rect(-14800, -14800, 59800, -14600),
        height: 3000,
        fromTaskId: 'site',
        untilTaskId: 'complete',
      },
      {
        id: 'gate',
        name: 'Gate',
        kind: 'gate',
        outline: rect(20000, -14900, 26000, -14500),
        height: 4000,
        fromTaskId: 'site',
        untilTaskId: 'complete',
      },
      {
        id: 'office',
        name: 'Site office',
        kind: 'office',
        outline: rect(48000, 30000, 57000, 36000),
        height: 5600,
        fromTaskId: 'site',
        untilTaskId: 'complete',
      },
      {
        id: 'yard',
        name: 'Materials yard',
        kind: 'yard',
        outline: rect(48000, 3000, 56000, 19000),
        height: 100,
        baseZ: 900,
        fromTaskId: 'ground',
        untilTaskId: 'roof',
      },
      {
        id: 'scaffold',
        name: 'Scaffolding',
        kind: 'scaffold',
        outline: rect(-1800, -1800, 45000, -800),
        height: 21500,
        fromTaskId: 'walls-1',
        untilTaskId: 'openings-5',
      },
    ],
  };
  return doc;
}

/**
 * F87 (CS3): the F37 office as precast concrete and steel with densities (concrete 2,400,
 * plaster 1,500, steel 7,850 kg/m³), for crane lifts.
 */
export function f87Building(bim: BimDocument = f37Office()): BimDocument {
  const doc = structuredClone(bim);
  const density: Record<string, number> = { concrete: 2400, finish: 1500, metal: 7850 };
  for (const m of doc.materials) {
    const d = density[m.category];
    if (d !== undefined) m.densityKgM3 = d;
  }
  return doc;
}

/**
 * F87 (CS3): F86 with a tower crane south of the building (jib 50 m at 30 m, 250 t·m: 10 t to
 * 25 m) standing from the ground slab to the roof, lifting every column and beam from the
 * materials yard.
 */
export function f87OfficeCranes(bim: BimDocument = f87Building()): ConstructionDocument {
  const doc = f86OfficeSite(bim);
  const site = doc.site!;
  site.cranes = [
    {
      id: 'tc-1',
      name: 'Tower crane 1',
      kind: 'tower',
      base: [21600, -6000],
      height: 30000,
      jibLength: 50000,
      minRadius: 3000,
      loadChart: [
        { radius: 25000, capacityKg: 10000 },
        { radius: 30000, capacityKg: 8300 },
        { radius: 35000, capacityKg: 7100 },
        { radius: 40000, capacityKg: 6250 },
        { radius: 45000, capacityKg: 5500 },
        { radius: 50000, capacityKg: 5000 },
      ],
      fromTaskId: 'ground',
      untilTaskId: 'roof',
    },
  ];
  site.lifts = doc.tasks
    .filter((t) => t.id.startsWith('col-') || t.id.startsWith('beam-'))
    .flatMap((t) =>
      t.elementIds.map((elementId) => ({
        id: `lift-${elementId}`,
        craneId: 'tc-1',
        taskId: t.id,
        elementId,
        pick: [52000, 11000, 1000] as [number, number, number],
      })),
    );
  return doc;
}

/** F88 (CS4): F87's building with stiffness: concrete 24,000 MPa (ν 0.2), metal 205,000 (ν 0.3). */
export function f88Building(bim: BimDocument = f37Office()): BimDocument {
  const doc = f87Building(bim);
  const stiffness: Record<string, [number, number]> = {
    concrete: [24000, 0.2],
    metal: [205000, 0.3],
  };
  for (const m of doc.materials) {
    const e = stiffness[m.category];
    if (e) [m.youngsModulusMPa, m.poissonsRatio] = e;
  }
  return doc;
}

/**
 * F88 (CS4): F87 with the tower crane's own mass (60 t with its counterweight) and a site load:
 * while the 4F slab is cast, its shoring and the stocked rebar lay 6 kN/m² on the 3F slab.
 */
export function f88OfficeFrame(bim: BimDocument = f88Building()): ConstructionDocument {
  const doc = f87OfficeCranes(bim);
  const site = doc.site!;
  site.cranes![0]!.massKg = 60000;
  site.loads = [
    {
      id: 'load-shoring-4',
      name: 'Shoring and rebar for 4F',
      taskId: 'slab-4',
      elementIds: doc.tasks.find((t) => t.id === 'slab-3')!.elementIds.slice(),
      kNm2: 6,
    },
  ];
  return doc;
}

/**
 * F89 (CS5): F88 with the site's traffic while the 1F columns go up: steel trucks from the gate
 * to the yard and back (10 km/h, three a day), site workers walking from the gate past the pit to
 * the office (4 km/h), and a rebar cutting area beside the truck way in the afternoons; the day
 * 07:30–17:30.
 */
export function f89OfficeTraffic(bim: BimDocument = f88Building()): ConstructionDocument {
  const doc = f88OfficeFrame(bim);
  const site = doc.site!;
  site.hours = { start: '07:30', end: '17:30' };
  site.routes = [
    {
      id: 'truck-steel',
      name: 'Steel delivery',
      kind: 'truck',
      path: [
        [23000, -14700],
        [23000, -10500],
        [52000, -10500],
        [52000, 2500],
      ],
      speedKmh: 10,
      taskId: 'col-1',
      departures: ['08:30', '10:30', '13:30'],
      returns: true,
    },
    {
      id: 'walk-office',
      name: 'Workers to the office',
      kind: 'worker',
      path: [
        [21000, -14700],
        [21000, -8000],
        [46000, -8000],
        [46000, 33000],
        [48000, 33000],
      ],
      speedKmh: 4,
      taskId: 'col-1',
      departures: ['07:40', '12:50'],
    },
  ];
  site.zones = [
    {
      id: 'rebar-cutting',
      name: 'Rebar cutting',
      outline: [
        [30000, -13000],
        [36000, -13000],
        [36000, -11500],
        [30000, -11500],
      ],
      taskId: 'col-1',
      hours: ['13:00', '15:00'],
    },
  ];
  return doc;
}
