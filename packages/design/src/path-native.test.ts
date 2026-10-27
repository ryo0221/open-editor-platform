import { expect, it } from 'vitest';
import {
  canonicalJson,
  createArtifact,
  commitVersion,
  MemoryStorage,
  serializeArtifact,
} from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import {
  ArtifactEditor,
  loadHostArtifact,
  type EditorHostAdapter,
} from '@editor-platform/editor-host';
import {
  createDesign,
  isDesign,
  isDesignWithPaths,
  duplicateElements,
  groupElements,
  reparentElement,
  patchDesign,
  insertElement,
  createComponent,
  guardDesignCommand,
  designDrawings,
  exportDesignSvg,
  type DesignContent,
} from './model';
import {
  presetDesignPath,
  insertDesignPath,
  moveDesignPathPoint,
  replaceDesignPath,
  setDesignAnchorMode,
} from './path-commands';
function fixture() {
  const session = new EditorSession(createDesign()),
    insert = insertDesignPath(presetDesignPath('cubic'));
  session.execute(insert);
  return { session, id: insert.elementId };
}
it('preserves path coordinates through native transforms, grouping and reparenting with Undo', () => {
  const { session, id } = fixture();
  session.execute(guardDesignCommand(duplicateElements([id])));
  const ids = session.content.elements.map((e) => e.id);
  session.execute(
    guardDesignCommand(patchDesign([id], { rotation: 35, flipX: true, flipY: true })),
  );
  const before = session.content;
  const drawings = () =>
    designDrawings(session.content, session.content.elements.find((e) => e.id === id)!).map(
      ({ bounds, rotation, flipX, flipY, path }) => ({ bounds, rotation, flipX, flipY, path }),
    );
  const projection = drawings();
  session.execute(guardDesignCommand(groupElements(ids)));
  const grouped = session.content;
  expect(isDesignWithPaths(grouped)).toBe(true);
  expect(grouped.elements.find((e) => e.id === id)!.path).toEqual(
    before.elements.find((e) => e.id === id)!.path,
  );
  expect(drawings()).toEqual(projection);
  session.execute(guardDesignCommand(reparentElement(id)));
  expect(drawings()).toEqual(projection);
  session.undo();
  expect(session.content).toEqual(grouped);
  session.undo();
  expect(session.content).toEqual(before);
});
it('inserts into an auto-layout frame and grows its hug size in the same Undo', () => {
  const session = new EditorSession(createDesign());
  session.execute(
    insertElement('frame', {
      id: 'flow',
      bounds: { x: 100, y: 200, width: 300, height: 200 },
    }),
  );
  session.execute(
    patchDesign(['flow'], {
      layout: { direction: 'row', gap: 20, padding: 10, align: 'start', sizing: 'hug' },
    }),
  );
  const before = session.content;
  const insertion = insertDesignPath(
    presetDesignPath('line'),
    { x: 900, y: 900, width: 220, height: 160 },
    'flow',
  );
  session.execute(insertion);
  const added = session.content.elements.find((e) => e.id === insertion.elementId)!;
  expect(added.bounds).toEqual({ x: 110, y: 210, width: 220, height: 160 });
  expect(session.content.elements.find((e) => e.id === 'flow')!.bounds).toEqual({
    x: 100,
    y: 200,
    width: 240,
    height: 180,
  });
  session.undo();
  expect(session.content).toEqual(before);
});
const adapter: EditorHostAdapter<DesignContent> = {
  kind: 'design',
  validate: isDesignWithPaths,
  capabilities: { undo: true, nativeJson: true, formats: [], preview: 'none', shared: false },
};
it('migrates and inserts atomically, preserves old versions and roundtrips every native version', async () => {
  const old = await commitVersion(createArtifact('design', 'Path', createDesign()), null, 'old'),
    bytes = canonicalJson(old.versions);
  const { session, id } = fixture();
  expect(session.content.schemaVersion).toBe(3);
  expect(isDesign(session.content)).toBe(false);
  expect(isDesignWithPaths(session.content)).toBe(true);
  session.undo();
  expect(session.content).toEqual(createDesign());
  session.redo();
  const saved = await commitVersion(
    { ...old, draft: { ...old.draft, content: session.content } },
    null,
    'path',
  );
  expect(canonicalJson(saved.versions.slice(0, 1))).toBe(bytes);
  expect((await loadHostArtifact(serializeArtifact(saved), adapter)).draft.content).toEqual(
    session.content,
  );
  const corrupt = structuredClone(saved);
  corrupt.versions[1].content.elements[0].path!.subpaths[0].segments[0].to = 'missing';
  await expect(loadHostArtifact(serializeArtifact(corrupt), adapter)).rejects.toThrow();
  expect(designDrawings(session.content, session.content.elements[0])[0].path).toBeDefined();
  expect(exportDesignSvg(session.content, [id])).toContain('C');
});
it('refuses schema1/2 paths, unsupported native storage, vector coexistence and legacy schema3 entrypoints', () => {
  const { session } = fixture(),
    content = session.content;
  for (const schemaVersion of [1, 2] as const)
    expect(isDesignWithPaths({ ...content, schemaVersion })).toBe(false);
  const path = content.elements[0].path!;
  for (const modify of [
    (d: DesignContent) => {
      d.elements[0].vector = {
        viewBox: path.frame,
        paths: ['M0 0L1 1'],
        provenance: { source: 's', name: 'n', version: 'v', license: 'l' },
      };
    },
    (d: DesignContent) => {
      d.elements[0].overrides = { root: { path } };
    },
    (d: DesignContent) => {
      d.elements[0].type = 'instance';
    },
    (d: DesignContent) => {
      d.components = [
        {
          id: 'c',
          name: 'c',
          width: 220,
          height: 160,
          template: { type: 'shape', text: '', fill: 'none' },
          elements: [d.elements[0]],
        },
      ];
    },
  ]) {
    const bad = structuredClone(content);
    modify(bad);
    expect(isDesignWithPaths(bad)).toBe(false);
    expect(isDesign(bad)).toBe(false);
  }
});
it('has one native edit/Undo, no history on stale, revoked, locked or no-op commands', () => {
  const { session, id } = fixture(),
    base = session.content,
    p = base.elements[0].path!,
    s = p.subpaths[0],
    target = { subpathId: s.id, anchorId: s.anchors[0].id };
  const next = moveDesignPathPoint(p, target, { x: 10, y: 25 });
  session.execute(replaceDesignPath(base, id, next));
  expect(session.content.elements[0].path).toEqual(next);
  session.undo();
  expect(session.content).toEqual(base);
  expect(() => session.execute(replaceDesignPath(base, id, p))).toThrow('no-op');
  expect(session.canRedo).toBe(true);
  let allowed = true;
  const c = replaceDesignPath(base, id, next, () => allowed);
  allowed = false;
  expect(() => session.execute(c)).toThrow('read only');
  expect(session.content).toEqual(base);
  const stale = replaceDesignPath(base, id, next);
  session.redo();
  expect(() => session.execute(stale)).toThrow('stale');
  expect(() => guardDesignCommand(insertDesignPath(p), () => false).apply(base)).toThrow();
  expect(() => createComponent(id).apply(base)).toThrow('paths');
});
it('remaps all identities atomically on duplicate and restores original IDs with Undo', () => {
  const { session, id } = fixture(),
    original = session.content.elements[0].path!;
  session.execute(duplicateElements([id]));
  const copy = session.content.elements[1].path!;
  expect(copy.subpaths[0].anchors[0].id).not.toBe(original.subpaths[0].anchors[0].id);
  expect(copy.subpaths[0].segments[0].from).toBe(copy.subpaths[0].anchors[0].id);
  session.undo();
  expect(session.content.elements[0].path).toEqual(original);
});
it('preserves unsaved draft and Undo on storage failure; retry uses the existing Host save', async () => {
  const storage = new MemoryStorage(),
    host = new ArtifactEditor(createArtifact('design', 'Path', createDesign()), adapter, storage);
  host.execute(insertDesignPath(presetDesignPath('line')));
  const draft = canonicalJson(host.content),
    put = storage.put.bind(storage);
  storage.put = async () => {
    throw Error('quota');
  };
  await expect(host.save({ commitVersion: true })).rejects.toThrow('quota');
  expect(canonicalJson(host.content)).toBe(draft);
  expect(host.snapshot.dirty).toBe(true);
  expect(host.canUndo).toBe(true);
  storage.put = put;
  await host.save({ commitVersion: true });
  expect(host.snapshot.dirty).toBe(false);
  expect(host.canUndo).toBe(true);
});
it('retains a 16 MiB-overflow draft/version history and permits correction/retry', async () => {
  const artifact = createArtifact('design', 'n'.repeat(16 * 1024 * 1024), createDesign());
  const host = new ArtifactEditor(artifact, adapter, new MemoryStorage());
  host.execute(insertDesignPath(presetDesignPath('line')));
  await expect(host.save({ commitVersion: true })).rejects.toThrow('16 MiB');
  expect(host.snapshot.dirty).toBe(true);
  expect(host.canUndo).toBe(true);
});
it('does not normalize saved modes and translates handles on anchor moves', () => {
  const p = presetDesignPath('cubic'),
    s = p.subpaths[0],
    a = s.anchors[0],
    e = s.segments[0];
  if (e.type !== 'cubic') throw Error();
  a.mode = 'symmetric';
  const before = structuredClone(e.c1);
  const next = moveDesignPathPoint(
    p,
    { subpathId: s.id, anchorId: a.id },
    { x: a.x + 5, y: a.y - 6 },
  );
  const c = next.subpaths[0].segments[0];
  if (c.type !== 'cubic') throw Error();
  expect(c.c1).toEqual({ x: before.x + 5, y: before.y - 6 });
  expect(setDesignAnchorMode(p, s.id, a.id, 'corner').subpaths[0].anchors[0].mode).toBe('corner');
});
it('links symmetric and smooth handles only on explicit edits and preserves saved coordinates on read', () => {
  const p = presetDesignPath('cubic'),
    sub = p.subpaths[0],
    anchor = sub.anchors[1];
  const symmetric = setDesignAnchorMode(p, sub.id, anchor.id, 'symmetric'),
    out = symmetric.subpaths[0].segments[1],
    incoming = symmetric.subpaths[0].segments[0];
  if (out.type !== 'cubic' || incoming.type !== 'cubic') throw Error();
  expect(incoming.c2.x - anchor.x).toBe(-(out.c1.x - anchor.x));
  expect(incoming.c2.y - anchor.y).toBeCloseTo(-(out.c1.y - anchor.y), 12);
  const moved = moveDesignPathPoint(
    symmetric,
    { subpathId: sub.id, segmentId: out.id, side: 'c1' },
    { x: anchor.x + 40, y: anchor.y + 50 },
  );
  const other = moved.subpaths[0].segments[0];
  if (other.type !== 'cubic') throw Error();
  expect(other.c2).toEqual({ x: anchor.x - 40, y: anchor.y - 50 });
});
it('rejects a frozen valid path in component/override contexts without reusing an admission cache', () => {
  const { session } = fixture(),
    content = session.content,
    path = content.elements[0].path!;
  expect(isDesignWithPaths(content)).toBe(true);
  const nested = {
    ...content,
    elements: [{ ...content.elements[0], path: undefined, overrides: { root: { path } } }],
  };
  expect(isDesignWithPaths(nested)).toBe(false);
  expect(
    isDesignWithPaths({ ...content, elements: [{ ...content.elements[0], locked: true }] }),
  ).toBe(true);
  const id = content.elements[0].id,
    locked = { ...content, elements: [{ ...content.elements[0], locked: true }] };
  expect(() => replaceDesignPath(locked, id, path).apply(locked)).toThrow('locked');
});
it('supports explicit cyclic closure with zero-length/line/cubic segments without normalization', () => {
  const path = presetDesignPath('line'),
    s = path.subpaths[0];
  s.closed = true;
  s.anchors[1].x = s.anchors[0].x;
  s.anchors[1].y = s.anchors[0].y;
  s.segments.push({
    id: 'closing',
    type: 'cubic',
    from: s.anchors[1].id,
    to: s.anchors[0].id,
    c1: { x: -100, y: -100 },
    c2: { x: 100, y: -100 },
  });
  path.fillRule = 'evenodd';
  const next = insertDesignPath(path).apply(createDesign());
  expect(isDesignWithPaths(next)).toBe(true);
  expect(next.elements[0].path).toEqual(path);
  expect(exportDesignSvg(next)).toContain(' Z');
});

