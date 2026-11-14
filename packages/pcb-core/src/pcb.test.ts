import { describe, expect, it } from 'vitest';
import {
  applyPcbOperation,
  arcPolygon,
  f75Pi5Board,
  loopArea,
  loopBounds,
  pcbContentHash,
  pcbCopperLayerNames,
  pcbEditorCommand,
  pcbLayerNames,
  pcbStarter,
  roundedRectLoop,
  validatePcb,
  type PcbDocument,
  type PcbHole,
} from './index';

const codes = (v: unknown) => validatePcb(v).map((d) => d.code);
const hole = (id: string, at: [number, number], extra: Partial<PcbHole> = {}): PcbHole => ({
  id,
  name: id.toUpperCase(),
  at,
  drillMm: 3,
  plated: false,
  keepoutMm: 6,
  ...extra,
});
const withBoard = (doc: PcbDocument, board: Partial<PcbDocument['board']>): PcbDocument => ({
  ...doc,
  board: { ...doc.board, ...board },
});

describe('PB1 board model (ST-460, TS-1920)', () => {
  it('accepts the starter and F75, with exact arcs in area and bounds', () => {
    expect(validatePcb(pcbStarter())).toEqual([]);
    const f75 = f75Pi5Board();
    expect(validatePcb(f75)).toEqual([]);
    expect(loopBounds(f75.board.outline)).toEqual([0, 0, 85, 56]);
    // 85 × 56 less the four corner squares outside the R3 arcs.
    expect(loopArea(f75.board.outline)).toBeCloseTo(85 * 56 - (4 - Math.PI) * 9, 9);
    expect(f75.holes.map((h) => h.at)).toEqual([
      [3.5, 3.5],
      [61.5, 3.5],
      [61.5, 52.5],
      [3.5, 52.5],
    ]);
  });

  it('names the copper and other layers in stack order', () => {
    expect(pcbCopperLayerNames(2)).toEqual(['F.Cu', 'B.Cu']);
    expect(pcbCopperLayerNames(4)).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
    expect(pcbLayerNames(2)).toEqual([
      'F.SilkS',
      'F.Paste',
      'F.Mask',
      'F.Cu',
      'B.Cu',
      'B.Mask',
      'B.Paste',
      'B.SilkS',
      'Edge.Cuts',
    ]);
  });

  it('refuses malformed content by code and path', () => {
    const doc = pcbStarter();
    expect(codes({ ...doc, schemaVersion: 2 })).toEqual(['unsupported-schema']);
    expect(codes({ ...doc, extra: 1 })).toEqual(['unknown-key']);
    expect(codes({ ...doc, units: 'in' })).toEqual(['units']);
    expect(codes(withBoard(doc, { thicknessMm: 0.1 }))).toEqual(['dimension']);
    expect(codes(withBoard(doc, { copperLayers: 3 as never }))).toEqual(['enum']);
    expect(codes(withBoard(doc, { maskColor: 'pink' as never }))).toEqual(['enum']);
    expect(
      codes(
        withBoard(doc, {
          outline: [
            [0, 0],
            [10, 0],
          ],
        }),
      ),
    ).toEqual(['loop-vertices']);
    expect(
      codes(
        withBoard(doc, {
          outline: [
            [0, 0],
            [10, 0, 2],
            [10, 10],
          ],
        }),
      ),
    ).toEqual(['loop-bulge']);
    // A bulge so small its arc's radius overflows (5e-324) is refused, not drawn.
    expect(
      codes(
        withBoard(doc, {
          outline: [
            [0, 0, 5e-324],
            [40, 0],
            [40, 30],
            [0, 30],
          ],
        }),
      ),
    ).toEqual(['loop-bulge']);
    expect(
      arcPolygon(
        [
          [0, 0, 5e-324],
          [40, 0],
          [40, 30],
          [0, 30],
        ],
        'within',
      ),
    ).toHaveLength(4);
    expect(
      codes(
        withBoard(doc, {
          outline: [
            [0, 0],
            [10, 0],
            [10, 0],
            [0, 10],
          ],
        }),
      ),
    ).toEqual(['loop-duplicate-vertex']);
    // A bow tie crosses itself.
    expect(
      codes(
        withBoard(doc, {
          outline: [
            [0, 0],
            [10, 10],
            [10, 0],
            [0, 10],
          ],
        }),
      ),
    ).toEqual(['loop-not-simple']);
    expect(codes(withBoard(doc, { outline: roundedRectLoop([0, 0], 1200, 10, 0) }))).toEqual([
      'limit-board-size',
    ]);
    expect(codes({ ...doc, holes: [{ ...hole('a', [10, 10]), at: [10, Infinity] }] })).toEqual([
      'number',
    ]);
    expect(validatePcb({ ...doc, holes: [hole('a', [10, 10]), hole('a', [30, 30])] })[0]).toEqual(
      expect.objectContaining({ code: 'duplicate-id', path: '$.holes[1].id', id: 'a' }),
    );
  });

  it('keeps cut-outs inside the board and apart', () => {
    const doc = pcbStarter();
    const slot = roundedRectLoop([20, 20], 10, 4, 1.9);
    expect(validatePcb(withBoard(doc, { cutouts: [slot] }))).toEqual([]);
    expect(codes(withBoard(doc, { cutouts: [roundedRectLoop([95, 20], 10, 4, 0)] }))).toEqual([
      'cutout-outside',
    ]);
    expect(codes(withBoard(doc, { cutouts: [roundedRectLoop([120, 20], 10, 4, 0)] }))).toEqual([
      'cutout-outside',
    ]);
    expect(codes(withBoard(doc, { cutouts: [slot, roundedRectLoop([22, 21], 2, 2, 0)] }))).toEqual([
      'cutouts-touch',
    ]);
    expect(codes(withBoard(doc, { cutouts: [slot, roundedRectLoop([25, 22], 10, 4, 0)] }))).toEqual(
      ['cutouts-touch'],
    );
  });

  it('keeps holes in the board material, off cut-outs and apart', () => {
    const doc = withBoard(pcbStarter(), { cutouts: [roundedRectLoop([40, 40], 20, 10, 0)] });
    expect(validatePcb({ ...doc, holes: [hole('a', [5, 5])] })).toEqual([]);
    expect(codes({ ...doc, holes: [hole('a', [1, 40])] })).toEqual(['hole-outside']);
    expect(codes({ ...doc, holes: [hole('a', [-5, 40])] })).toEqual(['hole-outside']);
    // In the R1 corner: inside the square, outside the arc.
    expect(
      codes({ ...doc, holes: [hole('a', [0.3, 0.3], { drillMm: 0.2, keepoutMm: 0 })] }),
    ).toEqual(['hole-outside']);
    // On a rounded corner's chord: inside the board, 0.76 mm from the arc.
    const small = withBoard(pcbStarter(), { outline: roundedRectLoop([0, 0], 10, 10, 3) });
    for (const at of [
      [9, 2],
      [8, 9],
    ] as [number, number][])
      expect(
        validatePcb({ ...small, holes: [hole('a', at, { drillMm: 0.1, keepoutMm: 0 })] }),
      ).toEqual([]);
    expect(codes({ ...doc, holes: [hole('a', [50, 45])] })).toEqual(['hole-in-cutout']);
    expect(codes({ ...doc, holes: [hole('a', [50, 38.6])] })).toEqual(['hole-in-cutout']);
    expect(codes({ ...doc, holes: [hole('a', [10, 10]), hole('b', [12, 10])] })).toEqual([
      'holes-overlap',
    ]);
    expect(codes({ ...doc, holes: [hole('a', [10, 10], { keepoutMm: 2 })] })).toEqual([
      'hole-keepout',
    ]);
  });

  it('applies operations atomically and refuses what would break the board', () => {
    const doc = pcbStarter();
    const added = applyPcbOperation(doc, {
      type: 'insert',
      entities: { holes: [hole('a', [10, 10])] },
    });
    expect(added.holes).toHaveLength(1);
    expect(doc.holes).toHaveLength(0);
    const moved = applyPcbOperation(added, {
      type: 'update',
      collection: 'holes',
      entity: hole('a', [20, 10]),
    });
    expect(moved.holes[0].at).toEqual([20, 10]);
    expect(() =>
      applyPcbOperation(added, {
        type: 'update',
        collection: 'holes',
        entity: hole('b', [20, 10]),
      }),
    ).toThrow('not-found');
    expect(() =>
      applyPcbOperation(added, {
        type: 'update',
        collection: 'holes',
        entity: hole('a', [200, 10]),
      }),
    ).toThrow('pcb-invalid:hole-outside@$.holes[0]');
    // A smaller board that would leave the hole outside is refused as a whole.
    expect(() =>
      applyPcbOperation(moved, {
        type: 'setBoard',
        board: { ...moved.board, outline: roundedRectLoop([0, 0], 15, 15, 0) },
      }),
    ).toThrow('hole-outside');
    expect(applyPcbOperation(moved, { type: 'delete', ids: ['a'] }).holes).toEqual([]);
    expect(() => applyPcbOperation(moved, { type: 'delete', ids: ['zz'] })).toThrow('not-found');
    expect(() => applyPcbOperation(moved, { type: 'insert', entities: {} })).toThrow(
      'operation-empty',
    );
    expect(() =>
      applyPcbOperation(moved, { type: 'insert', entities: { nets: [] } as never }),
    ).toThrow('operation');
  });

  it('wraps an operation in one command that re-checks base and authority', () => {
    const doc = pcbStarter();
    const op = { type: 'insert' as const, entities: { holes: [hole('a', [10, 10])] } };
    const cmd = pcbEditorCommand(op, { expectedHash: pcbContentHash(doc), canEdit: () => true });
    expect(cmd.label).toBe('Add');
    const stale = pcbEditorCommand(op, { expectedHash: 'x', canEdit: () => true });
    const denied = pcbEditorCommand(op, {
      expectedHash: pcbContentHash(doc),
      canEdit: () => false,
    });
    expect(cmd.type).toBe('pcb.insert');
    expect(cmd.apply(doc).holes).toHaveLength(1);
    expect(() => stale.apply(doc)).toThrow('pcb-base-mismatch');
    expect(() => denied.apply(doc)).toThrow('permission-denied');
  });
});
