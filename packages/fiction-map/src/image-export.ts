import { rasterizeSvg } from '@editor-platform/canvas-ui';
import { renderFictionMapSvg, type FictionMapRenderOptions } from './render';
export interface FictionMapExportGuard {
  isCurrent(): boolean;
  signal?: AbortSignal;
  rasterize?: (svg: string, width: number, height: number) => Promise<Uint8Array>;
}
/** Caller owns permission/revision/input checks; immutable source and SVG are pinned before await. */
export async function exportFictionMapPng(
  content: unknown,
  options: FictionMapRenderOptions,
  guard: FictionMapExportGuard,
): Promise<Uint8Array> {
  const check = () => {
    if (guard.signal?.aborted || !guard.isCurrent()) throw Error('stale-output');
  };
  check();
  const rendered = renderFictionMapSvg(content, options);
  check();
  const bytes = await (guard.rasterize ?? rasterizeSvg)(
    rendered.svg,
    rendered.width,
    rendered.height,
  );
  check();
  return bytes;
}
