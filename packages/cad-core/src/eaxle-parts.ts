/**
 * DW7c fixtures F131–F135 (docs/cad/drawing-editor.md, 動力系): the parts of a fictional
 * front e-Axle — a permanent-magnet motor (F131), a two-stage helical reducer of ratio 9
 * (F132), a bevel differential (F133), the drive shafts (F134) and the inverter (F135) — each
 * a part document of ordinary features, plus the bought parts (ball bearings, oil seals). Each
 * part is drawn about its own +Z axis from its origin; `eaxleLayout` holds where the assembly
 * (DW7d) puts them. Sizes are plausible for a ~100 kW unit, not any maker's.
 */
import { cadBuilder, type CadBuilder } from './builder';
import { fixtureKernel } from './fixtures';
import { helicalGear, spurGearRadii, type InvoluteGearSpec } from './gear';
import {
  ballBearing,
  bearingSeries02,
  oilSeal,
  revolveOutline,
  splineShaft,
} from './machine-elements';
import type { CadAppearance, CadDocument, CadKernelProfile } from './model';

type Kernel = Pick<CadKernelProfile, 'id' | 'buildHash'>;
type V3 = [number, number, number];
const deg = (d: number) => (d * Math.PI) / 180;

export interface EaxlePart {
  key: string;
  name: string;
  /** F131–F135: which unit it belongs to; bought parts are catalogue items. */
  unit: 'F131' | 'F132' | 'F133' | 'F134' | 'F135';
  bought?: boolean;
  content: CadDocument;
}

const look = {
  housing: { color: '#a7adb3', metalness: 0.6, roughness: 0.45 },
  core: { color: '#5d6670', metalness: 0.7, roughness: 0.4 },
  copper: { color: '#b8733a', metalness: 0.85, roughness: 0.35 },
  steel: { color: '#8d959c', metalness: 0.85, roughness: 0.35 },
  gear: { color: '#7f8a94', metalness: 0.9, roughness: 0.3 },
  rubber: { color: '#262626', metalness: 0, roughness: 0.85 },
  magnet: { color: '#3a3f45', metalness: 0.5, roughness: 0.5 },
  cover: { color: '#c4c9ce', metalness: 0.5, roughness: 0.5 },
} satisfies Record<string, Partial<CadAppearance>>;

/** The reducer's gears: normal module, teeth, hand (+ right) and face width. */
export const eaxleGears = Object.freeze({
  input: { module: 2, teeth: 17, helix: deg(20), faceWidth: 22 },
  counter: { module: 2, teeth: 51, helix: deg(-20), faceWidth: 20 },
  pinion: { module: 2.5, teeth: 19, helix: deg(-20), faceWidth: 30 },
  final: { module: 2.5, teeth: 57, helix: deg(20), faceWidth: 28 },
  /** The differential's straight bevels at 90°: side gears and pinions, profile-shifted. */
  side: { module: 3.5, teeth: 16, faceWidth: 10, profileShift: -0.35 },
  diffPinion: { module: 3.5, teeth: 10, faceWidth: 10, profileShift: 0.35 },
});

/** The transverse pitch radius of a reducer gear. */
export function eaxlePitchRadius(g: { module: number; teeth: number; helix: number }): number {
  const spec: InvoluteGearSpec = {
    module: g.module,
    teeth: g.teeth,
    pressureAngle: deg(20),
    profileShift: 0,
    addendum: 1,
    dedendum: 1.25,
    bore: 0,
  };
  return spurGearRadii(helicalGear(spec, g.helix)).pitch;
}

/** Where the assembly puts each axis (mm, the motor axis is the input axis): all along +X. */
export const eaxleLayout = (() => {
  const G = eaxleGears;
  const counterX = eaxlePitchRadius(G.input) + eaxlePitchRadius(G.counter);
  const outputX = counterX + eaxlePitchRadius(G.pinion) + eaxlePitchRadius(G.final);
  return Object.freeze({
    counterX,
    outputX,
    /** The ratio motor : wheels. */
    ratio: (G.counter.teeth / G.input.teeth) * (G.final.teeth / G.pinion.teeth),
    /** Reducer gear faces (z from the case's left face). */
    inputZ: 10,
    counterZ: 11,
    pinionZ: 40,
    finalZ: 41,
    /** The differential's centre on the output axis. */
    diffZ: 41,
  });
})();

