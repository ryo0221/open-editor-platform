import { insertDesignPage } from '@editor-platform/design/pagination';
import { designDivisionCommand } from '@editor-platform/design/division';
import { describe, expect, it } from 'vitest';
import {
  createArtifact,
  MemoryStorage,
  serializeArtifact,
  type Artifact,
} from '@editor-platform/artifact-core';
import { command, reviewProposedCommands, type EditorCommand } from '@editor-platform/editor-core';
import {
  ArtifactEditor,
  loadHostArtifact,
  type EditorHostAdapter,
} from '@editor-platform/editor-host';
import {
  createDesign,
  designDrawings,
  isDesign,
  isDesignWithPaths,
  patchDesign,
  makeDesignElement,
  makeDesignVector,
  overrideInstance,
  updateComponentPart,
  type DesignContent,
  type DesignElement,
} from '@editor-platform/design/model';
import { designMangaProposalDiff } from '@editor-platform/design/manga-proposal-diff';
import { designPageProposalDiff } from '@editor-platform/design/page-proposal-diff';
import { checkVector } from '../../../tests/fixtures/design-reuse/content';
import {
  creativeDesignAddressKey,
  parseCreativeDesignAddress,
  creativeDesignFocus,
  creativeDesignEditCommand,
  createCreativeDesignHostAdapter,
  designCreativeProposalDiff,
  prepareCreativeDesignProposal,
  type CreativeDesignAddress,
  type CreativeDesignProposalScope,
} from '@editor-platform/design/creative-proposal-diff';

const shared = (elementId: string): CreativeDesignAddress => ({ componentId: 'person', elementId });
const instance = (elementId: string, instanceId = 'A'): CreativeDesignAddress => ({
  componentId: 'person',
  elementId,
  instanceId,
});
function fixture(): DesignContent {
  return {
    ...createDesign(),
    elements: ['A', 'B'].map((id) => ({
      ...makeDesignElement('instance'),
      id,
      componentId: 'person',
      bounds: { x: id === 'A' ? 0 : 400, y: 0, width: 300, height: 500 },
    })),
    components: [
      {
        id: 'person',
        name: 'Person',
        width: 300,
        height: 500,
        template: { type: 'frame', text: '', fill: 'none' },
        elements: [
          { ...makeDesignElement('shape'), id: 'bangs' },
          { ...makeDesignVector(checkVector), id: 'eyes', fill: '#112233' },
          { ...makeDesignElement('image'), id: 'jacket', src: 'data:image/png;base64,b2xk' },
        ],
      },
    ],
  };
}
const baseAdapter: EditorHostAdapter<DesignContent> = {
  kind: 'design',
  validate: isDesign,
  capabilities: {
    undo: true,
    nativeJson: true,
    formats: [],
    preview: 'none',
    shared: false,
    proposals: true,
  },
};
function hostFixture(content = fixture()) {
  let writable = true;
  const storage = new MemoryStorage<Artifact<DesignContent>>();
  const adapter = createCreativeDesignHostAdapter(baseAdapter);
  const host = new ArtifactEditor(
    createArtifact('design', 'Creative', content),
    adapter,
    storage,
    () => writable,
  );
  return {
    host,
    storage,
    adapter,
    readonly: () => {
      writable = false;
    },
  };
}
function propose(
  host: ArtifactEditor<DesignContent>,
  commands: EditorCommand<DesignContent>[],
  scope: CreativeDesignProposalScope,
  id = 'edit',
) {
  return prepareCreativeDesignProposal(
    { id, summary: 'Edit a part', commands, baseLocalRevision: host.revision },
    scope,
  );
}
const part = (content: DesignContent, id: string) =>
  content.components[0].elements!.find((e) => e.id === id)!;
