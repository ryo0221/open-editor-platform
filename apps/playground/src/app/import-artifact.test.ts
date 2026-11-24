import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  commitVersion,
  contentHash,
  createArtifact,
  clone,
  serializeArtifact,
  type Artifact,
} from '@editor-platform/artifact-core';
import {
  formatLiveValue,
  ReferenceResolver,
  type EmbeddedReference,
  type LiveReference,
} from '@editor-platform/artifact-references';
import { createDocument, makeBlock } from '@editor-platform/document/model';
import { createDeck, insertSlideCitation } from '@editor-platform/slide/model';
import { nativeReferenceAdapters } from '@editor-platform/reference-adapters';
import { createSchedule, type ScheduleDocument } from '@editor-platform/schedule/model';
import { makeRow, type StructuredData } from '@editor-platform/structured-data/model';
import { defaultView } from '@editor-platform/structured-data/views';
import { readImportFiles } from './import-artifact';
import { hostNativeArtifactByteLimit } from '@editor-platform/editor-host';
import { builtinTemplates, prepareInstantiation } from '@editor-platform/templates';

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

it.each(['document', 'slide'] as const)(
  'rejects altered fixed quotes on native %s import',
  async (kind) => {
    const content = { value: 12 };
    const dependency = { unit: 'JPY' };
    const snapshot = {
      artifactId: 'source',
      domain: 'counter',
      versionId: 'saved',
      revision: 1,
      content,
      contentHash: await contentHash(content),
      dependencies: [
        { id: 'units', content: dependency, contentHash: await contentHash(dependency) },
      ],
    };
    const value = {
      schemaVersion: 2,
      mode: 'fixed',
      snapshot: clone(snapshot),
      source: {
        artifactId: 'source',
        domain: 'counter',
        target: { kind: 'value', targetId: 'base', metricId: 'value' },
      },
      presentation: {
        kind: 'value',
        value: 12,
        format: { style: 'decimal', digits: 0, unit: '円' },
      },
    } satisfies LiveReference;
    const figure = {
      ...value,
      snapshot: clone(snapshot),
      source: { ...value.source, target: { kind: 'figure', figureId: 'figure' } },
      presentation: { kind: 'figure', label: '図' },
    } satisfies LiveReference;
    function nativeArtifact(): Artifact<unknown> {
      if (kind === 'document') {
        const doc = createDocument();
        const text = formatLiveValue(value.presentation);
        doc.blocks[1] = {
          ...doc.blocks[1],
          text,
          rich: [{ text, liveQuote: { id: 'value', reference: value } }],
        };
        doc.blocks.push({ ...makeBlock('image'), liveFigure: figure });
        return createArtifact(kind, 'Quotes', doc);
      }
      const deck = createDeck();
      const slideId = deck.slides[0].id;
      const withValue = insertSlideCitation(slideId, 'value', value).apply(deck);
      return createArtifact(
        kind,
        'Quotes',
        insertSlideCitation(slideId, 'figure', figure).apply(withValue),
      );
    }
    const valid = await commitVersion(nativeArtifact(), null, 'first');
    await expect(readImportFiles([file(valid)], context())).resolves.toHaveLength(1);
    for (const reference of [value, figure]) {
      reference.snapshot.content.value = 18;
      await expect(readImportFiles([file(nativeArtifact())], context())).rejects.toThrow(
        '参照元の内容が一致しません。',
      );
      reference.snapshot.content.value = 12;
      reference.snapshot.dependencies[0].contentHash = '0'.repeat(64);
      const badVersion = await commitVersion(nativeArtifact(), null, 'altered');
      // Keep the draft valid and the outer version checksum consistent with the tampered version.
      await expect(
        readImportFiles([file({ ...badVersion, draft: valid.draft })], context()),
      ).rejects.toThrow('参照依存の内容が一致しません。');
      reference.snapshot.dependencies[0].contentHash = snapshot.dependencies[0].contentHash;
    }
  },
);

