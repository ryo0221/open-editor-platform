import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readBimIfcFile } from './ifc-import';

/** Reading an IFC file in a Host (R2c-6): what the user is shown before a building is made. */
describe('bim IFC import in hosts (R2c-6)', () => {
  it("asks before importing another program's file without follow relations, even with no loss", async () => {
    // F35's foreign file without what it cannot import: everything left imports, at fixed
    // heights and positions.
    const drop = new Set(['#114', '#116', '#117', '#118', '#230', '#231', '#320', '#800', '#810']);
    const text = readFileSync(
      new URL('../../bim-ifc/fixtures/f35-foreign.ifc', import.meta.url),
      'utf8',
    )
      .split('\n')
      .filter((l) => !drop.has(l.split('=')[0]!))
      .join('\n')
      .replace('(#113,#114)', '(#113)')
      .replace(',#230,', ',')
      .replace(',#800,#810,', ',')
      .replace(',#320)', ')');
    const file = new Blob([text]);
    const first = await readBimIfcFile(file);
    expect(first.status).toBe('needs-confirmation');
    expect(first.report).toMatchObject({ restored: 0, withoutFollow: 11, losses: [] });
    const done = await readBimIfcFile(file, { acceptLoss: true });
    expect(done.status).toBe('imported');
    expect(done.report).toEqual(first.report);
  });
});
