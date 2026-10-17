import { canonicalJson } from '@editor-platform/artifact-core';
import {
  immutableCommand,
  withCommandReads,
  type EditorCommand,
} from '@editor-platform/editor-core';
import {
  requireAnimation as check,
  type AnimationContent,
  type AnimationContentV1,
  type RectangleLayer,
} from './model';
import { readAnimationV1 } from './v1';
import type { AnimationEditScope } from './commands';
function edit(
  expected: AnimationContent,
  compositionId: string,
  scope: AnimationEditScope,
  name: string,
  change: (c: AnimationContentV1['compositions'][number]) => void,
): EditorCommand<AnimationContent> {
  const base = canonicalJson(readAnimationV1(expected));
  return withCommandReads(
    immutableCommand(name, name, (content) => {
      check(scope.canEdit(), 'read-only', 'command');
      check(canonicalJson(readAnimationV1(content)) === base, 'stale', 'command');
      const next = structuredClone(content) as AnimationContentV1;
      const composition = next.compositions.find((c) => c.id === compositionId);
      check(composition, 'missing-composition', compositionId);
      change(composition);
      return readAnimationV1(next);
    }),
    { content: ['*'] },
  );
}
/** Local v1 command: add one new layer or replace an existing layer with the same stable ID. */
export function putRectangleLayerV1(
  expected: AnimationContent,
  compositionId: string,
  layer: RectangleLayer,
  scope: AnimationEditScope,
): EditorCommand<AnimationContent> {
  const owned = structuredClone(layer);
  return edit(expected, compositionId, scope, 'animation.put-rectangle-layer', (c) => {
    const index = c.layers.findIndex((l) => l.id === owned.id);
    if (index < 0) c.layers.push(structuredClone(owned));
    else c.layers[index] = structuredClone(owned);
  });
}
/** Removing a final key removes its track; the unchanged base transform then applies. */
export function removeAnimationTrackV1(
  expected: AnimationContent,
  compositionId: string,
  trackId: string,
  scope: AnimationEditScope,
): EditorCommand<AnimationContent> {
  return edit(expected, compositionId, scope, 'animation.remove-track', (c) => {
    const index = c.tracks.findIndex((t) => t.id === trackId);
    check(index >= 0, 'missing-track', trackId);
    c.tracks.splice(index, 1);
  });
}
