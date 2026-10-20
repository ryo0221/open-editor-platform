import { requireAnimation as check } from '../model';
import { MAX_ANIMATION_EXPANDED_CLIPS2, MAX_ANIMATION_EXPANDED_SVG_DATA2 } from './model';
import type { AnimationContent2, Composition2, Layer2 } from './model';
import { animationSvgPathData2, animationSvgTextData2 } from './svg-data';
import { resolveComposition2 } from './source-resolution';

interface ExpansionBudget2 {
  layers: number;
  paths: number;
  svgData: number;
  text: number;
  clips: number;
  depth: number;
}
function textExpansion(
  content: AnimationContent2,
  composition: Composition2,
  layer: Extract<Layer2, { type: 'text' }>,
) {
  const variants = new Set([
    layer.text,
    ...composition.tracks
      .filter((track) => track.layerId === layer.id && track.property === 'text')
      .flatMap((track) => track.keys.map((key) => String(key.value))),
    ...content.publicInputs
      .filter(
        (input) =>
          input.target.compositionId === composition.id &&
          input.target.layerId === layer.id &&
          input.target.property === 'text',
      )
      .map((input) => String(input.default)),
  ]);
  const characters = Math.max(...[...variants].map((value) => value.length));
  // Fill is the only animated run default; reserve its longest admitted color.
  const svgData = Math.max(
    ...[...variants].map(
      (value) =>
        animationSvgTextData2({
          ...layer,
          text: value,
          runs: value === layer.text ? layer.runs : [],
          fill: '#00000000',
        }).length,
    ),
  );
  return { characters, svgData };
}

/** Bound every validated composition, including retained owners and repeated instances.
 * Structural validation populates clipCounts before this graph pass; source hashes
 * are checked afterward by the owning reader. No stage substitutes for another. */
export function assertAnimationExpansion2(
  contents: readonly AnimationContent2[],
  clipCounts: ReadonlyMap<Layer2, number>,
) {
  const memo = new Map<Composition2, ExpansionBudget2>();
  const walk = (
    node: AnimationContent2,
    c: Composition2,
    stack: Composition2[],
  ): ExpansionBudget2 => {
    check(!stack.includes(c), 'composition-cycle-depth', c.id);
    const cached = memo.get(c);
    if (cached) {
      check(stack.length + cached.depth <= 16, 'composition-cycle-depth', c.id);
      return cached;
    }
    const budget = { layers: c.layers.length, paths: 0, svgData: 0, text: 0, clips: 0, depth: 1 };
    for (const layer of c.layers) {
      const clipCount = clipCounts.get(layer)!;
      budget.clips += clipCount;
      budget.paths +=
        (layer.type === 'path' ? layer.path.length : 0) + (layer.motion?.path.length ?? 0);
      // Count the actual serialized coordinates, not just command count: cubic
      // segments and long decimal coordinates cost more than short line segments.
      if (layer.type === 'path') budget.svgData += animationSvgPathData2(layer.path).length;
      if (layer.type === 'text') {
        const text = textExpansion(node, c, layer);
        budget.text += text.characters;
        budget.svgData += text.svgData;
      }
      if (layer.type === 'composition') {
        const child = resolveComposition2(node, layer),
          nested = walk(child.content, child.composition, [...stack, c]);
        budget.layers += nested.layers;
        budget.paths += nested.paths;
        budget.svgData += nested.svgData;
        budget.text += nested.text;
        budget.clips += nested.clips + clipCount * nested.layers;
        budget.depth = Math.max(budget.depth, nested.depth + 1);
      }
      check(
        budget.layers <= 20000 &&
          budget.paths <= 200000 &&
          budget.svgData <= MAX_ANIMATION_EXPANDED_SVG_DATA2 &&
          budget.text <= 200000 &&
          budget.clips <= MAX_ANIMATION_EXPANDED_CLIPS2,
        'expansion',
        c.id,
      );
    }
    check(stack.length + budget.depth <= 16, 'composition-cycle-depth', c.id);
    memo.set(c, budget);
    return budget;
  };
  for (const node of contents) for (const c of node.compositions) walk(node, c, []);
}
