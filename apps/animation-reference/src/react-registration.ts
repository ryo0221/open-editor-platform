import implementation from './registered-player.tsx?raw';
import runtimePin from 'virtual:animation-runtime-pin';
import { reuseHash } from '@editor-platform/reuse-core';
import {
  sealReactComponent,
  sealReactEnvironment,
  loadReactUiDocument,
  type ReactRuntimeResolution,
} from '@editor-platform/react-ui-core';
import {
  inspectPlayableAnimationEmbed,
  createAnimation2,
  createPlayableAnimationEmbed,
  type PlayableAnimationEmbed,
} from '@editor-platform/animation-core/v2';
import { ANIMATION_REACT_NATIVE_BYTES, assertAnimationReactNativeBytes } from './registered-native';
export { ANIMATION_REACT_NATIVE_BYTES } from './registered-native';
export const animationReactEnvironment = sealReactEnvironment({
  schemaVersion: 1,
  ref: { id: 'animation-reference', version: '2.0.1' },
  reactVersion: '19.1.1',
  stylePolicy: 'allow-literals',
  tokenVariables: {},
  providerOrder: [],
  dependencies: [
    {
      id: 'animation-wrapper',
      kind: 'package',
      name: '@animation-reference/player',
      version: '2.0.1',
      hash: reuseHash(implementation),
    },
    {
      id: 'animation-runtime',
      kind: 'package',
      name: '@editor-platform/animation-player',
      version: '0.0.0-prototype.0',
      hash: runtimePin.hash,
    },
  ],
});
const sampleContent = createAnimation2();
const sampleEmbed = createPlayableAnimationEmbed(
  {
    artifactId: 'sample',
    versionId: 'v1',
    compositionId: sampleContent.rootCompositionId,
    contentHash: reuseHash(sampleContent),
  },
  sampleContent,
  'Animation preview',
);
export const animationReactComponent = sealReactComponent({
  schemaVersion: 1,
  name: 'Animation Player',
  ref: {
    registryId: 'animation-reference',
    componentId: 'Animation',
    version: '2.0.1',
    implementationHash: reuseHash({ implementation, runtime: runtimePin.hash }),
  },
  import: {
    source: '@animation-reference/player',
    export: 'named',
    name: 'RegisteredAnimationPlayer',
  },
  props: {
    native: { schema: { type: 'string', maxLength: ANIMATION_REACT_NATIVE_BYTES }, required: true },
  },
  events: {},
  slots: {},
  controlledInputs: [],
  layout: 'wrapper',
  requires: ['animation-wrapper', 'animation-runtime'],
  sampleProps: { native: JSON.stringify(sampleEmbed) },
});
export const animationReactResolution: ReactRuntimeResolution = {
  environment: animationReactEnvironment.ref,
  components: [animationReactComponent.ref],
  dependencies: animationReactEnvironment.dependencies.map(({ id, hash }) => ({ id, hash })),
};
export function createAnimationReactDocument(animation: PlayableAnimationEmbed) {
  const { embed } = inspectPlayableAnimationEmbed(animation);
  const native = JSON.stringify(embed);
  assertAnimationReactNativeBytes(native);
  return loadReactUiDocument({
    schemaVersion: 1,
    domain: 'react-ui',
    environment: animationReactEnvironment,
    components: [animationReactComponent],
    inputs: {},
    callbacks: {},
    fixture: {},
    breakpoints: [],
    roots: ['animation'],
    nodes: [
      {
        id: 'animation',
        component: animationReactComponent.ref,
        props: { native },
        bindings: {},
        slots: {},
        layout: {
          base: {
            width: { kind: 'literal', value: '100%' },
            height: { kind: 'literal', value: 360 },
          },
          breakpoints: {},
        },
      },
    ],
  });
}
