import { useEffect, type RefObject } from 'react';
import type { TextRun } from '@editor-platform/editor-core';
import { CanvasTextEditor } from '@editor-platform/canvas-ui/text-editor';
import {
  animationCommand2,
  animationLayerLocked2,
  evaluateAnimation2,
  prepareAnimation2,
  type AnimationCommand2,
  type AnimationContent2,
  type AnimationInputValues2,
  type Composition2,
  type Layer2,
} from '@editor-platform/animation-core/v2';
import { animationSceneSvg2 } from '@editor-platform/animation-player/v2';
import { animationStageDragActions2, type animationStageDragLayers2 } from './stage-drag';

export type AnimationStageDrag2 = {
  base: AnimationContent2;
  pointer: number;
  start: { x: number; y: number };
  delta: { x: number; y: number };
  layers: ReturnType<typeof animationStageDragLayers2>;
};

export type AnimationTextEditing2 = {
  compositionId: string;
  id: string;
  text: string;
  runs: TextRun[];
};

/**
 * Shows the dragged result over the hidden live stage. Preview and commit use the
 * same native patches and evaluator, so container/clip worlds are recomputed rather
 * than translating only painted leaf nodes. The preview is rebuilt only when `drag`
 * changes.
 */
export function useAnimationDragPreview2(
  stage: RefObject<HTMLDivElement | null>,
  drag: AnimationStageDrag2 | null,
  options: {
    compositionId: string;
    tick: number;
    values: AnimationInputValues2;
    scope: { canEdit(): boolean };
    prefix: string;
    report(message: string): void;
  },
) {
  useEffect(() => {
    const svg = stage.current?.querySelector('svg');
    if (!drag || !svg) return;
    const { compositionId, tick, values, scope, prefix, report } = options;
    let preview: SVGSVGElement;
    try {
      const next = animationCommand2(
        drag.base,
        animationStageDragActions2(compositionId, drag.layers, drag.delta),
        scope,
      ).apply(drag.base);
      const scene = evaluateAnimation2(prepareAnimation2(next), compositionId, tick, values);
      const parsed = new DOMParser().parseFromString(
        animationSceneSvg2(scene, prefix, false),
        'image/svg+xml',
      );
      const generated = parsed.querySelector('svg');
      if (!generated || parsed.querySelector('parsererror')) throw Error('Invalid generated scene');
      preview = svg.ownerDocument.importNode(generated, true);
    } catch (error) {
      report(String(error));
      return;
    }
    preview.setAttribute('data-preview', 'true');
    preview.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
    svg.style.visibility = 'hidden';
    stage.current!.append(preview);
    return () => {
      preview.remove();
      svg.style.visibility = '';
    };
  }, [drag]);
}

/** Native text editing over the stage; commit applies one layer patch to the live content. */
export function AnimationTextOverlay2({
  content,
  composition,
  editing,
  layer,
  readOnly,
  showStale,
  stale,
  scope,
  read,
  beforeCommit,
  execute,
  report,
  onClose,
}: {
  content: AnimationContent2;
  composition: Composition2;
  editing: AnimationTextEditing2;
  layer: Extract<Layer2, { type: 'text' }>;
  readOnly: boolean;
  /** Whether the editor shows the stale state; shared text bridges merge instead. */
  showStale: boolean;
  /** Whether the layer changed since editing began, which blocks the commit. */
  stale: boolean;
  scope: { canEdit(): boolean };
  read(): AnimationContent2;
  beforeCommit(): void;
  execute(command: AnimationCommand2): boolean | void;
  report(message: string): void;
  onClose(): void;
}) {
  return (
    <div className="a2-text-editor">
      <CanvasTextEditor
        elementId={editing.id}
        text={editing.text}
        runs={editing.runs}
        style={{
          fontSize: layer.fontSize,
          color: layer.fill,
          lineHeight: layer.lineHeight,
          fontFamily: layer.fontAssetId
            ? 'animation-font-' +
              content.assets.find((a) => a.id === layer.fontAssetId)!.contentHash
            : 'sans-serif',
        }}
        readOnly={readOnly || animationLayerLocked2(composition, editing.id)}
        stale={showStale}
        onCancel={onClose}
        onCommit={(text, runs) => {
          if (stale) return false;
          let ok = false;
          try {
            beforeCommit();
            ok =
              execute(
                animationCommand2(
                  read(),
                  [
                    {
                      type: 'layer.patch',
                      compositionId: composition.id,
                      id: editing.id,
                      patch: { text, runs },
                    },
                  ],
                  scope,
                  'Edit Animation text',
                ),
              ) !== false;
          } catch (error) {
            report(String(error));
          }
          if (ok) onClose();
          return ok;
        }}
      />
    </div>
  );
}
