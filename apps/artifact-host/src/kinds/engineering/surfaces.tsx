// The Artifact Host's engineering Surfaces. Three.js and the kernel adapter load only when a CAD
// or BIM Artifact opens.
import { lazy, Suspense } from 'react';
import { bimKind } from '@editor-platform/bim/kind';
import { cadDefinition } from '../engineering';
import { artifactSurface } from '../surface-kind';

const CadArtifactView = lazy(() => import('../../cad'));
const BimArtifactView = lazy(() => import('../../bim'));

export const engineeringSurfaces = [
  artifactSurface(cadDefinition, {
    Surface: ({ host, env }) => (
      <Suspense fallback={<p>3D CADを読み込んでいます…</p>}>
        <CadArtifactView
          host={host}
          kernel={env.cadKernel ?? null}
          kernels={env.cadKernels}
          onError={env.onError}
        />
      </Suspense>
    ),
  }),
  artifactSurface(bimKind, {
    Surface: ({ host, env }) => (
      <Suspense fallback={<p>建物を読み込んでいます…</p>}>
        <BimArtifactView host={host} kernel={env.cadKernel ?? null} onError={env.onError} />
      </Suspense>
    ),
  }),
];
