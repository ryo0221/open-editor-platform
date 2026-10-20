import type { AnimationContent } from '@editor-platform/animation-core';
import type { ControlledSurfaceController } from '@editor-platform/extension-contract/controlled-surface';
import type { Context } from '@editor-platform/extension-contract/draft2';
import { createAnimationPlayback } from '@editor-platform/animation/playback';
/** Keeps the existing extension entry while sharing the exact normal-Host Player bridge. */
export function createPlayback(
  editor: ControlledSurfaceController<AnimationContent>,
  context: Context<AnimationContent, never>,
  onError: (error: unknown) => void,
) {
  if (context.addons.lifecycle.state !== 'granted') throw Error('LifecycleUnavailable');
  return createAnimationPlayback(editor, context.addons.lifecycle.api, onError, () => {
    if (context.addons.inputs.state !== 'granted') return false;
    const inputs = context.addons.inputs.api.getSnapshot();
    return !!(inputs.dirty || inputs.composing);
  });
}
