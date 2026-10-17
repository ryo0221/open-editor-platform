import { describe, expect, it } from 'vitest';
import {
  clone,
  contentHash,
  createArtifact,
  commitVersion,
  canonicalJson,
} from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import {
  ReferenceError,
  ReferenceResolver,
  validEmbeddedReference,
  type ReferenceHost,
  type ReferenceSnapshot,
  type ReferenceSource,
} from '@editor-platform/artifact-references';
import { nativeReferenceAdapters } from './index';
import { createData, setCell, type StructuredData } from '@editor-platform/structured-data/model';
import { defaultView } from '@editor-platform/structured-data/views';
import { createRelationGraph, relationProfile } from '@editor-platform/structured-graph/model';
import { createDeck, insertObject, isDeck, slideDiff } from '@editor-platform/slide/model';
import { createDesign, makeDesignElement, isDesign } from '@editor-platform/design/model';
import {
  createWhiteboard,
  makeWhiteboardNode,
  isWhiteboard,
} from '@editor-platform/whiteboard/model';
import { createDocument, makeBlock, isDocument } from '@editor-platform/document/model';
import { contentToNode, nodeToContent } from '@editor-platform/document/engine';
import { captureSlideExportSnapshot, prepareSlidePptx } from '@editor-platform/slide-export';
import {
  captureDocumentExportSnapshot,
  prepareDocumentDocx,
} from '@editor-platform/document-export';
import {
  slideEditorCodec,
  designEditorCodec,
  whiteboardEditorCodec,
  documentCodec,
} from '@editor-platform/collaboration-adapters';

const source: ReferenceSource = {
  artifactId: 'hours',
  domain: 'data',
  target: { kind: 'table', viewId: 'default' },
};
function data(value = 95): StructuredData {
  const d = createData();
  d.columns = [
    { id: 'name', name: '業務', type: 'text' },
    { id: 'hours', name: '時間', type: 'number' },
    { id: 'double', name: '倍', type: 'formula', formula: '[時間] * 2' },
  ];
  d.rows = [{ id: 'work', values: { name: '定型作業', hours: value } }];
  return d;
}
async function snapshot(content: unknown = data(), revision = 1): Promise<ReferenceSnapshot> {
  return {
    artifactId: 'hours',
    domain: 'data',
    versionId: `v${revision}`,
    revision,
    content,
    contentHash: await contentHash(content),
    dependencies: [],
  };
}
async function setup() {
  let current = await snapshot();
  let failure: ReferenceError | undefined;
  let reads = 0,
    subscriptions = 0;
  const listeners = new Set<(id: string) => void>();
  const host: ReferenceHost = {
    list: async () => [{ label: 'Hours', source }],
    async read() {
      reads++;
      if (failure) throw failure;
      return current;
    },
    checkAccess() {
      if (failure?.status === 'forbidden') throw failure;
    },
    subscribe(listener) {
      subscriptions++;
      listeners.add(listener);
      return () => {
        subscriptions--;
        listeners.delete(listener);
      };
    },
  };
  const resolver = new ReferenceResolver(host, nativeReferenceAdapters, 'destination');
  return {
    resolver,
    host,
    listeners,
    get reads() {
      return reads;
    },
    get subscriptions() {
      return subscriptions;
    },
    setSnapshot(s: ReferenceSnapshot) {
      current = s;
    },
    fail(s?: ReferenceError) {
      failure = s;
    },
  };
}
const svg = (src: string) => Buffer.from(src.split(',')[1], 'base64').toString('utf8');

