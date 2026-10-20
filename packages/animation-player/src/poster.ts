import {
  evaluateAnimation,
  EVALUATOR_V1,
  type PreparedAnimation,
} from '@editor-platform/animation-core';
const attr = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Pure, deterministic rectangle poster. It has the exact evaluator used by the Player. */
export function rectangleAnimationPoster(
  source: PreparedAnimation,
  compositionId: string,
  tick: number,
): string {
  if (source.evaluatorVersion !== EVALUATOR_V1) throw Error('Poster requires rectangle v1');
  const scene = evaluateAnimation(source, compositionId, tick);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${scene.width} ${scene.height}" width="${scene.width}" height="${scene.height}">${scene.rectangles
    .map(
      (r) =>
        `<rect width="${r.width}" height="${r.height}" fill="${attr(r.fill)}" opacity="${r.opacity}" transform="matrix(${r.matrix.join(' ')})"/>`,
    )
    .join('')}</svg>`;
}
