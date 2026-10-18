import { useLayoutEffect, useRef } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import {
  geoEditorCommand,
  previewGeoRefresh,
  emptyGeoWorkspace,
  type GeoAction,
  type GeoDocument,
} from '@editor-platform/geo-core';
import {
  createImportWorkbench,
  createGeoWorkspaceSurface,
  createGeoDataExportWorkbench,
  inspectGeoPhoto,
  type GeoWorkspaceHost,
} from '@editor-platform/geo-inspector/import-experiment';
import type { EditorSession, EditorInputs, EditorCommand } from '@editor-platform/editor-core';
import type { LocalReadSnapshot } from '@editor-platform/extension-contract/draft2';
import type { SurfaceOperation } from '@editor-platform/extension-contract/controlled-surface';
import {
  sourceBudgets,
  sourceLimits,
  decodeOriginal,
  type SourceClosure,
} from './geo-source-envelope';
import { createSourceProfile } from './geo-source-profile';
import { createSourceRefresh } from './geo-source-refresh';
import { geoSlideImageArtifact } from './geo-slide-transfer';
import { closureFor, stageSource, validateGeoRecord } from './resources';
import { geoController } from './controller';
import { DataJoinTools } from './data-join';
import type { Content, StoredArtifact } from '../model';
export interface GeoSurfaceProps {
  artifact: StoredArtifact;
  session: EditorSession<Content>;
  inputs: EditorInputs;
  readOnly: boolean;
  records: StoredArtifact[];
  saved(): StoredArtifact;
  execute(
    command: EditorCommand<GeoDocument>,
    resources?: SourceClosure[],
    dataInputs?: StoredArtifact['geoDataInputs'],
  ): boolean;
  history(direction: 'undo' | 'redo'): void;
  save(): Promise<void>;
}
export function GeoSurface(props: GeoSurfaceProps) {
  const mount = useRef<HTMLDivElement>(null),
    latest = useRef(props),
    adapter = useRef<ReturnType<typeof geoController>>(undefined);
  latest.current = props;
  useLayoutEffect(() => {
    const originals = new Map(
      (props.artifact.geoResources ?? []).map((c) => [c.resourceId, structuredClone(c)]),
    );
    let sourceSequence = 0;
    for (const c of originals.values()) {
      const n = /^source-(\d+)$/.exec(c.sourceId);
      if (n) sourceSequence = Math.max(sourceSequence, Number(n[1]));
    }
    const sourceId = () => `source-${++sourceSequence}`;
    const pendingResources = () => [...originals.values()];
    const bridge = geoController({
      id: props.artifact.id,
      session: props.session as EditorSession<GeoDocument>,
      inputs: props.inputs,
      canEdit: () => !latest.current.readOnly,
      execute: (cmd) => latest.current.execute(cmd, pendingResources()),
      history: (d) => latest.current.history(d),
      save: () => latest.current.save(),
    });
    adapter.current = bridge;
    const profile = createSourceProfile({
      originals,
      allowManualFeatures: true,
      current: () => {
        bridge.stamp();
      },
    });
    profile.adopt(bridge.snapshot().content);
    const prepare = (snapshot: LocalReadSnapshot<GeoDocument>, actions: GeoAction[]) => {
      const cmd = geoEditorCommand({ expectedRevision: snapshot.revision, actions }, () => ({
        revision: bridge.snapshot().revision,
        canEdit: !latest.current.readOnly && !bridge.signal.aborted,
        budgets: sourceBudgets,
      }));
      const next = cmd.apply(snapshot.content);
      closureFor(next, originals);
      return { baseRevision: snapshot.revision, command: cmd };
    };
    const commit = (
      snapshot: LocalReadSnapshot<GeoDocument>,
      actions: GeoAction[],
      refresh = false,
    ): SurfaceOperation => {
      const prepared = prepare(snapshot, actions),
        next = prepared.command.apply(snapshot.content),
        rollback = profile.adopt(next, refresh);
      try {
        const result = bridge.controller.execute(prepared);
        if (result.state !== 'applied') rollback();
        return result;
      } catch (e) {
        rollback();
        throw e;
      }
    };
    const host: GeoWorkspaceHost = {
      ...createSourceRefresh({
        artifactId: props.artifact.id,
        sourceId,
        signal: bridge.signal,
        stamp: bridge.stamp,
        snapshot: bridge.snapshot,
        originals,
        commit,
      }),
      signal: bridge.signal,
      budgets: sourceBudgets,
      prepare,
      stamp: bridge.stamp,
      inputChanged: bridge.inputChanged,
      async capture(versionId) {
        const stamp = bridge.stamp(),
          record = structuredClone(latest.current.saved());
        await validateGeoRecord(record);
        if (stamp !== bridge.stamp()) throw Error('Geo capture changed');
        const v = versionId
          ? record.versions.find((v) => v.versionId === versionId)
          : record.versions.at(-1);
        if (!v) throw Error('Save a Geo version first');
        return {
          content: v.content as GeoDocument,
          pin: {
            artifactId: record.id,
            versionId: v.versionId,
            contentHash: 'sha256:' + v.contentHash,
          },
        };
      },
      async versions() {
        const record = latest.current.saved();
        return {
          head: record.versions.at(-1)?.versionId ?? null,
          versionIds: record.versions.map((v) => v.versionId),
        };
      },
      refresh(layerId, incomingLayerId) {
        const snapshot = bridge.snapshot(),
          old = snapshot.content.layers.find((l) => l.id === layerId),
          incoming = snapshot.content.layers.find((l) => l.id === incomingLayerId);
        if (!old || !incoming || layerId === incomingLayerId)
          throw Error('Choose distinct refresh inputs');
        return commit(
          snapshot,
          [
            { type: 'deleteLayer', layerId: incomingLayerId },
            { type: 'refreshLayer', layer: previewGeoRefresh(old, incoming).layer },
          ],
          true,
        );
      },
      original(id) {
        bridge.stamp();
        const source = bridge.snapshot().content.sources.find((s) => s.id === id),
          c = source && originals.get(source.resourceId);
        if (!c) throw Error('Geo original missing');
        return {
          bytes: decodeOriginal(c.bytes),
          name: c.sourceVersion.content.name,
          mediaType:
            c.sourceVersion.content.format === 'csv'
              ? 'text/csv'
              : c.sourceVersion.content.format === 'geojson'
                ? 'application/geo+json'
                : 'image/' + c.sourceVersion.content.format,
        };
      },
      photo(id) {
        bridge.stamp();
        const s = bridge.snapshot().content.sources.find((s) => s.id === id),
          c = s && originals.get(s.resourceId);
        if (!c) throw Error('Photo original missing');
        return decodeOriginal(c.bytes);
      },
      async attachPhoto(asset, input, name) {
        const stamp = bridge.stamp(),
          bytes = input.slice(),
          captured = structuredClone(asset),
          header = inspectGeoPhoto(bytes),
          image = await createImageBitmap(new Blob([bytes], { type: 'image/' + header.format }));
        try {
          if (image.width !== header.width || image.height !== header.height)
            throw Error('Photo dimensions');
        } finally {
          image.close();
        }
        const c = await stageSource(bytes, name, header.format, sourceId());
        if (stamp !== bridge.stamp()) throw Error('Photo input changed');
        const snapshot = bridge.snapshot(),
          w = structuredClone(snapshot.content.workspace ?? emptyGeoWorkspace());
        w.assets = [
          ...w.assets.filter(
            (a) => a.layerId !== captured.layerId || a.featureId !== captured.featureId,
          ),
          {
            ...captured,
            photos: [...captured.photos, { sourceId: c.sourceId, name, required: true }],
          },
        ];
        originals.set(c.resourceId, c);
        try {
          const result = commit(snapshot, [
            {
              type: 'retainSource',
              source: {
                id: c.sourceId,
                resourceId: c.resourceId,
                pin: c.pin,
                bytesHash: c.sourceVersion.content.bytesHash,
                format: header.format,
                adapterVersion: 'geo-local-photo@1',
                declaredCrs: 'OGC:CRS84',
                axis: 'longitude-latitude',
                attribution: 'User-selected local inspection photo',
              },
            },
            { type: 'setWorkspace', workspace: w },
          ]);
          if (result.state !== 'applied') originals.delete(c.resourceId);
          return result;
        } catch (e) {
          originals.delete(c.resourceId);
          throw e;
        }
      },
      async placeOnSlide(bundle) {
        const stamp = bridge.stamp(),
          result = await geoSlideImageArtifact(bundle);
        if (stamp !== bridge.stamp()) throw Error('Slide transfer changed');
        return result;
      },
    };
    const surface = createGeoWorkspaceSurface(document, bridge.controller, host);
    const staged = new Map<string, SourceClosure>();
    const importer = createImportWorkbench(
      document,
      {
        signal: bridge.signal,
        importedNotice:
          'Native originals are retained in this artifact. Save a version before cross-artifact references.',
        current: () => ({
          revision: bridge.snapshot().revision,
          canEdit: !latest.current.readOnly && !bridge.signal.aborted,
          budgets: sourceBudgets,
        }),
        async source(bytes, name, format, signal) {
          const stamp = bridge.stamp(),
            id = sourceId(),
            c = await stageSource(bytes, name, format, id);
          if (signal.aborted || stamp !== bridge.stamp()) throw Error('Import preparation changed');
          staged.set(id, c);
          return {
            source: {
              id,
              resourceId: c.resourceId,
              pin: c.pin,
              attribution: 'User-selected local file; original retained',
            },
            release() {
              staged.delete(id);
            },
          };
        },
        commit(result, material) {
          bridge.stamp();
          const action = result.command.actions[0];
          if (action.type !== 'importLayer') throw Error('Import only');
          const c = staged.get(action.source.id);
          if (
            !c ||
            canonicalJson(c.pin) !== canonicalJson(material.pin) ||
            c.sourceVersion.content.bytesHash !== result.sourceBytesHash
          )
            throw Error('Geo source mismatch');
          originals.set(c.resourceId, { ...c, recipe: material.recipe });
          try {
            const applied = commit(bridge.snapshot(), result.command.actions);
            if (applied.state !== 'applied') originals.delete(c.resourceId);
            return applied;
          } catch (e) {
            originals.delete(c.resourceId);
            throw e;
          }
        },
      },
      {
        native: { ...sourceBudgets, bytes: 2_000_000, features: 400, vertices: 2000 },
        sourceBytes: sourceLimits.originals,
        rows: 201,
        columns: 16,
        pendingPlans: 1,
      },
    );
    const urls = new Set<string>();
    let exportStamp = '';
    const retire = () => {
      for (const u of urls) URL.revokeObjectURL(u);
      urls.clear();
      downloads.replaceChildren();
    };
    const downloads = document.createElement('div');
    const exporter = createGeoDataExportWorkbench(
      document,
      {
        signal: bridge.signal,
        retire,
        async capture() {
          const captured = await host.capture();
          exportStamp = bridge.stamp();
          return captured;
        },
        authorize: () => {
          try {
            return exportStamp === bridge.stamp();
          } catch {
            return false;
          }
        },
        deliver(bundle) {
          if (exportStamp !== bridge.stamp()) throw Error('Export changed');
          for (const file of [bundle.data, bundle.receipt]) {
            const url = URL.createObjectURL(new Blob([file.text], { type: file.mediaType })),
              a = document.createElement('a');
            urls.add(url);
            a.href = url;
            a.download = file.name;
            a.textContent = 'Download ' + file.name;
            a.onclick = (e) => {
              try {
                if (!urls.has(url) || exportStamp !== bridge.stamp()) throw Error('retired');
              } catch {
                e.preventDefault();
                retire();
              }
            };
            downloads.append(a, document.createElement('br'));
          }
        },
      },
      { native: sourceBudgets, outputBytes: 500_000 },
    );
    const stop = bridge.controller.subscribe(() => retire()),
      stopInputs = props.inputs.subscribe(() => retire());
    const importPanel = document.createElement('details'),
      importTitle = document.createElement('summary');
    importTitle.textContent = 'Import CSV / GeoJSON';
    importPanel.open = bridge.snapshot().content.layers.length === 0;
    importPanel.append(importTitle, importer.element);
    const exportPanel = document.createElement('details'),
      exportTitle = document.createElement('summary');
    exportTitle.textContent = 'GeoJSON / CSV export';
    exportPanel.append(exportTitle, exporter.element, downloads);
    const stopImport = bridge.controller.subscribe(() => {
      if (bridge.snapshot().content.layers.length) importPanel.open = false;
    });
    mount.current!.append(importPanel, surface.element, exportPanel);
    return () => {
      stop();
      stopImport();
      stopInputs();
      retire();
      importer.dispose();
      surface.dispose();
      exporter.dispose();
      bridge.dispose();
      mount.current?.replaceChildren();
      adapter.current = undefined;
    };
  }, [props.artifact.id, props.session, props.inputs]);
  useLayoutEffect(() => {
    adapter.current?.notify();
  }, [props.artifact.draft.content, props.artifact.versions, props.readOnly]);
  return (
    <div className="playground-geo">
      <style>{`.playground-geo{padding:16px;max-width:100%;overflow-wrap:anywhere}.playground-geo details{background:white;border:1px solid #ccd8e0;border-radius:8px;padding:12px;margin:8px 0}.playground-geo summary{cursor:pointer;font-weight:600}.playground-geo .geo-import-workbench label{display:block;margin:8px 0}.playground-geo .geo-import-workbench fieldset{min-width:0}.playground-geo .geo-layout>section:last-child{max-height:65vh;overflow:auto;padding:0 8px}.playground-geo button,.playground-geo input,.playground-geo select{max-width:100%}`}</style>
      <div ref={mount} />
      <DataJoinTools {...props} />
    </div>
  );
}