it('retains the opposite smooth handle when the edited handle collapses to its anchor', () => {
  const path = presetDesignPath('cubic'),
    sub = path.subpaths[0],
    anchor = sub.anchors[1];
  anchor.mode = 'smooth';
  const incoming = sub.segments[0],
    outgoing = sub.segments[1];
  if (incoming.type !== 'cubic' || outgoing.type !== 'cubic') throw Error();
  const moved = moveDesignPathPoint(
      path,
      { subpathId: sub.id, segmentId: outgoing.id, side: 'c1' },
      anchor,
    ),
    other = moved.subpaths[0].segments[0];
  if (other.type !== 'cubic') throw Error();
  expect(other.c2).toEqual(incoming.c2);
});
it('refuses path geometry hidden in style appearances under every schema', () => {
  const { session } = fixture(),
    element = session.content.elements[0];
  for (const schemaVersion of [1, 2, 3] as const) {
    const bad = {
      ...createDesign(),
      schemaVersion,
      elements: [{ ...element, path: undefined, styleId: 'inject' }],
      styles: [{ id: 'inject', name: 'Inject', appearance: { path: {} } }],
    };
    expect(isDesignWithPaths(bad)).toBe(false);
    expect(isDesign(bad)).toBe(false);
  }
});
it('compares coordinate-only path edits with distinct bounded descriptions and exports expanded labels', async () => {
  const { session } = fixture(),
    before = session.content,
    after = structuredClone(before);
  after.elements[0].path!.subpaths[0].anchors[0].x += 1;
  const { designDiff } = await import('./model');
  const diff = designDiff(before, after);
  expect(diff.changes.some((c) => c.before !== c.after)).toBe(true);
  const label = after.elements[0];
  label.text = 'Expanded label\n'.repeat(40);
  label.typography = { overflow: 'expand' };
  const svg = exportDesignSvg(after);
  expect(svg).toContain('Expanded label');
  expect(Number(svg.match(/height="([^"]+)"/)![1])).toBeGreaterThan(label.bounds.height);
});
