import type { LadderCoil, LadderNode, LadderRung } from '@editor-platform/ladder-core';

/**
 * A rung on the grid (docs/cad/circuit-simulation.md, SL7). Units are grid cells: a contact,
 * box or coil takes one cell; a series runs left to right on its first row; a parallel stacks
 * its branches downwards and joins them with vertical bars. Coils sit in one column at the
 * right, in parallel. Every wire names the element whose power flows in it, so the screen can
 * colour it from a scan's result.
 */
export interface LadderCell {
  id: string;
  col: number;
  row: number;
  element: LadderNode | LadderCoil;
  coil: boolean;
  /** The node whose output powers the cell's input ('' is the left rail). */
  source: string;
}
export interface LadderWire {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** The node whose output powers the wire; '' is the left rail (always powered). */
  source: string;
}
export interface LadderRungLayout {
  cells: LadderCell[];
  wires: LadderWire[];
  /** The coils' column; the right rail is at `coilCol + 1`. */
  coilCol: number;
  rows: number;
}

/** Lays out `rung`; the coils go at column `minCols` or after the network, whichever is right of the other. */
export function ladderLayout(rung: LadderRung, minCols = 4): LadderRungLayout {
  const cells: LadderCell[] = [];
  const wires: LadderWire[] = [];
  const wire = (x1: number, y1: number, x2: number, y2: number, source: string) => {
    if (x1 !== x2 || y1 !== y2) wires.push({ x1, y1, x2, y2, source });
  };
  const place = (n: LadderNode, col: number, row: number, source: string) => {
    switch (n.kind) {
      case 'series': {
        let x = col;
        let h = 1;
        let s = source;
        for (const item of n.items) {
          const r = place(item, x, row, s);
          x += r.w;
          h = Math.max(h, r.h);
          s = item.id;
        }
        return { w: x - col, h };
      }
      case 'parallel': {
        const placed: { row: number; w: number; id: string }[] = [];
        let r = row;
        for (const b of n.branches) {
          const res = place(b, col, r, source);
          placed.push({ row: r, w: res.w, id: b.id });
          r += res.h;
        }
        // At least one cell wide, so a bypass (an empty branch) shows.
        const w = Math.max(1, ...placed.map((p) => p.w));
        for (const p of placed) wire(col + p.w, p.row + 0.5, col + w, p.row + 0.5, p.id);
        const last = placed[placed.length - 1].row + 0.5;
        wire(col, row + 0.5, col, last, source);
        wire(col + w, row + 0.5, col + w, last, n.id);
        return { w, h: r - row };
      }
      default:
        cells.push({ id: n.id, col, row, element: n, coil: false, source });
        return { w: 1, h: 1 };
    }
  };
  const net = place(rung.network, 0, 0, '');
  const coilCol = Math.max(net.w, minCols);
  wire(net.w, 0.5, coilCol, 0.5, rung.network.id);
  rung.coils.forEach((c, i) =>
    cells.push({
      id: c.id,
      col: coilCol,
      row: i,
      element: c,
      coil: true,
      source: rung.network.id,
    }),
  );
  if (rung.coils.length > 1) wire(coilCol, 0.5, coilCol, rung.coils.length - 0.5, rung.network.id);
  return { cells, wires, coilCol, rows: Math.max(net.h, rung.coils.length, 1) };
}
