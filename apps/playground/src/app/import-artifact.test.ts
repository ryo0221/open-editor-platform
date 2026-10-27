import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  commitVersion,
  createArtifact,
  serializeArtifact,
  type Artifact,
} from '@editor-platform/artifact-core';
import { ReferenceResolver, type EmbeddedReference } from '@editor-platform/artifact-references';
import { nativeReferenceAdapters } from '@editor-platform/reference-adapters';
import { createSchedule, type ScheduleDocument } from '@editor-platform/schedule/model';
import { makeRow, type StructuredData } from '@editor-platform/structured-data/model';
import { defaultView } from '@editor-platform/structured-data/views';
import { readImportFiles } from './import-artifact';

function plan(): StructuredData {
  const columns = [
    { id: 'col-name', name: 'Task', type: 'text' as const, required: true, defaultValue: 'Task' },
    { id: 'col-start', name: 'Start', type: 'date' as const },
    { id: 'col-end', name: 'End', type: 'date' as const },
  ];
  const base: StructuredData = { schemaVersion: 2, columns, rows: [] };
  const rows = [
    {
      ...makeRow(base, 'row-1'),
      values: { 'col-name': 'Design review', 'col-start': '2026-10-26', 'col-end': '2026-10-28' },
    },
  ];
  const view = {
    ...defaultView({ ...base, rows }),
    id: 'view-plan',
    name: 'Release plan',
    projection: 'Timeline' as const,
    timeline: {
      start: 'col-start',
      end: 'col-end',
      group: '',
      scale: 'week' as const,
      from: '',
      to: '',
    },
  };
  return { ...base, rows, views: [view] };
}

/** A saved Data artifact and a Schedule whose saved version and draft both show it as a lane. */
async function exported() {
  const data = await commitVersion(createArtifact('data', 'Plan', plan()), null, 'first');
  const version = data.versions[0];
  const reference: EmbeddedReference = {
    schemaVersion: 1,
    source: {
      artifactId: data.id,
      domain: 'data',
      target: { kind: 'timeline', viewId: 'view-plan' },
    },
    mode: 'fixed',
    fit: 'contain',
    snapshot: {
      artifactId: data.id,
      domain: 'data',
      versionId: version.versionId,
      revision: 1,
      contentHash: version.contentHash,
      content: version.content,
      dependencies: [],
    },
  };
  const content: ScheduleDocument = {
    ...createSchedule('UTC'),
    lanes: [{ id: 'lane-1', reference }],
  };
  const schedule = await commitVersion(createArtifact('schedule', 'Calendar', content), null, 'v1');
  return { data, schedule };
}

const file = (artifact: Artifact<unknown>, name = `${artifact.name}.json`) =>
  new File([serializeArtifact(artifact)], name, { type: 'application/json' });

const context = () => ({
  exists: () => false,
  references: new ReferenceResolver(
    {
      list: async () => [],
      subscribe: () => () => {},
      read: async () => {
        throw new Error('No live reads during import');
      },
    },
    nativeReferenceAdapters,
  ),
});

const lane = (content: unknown) => (content as ScheduleDocument).lanes[0].reference;

describe('importing several native files at once (ST-03#5, ST-03#6)', () => {
  it('re-identifies every file and points drafts at the new IDs of the same import', async () => {
    const { data, schedule } = await exported();
    const [importedSchedule, importedData] = await readImportFiles(
      [file(schedule), file(data)],
      context(),
    );
    expect(importedData.id).not.toBe(data.id);
    expect(importedSchedule.id).not.toBe(schedule.id);
    expect(importedData.versions.map((v) => [v.versionId, v.contentHash])).toEqual(
      data.versions.map((v) => [v.versionId, v.contentHash]),
    );
    const draft = lane(importedSchedule.draft.content);
    expect(draft.source.artifactId).toBe(importedData.id);
    expect(draft.snapshot.artifactId).toBe(importedData.id);
    expect(draft.snapshot.versionId).toBe(data.versions[0].versionId);
    // The saved version is immutable: its bytes, hash and reference stay as exported.
    expect(importedSchedule.versions[0].contentHash).toBe(schedule.versions[0].contentHash);
    expect(lane(importedSchedule.versions[0].content).source.artifactId).toBe(data.id);
  });

  it('leaves references to artifacts outside the import unchanged', async () => {
    const { schedule } = await exported();
    const [imported] = await readImportFiles([file(schedule)], context());
    expect(lane(imported.draft.content).source.artifactId).toBe(
      lane(schedule.draft.content).source.artifactId,
    );
  });

  it('refuses the whole import and names the file when one file is invalid', async () => {
    const { data, schedule } = await exported();
    const broken = new File(['{"schemaVersion":1,"kind":"data"'], 'broken.json');
    await expect(readImportFiles([file(data), broken, file(schedule)], context())).rejects.toThrow(
      /^broken\.json: /,
    );
  });

  it('refuses an import that contains the same artifact twice', async () => {
    const { data } = await exported();
    await expect(readImportFiles([file(data), file(data, 'copy.json')], context())).rejects.toThrow(
      'copy.json: This artifact is already in the import',
    );
  });

  it('keeps the single-file message unchanged', async () => {
    const broken = new File(['not json'], 'broken.json');
    await expect(readImportFiles([broken], context())).rejects.toThrow(/^(?!broken\.json)/);
  });
});