describe('committed artifact references', () => {
  it('follows 95→80 while fixed snapshots, native IDs, placement and destination Undo remain independent', async () => {
    const h = await setup(),
      follow = await h.resolver.create(source, 'follow'),
      fixed = await h.resolver.create(source, 'fixed');
    const session = new EditorSession(createDeck()),
      pageId = session.content.slides[0].id;
    session.execute(
      insertObject(pageId, 'image', {
        reference: follow,
        src: h.resolver.project(follow.snapshot, source.target).src,
      }),
    );
    const nativeBefore = canonicalJson(session.content);
    h.setSnapshot(await snapshot(data(80), 2));
    expect(svg((await h.resolver.refresh(follow)).projection!.src)).toContain('80');
    expect(svg((await h.resolver.refresh(fixed)).projection!.src)).toContain('95');
    expect(canonicalJson(session.content)).toBe(nativeBefore);
    const captured = await h.resolver.capture(session.content.slides[0].objects);
    expect(captured[0].reference?.snapshot.versionId).toBe('v2');
    expect(captured[0].bounds).toEqual(session.content.slides[0].objects[0].bounds);
    expect(captured[0].id).toBe(session.content.slides[0].objects[0].id);
    session.undo();
    expect(session.content.slides[0].objects).toHaveLength(0);
    session.redo();
    expect(session.content.slides[0].objects[0].reference).toEqual(follow);
  });
  it('uses native saved-view formula/filter/sort/aggregate semantics, and reports removed targets', async () => {
    const d = data();
    d.rows.push({ id: 'second', values: { name: '別業務', hours: 3 } });
    const view = defaultView(d);
    view.id = 'saved';
    view.filters = [{ id: 'filter', columnId: 'hours', operator: 'greater', value: '10' }];
    view.chart = { ...view.chart, x: 'name', y: 'double', aggregate: 'sum' };
    d.views = [view];
    const h = await setup();
    h.setSnapshot(await snapshot(d));
    const ref = await h.resolver.create(
      { ...source, target: { kind: 'chart', viewId: 'saved' } },
      'follow',
    );
    const rendered = svg(h.resolver.project(ref.snapshot, ref.source.target).src);
    expect(rendered).toContain('190');
    expect(rendered).not.toContain('別業務');
    const changed = clone(d);
    changed.views = [];
    h.setSnapshot(await snapshot(changed, 2));
    expect((await h.resolver.refresh(ref)).status).toBe('missing-target');
    await expect(
      h.resolver.create(
        { ...source, target: { kind: 'table', viewId: 'default', columnIds: ['deleted'] } },
        'fixed',
      ),
    ).rejects.toMatchObject({ status: 'missing-target' });
    await expect(
      h.resolver.create(
        { ...source, target: { kind: 'table', viewId: 'default', rowIds: ['deleted'] } },
        'fixed',
      ),
    ).rejects.toMatchObject({ status: 'missing-target' });
  });
  it('captures a source only once for several views and preserves historical immutable versions', async () => {
    const h = await setup(),
      ref = await h.resolver.create(source, 'follow');
    const chart = { ...ref, source: { ...source, target: { kind: 'chart', viewId: 'default' } } };
    const reads = h.reads;
    const items = await h.resolver.capture([
      { id: 'table', reference: ref },
      { id: 'chart', reference: chart },
    ]);
    expect(h.reads - reads).toBe(1);
    const deck = createDeck();
    deck.slides[0].objects = items.map((i, n) => ({
      type: 'image' as const,
      bounds: { x: n * 100, y: 50, width: 200, height: 200 },
      fill: '#fff',
      text: '',
      ...i,
    }));
    const saved = await commitVersion(createArtifact('slide', 'Report', deck), null, 'test');
    const old = canonicalJson(saved.versions[0]);
    h.setSnapshot(await snapshot(data(80), 2));
    await h.resolver.capture(items);
    expect(canonicalJson(saved.versions[0])).toBe(old);
    expect(await contentHash(saved.versions[0].content)).toBe(saved.versions[0].contentHash);
    const fixedCapture = await h.resolver.capture(items, false);
    expect(fixedCapture[0].reference!.snapshot.versionId).toBe('v1');
  });
  it('keeps proposal preview/reject and unsaved source edits out of notifications', async () => {
    const h = await setup(),
      ref = await h.resolver.create(source, 'follow'),
      sourceSession = new EditorSession(data());
    const change = setCell('work', 'hours', 80);
    const preview = change.apply(sourceSession.content);
    expect(preview.rows[0].values.hours).toBe(80);
    expect(svg((await h.resolver.refresh(ref)).projection!.src)).toContain('95');
    sourceSession.execute(change);
    expect(svg((await h.resolver.refresh(ref)).projection!.src)).toContain('95');
    h.setSnapshot(await snapshot(sourceSession.content, 2));
    expect(svg((await h.resolver.refresh(ref)).projection!.src)).toContain('80');
  });
  it('distinguishes offline cached content, revoked permission, missing sources and stale replies', async () => {
    const h = await setup(),
      ref = await h.resolver.create(source, 'follow');
    h.fail(new ReferenceError('offline', 'offline'));
    expect(await h.resolver.refresh(ref)).toMatchObject({
      status: 'offline',
      snapshot: ref.snapshot,
    });
    h.fail(new ReferenceError('forbidden', 'revoked'));
    expect(await h.resolver.refresh(ref)).toEqual({ status: 'forbidden', message: 'revoked' });
    expect(await h.resolver.refresh({ ...ref, mode: 'fixed' })).toEqual({
      status: 'forbidden',
      message: 'revoked',
    });
    h.fail(new ReferenceError('missing-source', 'deleted'));
    expect((await h.resolver.refresh(ref)).status).toBe('missing-source');
    h.fail();
    h.setSnapshot(await snapshot(data(80), 2));
    await h.resolver.refresh(ref);
    h.setSnapshot(await snapshot(data(95), 1));
    expect((await h.resolver.refresh(ref)).status).toBe('stale');
  });
  it('does not roll back from delayed replies, subscribes to saves, and unsubscribes on disposal', async () => {
    const h = await setup(),
      ref = await h.resolver.create(source, 'follow');
    let complete!: (s: ReferenceSnapshot) => void;
    const old = snapshot();
    h.host.read = () =>
      new Promise((resolve) => {
        complete = resolve;
      });
    const pending = h.resolver.refresh(ref);
    await expect.poll(() => typeof complete).toBe('function');
    h.host.read = async () => snapshot(data(80), 2);
    await h.resolver.refresh(ref);
    complete(await old);
    await pending;
    expect(h.resolver.get(ref).snapshot!.revision).toBe(2);
    const stop = h.resolver.observe([ref], () => {});
    expect(h.subscriptions).toBe(1);
    h.host.read = async () => snapshot(data(75), 3);
    for (const notify of h.listeners) notify('hours');
    await expect.poll(() => h.resolver.get(ref).snapshot?.revision).toBe(3);
    stop();
    expect(h.subscriptions).toBe(0);
  });
  it('rejects tampered bytes, invalid references, cycles, missing dependencies and resource excess', async () => {
    const h = await setup(),
      ref = await h.resolver.create(source, 'fixed');
    expect(validEmbeddedReference(ref)).toBe(true);
    const tampered = clone(ref);
    (tampered.snapshot.content as StructuredData).rows[0].values.hours = 1;
    await expect(h.resolver.capture([{ id: 'bad', reference: tampered }], false)).rejects.toThrow(
      'hash',
    );
    expect(validEmbeddedReference({ ...ref, mode: 'latest' })).toBe(false);
    expect(validEmbeddedReference({ ...ref, source: { ...source, artifactId: 'other' } })).toBe(
      false,
    );
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(validEmbeddedReference({ ...ref, snapshot: { ...ref.snapshot, content: cycle } })).toBe(
      false,
    );
    await expect(h.resolver.forDestination('hours').create(source, 'follow')).rejects.toThrow(
      '自己参照',
    );
    await expect(
      h.resolver.capture(Array.from({ length: 65 }, (_, n) => ({ id: String(n), reference: ref }))),
    ).rejects.toThrow('64');
    const nested = { ...ref, snapshot: { ...ref.snapshot, content: { reference: ref } } };
    expect(validEmbeddedReference(nested)).toBe(false);
    expect(
      validEmbeddedReference({
        ...ref,
        snapshot: { ...ref.snapshot, content: 'x'.repeat(2_097_153) },
      }),
    ).toBe(false);
  });
  it('retains Graph native structure/Profile/layout and resolves label and layout updates', async () => {
    const graph = createRelationGraph(),
      dependency = {
        id: `profile:${relationProfile.id}:${relationProfile.version}`,
        content: relationProfile,
        contentHash: await contentHash(relationProfile),
      };
    const h = await setup();
    const graphSource: ReferenceSource = {
      artifactId: 'relations',
      domain: 'structured-graph',
      target: { kind: 'graph', viewId: graph.id },
    };
    let current: ReferenceSnapshot = {
      artifactId: 'relations',
      domain: 'structured-graph',
      versionId: 'g1',
      revision: 1,
      content: graph,
      contentHash: await contentHash(graph),
      dependencies: [dependency],
    };
    h.host.read = async () => current;
    const ref = await h.resolver.create(graphSource, 'follow');
    expect(svg(h.resolver.project(ref.snapshot, graphSource.target).src)).toContain('supports');
    const next = clone(graph);
    next.nodes[0].attributes.name = '自動化';
    next.edges[0].attributes.label = '連動';
    next.layout['resource-a'] = { x: 100, y: 200 };
    current = {
      ...current,
      content: next,
      versionId: 'g2',
      revision: 2,
      contentHash: await contentHash(next),
    };
    const rendered = await h.resolver.refresh(ref);
    expect(svg(rendered.projection!.src)).toContain('自動化');
    expect(svg(rendered.projection!.src)).toContain('連動');
    expect(rendered.snapshot!.content).toEqual(next);
    expect(rendered.snapshot!.dependencies).toEqual([dependency]);
    await expect(
      h.resolver.create(
        { ...graphSource, target: { ...graphSource.target, nodeIds: ['deleted'] } },
        'fixed',
      ),
    ).rejects.toMatchObject({ status: 'missing-target' });
    current = { ...current, dependencies: [] };
    await expect(h.resolver.capture([{ id: 'graph', reference: ref }])).rejects.toThrow('Profile');
  });
  it('round trips all native destinations and refuses references at trusted shared boundaries', async () => {
    const h = await setup(),
      ref = await h.resolver.create(source, 'fixed'),
      src = h.resolver.project(ref.snapshot, source.target).src;
    const deck = insertObject(createDeck().slides[0].id, 'image').apply(createDeck());
    const slide = createDeck();
    slide.slides[0].objects = [
      {
        id: 'image',
        type: 'image',
        bounds: { x: 0, y: 0, width: 400, height: 200 },
        text: '',
        fill: '#fff',
        src,
        reference: ref,
      },
    ];
    const design = createDesign();
    design.elements = [{ ...makeDesignElement('image', 0), src, reference: ref }];
    const board = createWhiteboard();
    board.nodes = [{ ...makeWhiteboardNode('image', 0), src, reference: ref }];
    const document = createDocument();
    document.blocks.push({ ...makeBlock('image'), src, reference: ref });
    for (const [value, validate, codec] of [
      [slide, isDeck, slideEditorCodec],
      [design, isDesign, designEditorCodec],
      [board, isWhiteboard, whiteboardEditorCodec],
      [document, isDocument, documentCodec],
    ] as const) {
      expect(validate(JSON.parse(JSON.stringify(value)))).toBe(true);
      expect((codec.validate as (v: unknown) => boolean)(value)).toBe(false);
    }
    expect(nodeToContent(contentToNode(document), document).blocks.at(-1)?.reference).toEqual(ref);
    const basis = { kind: 'confirmed' as const, artifactId: 'destination', revision: 1 };
    const pptx = await prepareSlidePptx(
      await captureSlideExportSnapshot(slide, basis),
      {
        pageIds: 'all',
        includeHiddenSlides: false,
        includeNotes: false,
        fontProfileId: 'noto-cjk-jp-2.004',
        fallback: 'element-png',
      },
      {},
    );
    expect(
      pptx.report.diagnostics.some(
        (d) => d.code === 'REFERENCE_EXPORT_UNSUPPORTED' && d.severity === 'error',
      ),
    ).toBe(true);
    const docx = await prepareDocumentDocx(
      await captureDocumentExportSnapshot(document, basis),
      {
        fontProfileId: 'noto-cjk-jp-2.004',
        styleProfileId: 'document-ja-1',
        mermaid: 'reject',
        previewBlocks: 'reject',
      },
      {},
    );
    expect(
      docx.report.diagnostics.some(
        (d) => d.code === 'REFERENCE_EXPORT_UNSUPPORTED' && d.severity === 'error',
      ),
    ).toBe(true);
    const changed = clone(slide);
    changed.slides[0].objects[0].reference!.mode = 'follow';
    expect(slideDiff(slide, changed).changes[0].after).toContain('follow');
    expect(isDeck(deck)).toBe(true);
  });
});

