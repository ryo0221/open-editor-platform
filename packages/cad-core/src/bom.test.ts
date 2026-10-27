import { describe, expect, it } from 'vitest';
import { applyCadOperation, cadContentHash } from './operations';
import { validateCad } from './validation';
import { bomCsv, bomRows, csvCell } from './bom';
import { fixtureComponent, fixturePart, fixtureVersion } from './assembly-fixtures';
import { r2bBom } from './bom-fixtures';

const pick = (rows: ReturnType<typeof bomRows>) =>
  rows.map((r) => [r.item, r.kind, r.name, r.quantity, r.reference?.versionId ?? '']);

describe('BOM (R2b-3, CAD49)', () => {
  const f = r2bBom();
  const lookup = (h: string) => f.closure.get(h);
  const body = f.assembly.bodies.find((b) => b.state === 'active')!.name;

  it('counts each version once in the flat table, nested parts multiplied, the jig left out', () => {
    const rows = bomRows(f.assembly, lookup, 'flat');
    // The wheel only places parts: its hub and bolts are counted, four times over. The ring's
    // 8 and the row's 6 bolts count with their seeds.
    expect(pick(rows)).toEqual([
      ['1', 'body', body, 1, ''],
      ['2', 'part', 'Plate', 1 + 4, 'v1'],
      ['3', 'part', 'Plate', 1, 'v2'],
      ['4', 'part', 'Bolt "M8", long', 4 * 2 + 2 + 8 + 6, 'v1'],
    ]);
    expect(rows[1]).toMatchObject({ partNumber: 'PL-100', description: 'Base plate' });
    expect(rows[2]).toMatchObject({ partNumber: 'PL-100', description: 'Base plate, rev B' });
    expect(rows[0]).toMatchObject({ partNumber: '', description: '' });
  });

  it('lists each assembly’s own components under it in the hierarchical table', () => {
    const rows = bomRows(f.assembly, lookup, 'hierarchical');
    expect(pick(rows)).toEqual([
      ['1', 'body', body, 1, ''],
      ['2', 'part', 'Plate', 1, 'v1'],
      ['3', 'part', 'Plate', 1, 'v2'],
      ['4', 'assembly', 'Wheel', 4, 'v1'],
      ['4.1', 'part', 'Hub', 1, 'v1'],
      ['4.2', 'part', 'Bolt "M8", long', 2, 'v1'],
      ['5', 'part', 'Bolt "M8", long', 2 + 8 + 6, 'v1'],
    ]);
    expect(rows.map((r) => r.level)).toEqual([0, 0, 0, 0, 1, 1, 0]);
    expect(rows[3]).toMatchObject({ partNumber: 'W-1', description: 'Wheel' });
  });

  it('counts a component again once it is included, as one edit that keeps the shapes', () => {
    const doc = applyCadOperation(f.assembly, {
      type: 'setComponentBom',
      componentId: 'c-jig',
      bom: 'include',
    });
    expect(validateCad(doc)).toEqual([]);
    expect(bomRows(doc, lookup, 'flat')[1]!.quantity).toBe(6);
    expect(() =>
      applyCadOperation(doc, { type: 'setComponentBom', componentId: 'c-jig', bom: 'include' }),
    ).toThrow('component-bom-unchanged');
    expect(() =>
      applyCadOperation(doc, { type: 'setComponentBom', componentId: 'nope', bom: 'exclude' }),
    ).toThrow('target-missing');
    // Leaving out the wheels leaves out what they place.
    let out = doc;
    for (const id of ['c-wheel-1', 'c-wheel-2', 'c-wheel-3', 'c-wheel-4'])
      out = applyCadOperation(out, { type: 'setComponentBom', componentId: id, bom: 'exclude' });
    expect(pick(bomRows(out, lookup, 'flat')).map((r) => r[3])).toEqual([1, 2, 1, 16]);
  });

  it('shows a part it cannot read by its stored name only, and nothing inside it', () => {
    // The wheel's Artifact is revoked: its part number and parts are not shown.
    const rows = bomRows(f.assembly, lookup, 'hierarchical', (a) => a !== 'wheel');
    expect(rows.find((r) => r.name === 'Wheel')).toEqual({
      item: '4',
      level: 0,
      kind: 'part',
      partNumber: '',
      name: 'Wheel',
      description: '',
      quantity: 4,
      reference: { artifactId: 'wheel', versionId: 'v1' },
      unavailable: true,
    });
    expect(rows.some((r) => r.item === '4.1')).toBe(false);
    // In the flat table it is one row, and the bolts inside it are not counted.
    const flat = bomRows(f.assembly, lookup, 'flat', (a) => a !== 'wheel');
    expect(pick(flat).map((r) => [r[2], r[3]])).toEqual([
      [body, 1],
      ['Plate', 1],
      ['Plate', 1],
      ['Wheel', 4],
      ['Bolt "M8", long', 16],
    ]);
    // A version missing from the closure reads the same way.
    const missing = bomRows(
      f.assembly,
      (h) => (h === f.bolt.contentHash ? undefined : lookup(h)),
      'flat',
    );
    expect(missing.at(-1)).toMatchObject({
      name: 'Bolt "M8", long',
      unavailable: true,
      quantity: 24,
    });
  });

  it('keeps two Artifacts or versions with the same content as separate rows', () => {
    // Another Artifact saved with the plate's v1 content, and the plate's v3 unchanged from v2.
    const twin = fixtureVersion('plate-twin', 'v1', f.plate1.content);
    const v3 = fixtureVersion('plate', 'v3', f.plate2.content);
    expect(twin.contentHash).toBe(f.plate1.contentHash);
    const doc = applyCadOperation(f.assembly, {
      type: 'insertComponents',
      parts: [fixturePart('part-twin', 'Twin plate', twin), fixturePart('part-v3', 'Plate', v3)],
      components: [
        fixtureComponent('c-twin', 'part-twin', [0, 500, 0]),
        fixtureComponent('c-v3', 'part-v3', [0, 600, 0]),
      ],
    });
    const flat = bomRows(doc, lookup, 'flat');
    expect(pick(flat).slice(1)).toEqual([
      ['2', 'part', 'Plate', 5, 'v1'],
      ['3', 'part', 'Plate', 1, 'v2'],
      ['4', 'part', 'Bolt "M8", long', 24, 'v1'],
      ['5', 'part', 'Twin plate', 1, 'v1'],
      ['6', 'part', 'Plate', 1, 'v3'],
    ]);
    expect(flat[4]!.reference).toEqual({ artifactId: 'plate-twin', versionId: 'v1' });
    // Each Artifact's own access decides its row, whatever order the components are in.
    const revoked = bomRows(doc, lookup, 'hierarchical', (a) => a !== 'plate-twin');
    expect(revoked.find((r) => r.name === 'Twin plate')!.unavailable).toBe(true);
    expect(revoked.find((r) => r.item === '2')).toMatchObject({ partNumber: 'PL-100' });
  });

  it('writes RFC 4180 CSV with formulas made harmless, and never changes the content', () => {
    const hash = cadContentHash(f.assembly);
    const csv = bomCsv(bomRows(f.assembly, lookup, 'hierarchical'));
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('Item,Part number,Name,Description,Quantity,Artifact,Version');
    expect(lines).toContain(`4.2,'=B-M8,"Bolt ""M8"", long",'-M8 x 40,2,bolt,v1`);
    expect(lines).toContain('3,PL-100,Plate,"Base plate, rev B",1,plate,v2');
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(lines).toHaveLength(1 + 7 + 1);
    expect(cadContentHash(f.assembly)).toBe(hash);
    for (const [cell, out] of [
      ['=1+1', "'=1+1"],
      ['+1', "'+1"],
      ['@SUM(A1)', "'@SUM(A1)"],
      ['\tx', "'\tx"],
      ['\rx', `"'\rx"`],
      ['a\nb', '"a\nb"'],
      ['plain', 'plain'],
      ['', ''],
    ])
      expect(csvCell(cell!)).toBe(out);
  });
});
