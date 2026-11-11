import { createArtifact, commitVersion } from '@editor-platform/artifact-core';
import { createDocument } from '@editor-platform/document/model';
import { createCharacterSeed, defaultCharacterColumns } from '../character-source';
import { compareCreativeSavedContent } from '../workspace/saved-content-comparison';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  MemoryStorage,
  contentHash,
  canonicalJson,
  type Artifact,
} from '@editor-platform/artifact-core';
import type { StructuredData } from '@editor-platform/structured-data/model';
import type { CreativeWorkspaceLinksV2 } from '../workspace/model';
import { TimelineWorkbench } from './workbench';
import {
  compareTimelineSavedFacets,
  type TimelineSavedComparisonRequest,
} from './saved-comparison';
import type { Exact } from './analysis-context';

async function fixture(edit: (content: StructuredData) => void = () => {}) {
  const bundle = JSON.parse(
    readFileSync(
      new URL('../../../../../docs/story-timeline/fixtures/f0.json', import.meta.url),
      'utf8',
    ),
  ) as { artifacts: Artifact<StructuredData>[]; links: CreativeWorkspaceLinksV2 };
  const store = new MemoryStorage<Artifact<unknown>>();
  for (const a of bundle.artifacts) await store.put(a);
  const a = bundle.artifacts.find((a) => a.id === 'story-ledger-A')!;
  const v = a.versions.find((v) => v.versionId === a.draft.baseVersionId)!;
  const exact = (owner: Artifact<StructuredData>, item = ''): Exact => {
    const version = owner.versions.find((v) => v.versionId === owner.draft.baseVersionId)!;
    return {
      type: 'exact',
      artifact: owner.id,
      version: version.versionId,
      hash: version.contentHash,
      item,
    };
  };
  const hidden = new Set<string>();
  const w = await TimelineWorkbench.open(store, bundle.links, {
    mayRead: (id) => !hidden.has(id),
    mayEdit: () => true,
  });
  const before = exact(a, 'EV-101');
  const content = structuredClone(v.content);
  edit(content);
  const next = {
    ...v,
    versionId: 'comparison-only',
    content,
    contentHash: await contentHash(content),
  };
  a.versions.push(next);
  await store.put(a); // draft/base deliberately remain on the old version
  const after = { ...before, version: next.versionId, hash: next.contentHash };
  const roots = bundle.artifacts
    .filter((a) => a.id === bundle.links.story.worldSettings)
    .map((a) => exact(a));
  const input: TimelineSavedComparisonRequest = {
    before,
    after,
    beforeRoots: roots,
    afterRoots: roots,
    facets: ['existence', 'time', 'content', 'info:S1', 'info:S2', 'participants', 'evaluation'],
  };
  const readOnlySource = {
    links: w.links,
    source: w.source,
    readable: (id: string) => w.readable(id),
    captureAccess: (id: string) => w.captureAccess(id),
    get accessEpoch() {
      return w.accessEpoch;
    },
  };
  return { store, w, input, hidden, a, readOnlySource };
}
const states = (r: { facets: { facet: string; state: string }[] }) =>
  Object.fromEntries(r.facets.map((f) => [f.facet, f.state]));
