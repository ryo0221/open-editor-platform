import { canonicalJson } from '@editor-platform/artifact-core';
import {
  immutableCommand,
  withCommandReads,
  type EditorCommand,
} from '@editor-platform/editor-core';
import { requireAnimation as check, type AnimationContent, type Track } from './model';
import { ownJson, validateAnimation } from './validate';
/** Temporary scoped local adapter, not a registration API or authenticated authority. */
export interface AnimationEditScope {
  canEdit(): boolean;
}
export function replaceTrack(
  expected: AnimationContent,
  compositionId: string,
  track: Track,
  scope: AnimationEditScope,
): EditorCommand<AnimationContent> {
  const base = canonicalJson(validateAnimation(expected));
  const owned = ownJson(track) as Track;
  return withCommandReads(
    immutableCommand('animation.replace-track', 'Replace animation track', (content) => {
      check(scope.canEdit(), 'read-only', 'command');
      check(canonicalJson(validateAnimation(content)) === base, 'stale', 'command');
      check(
        content.compositions.some((c) => c.id === compositionId),
        'missing-composition',
        compositionId,
      );
      const next = structuredClone(content);
      const composition = next.compositions.find((c) => c.id === compositionId)!;
      const index = composition.tracks.findIndex((t) => t.id === owned.id);
      if (index < 0) composition.tracks.push(structuredClone(owned));
      else composition.tracks[index] = structuredClone(owned);
      return validateAnimation(next);
    }),
    { content: ['*'] },
  );
}
