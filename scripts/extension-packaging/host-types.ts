import {
  rectangleViewerExtension,
  type RectangleViewerProvenance,
} from '@editor-platform/extension-sample/animation-viewer';
import { ReferenceRegistry, type Binding } from '@editor-platform/extension-runtime/draft2';
import type { AnimationContentV1 } from '@editor-platform/animation-core';
import type { DefinitionD2 } from '@editor-platform/extension-contract/draft2';
export function typedHost(
  registry: ReferenceRegistry,
  hash: string,
  provenance: RectangleViewerProvenance,
  binding: Binding<AnimationContentV1, never>,
) {
  const definition: DefinitionD2<AnimationContentV1, never> = rectangleViewerExtension(
    hash,
    provenance,
  );
  return registry
    .install(definition, { trust: 'trusted', verifiedPin: definition.manifest })
    .open(binding);
}
// @ts-expect-error private implementation paths are deliberately not exported
import type { Ownership } from '@editor-platform/extension-runtime/src/draft2/primitives';
export type PrivatePathMustRemainRejected = Ownership;
