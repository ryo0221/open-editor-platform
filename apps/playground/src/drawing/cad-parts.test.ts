import { describe, expect, it } from 'vitest';
import { bomRows, expandAssembly, r2bBom } from '@editor-platform/cad-core';
import { drawingPartRowOf } from '@editor-platform/drawing-core';
import { drawingCadParts } from './cad-bodies';

// DW4a (docs/cad/drawing-editor.md, 組立図): a kept version's flat BOM as the drawing's parts
// list, and the row every placed body counts in. ST-708, TS-2425.

describe('parts of a kept CAD version (DW4a)', () => {
  const f = r2bBom();
  const lookup = (h: string) => f.closure.get(h);

  it('lists the flat BOM as the CAD Surface does, and numbers each placement by its version', () => {
    const parts = drawingCadParts(f.assembly, lookup);
    const flat = bomRows(f.assembly, lookup, 'flat');
    expect(parts.rows.map((r) => [r.item, r.name, r.quantity, r.partNumber])).toEqual(
      flat.map((r) => [r.item, r.name, r.quantity, r.partNumber]),
    );
    // The own body is row 1.
    const own = f.assembly.bodies.find((b) => b.state === 'active')!;
    expect(drawingPartRowOf(parts, { path: [], bodyId: own.id })?.item).toBe('1');
    // Every placement counted in the BOM has the row of its exact version; the rows' quantities
    // are the placements counted.
    const expansion = expandAssembly(f.assembly, lookup);
    const counts = new Map<string, number>();
    for (const o of expansion.occurrences) {
      const row = drawingPartRowOf(parts, { path: o.path, bodyId: '' });
      if (row) counts.set(row.item, (counts.get(row.item) ?? 0) + 1);
    }
    for (const r of parts.rows.slice(1)) expect(counts.get(r.item)).toBe(r.quantity);
    // The jig plate (left out of the BOM) and the wheel (it only places parts) take no balloon.
    const unnumbered = expansion.occurrences.filter(
      (o) => !drawingPartRowOf(parts, { path: o.path, bodyId: '' }),
    );
    expect(unnumbered.map((o) => o.path.join('/')).filter((p) => !p.includes('/'))).toEqual(
      expect.arrayContaining(['c-jig']),
    );
    expect(new Set(unnumbered.map((o) => o.part.name))).toEqual(new Set(['Plate', 'Wheel']));
  });

  it('keeps two imported parts of one name apart (Codex on #1228)', () => {
    const asm = structuredClone(f.assembly);
    for (const p of asm.parts)
      if (p.id === 'part-plate-1' || p.id === 'part-plate-2')
        p.source = {
          kind: 'imported',
          contentHash: p.source.contentHash,
          sourceAssetId: 'step',
          brepAssetId: `brep-${p.id}`,
          stepProduct: { id: p.id, name: 'Plate', description: '' },
        };
    const parts = drawingCadParts(asm, lookup);
    const plates = parts.rows.filter((r) => r.name === 'Plate');
    expect(plates).toHaveLength(2);
    expect(new Set(plates.map((r) => r.key)).size).toBe(2);
    const one = drawingPartRowOf(parts, { path: ['c-plate-1'], bodyId: '' });
    const two = drawingPartRowOf(parts, { path: ['c-plate-2'], bodyId: '' });
    expect([one?.name, two?.name]).toEqual(['Plate', 'Plate']);
    expect(one?.item).not.toBe(two?.item);
  });
});
