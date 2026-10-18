/** Synthetic standalone Host; source verification and actual download stay Host-owned. */
import { zipSync, strToU8 } from 'fflate';
import { contentHash, deepFreeze } from '@editor-platform/artifact-core';
import type {
  DeepReadonly,
  GeoExportCapture,
  GeoDataExportBundle,
} from '@editor-platform/geo-core';
import { createGeoDataExportWorkbench } from '@editor-platform/geo-inspector/import-experiment';
import { budgets, fixture } from './fixture';

async function mount() {
  const scope = new AbortController(),
    content = fixture(),
    original = strToU8(
      JSON.stringify({
        type: 'FeatureCollection',
        features: content.layers[0].features.map((f) => ({
          type: 'Feature',
          id: f.id,
          geometry: f.geometry,
          properties: f.values,
        })),
      }),
    );
  const bytesHash = async (bytes: Uint8Array<ArrayBuffer>) => {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return `sha256:${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  };
  content.sources[0].bytesHash = await bytesHash(original);
  content.sources[0].pin.contentHash = `sha256:${await contentHash({ bytesHash: content.sources[0].bytesHash, format: 'geojson' })}`;
  const saved = deepFreeze({
    content,
    pin: {
      artifactId: 'export-fixture',
      versionId: 'v1',
      contentHash: `sha256:${await contentHash(content)}`,
    },
  });
  let verified = '',
    authorizationCountdown = 0,
    allowed = true,
    closure = true,
    inputsReady = true,
    delivered: DeepReadonly<GeoDataExportBundle>[] = [],
    captureGate: Promise<void> | undefined,
    finishCapture: (() => void) | undefined;
  const urls = new Set<string>();
  const authorize = (candidate: DeepReadonly<GeoExportCapture>) => {
    const granted =
      !scope.signal.aborted &&
      allowed &&
      closure &&
      inputsReady &&
      JSON.stringify(candidate) === verified;
    if (authorizationCountdown > 0 && --authorizationCountdown === 0) {
      allowed = false;
      scope.abort();
    }
    return granted;
  };
  const workbench = createGeoDataExportWorkbench(
    document,
    {
      signal: scope.signal,
      async capture(signal) {
        await captureGate;
        if (signal.aborted || scope.signal.aborted) throw new Error('capture-cancelled');
        if (!inputsReady) throw new Error('inputs-not-ready');
        if (!allowed) throw new Error('export-grant-required');
        if (!closure || (await bytesHash(original)) !== saved.content.sources[0].bytesHash)
          throw new Error('source-bytes-mismatch');
        if (`sha256:${await contentHash(saved.content)}` !== saved.pin.contentHash)
          throw new Error('native-hash-mismatch');
        if (signal.aborted || scope.signal.aborted) throw new Error('capture-cancelled');
        verified = JSON.stringify(saved);
        return structuredClone(saved);
      },
      authorize,
      deliver(bundle, candidate) {
        if (!authorize(candidate)) throw new Error('download-not-authorized');
        const bytes = zipSync({
          [bundle.data.name]: strToU8(bundle.data.text),
          [bundle.receipt.name]: strToU8(bundle.receipt.text),
        });
        const url = URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], { type: 'application/zip' }),
        );
        urls.add(url);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'geographic-data.zip';
        document.body.append(anchor);
        try {
          anchor.click();
          delivered.push(bundle);
        } finally {
          anchor.remove();
          setTimeout(() => {
            URL.revokeObjectURL(url);
            urls.delete(url);
          }, 0);
        }
      },
    },
    { native: budgets, outputBytes: 100000 },
  );
  document.querySelector('#export')!.append(workbench.element);
  const api = {
    state: () => ({ saved, delivered, urls: urls.size }),
    grant: (value: boolean) => {
      allowed = value;
    },
    revokeDuringAuthorization(calls: number) {
      authorizationCountdown = calls;
    },
    closure: (value: boolean) => {
      closure = value;
    },
    inputs: (value: boolean) => {
      inputsReady = value;
    },
    corruptOriginal() {
      original[0] ^= 1;
      verified = '';
    },
    revoke() {
      allowed = false;
      verified = '';
      scope.abort();
    },
    holdCapture() {
      captureGate = new Promise<void>((resolve) => {
        finishCapture = resolve;
      });
    },
    releaseCapture() {
      finishCapture?.();
      captureGate = undefined;
    },
    clearDownloads() {
      delivered = [];
    },
  };
  window.addEventListener('pagehide', () => {
    api.revoke();
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
  });
  window.geoExportTest = api;
  return api;
}
declare global {
  interface Window {
    geoExportTest: Awaited<ReturnType<typeof mount>>;
  }
}
void mount();
