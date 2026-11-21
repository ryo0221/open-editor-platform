import { defineKind } from '@editor-platform/artifact-kinds';
import {
  readAnimationV1,
  SCHEMA_V1,
  TICKS_PER_SECOND_V1,
  type AnimationContentV1,
} from '@editor-platform/animation-core';
import {
  createAnimation2,
  readAnimation2,
  type AnimationContent2,
} from '@editor-platform/animation-core/v2';

/** Version 2 content, or version 1 content that still reads. Other domains never reach a reader. */
function isAnimationContent(content: unknown): content is AnimationContentV1 | AnimationContent2 {
  if (
    content &&
    typeof content === 'object' &&
    (content as { schemaVersion?: unknown }).schemaVersion === 2 &&
    (content as { ticksPerSecond?: unknown }).ticksPerSecond === TICKS_PER_SECOND_V1
  ) {
    try {
      readAnimation2(content);
      return true;
    } catch {
      return false;
    }
  }
  const candidate = content as Partial<AnimationContentV1> | null;
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    candidate.schemaVersion !== SCHEMA_V1 ||
    candidate.ticksPerSecond !== TICKS_PER_SECOND_V1
  )
    return false;
  try {
    readAnimationV1(content);
    return true;
  } catch {
    return false;
  }
}
/** The Animation kind (docs/kind-registry-design.md). */
export const animationKind = defineKind<AnimationContentV1 | AnimationContent2>({
  kind: 'animation',
  area: 'office',
  label: 'Animation',
  icon: '▶',
  description: 'Create and reuse 2D animation with a timeline',
  creatable: true,
  create: (count) => ({ name: `Animation ${count}`, content: createAnimation2() }),
  validate: isAnimationContent,
});