it('accepts optional undefined Data view fields after a native field prune, including IndexedDB-shaped copies', async () => {
  const { pruneViewFields } = await import('@editor-platform/structured-data/model');
  const d = data();
  d.views = [
    pruneViewFields(
      defaultView(d),
      d.columns.map((c) => c.id),
    ),
  ];
  expect(Object.hasOwn(d.views[0].chart, 'series')).toBe(true);
  expect(d.views[0].chart.series).toBeUndefined();
  const saved = await commitVersion(createArtifact('data', 'Hours', d), null, 'test');
  const s = await snapshot(structuredClone(saved.versions[0].content));
  expect(s.contentHash).toBe(saved.versions[0].contentHash);
  const h = await setup();
  h.setSnapshot(s);
  const ref = await h.resolver.create(source, 'follow');
  expect((await h.resolver.refresh(ref)).status).toBe('ready');
  const captured = await h.resolver.capture([{ id: 'image', reference: ref }]);
  expect(captured[0].reference!.snapshot.contentHash).toBe(s.contentHash);
  expect(validEmbeddedReference({ ...ref, snapshot: { ...s, content: [undefined] } })).toBe(false);
  const accessor = Object.defineProperty({}, 'bad', {
    enumerable: true,
    get() {
      throw Error('must not execute');
    },
  });
  expect(validEmbeddedReference({ ...ref, snapshot: { ...s, content: accessor } })).toBe(false);
});