describe('qualified Creative Design addresses', () => {
  it('roundtrips opaque IDs and distinguishes shared/instance scope and Host focus', () => {
    for (const address of [shared('eyes'), instance('eyes'), { elementId: 'a / : [日本語]' }])
      expect(parseCreativeDesignAddress(creativeDesignAddressKey(address))).toEqual(address);
    expect(creativeDesignAddressKey(shared('eyes'))).not.toBe(
      creativeDesignAddressKey(instance('eyes')),
    );
    expect(creativeDesignFocus(fixture(), instance('eyes'))).toMatchObject({
      address: instance('eyes'),
      key: creativeDesignAddressKey(instance('eyes')),
      focusElementId: 'A',
    });
    expect(creativeDesignFocus(fixture(), shared('eyes'))).toMatchObject({
      address: shared('eyes'),
      componentId: 'person',
    });
    expect(creativeDesignFocus(fixture(), shared('eyes'))).not.toHaveProperty('focusElementId');
  });
  it('rejects missing, mismatched, ambiguous and nested addresses explicitly', () => {
    for (const address of [
      instance('eyes', 'missing'),
      { ...instance('eyes'), componentId: 'other' },
      { elementId: 'eyes', instanceId: 'A' },
      { ...instance('eyes'), instancePath: ['A', 'inner'] },
    ])
      expect(() => creativeDesignFocus(fixture(), address as CreativeDesignAddress)).toThrow();
    const duplicate = fixture();
    duplicate.components[0].elements!.push({ ...part(duplicate, 'eyes') });
    expect(() => creativeDesignFocus(duplicate, shared('eyes'))).toThrow(/ambiguous/);
    const nested = fixture();
    nested.components[0].elements!.push({
      ...makeDesignElement('instance'),
      id: 'inner',
      componentId: 'leaf',
    });
    nested.components.push({
      id: 'leaf',
      name: 'Leaf',
      width: 10,
      height: 10,
      template: { type: 'shape', text: '', fill: 'none' },
    });
    expect(() =>
      creativeDesignEditCommand(instance('inner'), { fill: 'red' }).apply(nested),
    ).toThrow(/Nested/);
    const after = overrideInstance('A', ['inner', 'root'], { fill: 'red' }).apply(nested);
    expect(designCreativeProposalDiff.diff(nested, after).fallback.length).toBeGreaterThan(0);
  });
});

