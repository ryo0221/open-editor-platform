/**
 * F23 (docs/cad/r2b-assembly.md, R2b-4 規模): 300 kinds of part (the F11 bracket with its width
 * and height changed) placed 1,000 times, nested three deep. A module sub-assembly places 10
 * brackets in a row (30 modules hold every kind once); a bay places 6 modules; the assembly
 * places each of the 5 bays twice (600 brackets) and 400 brackets of its own, in a grid.
 */
import {
  fixtureComponent,
  fixturePart,
  fixtureVersion,
  type CadFixtureVersion,
} from './assembly-fixtures';
import { f11Bracket, fixtureKernel } from './fixtures';
import { emptyCad, type CadDocument, type CadKernelProfile } from './model';
import { applyCadOperation } from './operations';

/** F23's sizes: kinds, modules (10 kinds each), bays (6 modules each), own brackets. */
export const f23 = Object.freeze({ kinds: 300, modules: 30, bays: 5, own: 400, instances: 1_000 });

/** Kind `i`'s width and height (mm): 20 widths by 15 heights. */
export const f23Size = (i: number): [number, number] => [
  80 + (i % 20) * 5,
  60 + Math.floor(i / 20) * 4,
];

export function r2bScale(kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel) {
  const on = (doc: CadDocument): CadDocument => ({
    ...doc,
    kernelProfile: { ...doc.kernelProfile, ...kernel },
  });
  const brackets: CadFixtureVersion[] = [];
  for (let i = 0; i < f23.kinds; i++) {
    const doc = on(f11Bracket());
    const [w, h] = f23Size(i);
    doc.parameters = doc.parameters.map((p) =>
      p.id === 'W' || p.id === 'H' ? ({ ...p, value: p.id === 'W' ? w : h } as typeof p) : p,
    );
    brackets.push(fixtureVersion(`bracket-${i}`, 'v1', doc));
  }
  const bounds = (i: number): [[number, number, number], [number, number, number]] => {
    const [w, h] = f23Size(i);
    return [
      [0, 0, 0],
      [w, h, 10],
    ];
  };
  const modules = Array.from({ length: f23.modules }, (_, m) => {
    const kinds = Array.from({ length: 10 }, (_, k) => m * 10 + k);
    return fixtureVersion(
      `module-${m}`,
      'v1',
      applyCadOperation(emptyCad(kernel), {
        type: 'insertComponents',
        parts: kinds.map((i) => fixturePart(`p-${i}`, `Bracket ${i}`, brackets[i]!, bounds(i))),
        components: kinds.map((i, k) => fixtureComponent(`m-${k}`, `p-${i}`, [k * 160, 0, 0])),
      }),
    );
  });
  const moduleBounds: [[number, number, number], [number, number, number]] = [
    [0, 0, 0],
    [9 * 160 + 175, 116, 10],
  ];
  const bays = Array.from({ length: f23.bays }, (_, b) =>
    fixtureVersion(
      `bay-${b}`,
      'v1',
      applyCadOperation(emptyCad(kernel), {
        type: 'insertComponents',
        parts: Array.from({ length: 6 }, (_, k) =>
          fixturePart(`p-module-${k}`, `Module ${b * 6 + k}`, modules[b * 6 + k]!, moduleBounds),
        ),
        components: Array.from({ length: 6 }, (_, k) =>
          fixtureComponent(`b-${k}`, `p-module-${k}`, [0, k * 140, 0]),
        ),
      }),
    ),
  );
  const bayBounds: [[number, number, number], [number, number, number]] = [
    [0, 0, 0],
    [moduleBounds[1][0], 5 * 140 + 116, 10],
  ];
  // Own brackets in a 20 × 20 grid beside the bays, kinds 0–299 then 0–99 again.
  const own = Array.from({ length: f23.own }, (_, n) => n % f23.kinds);
  const assembly = applyCadOperation(on(emptyCad(kernel)), {
    type: 'insertComponents',
    parts: [
      ...bays.map((v, b) => fixturePart(`part-bay-${b}`, `Bay ${b}`, v, bayBounds)),
      ...brackets.map((v, i) => fixturePart(`part-bracket-${i}`, `Bracket ${i}`, v, bounds(i))),
    ],
    components: [
      ...bays.flatMap((_, b) =>
        [0, 1].map((twice) =>
          fixtureComponent(`c-bay-${b}-${twice}`, `part-bay-${b}`, [twice * 1800, b * 900, 0]),
        ),
      ),
      ...own.map((i, n) =>
        fixtureComponent(`c-bracket-${n}`, `part-bracket-${i}`, [
          (n % 20) * 200,
          -400 - Math.floor(n / 20) * 160,
          0,
        ]),
      ),
    ],
  });
  // Every version the assembly reaches, by content hash, as a Host's retained closure.
  const closure = new Map(
    [...brackets, ...modules, ...bays].map((v) => [v.contentHash, v.content] as const),
  );
  return { brackets, modules, bays, assembly, closure };
}
