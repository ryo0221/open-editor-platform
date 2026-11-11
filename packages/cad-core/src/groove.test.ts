import { describe, expect, it } from 'vitest';
import { cr6dGroove } from './fixtures';
import { validateCad } from './validation';

const codes = (doc: unknown) => validateCad(doc).map((d) => `${d.code}@${d.path}`);

describe('groove and grid pattern (CR6d, TS-1598)', () => {
  it('accepts the fixtures and refuses a radius out of range or broken rows', () => {
    for (const kind of ['open', 'closed', 'missed', 'grid', 'hollow', 'overhang', 'steep', 'shaded', 'far', 'ring'] as const)
      expect(codes(cr6dGroove(kind))).toEqual([]);
    const at = (doc: ReturnType<typeof cr6dGroove>, id: string) =>
      doc.features.findIndex((f) => f.id === id);
    const wide = structuredClone(cr6dGroove('open'));
    const g = wide.features[at(wide, 'groove')]!;
    if (g.type !== 'groove') throw new Error('fixture');
    g.args.radius = { literalMm: 20 };
    expect(codes(wide)).toEqual([`groove-radius@$.features[${at(wide, 'groove')}].args.radius`]);
    const grid = structuredClone(cr6dGroove('grid'));
    const p = grid.features[at(grid, 'cuts')]!;
    if (p.type !== 'pattern' || p.args.layout.type !== 'linear') throw new Error('fixture');
    (p.args.layout as { rows: unknown }).rows = 3;
    expect(codes(grid)).toEqual([`pattern-rows@$.features[${at(grid, 'cuts')}].args.layout.rows`]);
  });
});