describe('Creative Design semantic proposal diff', () => {
  it.each([
    ['bangs', { bounds: { x: 20, y: 30, width: 220, height: 160 } }, 'bounds'],
    ['eyes', { fill: '#cc3300' }, 'fill'],
    ['jacket', { src: 'data:image/png;base64,bmV3' }, 'src'],
    ['eyes', { opacity: 0.4 }, 'opacity'],
    ['eyes', { hidden: true }, 'hidden'],
    ['eyes', { locked: true }, 'locked'],
  ] as const)('names only the changed shared %s part (%s)', (id, patch, property) => {
    const before = fixture(),
      next = creativeDesignEditCommand(shared(id), patch).apply(before);
    const diff = designCreativeProposalDiff.diff(before, next);
    expect(diff.fallback).toEqual([]);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({
      elementId: creativeDesignAddressKey(shared(id)),
      property,
    });
    expect(next.elements).toEqual(before.elements);
    for (const unchanged of before.components[0].elements!.filter((e) => e.id !== id))
      expect(part(next, unchanged.id)).toEqual(unchanged);
    expect(designCreativeProposalDiff.has(next, creativeDesignAddressKey(shared(id)))).toBe(true);
  });
  it('changes A alone using the same native override and qualified address', () => {
    const before = fixture(),
      next = creativeDesignEditCommand(instance('eyes'), { fill: '#cc3300' }).apply(before);
    expect(next).toEqual(overrideInstance('A', ['eyes'], { fill: '#cc3300' }).apply(before));
    expect(next.components).toEqual(before.components);
    expect(next.elements[1]).toEqual(before.elements[1]);
    expect(designCreativeProposalDiff.diff(before, next)).toMatchObject({
      fallback: [],
      changes: [
        { elementId: creativeDesignAddressKey(instance('eyes')), property: 'overrides.fill' },
      ],
    });
    const a = designDrawings(next, next.elements[0]),
      b = designDrawings(next, next.elements[1]);
    expect(a.some((d) => d.fill === '#cc3300')).toBe(true);
    expect(b.some((d) => d.fill === '#cc3300')).toBe(false);
  });
  it('propagates shared component edits to both instances and avoids no-change', () => {
    const { host } = hostFixture();
    const proposal = propose(host, [updateComponentPart('person', 'eyes', { fill: '#cc3300' })], {
      required: [shared('eyes')],
    });
    const review = reviewProposedCommands(
      { content: host.content, base: { artifactId: host.id, revision: host.revision } },
      proposal,
      designCreativeProposalDiff,
    );
    expect(review.status).toBe('ready');
    host.propose(proposal);
    expect(host.acceptProposal(proposal.id).changedElementIds).toEqual([
      creativeDesignAddressKey(shared('eyes')),
    ]);
    expect(
      host.content.elements.every((e) =>
        designDrawings(host.content, e).some((d) => d.fill === '#cc3300'),
      ),
    ).toBe(true);
  });
  it('retains fallback for unsupported structure, metadata, nested overrides and styles', () => {
    const before = fixture();
    const changes: ((d: DesignContent) => void)[] = [
      (d) => {
        d.elements.reverse();
      },
      (d) => {
        d.components[0].width++;
      },
      (d) => {
        part(d, 'eyes').name = 'Changed';
      },
      (d) => {
        d.styles = [{ id: 'brand', name: 'Brand', appearance: { fill: '#ff0000' } }];
      },
      (d) => {
        d.elements[0].overrides = { eyes: { overrides: { root: { fill: '#ff0000' } } } };
      },
    ];
    for (const change of changes) {
      const next = structuredClone(before);
      change(next);
      expect(designCreativeProposalDiff.diff(before, next).fallback.length).toBeGreaterThan(0);
    }
  });
  it('treats raw override identity changes as fallback rather than an empty diff', () => {
    const before = fixture(),
      next = structuredClone(before);
    next.elements[0].overrides = { eyes: { id: 'other' } };
    expect(designCreativeProposalDiff.diff(before, next).fallback).toMatchObject([
      { reason: 'Creative Design address is missing or ambiguous' },
    ]);
  });
  it('reports resetting an override as an instance change while preserving the definition', () => {
    const before = overrideInstance('A', ['eyes'], { fill: 'red', opacity: 0.5 }).apply(fixture());
    const next = structuredClone(before);
    next.elements[0].overrides = {};
    const diff = designCreativeProposalDiff.diff(before, next);
    expect(diff.fallback).toEqual([]);
    expect(diff.changes.map((change) => change.elementId)).toEqual([
      creativeDesignAddressKey(instance('eyes')),
      creativeDesignAddressKey(instance('eyes')),
    ]);
    expect(diff.changes.map((change) => change.property)).toEqual([
      'overrides.fill',
      'overrides.opacity',
    ]);
    expect(next.components).toEqual(before.components);
  });
  it('supports ordinary element addresses without confusing opaque native IDs with qualified keys', () => {
    const id = creativeDesignAddressKey(shared('eyes'));
    const before = { ...createDesign(), elements: [{ ...makeDesignElement('shape'), id }] };
    const address = { elementId: id };
    const next = creativeDesignEditCommand(address, { fill: 'red' }).apply(before);
    expect(designCreativeProposalDiff.has(before, id)).toBe(true);
    expect(designCreativeProposalDiff.diff(before, next)).toMatchObject({
      fallback: [],
      changes: [{ elementId: creativeDesignAddressKey(address), property: 'fill' }],
    });
  });
  it('preserves manga/page adapter subset behavior', () => {
    const before = fixture();
    const componentChange = updateComponentPart('person', 'eyes', { fill: '#cc3300' }).apply(
      before,
    );
    for (const adapter of [designMangaProposalDiff, designPageProposalDiff]) {
      const diff = adapter.diff(before, componentChange);
      expect(diff.changes).toEqual([]);
      expect(diff.fallback).toMatchObject([
        { path: 'components', reason: 'unsupported-m0-property' },
      ]);
    }
    const eye = { ...makeDesignElement('shape'), id: 'eyes' };
    const plain = { ...createDesign(), elements: [eye] };
    for (const adapter of [designMangaProposalDiff, designPageProposalDiff])
      expect(
        adapter.diff(plain, { ...plain, elements: [{ ...eye, fill: 'red' }] }).fallback,
      ).toMatchObject([{ reason: 'unsupported-m0-property' }]);
  });
});