it('compares two explicit saved versions without draft, base, history or link mutation', async () => {
  const f = await fixture();
  const original = canonicalJson(await f.store.list()),
    links = canonicalJson(f.w.links);
  const r = await compareTimelineSavedFacets(f.readOnlySource, f.input);
  expect(Object.values(states(r))).toEqual(Array(7).fill('unchanged'));
  expect(r.before.version).not.toBe(r.after.version);
  expect(r.current()).toBe(true);
  expect(canonicalJson(await f.store.list())).toBe(original);
  expect(canonicalJson(f.w.links)).toBe(links);
  expect(f.w.undoState.canUndo).toBe(false);
});
it('keeps time-only differences narrow and symmetric', async () => {
  const f = await fixture((c) => {
    c.rows.find((r) => r.id === 'EV-101')!.values['tl1.time.start'] = 4;
  });
  const r = await compareTimelineSavedFacets(f.w, f.input);
  expect(states(r)).toMatchObject({
    time: 'changed',
    content: 'unchanged',
    'info:S1': 'unchanged',
  });
  const reversed = await compareTimelineSavedFacets(f.w, {
    ...f.input,
    before: f.input.after,
    after: f.input.before,
  });
  expect(states(reversed)).toEqual(states(r));
});
it('distinguishes per-information facets and content without widening time', async () => {
  const f = await fixture((c) => {
    const r = c.rows.find(
      (r) => r.values['tl1.subject'] === 'EV-002' && r.values['tl1.info'] === 'S1',
    )!;
    r.values['tl1.mode'] = 'doubt';
  });
  f.input.before.item = f.input.after.item = 'EV-002';
  expect(states(await compareTimelineSavedFacets(f.w, f.input))).toMatchObject({
    time: 'unchanged',
    content: 'changed',
    'info:S1': 'changed',
    'info:S2': 'unchanged',
  });
});
it.each(['hash', 'missing', 'duplicate', 'schema', 'kind'])(
  'does not certify invalid retained %s',
  async (fault) => {
    const f = await fixture();
    const a = (await f.store.get(f.a.id))!;
    if (fault === 'hash') f.input.after.hash = 'incorrect';
    if (fault === 'missing') a.versions.pop();
    if (fault === 'duplicate') a.versions.push(structuredClone(a.versions.at(-1)!));
    if (fault === 'schema') {
      (a.versions.at(-1)!.content as { schemaVersion: number }).schemaVersion = 999;
      a.versions.at(-1)!.contentHash = f.input.after.hash = await contentHash(
        a.versions.at(-1)!.content,
      );
    }
    if (fault === 'kind') a.kind = 'document';
    await f.store.put(a);
    if (fault === 'duplicate' || fault === 'kind')
      await expect(compareTimelineSavedFacets(f.w, f.input)).rejects.toThrow();
    else
      expect(states(await compareTimelineSavedFacets(f.w, f.input)).content).toBe('undetermined');
  },
);
it('reports absent premises and unknown facets without claiming no impact', async () => {
  const f = await fixture();
  const r = await compareTimelineSavedFacets(f.w, {
    ...f.input,
    beforeRoots: [],
    afterRoots: [],
    facets: ['time', 'evaluation', 'content', 'ontology'],
  });
  expect(states(r)).toEqual({
    time: 'undetermined',
    evaluation: 'undetermined',
    content: 'unchanged',
    ontology: 'unsupported',
  });
  expect(r.scope).toBe('partial');
});
it('distinguishes removal from an unresolved reference', async () => {
  const f = await fixture((c) => {
    c.rows = c.rows.filter(
      (r) =>
        r.id !== 'EV-101' &&
        r.values['tl1.subject'] !== 'EV-101' &&
        r.values['tl1.ref.item'] !== 'EV-101',
    );
  });
  const r = await compareTimelineSavedFacets(f.w, f.input);
  expect(states(r)).toMatchObject({ existence: 'changed', content: 'undetermined' });
  const missing = {
    ...f.input,
    before: { ...f.input.before, item: 'missing' },
    after: { ...f.input.after, item: 'missing' },
  };
  expect(states(await compareTimelineSavedFacets(f.w, missing)).existence).toBe('undetermined');
});
it('rejects owner/item disagreement and invalidates results after access loss', async () => {
  const f = await fixture();
  await expect(
    compareTimelineSavedFacets(f.w, { ...f.input, after: { ...f.input.after, item: 'other' } }),
  ).rejects.toThrow();
  await expect(
    compareTimelineSavedFacets(f.w, { ...f.input, after: { ...f.input.after, artifact: 'other' } }),
  ).rejects.toThrow();
  const r = await compareTimelineSavedFacets(f.w, f.input);
  f.hidden.add(f.input.before.artifact);
  expect(r.current()).toBe(false);
  await expect(compareTimelineSavedFacets(f.w, f.input)).rejects.toThrow('入力・権限');
});

