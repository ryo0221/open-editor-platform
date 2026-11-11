/**
 * WM6 (docs/cad/watch-design.md, 仕上げ): the images of SK-01's decoration, drawn here rather than
 * taken from anywhere: perlage (overlapping circular grains) for the main plate and Côtes de
 * Genève (parallel rounded ribs, each brushed in an arc) for the bridges. Each is a colour map
 * and an OpenGL normal map that repeat seamlessly; the caller encodes them as PNG and stores
 * them as texture assets (`Sk01Finish`). Pure arithmetic: no image encoding.
 */

/** An 8-bit RGB image, rows top to bottom. */
export interface Sk01Image {
  width: number;
  height: number;
  rgb: Uint8Array;
}
export interface Sk01FinishImages {
  perlage: { color: Sk01Image; normal: Sk01Image };
  cotes: { color: Sk01Image; normal: Sk01Image };
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));
/** A surface height's shade and normal per pixel, as two images. */
function images(
  size: number,
  at: (u: number, v: number) => { shade: number; slope: [number, number] },
): { color: Sk01Image; normal: Sk01Image } {
  const color = new Uint8Array(size * size * 3);
  const normal = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      // v up, as the normal map's green (OpenGL).
      const { shade, slope } = at((x + 0.5) / size, 1 - (y + 0.5) / size);
      const g = Math.round(255 * clamp(shade));
      const i = (y * size + x) * 3;
      color[i] = g;
      color[i + 1] = g;
      color[i + 2] = Math.round(255 * clamp(shade * 1.02));
      const [sx, sy] = slope;
      const n = Math.hypot(sx, sy, 1);
      normal[i] = Math.round(255 * clamp((-sx / n + 1) / 2));
      normal[i + 1] = Math.round(255 * clamp((-sy / n + 1) / 2));
      normal[i + 2] = Math.round(255 * clamp((1 / n + 1) / 2));
    }
  return {
    color: { width: size, height: size, rgb: color },
    normal: { width: size, height: size, rgb: normal },
  };
}

/**
 * Perlage: 4 × 4 grains a tile on a staggered grid, each drawn over the ones before it, with
 * fine concentric grooves (the slope) and a sheen that turns with the angle (the shade).
 */
function perlage(size: number) {
  const n = 4;
  const r = 0.62 / n;
  const grains: [number, number][] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) grains.push([(i + (j % 2) * 0.5) / n, (j + 0.5) / n]);
  return images(size, (u, v) => {
    let top: { dx: number; dy: number } | undefined;
    // The last grain drawn over this point, the tile repeated around it.
    for (const [cx, cy] of grains)
      for (const ox of [-1, 0, 1])
        for (const oy of [-1, 0, 1]) {
          const dx = u - (cx + ox);
          const dy = v - (cy + oy);
          if (dx * dx + dy * dy <= r * r) top = { dx, dy };
        }
    if (!top) return { shade: 0.8, slope: [0, 0] };
    const d = Math.hypot(top.dx, top.dy) / r;
    const a = Math.atan2(top.dy, top.dx);
    const groove = 0.18 * Math.sin(d * Math.PI * 9);
    const radial: [number, number] = d > 0 ? [top.dx / (d * r), top.dy / (d * r)] : [0, 0];
    return {
      shade: 0.82 + 0.13 * Math.cos(2 * a) * (0.4 + 0.6 * d) - 0.05 * d * d,
      slope: [groove * radial[0], groove * radial[1]],
    };
  });
}

/**
 * Côtes de Genève: 4 ribs a tile along u, each bent in an arc along v (the brushing), rounded
 * across (the slope) and bright on its crest (the shade).
 */
function cotes(size: number) {
  const ribs = 4;
  return images(size, (u, v) => {
    const w = (u + 0.06 * Math.cos(2 * Math.PI * v)) * ribs;
    const t = w - Math.floor(w);
    const crest = Math.sin(Math.PI * t);
    return {
      shade: 0.7 + 0.28 * crest ** 2,
      slope: [0.35 * Math.cos(Math.PI * t), 0],
    };
  });
}

/** The decoration images, `size` pixels square (16–1024). */
export function sk01FinishImages(size = 256): Sk01FinishImages {
  if (!Number.isInteger(size) || size < 16 || size > 1024) throw new Error('sk01-finish-size');
  return { perlage: perlage(size), cotes: cotes(size) };
}
