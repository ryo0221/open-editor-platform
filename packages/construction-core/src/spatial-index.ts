/**
 * TT4 (docs/cad/skytree-twin.md): a uniform grid over boxes, to find the few that may meet a
 * query box among thousands. Items are numbered (their order is kept by the caller); a box that
 * spans too many cells is kept apart and returned for every query.
 */
import type { Point3 } from './site';

type Box = [Point3, Point3];

/** A cell's key: each index within ±2^15 cells (±164 km at 5 m), packed in 48 bits. */
const cellKey = (x: number, y: number, z: number) =>
  ((x + 32768) * 65536 + (y + 32768)) * 65536 + (z + 32768);

export class BoxIndex {
  private readonly cells = new Map<number, number[]>();
  private readonly big: number[] = [];
  private readonly seen: Uint32Array;
  private stamp = 0;

  /**
   * @param boxes the items' boxes, by number (undefined: no item)
   * @param cell the grid's cell size (mm)
   * @param maxCells an item over more cells than this is returned for every query
   */
  constructor(
    boxes: readonly (Box | undefined)[],
    private readonly cell = 5000,
    maxCells = 512,
  ) {
    this.seen = new Uint32Array(boxes.length);
    boxes.forEach((b, n) => {
      if (!b) return;
      const [lo, hi] = this.range(b);
      const count = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1);
      const out = (v: number) => Math.abs(v) >= 32768;
      if (!Number.isFinite(count) || count > maxCells || lo.some(out) || hi.some(out)) {
        this.big.push(n);
        return;
      }
      for (let x = lo[0]; x <= hi[0]; x++)
        for (let y = lo[1]; y <= hi[1]; y++)
          for (let z = lo[2]; z <= hi[2]; z++) {
            const k = cellKey(x, y, z);
            const list = this.cells.get(k);
            if (list) list.push(n);
            else this.cells.set(k, [n]);
          }
    });
  }

  /** The cells a box touches; an inverted side (a padded thin box) counts both ends. */
  private range(b: Box): [number[], number[]] {
    const c = this.cell;
    return [
      [0, 1, 2].map((i) => Math.floor(Math.min(b[0][i]!, b[1][i]!) / c)),
      [0, 1, 2].map((i) => Math.floor(Math.max(b[0][i]!, b[1][i]!) / c)),
    ];
  }

  /**
   * The items in cells the box touches (and the big ones), each once, in no order.
   * @param also items to return as well (still each once)
   */
  query(box: Box, also: readonly number[] = []): number[] {
    const out = this.big.slice();
    if (++this.stamp === 0xffffffff) {
      this.seen.fill(0);
      this.stamp = 1;
    }
    const visit = (list: readonly number[] | undefined) => {
      if (!list) return;
      for (const n of list)
        if (this.seen[n] !== this.stamp) {
          this.seen[n] = this.stamp;
          out.push(n);
        }
    };
    for (const n of out) this.seen[n] = this.stamp;
    visit(also);
    const [lo, hi] = this.range(box);
    const count = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1);
    if (count > this.cells.size) for (const list of this.cells.values()) visit(list);
    else
      for (let x = lo[0]!; x <= hi[0]!; x++)
        for (let y = lo[1]!; y <= hi[1]!; y++)
          for (let z = lo[2]!; z <= hi[2]!; z++) visit(this.cells.get(cellKey(x, y, z)));
    return out;
  }
}
