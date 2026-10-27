import {
  applyBimOperation,
  f31BoxBuilding,
  validateBim,
  type BimDocument,
} from '@editor-platform/bim-core';
import { describe, expect, it } from 'vitest';
import { BimController } from './controller';
import { bimDrawingFileName, bimPngSize, bimSvgPaperMm } from './drawing-export';
import { draftPlanView, draftSectionView } from './drafting';
import { EditorSession } from '@editor-platform/editor-core';
import type { BimKernel } from './evaluate';

/** Views and drawing output without the kernel (R2c-5b). */
describe('bim views (R2c-5b)', () => {
  it('adds a plan of a level and a section on a line, named apart, as one edit each', () => {
    let doc: BimDocument = f31BoxBuilding();
    doc = applyBimOperation(doc, draftPlanView(doc, 'l-1f'));
    doc = applyBimOperation(doc, draftPlanView(doc, 'l-1f'));
    doc = applyBimOperation(doc, draftSectionView(doc, [5000, -1000], [5000, 9000]));
    expect(doc.views).toEqual([
      {
        id: 'v-1',
        kind: 'plan',
        name: '1F plan',
        level: 'l-1f',
        cutHeightMm: 1200,
        depthMm: 1200,
        scale: 100,
      },
      expect.objectContaining({ id: 'v-2', name: '1F plan 2' }),
      {
        id: 'v-3',
        kind: 'section',
        name: 'Section 1',
        line: [
          [5000, -1000],
          [5000, 9000],
        ],
        direction: 'left',
        depthMm: 20000,
        scale: 100,
      },
    ]);
    expect(() => draftSectionView(doc, [0, 0], [0.5, 0])).toThrow('section-too-short');
    expect(() => draftPlanView(doc, 'l-none')).toThrow('level-missing');
    // A section line without a direction is refused by validation too.
    const flat = structuredClone(doc);
    flat.views[2] = {
      ...flat.views[2]!,
      line: [
        [0, 0],
        [0, 0],
      ],
    } as BimDocument['views'][number];
    expect(validateBim(flat).map((d) => d.code)).toContain('view-line');
    // A plan follows its level: deleting the level names the plan.
    expect(() =>
      applyBimOperation(doc, { type: 'delete', ids: ['l-1f'], cascade: false }),
    ).toThrow();
  });

  it('draws through the controller without edit authority, once per content', async () => {
    let runs = 0;
    const kernel: BimKernel = {
      run: async (_g, requests) => (
        runs++,
        {
          status: 'ok',
          results: requests.map((r) => ({
            status: 'ok' as const,
            node: r.node,
            ...(r.section ? { section: [] } : {}),
            ...(r.projection
              ? { projection: { visible: new Float64Array(), hidden: new Float64Array() } }
              : {}),
          })),
        }
      ),
    };
    let doc: BimDocument = f31BoxBuilding();
    doc = applyBimOperation(doc, draftPlanView(doc, 'l-1f'));
    const c = new BimController({ session: new EditorSession(doc), kernel, canEdit: () => false });
    const r = await c.draw(doc.views[0]!);
    expect(r.status).toBe('ok');
    const after = runs;
    expect(await c.draw(doc.views[0]!)).toBe(r);
    expect(runs).toBe(after);
  });

  it('sizes the PNG from the paper and names files safely', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" width="254mm" height="127mm">';
    expect(bimSvgPaperMm(svg)).toEqual([254, 127]);
    // 150 dpi: 10 inches by 5.
    expect(bimPngSize([254, 127])).toEqual([1500, 750]);
    // A large sheet is scaled down to the largest side a canvas is given.
    expect(bimPngSize([4000, 1000])).toEqual([8192, 2048]);
    expect(bimDrawingFileName('A/B', 'Plan: 1F\u0001', 'svg')).toBe('A_B - Plan_ 1F_.svg');
  });
});
