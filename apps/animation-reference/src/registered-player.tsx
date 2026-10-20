import { AnimationViewer } from '@editor-platform/animation/viewer';
import { inspectPlayableAnimationEmbed } from '@editor-platform/animation-core/v2';
import { assertAnimationReactNativeBytes } from './registered-native';
/** Trusted Host implementation; the native prop is data and never executed. */
export function RegisteredAnimationPlayer({
  native,
  className,
  style,
}: {
  native: string;
  className?: string;
  style?: import('react').CSSProperties;
}) {
  assertAnimationReactNativeBytes(native);
  const { embed } = inspectPlayableAnimationEmbed(JSON.parse(native));
  return (
    <div className={className} style={{ height: 360, ...style }}>
      <AnimationViewer animation={embed} autoPlay={embed.trigger === 'on-enter'} />
    </div>
  );
}
