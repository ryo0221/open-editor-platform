/** Host-owned retained-version export. No new shared grant, Storage or native format. */
import { canonicalJson, deepFreeze } from '@editor-platform/artifact-core';
import type {
  DeepReadonly,
  GeoExportCapture,
  GeoDataExportBundle,
} from '@editor-platform/geo-core';
import { createGeoDataExportWorkbench } from '@editor-platform/geo-inspector/import-experiment';
import {
  checkedSourceEnvelope,
  sourceBudgets,
  sourceLimits,
  type GeoSourceEnvelope,
} from './geo-source-envelope';

export function createSavedGeoExportAuthority(options: {
  artifactId: string;
  signal: AbortSignal;
  versionId(): string;
  /** Flush the existing controller Inputs; throw on invalid/composing input. */
  flush(): void;
  /** Fresh scope, authority, input and revision guard, including selected version. */
  stamp(): string;
  read(versionId: string): Promise<GeoSourceEnvelope | undefined>;
}) {
  let generation = 0;
  let closed = options.signal.aborted;
  let proof: { stamp: string; key: string; record: DeepReadonly<GeoSourceEnvelope> } | undefined;
  const invalidate = () => {
    generation++;
    proof = undefined;
  };
  const dispose = () => {
    closed = true;
    invalidate();
  };
  options.signal.addEventListener('abort', dispose, { once: true });
  const stamp = () => {
    if (closed || options.signal.aborted) throw Error('GeoExportScopeClosed');
    return options.stamp();
  };
  return {
    async capture(signal: AbortSignal): Promise<GeoExportCapture> {
      invalidate();
      const ticket = generation;
      if (closed || options.signal.aborted) throw Error('GeoExportScopeClosed');
      if (signal.aborted) throw Error('GeoExportCancelled');
      options.flush();
      const versionId = options.versionId();
      if (!versionId) throw Error('GeoNoSavedVersion');
      const before = stamp();
      const check = () => {
        const now = stamp();
        if (signal.aborted || generation !== ticket) throw Error('GeoExportCancelled');
        if (now !== before) throw Error('GeoExportChanged');
      };
      const loaded = await options.read(versionId);
      check();
      if (!loaded) throw Error('GeoNoSavedVersion');
      // Verification owns its serialized input before every digest; no latest/draft substitute.
      const record = await checkedSourceEnvelope(JSON.stringify(loaded), options.artifactId);
      check();
      if (record.nativeVersion.versionId !== versionId) throw Error('GeoExportVersionChanged');
      const capture: GeoExportCapture = {
        content: record.request.content,
        pin: {
          artifactId: record.nativeVersion.artifactId,
          versionId: record.nativeVersion.versionId,
          contentHash: 'sha256:' + record.nativeVersion.contentHash,
        },
      };
      // Keep complete verified originals alive privately through confirmation/download.
      // Basic/controlled snapshots never contain original bytes or a second native history.
      proof = { stamp: before, key: canonicalJson(capture), record: deepFreeze(record) };
      return structuredClone(capture);
    },
    authorize(capture: DeepReadonly<GeoExportCapture>): boolean {
      try {
        const owned = proof;
        if (!owned || stamp() !== owned.stamp) return false;
        return canonicalJson(capture) === owned.key && proof === owned && !options.signal.aborted;
      } catch {
        return false;
      }
    },
    dispose() {
      dispose();
      options.signal.removeEventListener('abort', dispose);
    },
  };
}

export function mountSavedGeoExport(
  doc: Document,
  options: Parameters<typeof createSavedGeoExportAuthority>[0],
) {
  const authority = createSavedGeoExportAuthority(options),
    root = doc.createElement('section'),
    downloads = doc.createElement('div');
  root.setAttribute('aria-label', 'Saved geographic data output');
  const notice = doc.createElement('p');
  notice.textContent =
    'Export the selected retained version. Apply and Save first to include new edits. Download both the data and its receipt.';
  const urls = new Set<string>();
  const retire = () => {
    downloads.replaceChildren();
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
  };
  const workbench = createGeoDataExportWorkbench(
    doc,
    {
      signal: options.signal,
      capture: authority.capture,
      authorize: authority.authorize,
      retire,
      deliver(bundle: DeepReadonly<GeoDataExportBundle>, capture: DeepReadonly<GeoExportCapture>) {
        retire();
        if (!authority.authorize(capture)) throw Error('GeoExportNotAuthorized');
        const fragment = doc.createDocumentFragment();
        try {
          for (const [file, label] of [
            [bundle.data, 'Download geographic data'],
            [bundle.receipt, 'Download provenance receipt'],
          ] as const) {
            const link = doc.createElement('a');
            const url = URL.createObjectURL(new Blob([file.text], { type: file.mediaType }));
            urls.add(url);
            link.href = url;
            link.download = file.name;
            link.textContent = label;
            link.style.display = 'block';
            link.onclick = (event) => {
              if (!authority.authorize(capture) || !urls.has(url)) {
                event.preventDefault();
                retire();
                notice.textContent =
                  'Output retired. Load the saved version again after finishing input or restoring permission.';
              }
            };
            fragment.append(link);
          }
          if (!authority.authorize(capture)) throw Error('GeoExportNotAuthorized');
          downloads.replaceChildren(fragment);
        } catch (error) {
          retire();
          throw error;
        }
      },
    },
    { native: sourceBudgets, outputBytes: sourceLimits.record },
  );
  root.append(notice, workbench.element, downloads);
  const dispose = () => {
    workbench.dispose();
    authority.dispose();
    retire();
  };
  options.signal.addEventListener('abort', retire, { once: true });
  return {
    element: root,
    dispose() {
      dispose();
      options.signal.removeEventListener('abort', retire);
    },
    /** Host input/revision changes immediately remove volatile download links. */
    retire,
  };
}