/** A bevel gear's pitch cone angle for shafts at 90°. */
export function eaxleBevelCone(teeth: number, mating: number): number {
  return Math.atan(teeth / mating);
}

export function eaxleParts(kernel: Kernel = fixtureKernel): EaxlePart[] {
  const parts: EaxlePart[] = [];
  const part = (
    key: string,
    name: string,
    unit: EaxlePart['unit'],
    make: (b: CadBuilder) => void,
    bought?: boolean,
  ) => {
    const b = cadBuilder(kernel);
    make(b);
    parts.push({ key, name, unit, ...(bought && { bought }), content: b.build().document });
  };
  const G = eaxleGears;
  const L = eaxleLayout;

  // ---- F131 motor (axis +Z, the output end at −Z) ----
  // Housing: a cup, its rear wall holding the rear bearing, finned outside, with two feet.
  part('motor-housing', 'Motor housing', 'F131', (b) => {
    const cup = revolveOutline(
      b,
      'Motor housing',
      [
        [122, 0],
        [122, 235],
        [26, 235],
        [26, 230],
        [40, 230],
        [40, 210],
        [110, 210],
        [110, 0],
      ],
      [0, 0, 0],
      look.housing,
    );
    // Fins round all but the side the left drive shaft passes (−X here, +X in the e-Axle).
    const first = -(7 / 9) * Math.PI;
    const fin = b.box(
      'Fin',
      {
        size: [10, 4, 190],
        origin: [
          120 * Math.cos(first) + 2 * Math.sin(first),
          120 * Math.sin(first) - 2 * Math.cos(first),
          15,
        ],
        orientation: [0, 0, Math.sin(first / 2), Math.cos(first / 2)],
      },
      look.housing,
    );
    b.pattern(
      cup,
      fin,
      { type: 'circular', axisDirection: [0, 0, 1], count: 25, angle: -(2 * first) / 24 },
      'union',
      'Cooling fins',
    );
    const footA = b.box('Foot', { size: [180, 24, 40], origin: [-90, -142, 30] }, look.housing);
    const footB = b.box(
      'Foot rear',
      { size: [180, 24, 40], origin: [-90, -142, 160] },
      look.housing,
    );
    // The inverter's seat on top (+Y): a flat pad up to its fins (y 134 in the e-Axle).
    const pad = b.box(
      'Inverter pad',
      { size: [200, 16, 190], origin: [-100, 118, 22] },
      look.housing,
    );
    b.boolean(cup, [footA, footB, pad], 'union', 'Motor housing');
  });
  // Front cover: a plate with the front bearing's seat and the seal's bore.
  part('motor-cover', 'Motor front cover', 'F131', (b) => {
    revolveOutline(
      b,
      'Motor front cover',
      [
        [26, -5],
        [122, -5],
        [122, 0],
        [56, 0],
        [56, 20],
        [40, 20],
        [40, 0],
        [26, 0],
      ],
      [0, 0, 0],
      look.housing,
    );
  });
  // Stator: 48 open slots in a laminated ring, and the coil ends standing out of both faces.
  part('motor-stator', 'Stator', 'F131', (b) => {
    const ring = revolveOutline(
      b,
      'Stator core',
      [
        [70, 30],
        [110, 30],
        [110, 190],
        [70, 190],
      ],
      [0, 0, 0],
      look.core,
    );
    const slot = b.box('Slot', { size: [19, 5, 164], origin: [68, -2.5, 28] }, look.core);
    b.pattern(
      ring,
      slot,
      { type: 'circular', axisDirection: [0, 0, 1], count: 48, angle: (2 * Math.PI) / 48 },
      'cut',
      'Slots',
    );
    const end = (z0: number, z1: number, name: string) =>
      revolveOutline(
        b,
        name,
        [
          [74, z0 + 3],
          [77, z0],
          [85, z0],
          [88, z0 + 3],
          [88, z1 - 3],
          [85, z1],
          [77, z1],
          [74, z1 - 3],
        ],
        [0, 0, 0],
        look.copper,
      );
    end(12, 29, 'Coil end front');
    end(191, 208, 'Coil end rear');
  });
  // Rotor: the core with eight magnet pockets, shrunk on the shaft (one body), the output
  // spline at the shaft's front end.
  part('motor-rotor', 'Rotor and shaft', 'F131', (b) => {
    const core = revolveOutline(
      b,
      'Rotor core',
      [
        [30, 31],
        [69, 31],
        [69, 189],
        [30, 189],
      ],
      [0, 0, 0],
      look.core,
    );
    const pocket = b.box('Magnet pocket', { size: [6, 26, 158], origin: [56, -13, 31] }, look.core);
    b.pattern(
      core,
      pocket,
      { type: 'circular', axisDirection: [0, 0, 1], count: 8, angle: Math.PI / 4 },
      'cut',
      'Magnet pockets',
    );
    const shaft = revolveOutline(
      b,
      'Shaft',
      [
        [0, -50],
        [14, -50],
        [14, -15],
        [20, -15],
        [20, 25],
        [30.5, 25],
        [30.5, 195],
        [20, 195],
        [20, 235],
        [0, 235],
      ],
      [0, 0, 0],
      look.steel,
    );
    const spline = splineShaft(b, 'Output spline', {
      module: 1.25,
      teeth: 24,
      length: 32,
      origin: [0, 0, -48],
    });
    b.boolean(shaft, [core, spline], 'union', 'Rotor and shaft');
  });
  part('magnet', 'Rotor magnet', 'F131', (b) => {
    b.box('Rotor magnet', { size: [5.8, 25.8, 158], origin: [0, 0, 0] }, look.magnet);
  });

  // ---- F132 reducer ----
  const gear = (
    b: CadBuilder,
    name: string,
    g: { module: number; teeth: number; helix: number; faceWidth: number },
    z: number,
    bore = 0,
  ) =>
    b.spurGear(
      name,
      {
        module: g.module,
        teeth: g.teeth,
        faceWidth: g.faceWidth,
        pressureAngle: deg(20),
        helixAngle: g.helix,
        origin: [0, 0, z],
        ...(bore > 0 && { bore }),
      },
      look.gear,
    );
  const shaft = (b: CadBuilder, name: string, r: number, z0: number, z1: number) =>
    revolveOutline(
      b,
      name,
      [
        [0, z0],
        [r, z0],
        [r, z1],
        [0, z1],
      ],
      [0, 0, 0],
      look.steel,
    );
  part('input-gear', 'Input gear shaft', 'F132', (b) => {
    const s = shaft(b, 'Input shaft', 15, -30, 88);
    const g = gear(b, 'Input gear', G.input, L.inputZ);
    b.boolean(s, [g], 'union', 'Input gear shaft');
  });
  part('counter-gear', 'Counter gear shaft', 'F132', (b) => {
    const s = shaft(b, 'Counter shaft', 17.5, -6, 88);
    const g = gear(b, 'Counter gear', G.counter, L.counterZ);
    const p = gear(b, 'Final pinion', G.pinion, L.pinionZ);
    b.boolean(s, [g, p], 'union', 'Counter gear shaft');
  });
  part('final-gear', 'Final gear', 'F132', (b) => {
    gear(b, 'Final gear', G.final, L.finalZ, 104);
  });
  // The case in two halves split at z = 36, each a box hollowed out, with bosses for the
  // bearings of the three axes.
  const caseHalf = (
    b: CadBuilder,
    name: string,
    z0: number,
    z1: number,
    open: [number, number],
  ) => {
    const half = b.box(name, { size: [327, 204, z1 - z0], origin: [-52, -102, z0] }, look.housing);
    const outward = z0 === 0 ? -8 : z1;
    const seats: [number, number][] = [
      [0, bearingSeries02['6206']![1] / 2],
      [L.counterX, bearingSeries02['6207']![1] / 2],
      [L.outputX, bearingSeries02['6210']![1] / 2],
    ];
    const bosses = seats.map(([x, r], i) =>
      b.cylinder(
        `Boss ${i + 1}`,
        { radius: r + 9, height: 8, origin: [x, 0, outward] },
        look.housing,
      ),
    );
    b.boolean(half, bosses, 'union');
    const cavity = b.box(
      'Cavity',
      { size: [303, 180, open[1] - open[0]], origin: [-40, -90, open[0]] },
      look.housing,
    );
    const bores = seats.map(([x, r], i) =>
      b.cylinder(`Bore ${i + 1}`, { radius: r, height: z1 - z0 + 20, origin: [x, 0, z0 - 10] }),
    );
    b.boolean(half, [cavity, ...bores], 'cut', name);
  };
  part('case-left', 'Reducer case (motor side)', 'F132', (b) =>
    caseHalf(b, 'Reducer case (motor side)', 0, 36, [8, 37]),
  );
  part('case-right', 'Reducer case (cover side)', 'F132', (b) =>
    caseHalf(b, 'Reducer case (cover side)', 36, 82, [35, 70]),
  );

  // ---- F133 differential (part frame: the output axis is +Z, its centre at z = 0) ----
  const sideCone = eaxleBevelCone(G.side.teeth, G.diffPinion.teeth);
  const pinionCone = Math.PI / 2 - sideCone;
  part('diff-case', 'Differential case', 'F133', (b) => {
    const body = revolveOutline(
      b,
      'Differential case',
      [
        [20, -49],
        [25, -49],
        [25, -31],
        [50, -27],
        [72, -4],
        [72, 0],
        [52, 0],
        [52, 28],
        [25, 31],
        [25, 51],
        [20, 51],
      ],
      [0, 0, 0],
      look.housing,
    );
    const cavity = b.sphere('Gear cavity', { radius: 40, origin: [0, 0, 0] });
    const pin = b.cylinder('Pinion shaft hole', {
      radius: 6,
      height: 120,
      origin: [-60, 0, 0],
      orientation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
    });
    const window = b.box('Window', { size: [40, 60, 30], origin: [-20, -80, -15] });
    const window2 = b.box('Window 2', { size: [40, 60, 30], origin: [-20, 20, -15] });
    b.boolean(body, [cavity, pin, window, window2], 'cut', 'Differential case');
  });
  part('side-gear', 'Side gear', 'F133', (b) => {
    const g = b.spurGear(
      'Side gear',
      {
        module: G.side.module,
        teeth: G.side.teeth,
        faceWidth: G.side.faceWidth,
        pressureAngle: deg(20),
        profileShift: G.side.profileShift,
        coneAngle: sideCone,
      },
      look.gear,
    );
    const hub = revolveOutline(
      b,
      'Side gear hub',
      [
        [0, -14],
        [19.5, -14],
        [19.5, 0.5],
        [0, 0.5],
      ],
      [0, 0, 0],
      look.gear,
    );
    const bore = splineShaft(b, 'Side gear spline', {
      module: 1.25,
      teeth: 20,
      length: 40,
      origin: [0, 0, -20],
    });
    b.boolean(g, [hub], 'union');
    b.boolean(g, [bore], 'cut', 'Side gear');
  });
  part('diff-pinion', 'Differential pinion', 'F133', (b) => {
    b.spurGear(
      'Differential pinion',
      {
        module: G.diffPinion.module,
        teeth: G.diffPinion.teeth,
        faceWidth: G.diffPinion.faceWidth,
        pressureAngle: deg(20),
        profileShift: G.diffPinion.profileShift,
        coneAngle: pinionCone,
        bore: 12,
      },
      look.gear,
    );
  });
  part('pinion-shaft', 'Pinion shaft', 'F133', (b) => {
    shaft(b, 'Pinion shaft', 5.95, -51, 51);
  });

  // ---- F134 drive shaft: inboard tripod housing, bar, outboard bell, boots ----
  part('drive-shaft', 'Drive shaft', 'F134', (b) => {
    const inner = revolveOutline(
      b,
      'Inboard joint',
      [
        [0, -40],
        // Under the spline the core stays below its root (11.375), so the tooth spaces stay open.
        [11.2, -40],
        [11.2, -4],
        [12, -4],
        [12, 0],
        [34, 0],
        [40, 6],
        [40, 60],
        [32, 60],
        [32, 10],
        [0, 10],
      ],
      [0, 0, 0],
      look.steel,
    );
    const stub = splineShaft(b, 'Inboard spline', {
      module: 1.25,
      teeth: 20,
      length: 36,
      origin: [0, 0, -40],
    });
    b.boolean(inner, [stub], 'union', 'Inboard joint');
    shaft(b, 'Shaft bar', 12, 30, 480);
    revolveOutline(
      b,
      'Outboard joint',
      [
        [30, 470],
        [44, 470],
        [48, 490],
        [44, 520],
        [22, 540],
        [16, 540],
        [16, 600],
        [0, 600],
        [0, 515],
        [30, 500],
      ],
      [0, 0, 0],
      look.steel,
    );
    const boot = (z0: number, z1: number, r0: number, r1: number, name: string) => {
      const n = 5;
      const out: [number, number][] = [];
      for (let i = 0; i <= n * 2; i++) {
        const t = i / (n * 2);
        const r = r0 + (r1 - r0) * t + (i % 2 ? 6 : 0);
        out.push([r + 2, z0 + (z1 - z0) * t]);
      }
      const back = out.map(([r, z]) => [r - 2, z] as [number, number]).reverse();
      return revolveOutline(b, name, [...out, ...back], [0, 0, 0], look.rubber);
    };
    boot(62, 130, 40.5, 12.3, 'Inboard boot');
    boot(410, 468, 12.3, 30.5, 'Outboard boot');
  });

  // ---- F135 inverter: a finned box, its lid and three phase terminals ----
  part('inverter-case', 'Inverter case', 'F135', (b) => {
    const box = b.box(
      'Inverter case',
      { size: [260, 180, 80], origin: [-130, -90, 0] },
      look.housing,
    );
    const inner = b.box('Inverter cavity', { size: [244, 164, 75], origin: [-122, -82, 6] });
    b.boolean(box, [inner], 'cut');
    const fin = b.box(
      'Inverter fin',
      { size: [240, 3, 19], origin: [-120, -84, -18] },
      look.housing,
    );
    b.pattern(
      box,
      fin,
      { type: 'linear', direction: [0, 1, 0], count: 15, spacing: 12 },
      'union',
      'Inverter fins',
    );
    const ports = [-40, 0, 40].map((x, i) =>
      b.cylinder(
        `Terminal boss ${i + 1}`,
        {
          radius: 10,
          height: 14,
          origin: [x, 90 - 2, 40],
          orientation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2],
        },
        look.housing,
      ),
    );
    b.boolean(box, ports, 'union', 'Inverter case');
  });
  part('inverter-lid', 'Inverter lid', 'F135', (b) => {
    b.box('Inverter lid', { size: [260, 180, 6], origin: [-130, -90, 80] }, look.cover);
  });
  part('terminal', 'Phase terminal', 'F135', (b) => {
    const pin = shaft(b, 'Phase terminal', 5, 0, 30);
    const flange = b.cylinder(
      'Terminal flange',
      { radius: 8, height: 4, origin: [0, 0, 8] },
      look.copper,
    );
    b.boolean(pin, [flange], 'union', 'Phase terminal');
  });

  // ---- Bought parts ----
  for (const code of ['6206', '6207', '6208', '6210'])
    part(
      `bearing-${code}`,
      `Ball bearing ${code}`,
      code === '6208' ? 'F131' : 'F132',
      (b) => {
        ballBearing(b, `Ball bearing ${code}`, code);
      },
      true,
    );
  part(
    'seal-40',
    'Oil seal 40×52×5',
    'F131',
    (b) => oilSeal(b, 'Oil seal 40×52×5', { d: 40, D: 52, B: 5 }),
    true,
  );
  return parts;
}

export type { V3 as EaxleVec };
