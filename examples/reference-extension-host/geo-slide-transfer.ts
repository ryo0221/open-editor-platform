/** Host-owned static image handoff using the existing public Slide native file format.
 * Geo never changes Slide's schema or creates an editable/live map embed. */
import { commitVersion, createArtifact, serializeArtifact } from '@editor-platform/artifact-core';
import type { GeoPngBundle } from '@editor-platform/geo-inspector/import-experiment';
export async function geoSlideImageArtifact(bundle: GeoPngBundle) {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(bundle.dataUrl))
    throw Error('Slide requires a local PNG snapshot');
  const content = {
    schemaVersion: 2,
    width: 960,
    height: 600,
    slides: [
      {
        id: 'geo-map-slide',
        title: 'Geographic map',
        background: '#ffffff',
        notes: 'Fixed geographic image provenance\n' + JSON.stringify(bundle.receipt, null, 2),
        objects: [
          {
            id: 'geo-map-image',
            type: 'image',
            bounds: { x: 0, y: 0, width: 960, height: 600 },
            text: 'Fixed geographic map',
            fill: '#ffffff',
            src: bundle.dataUrl,
          },
        ],
      },
    ],
  };
  const artifact = await commitVersion(
    createArtifact('slide', 'Geographic map · fixed image', content, {
      source: 'imported',
      format: 'geo-fixed-png@1',
      importedAt: new Date().toISOString(),
    }),
    null,
    'Place fixed geographic PNG',
  );
  const text = serializeArtifact(artifact);
  if (new TextEncoder().encode(text).length > 16_000_000)
    throw Error('Slide native file exceeds import budget');
  return { name: 'geographic-map.slide.json', text };
}
