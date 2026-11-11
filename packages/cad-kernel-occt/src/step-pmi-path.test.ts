import { readFileSync } from 'node:fs';
import { readP21 } from '@editor-platform/geometry-core';
import { describe, expect, it } from 'vitest';
import { readPmiText } from './step-pmi';
import { pmiPathItems } from './step-pmi-path';

const read = (name: string) => {
  const text = readFileSync(new URL(`../fixtures/f43/${name}`, import.meta.url), 'latin1');
  const file = readP21(new TextEncoder().encode(text), {
    bytes: 1 << 24,
    entities: 1 << 22,
    depth: 64,
  });
  return { file, texts: readPmiText(file).texts };
};

describe('PMI-5a items through assembly paths (F46, CAD86, TS-1434)', () => {
  it('reads each path to its instance and the leaf part faces it names', () => {
    const { file, texts } = read('pmi-path.step');
    const { items, occurrences, shapes, partDatums } = pmiPathItems(file, texts);
    const signature = (i: (typeof items)[number]) =>
      i.text.kind === 'datum' ? i.text.letter : i.text.signature;
    // In file order.
    expect(items.map(signature)).toEqual([
      'Flatness|0.03|||',
      'Flatness|0.04|||',
      'Location_LinearDistance|5|',
      'Flatness|0.05|||',
      'Parallelism|0.02|||A',
      'A',
    ]);
    expect(items.every((i) => !i.problem)).toBe(true);
    // The block's only instance (#818), the second plate (#470) and their top faces.
    const [block, plate, distance, composite, parallelism, datum] = items;
    expect(block!.ends).toEqual([[{ path: 868, occurrences: [818], items: [802] }]]);
    expect(plate!.ends).toEqual([[{ path: 871, occurrences: [470], items: [239] }]]);
    expect(distance!.ends).toEqual([
      [{ path: 871, occurrences: [470], items: [239] }],
      [{ path: 868, occurrences: [818], items: [802] }],
    ]);
    expect(composite!.ends).toEqual(block!.ends);
    // The block's datum A is on its path; the parallelism references the plate part's own A
    // (#822, not the block's #884), which is a part datum to copy onto the plate's instance.
    expect(datum!.text).toMatchObject({ kind: 'datum', entity: 884, letter: 'A' });
    expect(datum!.ends).toEqual(block!.ends);
    expect(parallelism!.ends).toEqual(plate!.ends);
    expect(parallelism!.text).toMatchObject({ datumEntities: [[822]] });
    expect(partDatums.map((d) => [d.text.entity, d.text.letter])).toEqual([[822, 'A']]);
    expect(occurrences.sort()).toEqual([470, 818]);
    expect(shapes.filter((s) => !partDatums[0]!.items.includes(s)).sort()).toEqual([239, 802]);
  });

  it('leaves the part-level PMI to the kernel reader', () => {
    const { file, texts } = read('pmi-assembly.step');
    expect(pmiPathItems(file, texts).items).toEqual([]);
  });
});
