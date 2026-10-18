/** Bounded pending reimport lives outside native/Basic until explicit difference adoption. */
import { contentHash } from '@editor-platform/artifact-core';
import {
  createGeoImporter,
  previewGeoRefresh,
  type GeoAction,
  type GeoDocument,
  type ImportRequest,
} from '@editor-platform/geo-core';
import type { LocalReadSnapshot } from '@editor-platform/extension-contract/draft2';
import type { SurfaceOperation } from '@editor-platform/extension-contract/controlled-surface';
import type { GeoWorkspaceHost } from '@editor-platform/geo-inspector/import-experiment';
import {
  originalHash,
  sourceBudgets,
  sourceLimits,
  type SourceClosure,
} from './geo-source-envelope';
export function createSourceRefresh(options: {
  artifactId: string;
  sourceId(): string;
  signal: AbortSignal;
  stamp(): string;
  snapshot(): LocalReadSnapshot<GeoDocument>;
  originals: Map<string, SourceClosure>;
  commit(
    snapshot: LocalReadSnapshot<GeoDocument>,
    actions: GeoAction[],
    refresh: boolean,
  ): SurfaceOperation;
}) {
  const makeImporter = () =>
    createGeoImporter({
      native: { ...sourceBudgets, bytes: 2_000_000, features: 400, vertices: 2000 },
      sourceBytes: sourceLimits.originals,
      rows: 201,
      columns: 16,
      pendingPlans: 1,
    });
  let epoch = 0;
  let pending:
    | {
        token: string;
        stamp: string;
        snapshot: LocalReadSnapshot<GeoDocument>;
        importer: ReturnType<typeof makeImporter>;
        preview: Awaited<ReturnType<ReturnType<typeof makeImporter>['prepare']>>;
        closure: SourceClosure;
        bytes: Uint8Array;
        targetId: string;
      }
    | undefined;
  const cancel = () => {
    epoch++;
    pending?.importer.dispose();
    pending = undefined;
  };
  options.signal.addEventListener('abort', cancel, { once: true });
  const previewRefreshFile: GeoWorkspaceHost['previewRefreshFile'] = async (
    layerId,
    input,
    name,
  ) => {
    cancel();
    const ticket = epoch,
      stamp = options.stamp(),
      snapshot = options.snapshot(),
      bytes = input.slice();
    const check = () => {
      if (options.signal.aborted || ticket !== epoch || options.stamp() !== stamp)
        throw Error('Refresh preview changed');
    };
    if (bytes.length > sourceLimits.originals || !name || name.length > 128)
      throw Error('Refresh file budget');
    const layer = snapshot.content.layers.find((l) => l.id === layerId),
      sourceId = layer?.features[0]?.sourceRef?.sourceId;
    if (!layer || !sourceId || layer.features.some((f) => f.sourceRef?.sourceId !== sourceId))
      throw Error(
        'Refresh needs one imported source; manual/mixed features require explicit separate layers',
      );
    const source = snapshot.content.sources.find((s) => s.id === sourceId),
      original = source && options.originals.get(source.resourceId);
    if (!original || !['csv', 'geojson'].includes(original.sourceVersion.content.format))
      throw Error('Refresh mapping/original missing');
    const recipe = structuredClone(original.recipe) as {
      format: ImportRequest['format'];
      crs: ImportRequest['crs'];
      fields: ImportRequest['fields'];
      csv?: ImportRequest['csv'];
    };
    const format = original.sourceVersion.content.format as 'csv' | 'geojson';
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
    const id = options.sourceId();
    const manifest = {
      schemaVersion: 1 as const,
      name,
      format,
      byteLength: bytes.length,
      bytesHash: await originalHash(bytes),
    };
    check();
    const hash = await contentHash(manifest);
    check();
    const pin = {
      artifactId: `${options.artifactId}:${id}`,
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
      reason: 'Explicit source refresh',
      content: manifest,
    };
    let raw = '';
    for (const b of bytes) raw += String.fromCharCode(b);
    const closure: SourceClosure = {
      sourceId: id,
      resourceId: `resource-${id}`,
      pin,
      sourceVersion,
      recipe: {},
      encoding: 'base64',
      bytes: btoa(raw),
    };
    const request: ImportRequest = {
      planId: 'i' + nonce,
      revision: { ...snapshot.revision },
      format,
      crs: recipe.crs,
      layerId: layer.id,
      layerName: layer.name,
      source: { id, resourceId: closure.resourceId, pin, attribution: source!.attribution },
      fields: recipe.fields,
      ...(format === 'csv' ? { csv: recipe.csv } : {}),
    };
    const importer = makeImporter();
    try {
      const preview = await importer.prepare(bytes, request);
      check();
      const diff = previewGeoRefresh(layer, preview.plan.layer);
      pending = {
        token: id,
        stamp,
        snapshot,
        importer,
        preview,
        closure,
        bytes,
        targetId: layerId,
      };
      return {
        token: id,
        counts: { ...preview.plan.counts },
        excludedRows: preview.plan.candidates
          .filter((c) => c.diagnostics.some((d) => d.severity === 'error'))
          .map((c) => c.inputRow),
        changes: diff.changes,
        mapping: { recipe, previousSource: source, pendingSource: preview.plan.source },
      };
    } catch (error) {
      importer.dispose();
      throw error;
    }
  };
  const applyRefreshFile: GeoWorkspaceHost['applyRefreshFile'] = async (token, partial) => {
    const captured = pending;
    if (!captured || captured.token !== token || captured.stamp !== options.stamp())
      throw Error('Refresh preview is stale; preview again');
    const excludedRows = captured.preview.plan.candidates
      .filter((c) => c.diagnostics.some((d) => d.severity === 'error'))
      .map((c) => c.inputRow);
    const decision = partial
      ? { mode: 'partial' as const, excludedRows }
      : { mode: 'all' as const };
    const confirmed = await captured.importer.confirm(
      captured.preview,
      decision,
      { bytes: captured.bytes, pin: captured.closure.pin },
      () => {
        if (pending !== captured || options.signal.aborted || options.stamp() !== captured.stamp)
          throw Error('Refresh changed before adoption');
        return {
          revision: options.snapshot().revision,
          canEdit: true,
          budgets: { ...sourceBudgets, bytes: 2_000_000, features: 400, vertices: 2000 },
        };
      },
    );
    if (pending !== captured || options.stamp() !== captured.stamp)
      throw Error('Refresh changed before adoption');
    const action = confirmed.command.actions[0];
    if (action.type !== 'importLayer') throw Error('Refresh import only');
    const old = captured.snapshot.content.layers.find((l) => l.id === captured.targetId)!;
    const replacement = previewGeoRefresh(old, action.layer).layer;
    captured.closure.recipe = {
      format: captured.preview.request.format,
      crs: captured.preview.request.crs,
      fields: structuredClone(captured.preview.request.fields),
      ...(captured.preview.request.csv
        ? { csv: structuredClone(captured.preview.request.csv) }
        : {}),
      decision,
    };
    options.originals.set(captured.closure.resourceId, captured.closure);
    try {
      const result = options.commit(
        captured.snapshot,
        [
          { type: 'retainSource', source: action.source },
          { type: 'refreshLayer', layer: replacement },
        ],
        true,
      );
      if (result.state !== 'applied') options.originals.delete(captured.closure.resourceId);
      cancel();
      return result;
    } catch (error) {
      options.originals.delete(captured.closure.resourceId);
      cancel();
      throw error;
    }
  };
  return { previewRefreshFile, applyRefreshFile };
}