it('compares native Document blocks, ignoring other blocks and exposing unsupported semantic facets', async () => {
  const f = await fixture();
  const content = createDocument();
  content.blocks = [
    { id: 'target', type: 'paragraph', text: 'kept' },
    { id: 'other', type: 'paragraph', text: 'before' },
  ];
  const first = await commitVersion(
    createArtifact('document', 'manuscript', content),
    null,
    'fixture',
  );
  const beforeVersion = first.versions[0];
  first.draft.content.blocks[1].text = 'after';
  const second = await commitVersion(first, beforeVersion.versionId, 'fixture');
  await f.store.put(second);
  const before: Exact = {
    type: 'exact',
    artifact: second.id,
    version: beforeVersion.versionId,
    hash: beforeVersion.contentHash,
    item: 'target',
  };
  const after: Exact = {
    ...before,
    version: second.versions.at(-1)!.versionId,
    hash: second.versions.at(-1)!.contentHash,
  };
  const input = {
    domain: 'document-block' as const,
    before,
    after,
    facets: ['existence', 'content', 'time'],
  };
  const original = canonicalJson(await f.store.list());
  const result = await compareCreativeSavedContent(f.w, input);
  expect(states(result)).toEqual({
    existence: 'unchanged',
    content: 'unchanged',
    time: 'unsupported',
  });
  expect(canonicalJson(await f.store.list())).toBe(original);
  const changed = await compareCreativeSavedContent(f.w, {
    ...input,
    before: { ...before, item: 'other' },
    after: { ...after, item: 'other' },
  });
  expect(states(changed).content).toBe('changed');
  f.hidden.add(second.id);
  expect(result.current()).toBe(false);
  await expect(compareCreativeSavedContent(f.w, input)).rejects.toThrow('入力・権限');
});
it('compares character fields through explicit native column mappings and preserves unassessed state', async () => {
  const f = await fixture();
  const first = await commitVersion(
    createArtifact('data', 'characters', createCharacterSeed()),
    null,
    'fixture',
  );
  const v = first.versions[0];
  first.draft.content.rows[0].values[defaultCharacterColumns.voice] = 'new voice';
  const next = await commitVersion(first, v.versionId, 'fixture');
  await f.store.put(next);
  const before: Exact = {
    type: 'exact',
    artifact: next.id,
    version: v.versionId,
    hash: v.contentHash,
    item: 'CH-01',
  };
  const after: Exact = {
    ...before,
    version: next.versions.at(-1)!.versionId,
    hash: next.versions.at(-1)!.contentHash,
  };
  const input = {
    domain: 'character' as const,
    before,
    after,
    beforeColumns: defaultCharacterColumns,
    afterColumns: defaultCharacterColumns,
    facets: ['existence', 'content', 'field:voice', 'field:name', 'time'],
  };
  expect(states(await compareCreativeSavedContent(f.w, input))).toEqual({
    existence: 'unchanged',
    content: 'changed',
    'field:voice': 'changed',
    'field:name': 'unchanged',
    time: 'unsupported',
  });
  expect(
    states(
      await compareCreativeSavedContent(f.w, {
        ...input,
        afterColumns: { ...defaultCharacterColumns, voice: 'absent' },
      }),
    ).content,
  ).toBe('undetermined');
  expect(
    states(await compareCreativeSavedContent(f.w, { ...input, after: { ...after, hash: 'wrong' } }))
      .existence,
  ).toBe('undetermined');
});
it('rejects permission loss during an asynchronous exact read without returning target metadata', async () => {
  const f = await fixture();
  const get = f.w.source.get;
  f.w.source.get = async (id) => {
    const result = await get(id);
    f.hidden.add(id);
    return result;
  };
  await expect(compareTimelineSavedFacets(f.w, f.input)).rejects.toThrow(/権限/);
});
it('marks changed explicit clock premises without substituting the current world draft', async () => {
  const f = await fixture();
  const ref = f.input.beforeRoots[0];
  const a = (await f.store.get(ref.artifact))!;
  const version = structuredClone(a.versions.find((v) => v.versionId === ref.version)!);
  version.versionId = 'other-world';
  const data = version.content as StructuredData;
  const row = data.rows.find((r) => r.values['tl1.row'] === 'worldline')!;
  row.values['tl1.clock'] = 'missing-clock';
  version.contentHash = await contentHash(data);
  a.versions.push(version);
  await f.store.put(a);
  const result = await compareTimelineSavedFacets(f.w, {
    ...f.input,
    afterRoots: [{ ...ref, version: version.versionId, hash: version.contentHash }],
  });
  expect(states(result).time).not.toBe('unchanged');
});
it('invalidates in-flight comparison on source generation change and earlier completed results on link changes', async () => {
  const f = await fixture();
  const result = await compareTimelineSavedFacets(f.w, f.input);
  const get = f.w.source.get;
  f.w.source.get = async (id) => {
    const value = await get(id);
    f.w.invalidate();
    return value;
  };
  await expect(compareTimelineSavedFacets(f.w, f.input)).rejects.toThrow(/権限/);
  expect(result.current()).toBe(false);
});

