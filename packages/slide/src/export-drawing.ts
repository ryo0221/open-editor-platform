import { drawingPrimitives, serializeSvg, type SvgPrimitive } from '@editor-platform/editor-core';
import { slideDrawing, slideMotionState, slidePaintOrder, type SlideContent } from './model';
import { slideMotionTransform, slideTransitionLayers } from './motion';
import { type ExportPose, type SlideMp4Plan, slideMp4Frame } from './export-playback';

export function slideExportRenderer(deck: SlideContent) {
  const drawings = new WeakMap<ExportPose['page'], ReturnType<typeof pageDrawings>>();
  function pageDrawings(page: ExportPose['page'], prefix: string) {
    return slidePaintOrder(page).map((object, index) => ({
      object,
      nodes: object.hidden ? [] : drawingPrimitives(slideDrawing(object), `${prefix}-${index}`),
    }));
  }
  function layer(pose: ExportPose, placement = { x: 0, y: 0, opacity: 1 }): SvgPrimitive {
    let rendered = drawings.get(pose.page);
    if (!rendered) {
      rendered = pageDrawings(pose.page, `page-${deck.slides.indexOf(pose.page)}`);
      drawings.set(pose.page, rendered);
    }
    const state = slideMotionState(deck, pose.page, pose.step, pose.elapsedMs);
    return {
      tag: 'g',
      attrs: { opacity: placement.opacity, transform: `translate(${placement.x} ${placement.y})` },
      children: [
        {
          tag: 'rect',
          attrs: { width: deck.width, height: deck.height, fill: pose.page.background },
        },
        ...rendered.flatMap(({ object, nodes }): SvgPrimitive[] => {
          const motion = state.get(object.id);
          return motion?.visible && nodes.length
            ? [
                {
                  tag: 'g',
                  attrs: {
                    opacity: motion.opacity,
                    transform: slideMotionTransform(object, motion),
                  },
                  children: nodes,
                },
              ]
            : [];
        }),
      ],
    };
  }
  function svg(children: SvgPrimitive[], width: number, height: number, title?: string) {
    const root = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${deck.width} ${deck.height}">`;
    return (
      root +
      serializeSvg(
        title ? [{ tag: 'title', attrs: {}, children: [title] }, ...children] : children,
      ) +
      '</svg>'
    );
  }
  return {
    pdf: (pose: ExportPose) => svg([layer(pose)], deck.width, deck.height, pose.page.title),
    video(plan: SlideMp4Plan, frame: number) {
      const { segment, elapsedMs } = slideMp4Frame(plan, frame);
      const { width, height } = plan;
      if (segment.kind === 'transition') {
        const { incoming, outgoing } = slideTransitionLayers(
          deck,
          segment.transition,
          elapsedMs / segment.transition.durationMs,
        );
        return svg([layer(segment.from, outgoing), layer(segment.pose, incoming)], width, height);
      }
      const pose = segment.kind === 'step' ? { ...segment.pose, elapsedMs } : segment.pose;
      return svg([layer(pose)], width, height);
    },
  };
}
