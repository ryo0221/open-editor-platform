/** Why a flow computation was refused or stopped (VS2). */
export type CfdErrorCode =
  /** The surface is not closed: an edge is not shared by exactly two triangles. */
  | 'surface-open'
  /** The surface is empty, has a bad index or a non-finite coordinate. */
  | 'surface-invalid'
  /** The grid has more cells than the limit. */
  | 'grid-too-large'
  /** The body does not lie inside the grid with a margin of one cell. */
  | 'body-outside'
  /** A setting is outside its range. */
  | 'config'
  /** The computation blew up (a non-finite value or a speed past the lattice limit). */
  | 'unstable'
  /** The run was cancelled by its caller. */
  | 'cancelled'
  /** WebGPU cannot run this flow (no adapter, buffers too small, a lost device); the CPU can. */
  | 'gpu-unavailable'
  /** A Host job (VS3) that is not one this Host runs: a field, range or unknown key. */
  | 'job-invalid';

export class CfdError extends Error {
  constructor(
    readonly code: CfdErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'CfdError';
  }
}
