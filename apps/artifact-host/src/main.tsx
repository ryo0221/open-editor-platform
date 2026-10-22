import { createRoot } from 'react-dom/client';
import cadKernel from 'virtual:cad-kernel-build';
import { HostApp } from './HostApp';
import { BrowserArtifactStorage, cadSample, referenceArtifacts } from './model';
declare const __ARTIFACT_PREVIEW_DOCUMENT__: string;
// The CAD sample is offered only when this Host supplies a kernel build (CAD_OCCT_DIST).
const storage = new BrowserArtifactStorage(localStorage),
  samples = [
    ...referenceArtifacts(),
    ...(cadKernel
      ? [cadSample({ id: 'opencascade.js-2.0.0-beta.b5ff984', buildHash: cadKernel.buildHash })]
      : []),
  ];
createRoot(document.getElementById('root')!).render(
  <HostApp
    storage={storage}
    samples={samples}
    previewDocument={__ARTIFACT_PREVIEW_DOCUMENT__}
    cadKernel={cadKernel}
  />,
);