describe('Creative Design acceptance on the existing public Host', () => {
  it('previews without mutation, rejects without history, applies one Undo step and saves/reloads', async () => {
    const { host, adapter, storage } = hostFixture(),
      before = host.content;
    const proposal = propose(
      host,
      [
        creativeDesignEditCommand(instance('bangs'), {
          bounds: { ...part(before, 'bangs').bounds, x: 90 },
        }),
        creativeDesignEditCommand(instance('eyes'), { fill: '#ff8800' }),
      ],
      { required: [instance('bangs'), instance('eyes')] },
    );
    const pending = host.propose(proposal);
    expect(host.content).toEqual(before);
    expect(host.canUndo).toBe(false);
    expect(pending.preview.content).not.toEqual(before);
    host.rejectProposal(proposal.id);
    expect(host.content).toEqual(before);
    expect(host.canUndo).toBe(false);
    host.propose(proposal);
    host.acceptProposal(proposal.id);
    const after = host.content;
    host.undo();
    expect(host.content).toEqual(before);
    expect(host.canUndo).toBe(false);
    host.redo();
    expect(host.content).toEqual(after);
    await host.save({ commitVersion: true });
    const reloaded = await loadHostArtifact(
      serializeArtifact((await storage.get(host.id))!),
      adapter,
    );
    expect(reloaded.draft.content).toEqual(after);
    expect(isDesign(reloaded.draft.content)).toBe(true);
  });
  it('refuses empty/required-missing/outside-scope and fallback changes atomically', () => {
    const cases: [EditorCommand<DesignContent>[], CreativeDesignProposalScope][] = [
      [[], { required: [shared('eyes')] }],
      [[creativeDesignEditCommand(shared('eyes'), { fill: 'red' })], { required: [] }],
      [
        [creativeDesignEditCommand(shared('bangs'), { fill: 'red' })],
        { required: [shared('eyes')], allowed: [shared('eyes'), shared('bangs')] },
      ],
      [
        [
          creativeDesignEditCommand(shared('eyes'), { fill: 'red' }),
          creativeDesignEditCommand(shared('jacket'), { src: 'data:image/png;base64,bmV3' }),
        ],
        { required: [shared('eyes')] },
      ],
      [
        [creativeDesignEditCommand(shared('eyes'), { fill: 'red', name: 'Unreviewed' })],
        { required: [shared('eyes')] },
      ],
      [
        [creativeDesignEditCommand(instance('eyes', 'B'), { fill: 'red' })],
        { required: [instance('eyes')] },
      ],
      [
        [creativeDesignEditCommand(shared('eyes'), { fill: 'red' })],
        { required: [instance('eyes')] },
      ],
    ];
    for (const [commands, scope] of cases) {
      const { host } = hostFixture(),
        before = host.snapshot;
      expect(() => host.propose(propose(host, commands, scope))).toThrow();
      expect(host.snapshot).toEqual(before);
      expect(host.proposals).toEqual([]);
    }
  });
  it.each(['locked', 'hidden'] as const)(
    'rejects %s part/ancestor, including a raw command that bypasses native guards',
    (property) => {
      for (const target of ['part', 'owner', 'ancestor'] as const) {
        const before = fixture();
        if (target === 'part') part(before, 'eyes')[property] = true;
        else if (target === 'owner') before.elements[0][property] = true;
        else {
          before.components[0].elements!.unshift({
            ...makeDesignElement('group'),
            id: 'face',
            [property]: true,
          });
          part(before, 'eyes').parentId = 'face';
        }
        const { host } = hostFixture(before);
        const raw = command<DesignContent>('raw', 'Raw edit', (d) => ({
          ...d,
          elements: d.elements.map((e) =>
            e.id === 'A' ? { ...e, overrides: { eyes: { fill: 'red' } } } : e,
          ),
        }));
        expect(() => host.propose(propose(host, [raw], { required: [instance('eyes')] }))).toThrow(
          /Unlock/,
        );
        expect(host.content).toEqual(before);
        expect(host.canUndo).toBe(false);
      }
    },
  );
  it.each(['locked', 'hidden'] as const)(
    'honors effective %s styles on parts and ancestors',
    (property) => {
      const before = fixture();
      before.styles = [{ id: 'guarded', name: 'Guarded', appearance: { [property]: true } }];
      part(before, 'eyes').styleId = 'guarded';
      const { host } = hostFixture(before);
      const raw = command<DesignContent>('raw', 'Raw edit', (d) => ({
        ...d,
        elements: d.elements.map((e) =>
          e.id === 'A' ? { ...e, overrides: { eyes: { fill: 'red' } } } : e,
        ),
      }));
      expect(() => host.propose(propose(host, [raw], { required: [instance('eyes')] }))).toThrow(
        /Unlock/,
      );
      expect(host.content).toEqual(before);
    },
  );
  it('uses the same scope guard for native human commands and rejects hidden descendants of a group', () => {
    const before = fixture();
    before.styles = [{ id: 'guarded', name: 'Guarded', appearance: { hidden: true } }];
    part(before, 'eyes').styleId = 'guarded';
    expect(() =>
      creativeDesignEditCommand(instance('eyes'), { fill: 'red' }).apply(before),
    ).toThrow(/Unlock/);
    const grouped = fixture();
    grouped.components[0].elements!.push({ ...makeDesignElement('group'), id: 'face' });
    part(grouped, 'eyes').parentId = 'face';
    part(grouped, 'eyes').hidden = true;
    const { host } = hostFixture(grouped);
    const raw = command<DesignContent>('raw', 'Raw edit', (d) => ({
      ...d,
      components: d.components.map((c) => ({
        ...c,
        elements: c.elements!.map((e) => (e.id === 'face' ? { ...e, fill: 'red' } : e)),
      })),
    }));
    expect(() => host.propose(propose(host, [raw], { required: [shared('face')] }))).toThrow(
      /Unlock/,
    );
    expect(host.content).toEqual(grouped);
  });
  it('revalidates trusted permission and scope permission between preview and apply', () => {
    const first = hostFixture();
    first.host.propose(
      propose(first.host, [creativeDesignEditCommand(shared('eyes'), { fill: 'red' })], {
        required: [shared('eyes')],
      }),
    );
    first.readonly();
    expect(() => first.host.acceptProposal('edit')).toThrow(/read.only/i);
    expect(first.host.canUndo).toBe(false);
    const second = hostFixture();
    let allowed = true;
    const proposal = prepareCreativeDesignProposal(
      {
        id: 'guarded',
        summary: 'Scoped permission',
        baseLocalRevision: second.host.revision,
        commands: [creativeDesignEditCommand(shared('eyes'), { fill: 'red' })],
      },
      { required: [shared('eyes')] },
      () => allowed,
    );
    second.host.propose(proposal);
    allowed = false;
    expect(() => second.host.acceptProposal('guarded')).toThrow(/read only/);
    expect(second.host.canUndo).toBe(false);
  });
  it('refuses stale prepared and previewed revisions, even after undo restores content', () => {
    const { host } = hostFixture();
    const proposal = propose(host, [creativeDesignEditCommand(shared('eyes'), { fill: 'red' })], {
      required: [shared('eyes')],
    });
    host.propose(proposal);
    host.execute(creativeDesignEditCommand(shared('bangs'), { fill: 'blue' }));
    host.undo();
    expect(() => host.acceptProposal(proposal.id)).toThrow(/draft changed/i);
    expect(() => host.propose(proposal)).toThrow(/draft changed/i);
    expect(host.content).toEqual(fixture());
  });
  it('owns scope addresses and native patches across preview/apply', () => {
    const { host } = hostFixture();
    const address = instance('eyes'),
      patch = { fill: 'red' },
      scope = { required: [address] };
    const proposal = propose(host, [creativeDesignEditCommand(address, patch)], scope);
    host.propose(proposal);
    patch.fill = 'blue';
    address.elementId = 'jacket';
    scope.required.length = 0;
    expect(host.acceptProposal(proposal.id).changedElementIds).toEqual([
      creativeDesignAddressKey(instance('eyes')),
    ]);
  });
});

