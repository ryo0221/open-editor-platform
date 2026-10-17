import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AnimationControlledSurface } from '@editor-platform/animation/controlled';
import type { AnimationPlaybackPort } from '@editor-platform/animation/controlled-contract';
import {
  readAnimationV1,
  putRectangleLayerV1,
  type AnimationContent,
} from '@editor-platform/animation-core';
import { createControlledSurfaceController } from '@editor-platform/extension-runtime/controlled';
import type { ControlledSurfaceController } from '@editor-platform/extension-contract/controlled-surface';
import type { DefinitionD2 } from '@editor-platform/extension-contract/draft2';
import { createPlayback } from './playback';
export interface AnimationAdapterView {
  editor: ControlledSurfaceController<AnimationContent>;
  playback: AnimationPlaybackPort;
}
export function controlledAnimationExtension(
  packageHash: string,
  options: { onError(error: unknown): void; mounted(view: AnimationAdapterView): void },
): DefinitionD2<AnimationContent, never> {
  return {
    manifest: {
      id: 'example.controlled-animation',
      version: '0.0.0-experiment.1',
      packageHash,
      contractVersion: '1.0.0-draft.2',
      artifactKind: 'animation',
      schemaVersion: 1,
      surface: true,
      permissions: ['artifact:read', 'artifact:edit', 'artifact:save'],
      addons: {
        edit: { version: 'local-edit@0-draft', requirement: 'optional' },
        inputs: { version: 'inputs@0-draft', requirement: 'optional' },
        save: { version: 'local-persistence@0-draft', requirement: 'optional' },
        lifecycle: { version: 'lifecycle@0-draft', requirement: 'required' },
      },
      licenseNotices: ['Local trusted prototype; repository license scope is unchanged.'],
    },
    validate(value): value is AnimationContent {
      try {
        readAnimationV1(value as AnimationContent);
        return true;
      } catch {
        return false;
      }
    },
    mount(container, context) {
      if (context.addons.lifecycle.state !== 'granted') throw Error('LifecycleUnavailable');
      const lifecycle = context.addons.lifecycle.api;
      const editor = createControlledSurfaceController(context, {
        beforeMutation() {
          playback.pause();
        },
        onError: options.onError,
      });
      const playback = createPlayback(editor, context, options.onError);
      const root = createRoot(container, {
        onUncaughtError: options.onError,
        onRecoverableError: options.onError,
      });
      let cleanup: Promise<void> | undefined;
      const dispose = () => {
        cleanup ??= new Promise<void>((resolve, reject) =>
          queueMicrotask(() => {
            try {
              root.unmount();
              resolve();
            } catch (error) {
              reject(error);
            }
          }),
        );
        return cleanup;
      };
      lifecycle.registerDisposable('animation-react-root', dispose);
      flushSync(() =>
        root.render(createElement(AnimationControlledSurface, { editor, playback: playback! })),
      );
      lifecycle.assertCurrent();
      options.mounted({ editor, playback });
    },
  };
}
export function setAnimationLayerX(
  editor: ControlledSurfaceController<AnimationContent>,
  compositionId: string,
  layerId: string,
  value: number,
) {
  const view = editor.getSnapshot();
  if (view.state !== 'open')
    return { state: 'refused' as const, code: 'ScopeRevoked', message: 'ScopeRevoked' };
  try {
    const native = readAnimationV1(view.snapshot.content),
      layer = native.compositions
        .find((c) => c.id === compositionId)
        ?.layers.find((l) => l.id === layerId);
    if (!layer || layer.type !== 'rect') throw Error('RectangleMissing');
    return editor.execute({
      baseRevision: view.snapshot.revision,
      command:
        layer.transform.x === value
          ? null
          : putRectangleLayerV1(
              view.snapshot.content,
              compositionId,
              {
                ...layer,
                transform: { ...layer.transform, x: value },
              },
              {
                canEdit: () => {
                  const current = editor.getSnapshot();
                  return current.state === 'open' && current.canEdit;
                },
              },
            ),
    });
  } catch (error) {
    return { state: 'refused' as const, code: 'DomainInput', message: String(error) };
  }
}
