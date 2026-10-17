/** Synthetic exact-closure fixture. No IDB, durable storage, adopted production profile or API. */
import { createGeoImporter, emptyGeo } from '@editor-platform/geo-core';
import { budgets } from './fixture';
import { createSourceStaging } from './source-staging';
import { sourceIdentity, type GeoPointEditProfile } from '../src/point-edit/profile';
export async function retainedEditFixture() {
  const bytes = new TextEncoder().encode(
    'ID,lon,lat,metric\n001,12,34,10\n002,13,35,20\n003,,35,30',
  );
  const current = () => ({
    revision: { sessionId: 'retained-fixture', sequence: 0 },
    canEdit: true,
    budgets,
  });
  const stages = createSourceStaging({ limit: 1, current });
  const lease = await stages.prepare(bytes, 'synthetic.csv', 'csv', new AbortController().signal);
  const importer = createGeoImporter({
    native: budgets,
    sourceBytes: 100_000,
    rows: 201,
    columns: 16,
    pendingPlans: 1,
  });
  const preview = await importer.prepare(bytes, {
    planId: 'retained-edit',
    revision: current().revision,
    format: 'csv',
    crs: 'OGC:CRS84',
    layerId: 'retained-sites',
    layerName: 'Retained synthetic sites',
    source: lease.source,
    fields: [{ id: 'metric', input: 'metric', name: 'Metric', type: 'number' }],
    csv: {
      idColumn: 'ID',
      firstCoordinate: 'lon',
      secondCoordinate: 'lat',
      axis: 'longitude-latitude',
      missingCoordinates: 'reject',
    },
  });
  const result = await importer.confirm(
    preview,
    { mode: 'partial', excludedRows: [3] },
    { bytes, pin: lease.source.pin },
    current,
  );
  const content = result.editorCommand.apply(emptyGeo());
  // Test Host holds the complete original and exact source identity independently of native edits.
  const original = bytes.slice(),
    excluded = structuredClone(result.excluded),
    identity = sourceIdentity(content);
  let available = true,
    historyAvailable = true;
  const profile: GeoPointEditProfile = {
    kind: 'retained-source-closure',
    check(candidate, intent) {
      return (
        available &&
        (intent !== 'history' || historyAvailable) &&
        sourceIdentity(candidate) === identity
      );
    },
  };
  lease.release();
  stages.dispose();
  importer.dispose();
  return {
    content,
    profile,
    get original() {
      return original.slice();
    },
    get excluded() {
      return structuredClone(excluded);
    },
    closure(value: boolean) {
      available = value;
    },
    history(value: boolean) {
      historyAvailable = value;
    },
  };
}