it('imports native JSON at the current byte boundary, preserves versions and rejects the next byte', async () => {
  const { data } = await exported();
  const json = serializeArtifact(data);
  // Valid JSON whitespace exercises the file boundary without adding invalid
  // domain content or allocating a giant visible field in the imported editor.
  const padding = ' '.repeat(hostNativeArtifactByteLimit - new TextEncoder().encode(json).length);
  const boundary = new File([json, padding], 'boundary.json', { type: 'application/json' });
  expect(boundary.size).toBe(hostNativeArtifactByteLimit);
  const [imported] = await readImportFiles([boundary], context());
  expect(imported.versions).toEqual(
    data.versions.map((version) => ({ ...version, artifactId: imported.id })),
  );
  expect(imported.draft.content).toEqual(data.draft.content);
  const oversized = new File([boundary, ' '], 'oversized.json', { type: 'application/json' });
  await expect(readImportFiles([oversized], context())).rejects.toThrow('64 MiB');
});

it('retains the fixed Design template through repeated native imports', async () => {
  const template = builtinTemplates.find((t) => t.templateId === 'design-dashboard')!;
  const prepared = await prepareInstantiation(template, template.sample, 'dashboard-test');
  const saved = await commitVersion(prepared.artifact, null, 'first');
  const [first] = await readImportFiles([file(saved)], context());
  const [second] = await readImportFiles([file(first)], context());
  expect(new Set([saved.id, first.id, second.id]).size).toBe(3);
  for (const imported of [first, second]) {
    expect(imported.provenance.source).toBe('imported');
    expect(imported.provenance.template).toEqual({
      id: template.templateId,
      version: template.templateVersion,
      hash: template.hash,
    });
    expect(imported.versions[0].contentHash).toBe(saved.versions[0].contentHash);
  }
});

it('keeps the separate text/CSV import limit', async () => {
  const csv = new File([' '.repeat(16_000_001)], 'oversized.csv');
  await expect(readImportFiles([csv], context())).rejects.toThrow('16 MB');
});

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

it('admits Fiction Map native history without routing it through template adapters', async () => {
  const { createFictionMap } = await import('@editor-platform/fiction-map/model');
  const artifact = await commitVersion(
    createArtifact('fiction-map', 'Map', createFictionMap()),
    null,
    'first',
  );
  const [imported] = await readImportFiles([file(artifact)], context());
  expect(imported.kind).toBe('fiction-map');
  expect(imported.draft.content).toEqual(artifact.draft.content);
  expect(imported.versions[0].contentHash).toBe(artifact.versions[0].contentHash);
  const bad = structuredClone(artifact);
  bad.versions[0].contentHash = '0'.repeat(64);
  await expect(readImportFiles([file(bad)], context())).rejects.toThrow('hash');
});

it('opens a bare Mind Map JSON (its own export or an external mindmap-editor 0.1.5 file)', async () => {
  const { readFileSync } = await import('node:fs');
  const sample = JSON.parse(
    readFileSync(
      new URL('../../../../packages/mindmap-core/fixtures/valid-rich.json', import.meta.url),
      'utf8',
    ),
  );
  const bare = (value: unknown) =>
    new File([JSON.stringify(value)], 'map.json', { type: 'application/json' });
  const [imported] = await readImportFiles([bare(sample)], context());
  expect(imported.kind).toBe('mindmap');
  expect(imported.name).toBe('map');
  expect(imported.draft.content).toEqual(sample);
  await expect(
    readImportFiles([bare({ ...sample, rootId: 'n-missing' })], context()),
  ).rejects.toThrow('Invalid Mind Map: 根が存在しない');
});

it('AR3 keeps item declarations and row references through native JSON export and import', async () => {
  const content: StructuredData = {
    schemaVersion: 3,
    columns: [
      { id: 'fcId', name: '故障原因の ID', type: 'text' },
      { id: 'cause', name: '故障原因', type: 'text' },
    ],
    rows: [
      {
        id: 'r1',
        values: { fcId: 'FC-01', cause: '接点の溶着' },
        refs: { causeCandidates: ['CC-01'] },
      },
    ],
    items: [{ kind: 'failure-cause', id: 'fcId', title: 'cause', refs: ['refs.causeCandidates'] }],
  };
  const saved = await commitVersion(createArtifact('data', 'DFMEA', content), null, 'first');
  const json = serializeArtifact(saved);
  const [imported] = await readImportFiles(
    [new File([json], 'dfmea.json', { type: 'application/json' })],
    context(),
  );
  expect(imported.draft.content).toEqual(content);
  expect(imported.versions[0]!.content).toEqual(content);
});