it.each([
  {
    label: 'different unresolved formulas',
    before: { type: 'formula', formula: 'MissingA + 1' },
    after: { type: 'formula', formula: 'MissingB + 2' },
    state: 'undetermined',
  },
  {
    label: 'error before valid formula',
    before: { type: 'formula', formula: 'MissingA' },
    after: { type: 'formula', formula: '1 + 1' },
    state: 'undetermined',
  },
  {
    label: 'valid formula before error',
    before: { type: 'formula', formula: '2' },
    after: { type: 'formula', formula: 'MissingB' },
    state: 'undetermined',
  },
  {
    label: 'valid equivalent formulas',
    before: { type: 'formula', formula: '1 + 1' },
    after: { type: 'formula', formula: '4 / 2' },
    state: 'unchanged',
  },
  {
    label: 'valid different formulas',
    before: { type: 'formula', formula: '2' },
    after: { type: 'formula', formula: '3' },
    state: 'changed',
  },
  {
    label: 'literal error text',
    before: { type: 'text', value: '#ERROR' },
    after: { type: 'text', value: '#ERROR' },
    state: 'unchanged',
  },
  {
    label: 'ordinary changed text',
    before: { type: 'text', value: 'quiet' },
    after: { type: 'text', value: 'loud' },
    state: 'changed',
  },
  {
    label: 'literal error text versus evaluation error',
    before: { type: 'text', value: '#ERROR' },
    after: { type: 'formula', formula: 'MissingA' },
    state: 'undetermined',
  },
  {
    label: 'invalid numeric cells',
    before: { type: 'number', value: 'bad' },
    after: { type: 'number', value: 'different bad' },
    state: 'undetermined',
  },
] as const)(
  'retains character cell evaluation state: $label',
  async ({ before: oldCell, after: nextCell, state }) => {
    const f = await fixture();
    const makeContent = (cell: typeof oldCell | typeof nextCell) => {
      const data = createCharacterSeed();
      const column = data.columns.find((c) => c.id === defaultCharacterColumns.voice)!;
      column.type = cell.type;
      if ('formula' in cell) column.formula = cell.formula;
      data.rows[0].values[column.id] = 'value' in cell ? (cell.value ?? null) : null;
      return data;
    };
    const first = await commitVersion(
      createArtifact('data', 'characters', makeContent(oldCell)),
      null,
      'fixture',
    );
    const v = first.versions[0];
    first.draft.content = makeContent(nextCell);
    const next = await commitVersion(first, v.versionId, 'fixture');
    await f.store.put(next);
    const before: Exact = {
      type: 'exact',
      artifact: next.id,
      version: v.versionId,
      hash: v.contentHash,
      item: 'CH-01',
    };
    const after: Exact = {
      ...before,
      version: next.versions.at(-1)!.versionId,
      hash: next.versions.at(-1)!.contentHash,
    };
    const input = {
      domain: 'character' as const,
      before,
      after,
      beforeColumns: defaultCharacterColumns,
      afterColumns: defaultCharacterColumns,
      facets: ['existence', 'content', 'field:voice', 'field:name'],
    };
    const retained = canonicalJson(await f.store.list());
    const result = await compareCreativeSavedContent(f.readOnlySource, input);
    expect(states(result)).toEqual({
      existence: 'unchanged',
      content: state,
      'field:voice': state,
      'field:name': 'unchanged',
    });
    expect(result.scope).toBe(state === 'undetermined' ? 'partial' : 'complete');
    if (state === 'undetermined')
      expect(result.facets.find((f) => f.facet === 'field:voice')?.reason).toBe(
        'unresolved-character-cell',
      );
    const nameOnly = await compareCreativeSavedContent(f.readOnlySource, {
      ...input,
      facets: ['field:name'],
    });
    expect(nameOnly.scope).toBe('complete');
    expect(canonicalJson(await f.store.list())).toBe(retained);
    expect(result.current()).toBe(true);
  },
);
