import { useMemo } from 'react';
import {
  animationPlaybackContent2,
  inspectPlayableAnimationEmbed,
  type PlayableAnimationEmbed,
} from '@editor-platform/animation-core/v2';
import { AnimationReactPlayer2 } from './scene2/viewer';

/** Retained source integrity is checked before rendering through the current Player. */
export function AnimationViewer(props: {
  animation: PlayableAnimationEmbed;
  autoPlay?: boolean;
  controls?: boolean;
}) {
  const result = useMemo(() => {
    try {
      const { embed } = inspectPlayableAnimationEmbed(props.animation);
      return { embed, content: animationPlaybackContent2(embed) };
    } catch (error) {
      return { error: String(error) };
    }
  }, [props.animation]);
  if ('error' in result) return <p role="alert">{result.error}</p>;
  const { embed, content } = result;
  return (
    <AnimationReactPlayer2
      content={content}
      compositionId={embed.source.compositionId}
      inputs={embed.format === 'animation-embed-2' ? embed.inputs : undefined}
      label={embed.label}
      posterTick={embed.posterTick}
      loop={embed.loop}
      autoPlay={props.autoPlay}
      controls={props.controls}
    />
  );
}
