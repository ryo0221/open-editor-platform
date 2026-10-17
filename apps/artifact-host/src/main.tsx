import { createRoot } from 'react-dom/client';
import { HostApp } from './HostApp';
import { BrowserArtifactStorage, referenceArtifacts } from './model';
declare const __ARTIFACT_PREVIEW_DOCUMENT__: string;
const storage = new BrowserArtifactStorage(localStorage),
  samples = referenceArtifacts();
createRoot(document.getElementById('root')!).render(
  <HostApp storage={storage} samples={samples} previewDocument={__ARTIFACT_PREVIEW_DOCUMENT__} />,
);