for (const live of [false, true]) {
  for (const conflict of ['version', 'content', 'dependency'] as const) {
    it(`rejects contradictory retained ${conflict} at the same revision (live=${live})`, async () => {
      const h = await setup();
      let ref = await h.resolver.create(source, 'fixed');
      if (conflict === 'dependency') {
        const graph = createRelationGraph();
        const s: ReferenceSnapshot = {
          ...(await snapshot()),
          artifactId: 'graph',
          domain: 'structured-graph',
          content: graph,
          contentHash: await contentHash(graph),
          dependencies: [
            {
              id: `profile:${relationProfile.id}:${relationProfile.version}`,
              content: relationProfile,
              contentHash: await contentHash(relationProfile),
            },
          ],
        };
        ref = {
          ...ref,
          source: {
            artifactId: 'graph',
            domain: s.domain,
            target: { kind: 'graph', viewId: graph.id },
          },
          snapshot: s,
        };
      }
      const other = clone(ref);
      if (conflict === 'version') other.snapshot.versionId = 'contradictory-version';
      if (conflict === 'content') {
        other.snapshot.content = data(80);
        other.snapshot.contentHash = await contentHash(other.snapshot.content);
      }
      if (conflict === 'dependency') {
        const profile = clone(relationProfile);
        profile.nodes.entity.ui = { ...profile.nodes.entity.ui, label: 'Changed entity' };
        other.snapshot.dependencies[0] = {
          ...other.snapshot.dependencies[0],
          content: profile,
          contentHash: await contentHash(profile),
        };
      }
      // A fresh import scope must detect conflicts within this capture itself.
      const importing = h.resolver.forDestination('imported');
      await expect(
        importing.capture(
          [
            { id: 'one', reference: ref },
            { id: 'two', reference: other },
          ],
          live,
        ),
      ).rejects.toMatchObject({ status: 'stale' });
      const display = h.resolver.forDestination('display');
      expect((await display.refresh(ref)).status).toBe('ready');
      expect((await display.refresh(other)).status).toBe('stale');
    });
  }
}