it('requires a runtime base revision for JavaScript/AI callers too', () => {
  const host = hostFixture().host;
  for (const baseLocalRevision of [
    undefined,
    {},
    { ...host.revision, sequence: -1 },
    { ...host.revision, sequence: 0.5 },
  ]) {
    expect(() =>
      prepareCreativeDesignProposal(
        {
          id: 'missing-revision',
          summary: 'Edit eyes',
          commands: [creativeDesignEditCommand(instance('eyes'), { fill: 'red' })],
          baseLocalRevision,
        } as Parameters<typeof prepareCreativeDesignProposal>[0],
        { required: [instance('eyes')] },
      ),
    ).toThrow(/baseLocalRevision/);
  }
});

describe('PR #619 review regressions', () => {
  it.each(['locked', 'hidden'] as const)(
    'restores a shared part after %s survives save/reload',
    async (property) => {
      const { host, storage, adapter } = hostFixture();
      host.execute(creativeDesignEditCommand(shared('eyes'), { [property]: true }));
      await host.save({ commitVersion: true });
      const saved = await loadHostArtifact(
        serializeArtifact((await storage.get(host.id))!),
        adapter,
      );
      const reloaded = new ArtifactEditor(saved, adapter, storage);
      const before = reloaded.content;
      const proposal = propose(
        reloaded,
        [creativeDesignEditCommand(shared('eyes'), { [property]: false })],
        { required: [shared('eyes')] },
      );
      expect(
        reloaded
          .propose(proposal)
          .preview.content.components[0].elements!.find((e) => e.id === 'eyes')![property],
      ).toBe(false);
      expect(reloaded.content).toEqual(before);
      reloaded.acceptProposal(proposal.id);
      const after = reloaded.content;
      expect(part(after, 'eyes')[property]).toBe(false);
      expect(after.elements).toEqual(before.elements);
      reloaded.undo();
      expect(reloaded.content).toEqual(before);
      reloaded.redo();
      expect(reloaded.content).toEqual(after);
      expect(updateComponentPart('person', 'eyes', { [property]: false }).apply(before)).toEqual(
        after,
      );
      expect(() =>
        updateComponentPart('person', 'eyes', { [property]: false, fill: 'red' }).apply(before),
      ).toThrow(/Unlock/);
      const guarded = structuredClone(before);
      guarded.components[0].elements!.push({
        ...makeDesignElement('group'),
        id: 'face',
        [property]: true,
      });
      part(guarded, 'eyes').parentId = 'face';
      expect(() =>
        updateComponentPart('person', 'eyes', { [property]: false }).apply(guarded),
      ).toThrow(/Unlock/);
      expect(() =>
        creativeDesignEditCommand(shared('eyes'), { [property]: false }).apply(guarded),
      ).toThrow(/Unlock/);
    },
  );
  it.each(['locked', 'hidden'] as const)(
    'uses an override-selected %s style for parts and ancestors',
    (property) => {
      for (const target of ['eyes', 'face']) {
        const before = fixture();
        before.styles = [
          { id: 'definition', name: 'Definition', appearance: { fill: 'blue' } },
          { id: 'guarded', name: 'Guarded', appearance: { [property]: true } },
        ];
        part(before, 'eyes').styleId = 'definition';
        if (target === 'face') {
          before.components[0].elements!.push({
            ...makeDesignElement('group'),
            id: 'face',
            styleId: 'definition',
          });
          part(before, 'eyes').parentId = 'face';
        }
        before.elements[0].overrides = { [target]: { styleId: 'guarded' } };
        const { host } = hostFixture(before);
        const raw = command<DesignContent>('raw', 'Change fill', (d) => ({
          ...d,
          elements: d.elements.map((e) =>
            e.id === 'A'
              ? { ...e, overrides: { ...e.overrides, eyes: { ...e.overrides?.eyes, fill: 'red' } } }
              : e,
          ),
        }));
        expect(() => overrideInstance('A', ['eyes'], { fill: 'red' }).apply(before)).toThrow(
          /Unlock/,
        );
        expect(() => host.propose(propose(host, [raw], { required: [instance('eyes')] }))).toThrow(
          /Unlock/,
        );
        expect(host.content).toEqual(before);
        expect(host.canUndo).toBe(false);
      }
    },
  );
  it('reports component order as fallback and refuses it together with an allowed edit', () => {
    const before = fixture();
    before.components.push({ ...structuredClone(before.components[0]), id: 'other' });
    const after = structuredClone(before);
    after.components.reverse();
    expect(designCreativeProposalDiff.diff(before, after)).toMatchObject({
      changes: [],
      fallback: [
        {
          path: 'components',
          reason: 'unsupported-creative-order',
          before: ['person', 'other'],
          after: ['other', 'person'],
        },
      ],
    });
    const { host } = hostFixture(before);
    const raw = command<DesignContent>('raw', 'Reorder and edit', (d) => {
      const next = updateComponentPart('person', 'eyes', { fill: 'red' }).apply(d);
      return { ...next, components: [...next.components].reverse() };
    });
    expect(() => host.propose(propose(host, [raw], { required: [shared('eyes')] }))).toThrow(
      /fallback/,
    );
    expect(host.content).toEqual(before);
    expect(host.canUndo).toBe(false);
  });
});

