import { createRoot } from 'react-dom/client';
import cadKernel, { kernels as cadKernels } from 'virtual:cad-kernel-build';
import { HostApp } from './HostApp';
import { BrowserArtifactStorage, bimSample, cadSample, referenceArtifacts } from './model';
declare const __ARTIFACT_PREVIEW_DOCUMENT__: string;
// The CAD and building samples are offered only when this Host supplies a kernel build (CAD_OCCT_DIST).
const storage = new BrowserArtifactStorage(localStorage),
  samples = [
    ...referenceArtifacts(),
    ...(cadKernel
      ? [cadSample({ id: cadKernel.id, buildHash: cadKernel.buildHash }), bimSample()]
      : []),
  ];
createRoot(document.getElementById('root')!).render(
  <HostApp
    storage={storage}
    samples={samples}
    previewDocument={__ARTIFACT_PREVIEW_DOCUMENT__}
    cadKernel={cadKernel}
    cadKernels={cadKernels}
  />,
);