it('allows an older fixed revision after a newer live revision and preserves exact retained bytes', async () => {
  const h = await setup();
  const fixed = await h.resolver.create(source, 'fixed');
  h.setSnapshot(await snapshot(data(80), 2));
  const follow = await h.resolver.create(source, 'follow');
  const original = canonicalJson(fixed);
  const captured = await h.resolver.capture([
    { id: 'live', reference: follow },
    { id: 'old', reference: fixed },
  ]);
  expect(captured.map((i) => i.reference.snapshot.versionId)).toEqual(['v2', 'v1']);
  expect(canonicalJson(captured[1].reference)).toBe(original);
  expect((await h.resolver.refresh(fixed)).status).toBe('ready');
});

it('uses reference fit in all native static exporters even when legacy imageFit disagrees', async () => {
  const { exportSlideSvg } = await import('@editor-platform/slide/model');
  const { exportDesignSvg } = await import('@editor-platform/design/model');
  const { exportBoardSvg } = await import('@editor-platform/whiteboard');
  const h = await setup();
  const reference = { ...(await h.resolver.create(source, 'fixed')), fit: 'cover' as const };
  const src = h.resolver.project(reference.snapshot, source.target).src;
  const patch = { reference, src, imageFit: 'fit' as const };
  const deck = createDeck();
  deck.slides[0].objects = insertObject(deck.slides[0].id, 'image', patch).apply(
    deck,
  ).slides[0].objects;
  const design = createDesign();
  design.elements = [{ ...makeDesignElement('image'), ...patch }];
  const board = createWhiteboard();
  board.nodes = [{ ...makeWhiteboardNode('image'), ...patch }];
  for (const svg of [
    exportSlideSvg(deck, deck.slides[0]),
    exportDesignSvg(design),
    exportBoardSvg(board),
  ]) {
    expect(svg).toContain('preserveAspectRatio="xMidYMid slice"');
    expect(svg).not.toContain('preserveAspectRatio="xMidYMid meet"');
  }
});