describe('raw proposal native before/after guards', () => {
  function linkedPage() {
    return designDivisionCommand({
      type: 'startDivision',
      pageId: 'page',
      region: { x: 30, y: 40, width: 540, height: 720 },
      root: { panelId: 'panel' },
    }).apply(
      insertDesignPage({ x: 100, y: 200, width: 600, height: 800 }, 'page').apply(createDesign()),
    );
  }
  function pageHost(content: DesignContent) {
    const adapter = createCreativeDesignHostAdapter({
      ...baseAdapter,
      validate: isDesignWithPaths,
    });
    return new ArtifactEditor(
      createArtifact('design', 'Linked page', content),
      adapter,
      new MemoryStorage(),
    );
  }
  const resizePage = (d: DesignContent): DesignContent => ({
    ...d,
    elements: d.elements.map((e) =>
      e.id === 'page' ? { ...e, bounds: { ...e.bounds, width: 650 } } : e,
    ),
  });
  it('rejects raw linked-page resize even when the resulting snapshot and semantic scope are valid', () => {
    const before = linkedPage();
    expect(isDesignWithPaths(resizePage(before))).toBe(true);
    expect(designCreativeProposalDiff.diff(before, resizePage(before))).toMatchObject({
      changes: [{ property: 'bounds' }],
      fallback: [],
    });
    const bounds = resizePage(before).elements.find((e) => e.id === 'page')!.bounds;
    expect(() => patchDesign(['page'], { bounds }).apply(before)).toThrow(/Linked page resize/);
    const host = pageHost(before),
      initial = host.snapshot;
    const raw = command('raw', 'Resize linked page', resizePage);
    expect(() => host.propose(propose(host, [raw], { required: [{ elementId: 'page' }] }))).toThrow(
      /Linked page resize/,
    );
    expect(host.snapshot).toEqual(initial);
    expect(host.proposals).toEqual([]);
  });
  it('runs the native transition guard again at apply without consuming history', () => {
    const host = pageHost(linkedPage()),
      before = host.snapshot;
    let resize = false;
    const raw = command<DesignContent>('raw', 'Change page', (d) =>
      resize
        ? resizePage(d)
        : {
            ...d,
            elements: d.elements.map((e) => (e.id === 'page' ? { ...e, fill: '#112233' } : e)),
          },
    );
    const proposal = propose(host, [raw], { required: [{ elementId: 'page' }] });
    host.propose(proposal);
    resize = true;
    expect(() => host.acceptProposal(proposal.id)).toThrow(/Linked page resize/);
    expect(host.snapshot).toEqual(before);
  });
  it('preserves ordinary and explicitly detached page resize', () => {
    const detached = designDivisionCommand({ type: 'detachDivision', pageId: 'page' }).apply(
      linkedPage(),
    );
    for (const before of [
      insertDesignPage({ x: 100, y: 200, width: 600, height: 800 }, 'page').apply(createDesign()),
      detached,
    ]) {
      const host = pageHost(before);
      const raw = command('raw', 'Resize page', resizePage);
      const proposal = propose(host, [raw], { required: [{ elementId: 'page' }] });
      host.propose(proposal);
      host.acceptProposal(proposal.id);
      expect(host.content).toEqual(resizePage(before));
      host.undo();
      expect(host.content).toEqual(before);
    }
  });
});

