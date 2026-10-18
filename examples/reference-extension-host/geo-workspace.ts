/** Geo-specific trusted Host adapter; no extension API or domain-specific shared grant. */
import { contentHash } from '@editor-platform/artifact-core';
import {
  geoEditorCommand,
  previewGeoRefresh,
  type GeoAction,
  type GeoDocument,
} from '@editor-platform/geo-core';
import type { Context, LocalReadSnapshot } from '@editor-platform/extension-contract/draft2';
import type { ControlledSurfaceController } from '@editor-platform/extension-contract/controlled-surface';
import type {
  GeoPngBundle,
  GeoWorkspaceHost,
} from '@editor-platform/geo-inspector/import-experiment';
import { inspectGeoPhoto } from '@editor-platform/geo-inspector/import-experiment';
import {
  decodeOriginal,
  originalHash,
  sourceBudgets,
  sourceLimits,
  type SourceClosure,
} from './geo-source-envelope';
import type { GeoSourceStorage } from './geo-source-adapter';
import type { createSourceProfile } from './geo-source-profile';
import { createSourceRefresh } from './geo-source-refresh';

export function createGeoWorkspaceHost(options: {
  artifactId: string;
  sourceId(): string;
  context: Context<GeoDocument, never>;
  editor: ControlledSurfaceController<GeoDocument>;
  storage: GeoSourceStorage;
  originals: Map<string, SourceClosure>;
  profile: ReturnType<typeof createSourceProfile>;
  versionId(): string;
  stamp(): string;
  inputChanged?(): void;
  capacity(snapshot: LocalReadSnapshot<GeoDocument>, next: GeoDocument): void;
  placeOnSlide(bundle: GeoPngBundle): Promise<{ name: string; text: string }>;
}): GeoWorkspaceHost {
  const { context, editor } = options;
  if (context.addons.lifecycle.state !== 'granted') throw Error('LifecycleRequired');
  const signal = context.addons.lifecycle.api.signal;
  const current = () => {
    if (context.addons.lifecycle.state !== 'granted') throw Error('LifecycleRequired');
    context.addons.lifecycle.api.assertCurrent();
    const snapshot = context.basic.read();
    return {
      revision: snapshot.revision,
      canEdit: context.addons.edit.state === 'granted' && context.addons.inputs.state === 'granted',
      budgets: sourceBudgets,
    };
  };
  const prepare = (snapshot: LocalReadSnapshot<GeoDocument>, actions: GeoAction[]) => {
    const command = geoEditorCommand(
      { expectedRevision: { ...snapshot.revision }, actions },
      current,
    );
    const apply = (content: GeoDocument) => {
      if (!options.profile.profile.check(content, 'edit')) throw Error('GeoSourceClosureRequired');
      const next = command.apply(content);
      options.capacity(snapshot, next);
      if (!options.profile.profile.check(next, 'edit')) throw Error('GeoSourceClosureRequired');
      return next;
    };
    const next = apply(snapshot.content);
    return {
      baseRevision: { ...snapshot.revision },
      command:
        JSON.stringify(next) === JSON.stringify(snapshot.content) ? null : { ...command, apply },
    };
  };
  const commitAdopted = (
    snapshot: LocalReadSnapshot<GeoDocument>,
    actions: GeoAction[],
    refresh = false,
  ) => {
    const command = geoEditorCommand(
        { expectedRevision: { ...snapshot.revision }, actions },
        current,
      ),
      next = command.apply(snapshot.content);
    options.capacity(snapshot, next);
    const rollback = options.profile.adopt(next, refresh);
    try {
      const result = editor.execute(prepare(snapshot, actions));
      if (result.state !== 'applied') rollback();
      return result;
    } catch (error) {
      rollback();
      throw error;
    }
  };
  return {
    ...createSourceRefresh({
      artifactId: options.artifactId,
      sourceId: options.sourceId,
      signal,
      stamp: options.stamp,
      originals: options.originals,
      snapshot: () => {
        const view = editor.getSnapshot();
        if (view.state !== 'open') throw Error('ScopeRevoked');
        return view.snapshot;
      },
      commit: commitAdopted,
    }),
    signal,
    budgets: sourceBudgets,
    prepare,
    stamp: options.stamp,
    inputChanged: options.inputChanged,
    versions: () => options.storage.inspect(),
    async capture(versionId) {
      const stamp = options.stamp(),
        loaded = await options.storage.read(versionId ?? options.versionId());
      if (stamp !== options.stamp()) throw Error('GeoExportChanged');
      if (!loaded.record) throw Error('GeoNoSavedVersion');
      const record = loaded.record;
      return {
        content: structuredClone(record.request.content),
        pin: {
          artifactId: record.nativeVersion.artifactId,
          versionId: record.nativeVersion.versionId,
          contentHash: 'sha256:' + record.nativeVersion.contentHash,
        },
      };
    },
    refresh(layerId, incomingLayerId) {
      options.stamp();
      if (layerId === incomingLayerId) throw Error('Refresh requires distinct layers');
      const view = editor.getSnapshot();
      if (view.state !== 'open') throw Error('ScopeRevoked');
      const content = view.snapshot.content,
        old = content.layers.find((l) => l.id === layerId),
        incoming = content.layers.find((l) => l.id === incomingLayerId);
      if (!old || !incoming) throw Error('Missing refresh input');
      const preview = previewGeoRefresh(old, incoming);
      return commitAdopted(
        view.snapshot,
        [
          { type: 'deleteLayer', layerId: incomingLayerId },
          { type: 'refreshLayer', layer: preview.layer },
        ],
        true,
      );
    },
    async attachPhoto(asset, bytes, name) {
      const stamp = options.stamp(),
        owned = bytes.slice();
      const capturedAsset = structuredClone(asset);
      if (owned.length > sourceLimits.originals || !name || name.length > 128)
        throw Error('Photo input budget');
      const header = inspectGeoPhoto(owned),
        format = header.format;
      const decoded = await createImageBitmap(
        new Blob([owned], { type: format === 'png' ? 'image/png' : 'image/jpeg' }),
      );
      try {
        if (decoded.width !== header.width || decoded.height !== header.height)
          throw Error('Photo dimension mismatch');
      } finally {
        decoded.close();
      }
      if (stamp !== options.stamp()) throw Error('Photo scope changed');
      const manifest: SourceClosure['sourceVersion']['content'] = {
        schemaVersion: 1 as const,
        name,
        format,
        byteLength: owned.length,
        bytesHash: await originalHash(owned),
      };
      const hash = await contentHash(manifest);
      if (stamp !== options.stamp()) throw Error('Photo scope changed');
      const view = editor.getSnapshot();
      if (view.state !== 'open') throw Error('ScopeRevoked');
      const sourceId = `photo-${crypto.randomUUID()}`,
        resourceId = `resource-${sourceId}`;
      const pin = {
        artifactId: sourceId,
        versionId: `original-${crypto.randomUUID()}`,
        contentHash: 'sha256:' + hash,
      };
      const sourceVersion = {
        artifactId: pin.artifactId,
        versionId: pin.versionId,
        parentVersionId: null,
        schemaVersion: 1,
        contentHash: hash,
        createdAt: new Date().toISOString(),
        createdBy: null,
        reason: 'Local photo',
        content: manifest,
      };
      let raw = '';
      for (const byte of owned) raw += String.fromCharCode(byte);
      const closure: SourceClosure = {
        sourceId,
        resourceId,
        pin,
        sourceVersion,
        recipe: { purpose: 'asset-photo' },
        encoding: 'base64',
        bytes: btoa(raw),
      };
      const source = {
        id: sourceId,
        resourceId,
        pin,
        bytesHash: manifest.bytesHash,
        format,
        adapterVersion: 'geo-local-photo@1',
        declaredCrs: 'OGC:CRS84' as const,
        axis: 'longitude-latitude' as const,
        attribution: 'User-selected local inspection photo; retained privately.',
      };
      const w = structuredClone(
        view.snapshot.content.workspace ?? {
          schemaVersion: 1 as const,
          styles: [],
          annotations: [],
          views: [],
          joins: [],
          assets: [],
          comparisons: [],
        },
      );
      const nextAsset = {
        ...capturedAsset,
        photos: [...capturedAsset.photos, { sourceId, name, required: true }],
      };
      w.assets = [
        ...w.assets.filter((a) => a.layerId !== asset.layerId || a.featureId !== asset.featureId),
        nextAsset,
      ];
      options.originals.set(resourceId, closure);
      try {
        const result = commitAdopted(view.snapshot, [
          { type: 'retainSource', source },
          { type: 'setWorkspace', workspace: w },
        ]);
        if (result.state !== 'applied') options.originals.delete(resourceId);
        return result;
      } catch (error) {
        options.originals.delete(resourceId);
        throw error;
      }
    },
    original(sourceId) {
      options.stamp();
      const source = context.basic.read().content.sources.find((s) => s.id === sourceId),
        entry = source && options.originals.get(source.resourceId);
      if (!entry || entry.sourceId !== sourceId) throw Error('Required original missing');
      const format = entry.sourceVersion.content.format;
      return {
        bytes: decodeOriginal(entry.bytes),
        name: entry.sourceVersion.content.name,
        mediaType:
          format === 'csv'
            ? 'text/csv'
            : format === 'geojson'
              ? 'application/geo+json'
              : format === 'png'
                ? 'image/png'
                : 'image/jpeg',
      };
    },
    photo(sourceId) {
      options.stamp();
      const content = context.basic.read().content,
        source = content.sources.find((s) => s.id === sourceId),
        entry = source && options.originals.get(source.resourceId);
      if (
        !entry ||
        entry.sourceId !== sourceId ||
        !['png', 'jpeg'].includes(entry.sourceVersion.content.format)
      )
        throw Error('Required photo resource missing');
      return decodeOriginal(entry.bytes);
    },
    placeOnSlide: options.placeOnSlide,
  };
}