it('rejects references in component definitions, templates and instance overrides at native import', async () => {
  const h = await setup();
  const reference = await h.resolver.create(source, 'fixed');
  const design = createDesign();
  const part = makeDesignElement('image');
  design.components = [
    {
      id: 'component',
      name: 'Component',
      width: 100,
      height: 100,
      template: { type: 'image', text: '', fill: 'none' },
      elements: [part],
    },
  ];
  design.elements = [{ ...makeDesignElement('instance'), componentId: 'component' }];
  expect(isDesign(design)).toBe(true);
  const imported = (value: unknown) => JSON.parse(JSON.stringify(value));
  design.components[0].elements![0].reference = reference;
  expect(isDesign(imported(design))).toBe(false);
  delete design.components[0].elements![0].reference;
  Object.assign(design.components[0].template, { reference });
  expect(isDesign(imported(design))).toBe(false);
  delete (design.components[0].template as Partial<typeof part>).reference;
  design.elements[0].overrides = { [part.id]: { reference } };
  expect(isDesign(imported(design))).toBe(false);
  design.elements[0].overrides = { [part.id]: { overrides: { child: { reference } } } };
  expect(isDesign(imported(design))).toBe(false);
  design.elements[0].overrides = undefined;
  design.elements.push({ ...part, reference });
  expect(isDesign(imported(design))).toBe(true);
});

