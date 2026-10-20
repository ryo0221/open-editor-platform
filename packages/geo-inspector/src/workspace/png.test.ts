import { describe, expect, it, vi } from 'vitest';
import { contentHash } from '@editor-platform/artifact-core';
import { emptyGeoWorkspace, type GeoDocument } from '@editor-platform/geo-core';
import { createGeoPng } from './png';

describe('fixed Geo PNG byte provenance', () => {
  it.each([68, 70001])(
    'uses the same %i encoded bytes for download, receipt and Slide data URL',
    async (length) => {
      const encoded = Uint8Array.from({ length }, (_, i) => i % 256);
      const secondEncoder = vi.fn(() => 'data:image/png;base64,AA==');
      const image = { src: '', decode: vi.fn(async () => {}), removeAttribute: vi.fn() };
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: vi.fn() }),
        toBlob(callback: BlobCallback) {
          callback(new Blob([encoded], { type: 'image/png' }));
        },
        toDataURL: secondEncoder,
      };
      const doc = {
        createElement(tag: string) {
          if (tag === 'img') return image;
          if (tag === 'canvas') return canvas;
          throw Error('Unexpected element');
        },
      } as unknown as Document;
      const content: GeoDocument = {
        schemaVersion: 1,
        sources: [],
        layers: [],
        workspace: {
          ...emptyGeoWorkspace(),
          views: [{ id: 'v', name: 'View', extent: [-1, -1, 1, 1], styles: [], annotations: [] }],
        },
      };
      const pin = {
        artifactId: 'map',
        versionId: 'v1',
        contentHash: 'sha256:' + (await contentHash(content)),
      };
      const bundle = await createGeoPng(
        doc,
        { content, pin },
        'v',
        [960, 600],
        { actions: 10, bytes: 65536, depth: 24, layers: 1, features: 200, vertices: 1000 },
        () => {},
      );
      expect(bundle.bytes).toEqual(encoded);
      expect(bundle.dataUrl).toMatch(/^data:image\/png;base64,/);
      expect(Uint8Array.from(atob(bundle.dataUrl.split(',')[1]), (c) => c.charCodeAt(0))).toEqual(
        encoded,
      );
      const expectedHash =
        'sha256:' +
        Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoded)), (b) =>
          b.toString(16).padStart(2, '0'),
        ).join('');
      expect(bundle.receipt.outputBytesHash).toBe(expectedHash);
      expect(secondEncoder).not.toHaveBeenCalled();
      expect(image.removeAttribute).toHaveBeenCalledWith('src');
    },
  );
});