describe('causal source-attribution cleanup scope', () => {
  const source = 'data:image/png;base64,b2xk',
    replacement = 'data:image/png;base64,bmV3';
  const oldProvenance = {
    src: source,
    source: 'Old instance artist',
    license: 'CC0',
  };
  type AttributedPatch = Partial<DesignElement> & { provenance?: unknown };
  function attributedFixture() {
    const before = fixture();
    before.elements[0].overrides = {
      jacket: { provenance: oldProvenance } as AttributedPatch,
    };
    return before;
  }
  // Model the native #615 canonical cleanup without importing its unmerged type
  // or API. Runtime metadata remains visible in the ordinary qualified diff.
  function sourceAndCleanup(before: DesignContent) {
    const after = structuredClone(before);
    part(after, 'jacket').src = replacement;
    const override = after.elements[0].overrides!.jacket as AttributedPatch;
    delete override.provenance;
    return after;
  }
  function raw(after: DesignContent) {
    return command<DesignContent>('raw', 'Shared source and attribution cleanup', () =>
      structuredClone(after),
    );
  }
  it.each([undefined, 'locked', 'hidden'] as const)(
    'accepts only causal cleanup and keeps qualified diff targets (owner %s)',
    (guard) => {
      const before = attributedFixture();
      if (guard) before.elements[0][guard] = true;
      const after = sourceAndCleanup(before),
        { host } = hostFixture(before);
      const diff = designCreativeProposalDiff.diff(before, after);
      expect(diff.fallback).toEqual([]);
      expect(diff.changes.map((change) => change.elementId).sort()).toEqual(
        [
          creativeDesignAddressKey(instance('jacket')),
          creativeDesignAddressKey(shared('jacket')),
        ].sort(),
      );
      const proposal = propose(host, [raw(after)], {
        required: [shared('jacket')],
      });
      expect(host.propose(proposal).preview.content).toEqual(after);
      const accepted = host.acceptProposal(proposal.id);
      expect(accepted.changedElementIds?.slice().sort()).toEqual(
        [
          creativeDesignAddressKey(instance('jacket')),
          creativeDesignAddressKey(shared('jacket')),
        ].sort(),
      );
      expect(host.content).toEqual(after);
      host.undo();
      expect(host.content).toEqual(before);
      host.redo();
      expect(host.content).toEqual(after);
    },
  );
  it('does not count cleanup as a requested instance edit', () => {
    const before = attributedFixture(),
      after = sourceAndCleanup(before),
      { host } = hostFixture(before);
    expect(() =>
      host.propose(
        propose(host, [raw(after)], {
          required: [instance('jacket')],
          allowed: [shared('jacket'), instance('jacket')],
        }),
      ),
    ).toThrow(/every required part/);
    expect(host.content).toEqual(before);
    expect(host.canUndo).toBe(false);
  });
  it('requires the shared source origin itself to be allowed', () => {
    const before = attributedFixture(),
      after = sourceAndCleanup(before),
      { host } = hostFixture(before);
    expect(() =>
      host.propose(propose(host, [raw(after)], { required: [instance('jacket')] })),
    ).toThrow(/outside/);
    expect(host.content).toEqual(before);
  });
  const cases: [string, (before: DesignContent) => void, (after: DesignContent) => void][] = [
    [
      'explicit own source',
      (d) => {
        d.elements[0].overrides!.jacket.src = source;
      },
      () => {},
    ],
    [
      'attribution for another source',
      (d) => {
        (d.elements[0].overrides!.jacket as AttributedPatch).provenance = {
          ...oldProvenance,
          src: replacement,
        };
      },
      () => {},
    ],
    [
      'new attribution',
      () => {},
      (d) => {
        (d.elements[0].overrides!.jacket as AttributedPatch).provenance = {
          ...oldProvenance,
          src: replacement,
          source: 'Changed',
        };
      },
    ],
    [
      'undefined marker',
      () => {},
      (d) => {
        (d.elements[0].overrides!.jacket as AttributedPatch).provenance = undefined;
      },
    ],
    [
      'new explicit source',
      () => {},
      (d) => {
        d.elements[0].overrides!.jacket.src = replacement;
      },
    ],
    [
      'additional fill edit',
      () => {},
      (d) => {
        d.elements[0].overrides!.jacket.fill = 'red';
      },
    ],
    [
      'same source',
      () => {},
      (d) => {
        part(d, 'jacket').src = source;
        part(d, 'jacket').fill = 'red';
      },
    ],
  ];
  it.each(cases)('rejects %s alongside a shared edit', (_label, prepare, alter) => {
    const before = attributedFixture();
    prepare(before);
    const after = sourceAndCleanup(before);
    alter(after);
    let checkedHost: ReturnType<typeof hostFixture>['host'] | undefined;
    expect(() => {
      checkedHost = hostFixture(before).host;
      checkedHost.propose(propose(checkedHost, [raw(after)], { required: [shared('jacket')] }));
    }).toThrow();
    if (checkedHost) {
      expect(checkedHost.content).toEqual(before);
      expect(checkedHost.canUndo).toBe(false);
    }
  });
  it('rejects manual attribution deletion without a shared source change', () => {
    const before = attributedFixture(),
      after = structuredClone(before);
    delete (after.elements[0].overrides!.jacket as AttributedPatch).provenance;
    const { host } = hostFixture(before);
    expect(() =>
      host.propose(propose(host, [raw(after)], { required: [shared('jacket')] })),
    ).toThrow(/outside|every required/);
  });
  it('does not exempt cleanup of an unrelated part', () => {
    const before = attributedFixture();
    before.components[0].elements!.push({
      ...part(before, 'jacket'),
      id: 'unrelated',
    });
    before.elements[0].overrides = {
      unrelated: { provenance: oldProvenance } as AttributedPatch,
    };
    const after = structuredClone(before);
    part(after, 'jacket').src = replacement;
    delete (after.elements[0].overrides!.unrelated as AttributedPatch).provenance;
    const { host } = hostFixture(before);
    expect(() =>
      host.propose(propose(host, [raw(after)], { required: [shared('jacket')] })),
    ).toThrow(/outside/);
    expect(host.content).toEqual(before);
  });
  it('does not exempt cleanup in another component with the same part ID', () => {
    const before = attributedFixture();
    before.components.push({
      ...structuredClone(before.components[0]),
      id: 'other',
    });
    before.elements[0].componentId = 'other';
    const after = sourceAndCleanup(before),
      { host } = hostFixture(before);
    expect(() =>
      host.propose(propose(host, [raw(after)], { required: [shared('jacket')] })),
    ).toThrow(/outside/);
    expect(host.content).toEqual(before);
  });
});