it('preserves arbitrary own native JSON keys through committed Data reference resolution', async () => {
  const { isStructuredData } = await import('@editor-platform/structured-data/model');
  const content = createData();
  const keys = ['constructor', 'prototype', '__proto__', '日本語'];
  content.columns = keys.map((id) => ({ id, name: id, type: 'number' }));
  content.rows = [{ id: 'row', values: Object.fromEntries(keys.map((id, i) => [id, 95 + i])) }];
  expect(isStructuredData(content)).toBe(true);
  const saved = await commitVersion(createArtifact('data', 'Own keys', content), null, 'test');
  const s = await snapshot(structuredClone(saved.versions[0].content));
  const before = canonicalJson(s);
  const h = await setup();
  h.setSnapshot(s);
  const ref = await h.resolver.create(source, 'follow');
  expect((await h.resolver.refresh(ref)).status).toBe('ready');
  const [captured] = await h.resolver.capture([{ id: 'image', src: '', reference: ref }]);
  expect(canonicalJson(captured.reference.snapshot)).toBe(before);
  expect(svg(captured.src!)).toContain('98');
  expect(Object.prototype).not.toHaveProperty('polluted');
});

for (const conflict of ['revision', 'profile'] as const) {
  it(`rejects reused immutable version IDs across all resolver paths (${conflict})`, async () => {
    const h = await setup();
    const graph = createRelationGraph();
    const original: ReferenceSnapshot = {
      ...(await snapshot()),
      artifactId: 'graph',
      domain: 'structured-graph',
      content: graph,
      contentHash: await contentHash(graph),
      dependencies: [
        {
          id: `profile:${relationProfile.id}:${relationProfile.version}`,
          content: relationProfile,
          contentHash: await contentHash(relationProfile),
        },
      ],
    };
    const graphSource = {
      artifactId: 'graph',
      domain: 'structured-graph',
      target: { kind: 'graph', viewId: graph.id },
    };
    h.setSnapshot(original);
    const reference = await h.resolver.create(graphSource, 'follow');
    const changed = clone(original);
    changed.revision++;
    if (conflict === 'profile') {
      const profile = clone(relationProfile);
      profile.nodes.entity.ui = { ...profile.nodes.entity.ui, label: 'Changed Profile' };
      changed.dependencies[0] = {
        ...changed.dependencies[0],
        content: profile,
        contentHash: await contentHash(profile),
      };
    }
    expect(changed.contentHash).toBe(original.contentHash);
    h.setSnapshot(changed);
    expect((await h.resolver.refresh(reference)).status).toBe('stale');
    await expect(h.resolver.create(graphSource, 'fixed')).rejects.toMatchObject({
      status: 'stale',
    });
    await expect(h.resolver.capture([{ id: 'image', reference }])).rejects.toMatchObject({
      status: 'stale',
    });
    const fixed = { ...reference, mode: 'fixed' as const };
    const conflicting = { ...fixed, snapshot: changed };
    const imported = h.resolver.forDestination('imported');
    await expect(
      imported.capture(
        [
          { id: 'first', reference: fixed },
          { id: 'second', reference: conflicting },
        ],
        false,
      ),
    ).rejects.toMatchObject({ status: 'stale' });
    expect((await imported.refresh(conflicting)).status).toBe('stale');
    // A rejected response must not poison the revision slot for a valid new version.
    h.setSnapshot({ ...changed, versionId: 'valid-v2', dependencies: original.dependencies });
    expect((await h.resolver.create(graphSource, 'follow')).snapshot.versionId).toBe('valid-v2');
    expect((await h.resolver.refresh(fixed)).status).toBe('ready');
  });
}

it('rejects unrelated dependencies instead of retaining them in a Graph closure', async () => {
  const h = await setup();
  const graph = createRelationGraph();
  const source = {
    artifactId: 'graph',
    domain: 'structured-graph',
    target: { kind: 'graph', viewId: graph.id },
  };
  const saved: ReferenceSnapshot = {
    ...(await snapshot()),
    artifactId: 'graph',
    domain: 'structured-graph',
    content: graph,
    contentHash: await contentHash(graph),
    dependencies: [
      {
        id: `profile:${relationProfile.id}:${relationProfile.version}`,
        content: relationProfile,
        contentHash: await contentHash(relationProfile),
      },
    ],
  };
  h.setSnapshot(saved);
  const reference = await h.resolver.create(source, 'follow');
  const content = { private: 'unrelated data must not be exported' };
  const bad = {
    ...saved,
    dependencies: [
      ...saved.dependencies,
      { id: 'unrelated', content, contentHash: await contentHash(content) },
    ],
  };
  h.setSnapshot(bad);
  await expect(h.resolver.create(source, 'follow')).rejects.toMatchObject({ status: 'error' });
  expect((await h.resolver.refresh(reference)).status).toBe('error');
  await expect(h.resolver.capture([{ id: 'image', reference }])).rejects.toMatchObject({
    status: 'error',
  });
  await expect(
    h.resolver
      .forDestination('imported')
      .capture([{ id: 'image', reference: { ...reference, mode: 'fixed', snapshot: bad } }], false),
  ).rejects.toMatchObject({ status: 'error' });
  expect(() => h.resolver.project(bad, source.target)).toThrow(/Profile一件/);
});

it('applies generic image fit to each selected native reference without replacing its source or mode', async () => {
  const { patchObjects } = await import('@editor-platform/slide/model');
  const { patchDesign } = await import('@editor-platform/design/model');
  const { patchNodes } = await import('@editor-platform/whiteboard/model');
  const h = await setup();
  const fixed = await h.resolver.create(source, 'fixed');
  const follow = await h.resolver.create(source, 'follow');
  const refs = [fixed, follow, undefined];
  const deck = createDeck();
  const object = insertObject(deck.slides[0].id, 'image').apply(deck).slides[0].objects[0];
  deck.slides[0].objects = refs.map((reference, index) => ({
    ...object,
    id: String(index),
    reference,
  }));
  const design = createDesign();
  design.elements = refs.map((reference, index) => ({
    ...makeDesignElement('image'),
    id: String(index),
    reference,
  }));
  const board = createWhiteboard();
  board.nodes = refs.map((reference, index) => ({
    ...makeWhiteboardNode('image'),
    id: String(index),
    reference,
  }));
  const ids = ['0', '1', '2'];
  const outcomes = [
    patchObjects(deck.slides[0].id, ids, { imageFit: 'fill' }).apply(deck).slides[0].objects,
    patchDesign(ids, { imageFit: 'fill' }).apply(design).elements,
    patchNodes(ids, { imageFit: 'fill' }).apply(board).nodes,
  ];
  for (const items of outcomes) {
    expect(items.map((i) => i.imageFit)).toEqual(['fill', 'fill', 'fill']);
    expect(items.map((i) => i.reference?.fit)).toEqual(['cover', 'cover', undefined]);
    expect(items.map((i) => i.reference?.mode)).toEqual(['fixed', 'follow', undefined]);
    expect(items[0].reference?.source).toEqual(source);
    expect(items[1].reference?.source).toEqual(source);
  }
  expect(fixed.fit).toBe('contain');
  expect(follow.fit).toBe('contain');
});
