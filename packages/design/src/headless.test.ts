import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { canonicalJson, deepFreeze } from '@editor-platform/artifact-core';
import { EditorSession, type EditorCommand } from '@editor-platform/editor-core';
import {
  createDesign,
  makeDesignElement,
  insertElement,
  insertInstance,
  createComponent,
  updateElement,
  updateComponent,
  updateComponentPart,
  overrideInstance,
  patchDesign,
  reparentElement,
  transformElements,
  isDesign,
  designIntentCommand,
  parseDesignIntents,
  previewDesignIntents,
  prepareDesignIntentApplication,
  type DesignContent,
  type DesignIntent,
} from '@editor-platform/design/model';
import { setDesignInteractions, setDesignPrototype } from '@editor-platform/design/prototype';
import { sealReactComponent, sealReactEnvironment } from '@editor-platform/react-ui-core';
import { configureDesignWeb, insertDesignReact } from '@editor-platform/design-react-core';
import { reuseHash } from '@editor-platform/reuse-core';

const box = { x: 10, y: 20, width: 120, height: 40 };
const content = (): DesignContent => ({
  ...createDesign(),
  elements: [
    { ...makeDesignElement('frame'), id: 'frame', bounds: { x: 0, y: 0, width: 600, height: 400 } },
  ],
});
function state(session: EditorSession<DesignContent>) {
  return {
    content: session.content,
    revision: session.revision,
    canUndo: session.canUndo,
    canRedo: session.canRedo,
  };
}
function unchangedFailure(
  session: EditorSession<DesignContent>,
  command: EditorCommand<DesignContent> | (() => EditorCommand<DesignContent>),
) {
  const before = state(session);
  expect(() => session.execute(typeof command === 'function' ? command() : command)).toThrow();
  expect(state(session)).toStrictEqual(before);
}

describe('Design stable insertion', () => {
  it('exposes an owned ID, accepts bounds/parent/order and preserves the source-string API', () => {
    const source = deepFreeze(content());
    const placement = { id: '日本語 / child', bounds: { ...box }, parentId: 'frame', index: 0 };
    const cmd = insertElement('text', placement);
    placement.bounds.width = 999;
    expect(cmd.elementId).toBe('日本語 / child');
    const a = cmd.apply(source),
      b = cmd.apply(source);
    expect(a).toStrictEqual(b);
    expect(a.elements.map((e) => e.id)).toEqual([cmd.elementId, 'frame']);
    expect(a.elements[0]).toMatchObject({ bounds: box, parentId: 'frame' });
    expect(source.elements).toHaveLength(1);
    const generated = insertElement('rectangle');
    expect(generated.apply(source).elements.at(-1)!.id).toBe(generated.elementId);
    expect(generated.apply(source)).toStrictEqual(generated.apply(source));
    const src = 'data:image/png;base64,YQ==';
    expect(insertElement('image', '').apply(source).elements.at(-1)).not.toHaveProperty('src');
    expect(insertElement('image', src).apply(source).elements.at(-1)!.src).toBe(src);
  });
  it('positions multiple instances deterministically and rejects collisions without consuming history', () => {
    let d = insertElement('text', { id: 'title', bounds: box }).apply(content());
    d = createComponent('title', 'component').apply(d);
    const cmd = insertInstance('component', {
      id: 'instance',
      bounds: box,
      parentId: 'frame',
      index: 1,
    });
    expect(cmd.elementId).toBe('instance');
    expect(cmd.apply(d)).toStrictEqual(cmd.apply(d));
    const session = new EditorSession(d);
    session.execute(cmd);
    expect(session.content.elements[1]).toMatchObject({
      id: 'instance',
      componentId: 'component',
      bounds: box,
      parentId: 'frame',
    });
    unchangedFailure(session, cmd);
    session.undo();
    expect(session.content).toEqual(d);
    unchangedFailure(session, insertInstance('missing'));
    session.redo();
    expect(session.content.elements[1].id).toBe('instance');
  });
  it.each([
    { id: 'frame' },
    { id: '' },
    { bounds: { ...box, width: 0 } },
    { parentId: 'missing' },
    { index: -1 },
    { index: 2 },
    { index: 0.5 },
    { bounds: { ...box, x: Infinity } },
  ])('rejects invalid insertion options atomically: %j', (options) => {
    unchangedFailure(new EditorSession(content()), () => insertElement('rectangle', options));
  });
});

describe('same validated Design commands in UI and headless code', () => {
  it('rejects undeclared nested fields without consuming the existing Redo branch', () => {
    const vector = {
      viewBox: { x: 0, y: 0, width: 10, height: 10 },
      paths: ['M0 0L10 10'],
      provenance: { source: 'fixture', name: 'Line', version: '1', license: 'CC0' },
    };
    const reference = {
      schemaVersion: 1,
      source: { artifactId: 'source', domain: 'design', target: { kind: 'all', viewId: 'main' } },
      mode: 'fixed',
      fit: 'contain',
      snapshot: {
        artifactId: 'source',
        domain: 'design',
        versionId: 'v1',
        revision: 1,
        content: {},
        contentHash: reuseHash({}),
        dependencies: [],
      },
    };
    const cases: { type?: 'shape' | 'image'; valid: object; invalid: object }[] = [
      {
        valid: {
          layout: { direction: 'row', gap: 1, padding: 0, align: 'start', sizing: 'fixed' },
        },
        invalid: {
          layout: {
            direction: 'row',
            gap: 1,
            padding: 0,
            align: 'start',
            sizing: 'fixed',
            unexpected: true,
          },
        },
      },
      {
        valid: { constraints: { horizontal: 'left', vertical: 'top' } },
        invalid: { constraints: { horizontal: 'left', vertical: 'top', unexpected: true } },
      },
      {
        valid: { crop: { x: 0, y: 0, scale: 1 } },
        invalid: { crop: { x: 0, y: 0, scale: 1, unexpected: true } },
      },
      {
        valid: { typography: { fontSize: 18 } },
        invalid: { typography: { fontSize: 18, unexpected: true } },
      },
      {
        valid: { runs: [{ text: 'A', style: { bold: true } }] },
        invalid: { runs: [{ text: 'A', style: { bold: true, unexpected: true } }] },
      },
      { valid: { runs: [{ text: 'A' }] }, invalid: { runs: [{ text: 'A', unexpected: true }] } },
      ...[
        { ...vector, unexpected: true },
        { ...vector, viewBox: { ...vector.viewBox, unexpected: true } },
        { ...vector, provenance: { ...vector.provenance, unexpected: true } },
      ].map((value) => ({ type: 'shape' as const, valid: { vector }, invalid: { vector: value } })),
      ...[
        { ...reference, unexpected: true },
        { ...reference, source: { ...reference.source, unexpected: true } },
        {
          ...reference,
          source: { ...reference.source, target: { ...reference.source.target, unexpected: true } },
        },
        { ...reference, snapshot: { ...reference.snapshot, unexpected: true } },
      ].map((value) => ({
        type: 'image' as const,
        valid: { reference },
        invalid: { reference: value },
      })),
      {
        valid: { web: { layout: { base: {}, breakpoints: {} } } },
        invalid: { web: { layout: { base: {}, breakpoints: {}, unexpected: true } } },
      },
    ];
    for (const { type = 'text', valid, invalid } of cases) {
      const source = insertElement(type, { id: 'item' }).apply(content());
      expect(isDesign(updateElement('item', valid).apply(source))).toBe(true);
      const session = new EditorSession(source);
      session.execute(updateElement('item', { name: 'Redo target' }));
      session.undo();
      unchangedFailure(session, updateElement('item', invalid));
      unchangedFailure(session, patchDesign(['item'], invalid));
      unchangedFailure(
        session,
        designIntentCommand([{ type: 'update', id: 'item', patch: invalid }]),
      );
      unchangedFailure(
        session,
        designIntentCommand([{ type: 'properties', ids: ['item'], patch: invalid }]),
      );
    }
    let d = insertElement('text', { id: 'part' }).apply(content());
    d = createComponent('part', 'simple').apply(d);
    const session = new EditorSession(d);
    const patch = { typography: { fontSize: 18, unexpected: true } };
    unchangedFailure(session, updateComponent('simple', patch));
    unchangedFailure(session, overrideInstance('part', 'root', patch));
    unchangedFailure(session, updateElement('part', { overrides: { root: patch } }));
    d = createComponent('frame', 'complex').apply(content());
    unchangedFailure(new EditorSession(d), updateComponentPart('complex', 'frame', patch));
  });
  it('keeps React identities behind registered insertion while preserving ordinary binding edits', () => {
    const registration = sealReactComponent({
      schemaVersion: 1,
      ref: {
        registryId: 'fixture',
        componentId: 'Badge',
        version: '1',
        implementationHash: '0'.repeat(64),
      },
      name: 'Badge',
      import: { source: './Badge', export: 'named', name: 'Badge' },
      props: { title: { schema: { type: 'string' }, required: true } },
      slots: {},
      events: {},
      controlledInputs: [],
      layout: 'wrapper',
      requires: [],
      sampleProps: { title: 'Badge' },
    });
    const environment = sealReactEnvironment({
      schemaVersion: 1,
      ref: { id: 'fixture', version: '1' },
      reactVersion: '19.1.1',
      dependencies: [],
      providerOrder: [],
      stylePolicy: 'allow-literals',
      tokenVariables: {},
    });
    const configured = configureDesignWeb({
      schemaVersion: 1,
      environment,
      registrations: [],
      inputs: { title: { schema: { type: 'string' }, required: true } },
      callbacks: {},
      fixture: { title: 'Bound' },
      breakpoints: [],
      pages: [],
    }).apply(content());
    const d = insertDesignReact(registration, 'registered').apply(configured);
    const react = d.elements.find((e) => e.id === 'registered')!.react!;
    const session = new EditorSession(d);
    unchangedFailure(
      session,
      designIntentCommand([
        { type: 'insert', elementType: 'text', options: { id: 'fabricated' } },
        { type: 'update', id: 'fabricated', patch: { type: 'react', react } },
      ]),
    );
    unchangedFailure(session, updateElement('frame', { react }));
    unchangedFailure(session, updateElement('registered', { type: 'rectangle', react: undefined }));
    unchangedFailure(
      session,
      updateElement('registered', {
        react: { ...react, component: { ...react.component, componentId: 'Unregistered' } },
      }),
    );
    unchangedFailure(
      session,
      updateElement('registered', {
        react: { ...react, import: { ...react.import, source: './Unregistered' } },
      }),
    );
    unchangedFailure(
      session,
      updateElement('registered', { react: { ...react, slots: { children: ['frame'] } } }),
    );
    session.execute(
      updateElement('registered', {
        react: {
          ...react,
          props: {},
          bindings: { title: { kind: 'data', input: 'title', path: [] } },
        },
      }),
    );
    expect(
      session.content.elements.find((e) => e.id === 'registered')!.react!.bindings.title,
    ).toEqual({ kind: 'data', input: 'title', path: [] });
    expect(session.content.web!.registrations).toEqual(d.web!.registrations);
    session.undo();
    expect(session.content).toEqual(d);
  });
  it.each(['locked', 'hidden', 'locked-ancestor', 'hidden-ancestor'] as const)(
    'applies native destination editability to parent patches: %s',
    (mode) => {
      const ancestor = mode.endsWith('-ancestor');
      const field = mode.startsWith('locked') ? 'locked' : 'hidden';
      const source = {
        ...createDesign(),
        elements: [
          { ...makeDesignElement('frame'), id: 'outer', ...(ancestor ? { [field]: true } : {}) },
          {
            ...makeDesignElement('frame'),
            id: 'parent',
            ...(ancestor ? { parentId: 'outer' } : { [field]: true }),
          },
          { ...makeDesignElement('text'), id: 'item' },
        ],
      };
      const session = new EditorSession(source);
      const patch = { parentId: 'parent' };
      unchangedFailure(session, reparentElement('item', 'parent'));
      unchangedFailure(session, updateElement('item', patch));
      unchangedFailure(session, patchDesign(['item'], patch));
      unchangedFailure(session, designIntentCommand([{ type: 'update', id: 'item', patch }]));
      unchangedFailure(
        session,
        designIntentCommand([{ type: 'properties', ids: ['item'], patch }]),
      );
      expect(
        updateElement('item', { parentId: 'parent' })
          .apply({
            ...source,
            elements: source.elements.map((e) => ({ ...e, locked: false, hidden: false })),
          })
          .elements.find((e) => e.id === 'item')!.parentId,
      ).toBe('parent');
    },
  );
  it('preserves valid template-only instance components across native and JSON updates', () => {
    let d = insertElement('text', { id: 'seed' }).apply(content());
    d = createComponent('seed', 'base').apply(d);
    d = createComponent('seed', 'wrapper').apply(d);
    d = JSON.parse(JSON.stringify(d));
    expect(isDesign(d)).toBe(true);
    expect(d.components.find((c) => c.id === 'wrapper')!.template.type).toBe('instance');
    const session = new EditorSession(d);
    session.execute(updateComponent('wrapper', { fill: '#112233' }));
    session.undo();
    expect(session.content).toEqual(d);
    const preview = previewDesignIntents(session.content, [
      {
        type: 'update-component',
        componentId: 'wrapper',
        patch: { text: 'Updated saved template' },
      },
    ]);
    session.execute(
      prepareDesignIntentApplication(JSON.parse(JSON.stringify(preview.intentProposal))),
    );
    expect(session.content.components.find((c) => c.id === 'wrapper')!.template.text).toBe(
      'Updated saved template',
    );
    session.undo();
    expect(session.content).toEqual(d);
    session.execute(overrideInstance('seed', 'root', { fill: '#445566' }));
    expect(isDesign(session.content)).toBe(true);
  });
  it('rejects invalid element values, missing targets and immutable identities on execution', () => {
    const session = new EditorSession(insertElement('text', { id: 'text' }).apply(content()));
    for (const patch of [
      { opacity: 2 },
      { bounds: { ...box, y: NaN } },
      { type: 'script' },
      { text: 4 },
      { id: 'changed' },
      { componentId: 'missing', type: 'instance' },
      { layout: { direction: 'bad', padding: 0, gap: 1, align: 'start', sizing: 'fixed' } },
      { sizing: 'invalid' },
      { src: 'https://untrusted.example/image.png' },
    ]) {
      unchangedFailure(session, () =>
        updateElement('text', patch as Parameters<typeof updateElement>[1]),
      );
      unchangedFailure(session, () =>
        patchDesign(['text'], patch as Parameters<typeof patchDesign>[1]),
      );
    }
    unchangedFailure(session, updateElement('missing', { text: 'no' }));
    unchangedFailure(session, reparentElement('text', 'text'));
    unchangedFailure(session, transformElements(['missing'], { dx: 1, dy: 0, dw: 0, dh: 0 }));
    expect(isDesign(session.content)).toBe(true);
  });
  it('validates component and effective override patches against their actual parts', () => {
    let d = insertElement('text', { id: 'text' }).apply(content());
    d = createComponent('text', 'simple').apply(d);
    const session = new EditorSession(d);
    unchangedFailure(session, updateComponent('simple', { opacity: 4 }));
    unchangedFailure(session, updateComponent('missing', { text: 'no' }));
    unchangedFailure(session, overrideInstance('text', 'missing', { text: 'no' }));
    unchangedFailure(session, overrideInstance('frame', 'root', { text: 'no' }));
    unchangedFailure(session, overrideInstance('text', 'root', { typography: { fontSize: -2 } }));
    session.execute(overrideInstance('text', 'root', { text: 'local' }));
    session.execute(updateComponent('simple', { text: 'shared' }));
    expect(isDesign(session.content)).toBe(true);
    const frame = { ...makeDesignElement('frame'), id: 'card' };
    const child = { ...makeDesignElement('text'), id: 'label', parentId: frame.id };
    d = createComponent(frame.id, 'complex').apply({ ...createDesign(), elements: [frame, child] });
    const scoped = new EditorSession(d);
    unchangedFailure(scoped, updateComponentPart('complex', 'missing', { text: 'no' }));
    unchangedFailure(
      scoped,
      updateComponentPart('complex', 'label', { bounds: { ...box, width: -1 } }),
    );
    scoped.execute(updateComponentPart('complex', 'label', { text: 'valid' }));
    expect(isDesign(scoped.content)).toBe(true);
  });
  it('rejects cyclic component-part overrides through every patch entrypoint', () => {
    const frame = { ...makeDesignElement('frame'), id: 'root' };
    const group = { ...makeDesignElement('group'), id: 'child', parentId: 'root' };
    const source = createComponent('root', 'definition').apply({
      ...createDesign(),
      elements: [frame, group],
    });
    unchangedFailure(
      new EditorSession(source),
      overrideInstance('root', 'root', { parentId: 'child' }),
    );
    // A coincident outer ID must not turn a component-local cycle into a valid reference.
    const session = new EditorSession({
      ...source,
      elements: [...source.elements, { ...makeDesignElement('group'), id: 'child' }],
    });
    const patch = { overrides: { root: { parentId: 'child' } } };
    unchangedFailure(session, updateElement('root', patch));
    unchangedFailure(session, patchDesign(['root'], patch));
    unchangedFailure(session, designIntentCommand([{ type: 'update', id: 'root', patch }]));
    session.execute(updateElement('root', { overrides: { child: { parentId: 'root' } } }));
    expect(session.content.elements[0].overrides?.child.parentId).toBe('root');
  });
  it('rejects new broken prototype targets but preserves diagnosable retained broken links', () => {
    const session = new EditorSession(content());
    unchangedFailure(
      session,
      setDesignInteractions('frame', [
        { trigger: 'click', action: { type: 'navigate', frameId: 'missing' } },
      ]),
    );
    unchangedFailure(
      session,
      setDesignPrototype({ schemaVersion: 1, startFrameId: 'missing', flows: [] }),
    );
    const retained = content();
    retained.prototyping = { schemaVersion: 1, startFrameId: 'deleted-frame', flows: [] };
    expect(isDesign(retained)).toBe(true);
    expect(updateElement('frame', { name: 'Still editable' }).apply(retained).prototyping).toEqual(
      retained.prototyping,
    );
  });
});

describe('bounded JSON intent batches and proposals', () => {
  it('routes component, properties, reparent, override/reset and removal through native commands', () => {
    const batch: DesignIntent[] = [
      { type: 'insert', elementType: 'frame', options: { id: 'card', parentId: 'frame' } },
      { type: 'insert', elementType: 'text', options: { id: 'label', parentId: 'card' } },
      { type: 'create-component', ids: ['card'], componentId: 'card-component' },
      {
        type: 'insert-instance',
        componentId: 'card-component',
        options: { id: 'copy', parentId: 'frame', bounds: box },
      },
      {
        type: 'update-component-part',
        componentId: 'card-component',
        partId: 'label',
        patch: { text: 'Shared' },
      },
      { type: 'override', id: 'copy', partId: 'label', patch: { text: 'Local' } },
      { type: 'properties', ids: ['copy'], patch: { name: 'Copy' } },
      { type: 'update-component', componentId: 'card-component', patch: { fill: '#abcdef' } },
      { type: 'reparent', id: 'copy' },
      { type: 'reset-instance', id: 'copy' },
      { type: 'delete', ids: ['copy'] },
      {
        type: 'set-interactions',
        id: 'card',
        partId: 'label',
        definition: true,
        interactions: [{ trigger: 'click', action: { type: 'navigate', frameId: 'frame' } }],
      },
      { type: 'set-prototype', settings: null },
    ];
    const next = designIntentCommand(batch).apply(content());
    expect(isDesign(next)).toBe(true);
    expect(next.elements.map((e) => e.id)).toEqual(['frame', 'card']);
    expect(next.components[0].elements?.find((e) => e.id === 'label')?.text).toBe('Shared');
    expect(next.components[0].template.fill).toBe('#abcdef');
  });
  const intents: DesignIntent[] = [
    {
      type: 'insert',
      elementType: 'text',
      options: { id: 'heading', parentId: 'frame', bounds: box },
    },
    { type: 'update', id: 'heading', patch: { text: '日本語の見出し' } },
    { type: 'transform', ids: ['heading'], delta: { dx: 5, dy: 0, dw: 0, dh: 0 } },
    {
      type: 'set-interactions',
      id: 'heading',
      interactions: [{ trigger: 'click', action: { type: 'navigate', frameId: 'frame' } }],
    },
    { type: 'set-prototype', settings: { schemaVersion: 1, startFrameId: 'frame', flows: [] } },
  ];
  it('previews without mutation and applies a serialized proposal with one Undo/Redo step', () => {
    const source = deepFreeze(content());
    const session = new EditorSession(source);
    const before = state(session);
    const preview = previewDesignIntents(session.content, JSON.parse(JSON.stringify(intents)), {
      baseLocalRevision: session.revision,
    });
    expect(state(session)).toStrictEqual(before);
    expect(preview.baseContent).toEqual(source);
    expect(preview.proposal.commands).toHaveLength(1);
    expect(preview.content.elements[1]).toMatchObject({
      id: 'heading',
      text: '日本語の見出し',
      bounds: { ...box, x: 15 },
    });
    session.execute(
      prepareDesignIntentApplication(JSON.parse(JSON.stringify(preview.intentProposal)), {
        readRevision: () => session.revision,
      }),
    );
    expect(session.content).toEqual(preview.content);
    session.undo();
    expect(session.content).toEqual(source);
    expect(session.canUndo).toBe(false);
    session.redo();
    expect(session.content).toEqual(preview.content);
    expect(JSON.parse(JSON.stringify(session.content))).toEqual(session.content);
  });
  it('owns intent inputs and assigns generated IDs once before serializing the preview', () => {
    const input = [{ type: 'insert', elementType: 'text' }];
    const preview = previewDesignIntents(content(), input);
    input[0].elementType = 'rectangle';
    const normalized = preview.intentProposal.intents[0];
    expect(normalized.type).toBe('insert');
    const applied = prepareDesignIntentApplication(
      JSON.parse(JSON.stringify(preview.intentProposal)),
    ).apply(content());
    expect(applied).toEqual(preview.content);
    expect(applied.elements[1].type).toBe('text');
    expect(applied.elements[1].id).not.toBe('');
    const again = prepareDesignIntentApplication(
      JSON.parse(JSON.stringify(preview.intentProposal)),
    ).apply(content());
    expect(again).toEqual(applied);
  });
  it('rejects a serialized proposal whose intents differ from the previewed result', () => {
    const preview = previewDesignIntents(content(), intents);
    const proposal = JSON.parse(JSON.stringify(preview.intentProposal));
    proposal.intents[1].patch.text = 'Changed after preview';
    unchangedFailure(new EditorSession(content()), prepareDesignIntentApplication(proposal));
  });
  it('rejects partial failures without changing existing Undo/Redo branches or input content', () => {
    const session = new EditorSession(content());
    session.execute(insertElement('text', { id: 'undoable' }));
    session.undo();
    unchangedFailure(
      session,
      designIntentCommand([...intents, { type: 'update', id: 'missing', patch: { text: 'no' } }]),
    );
    session.redo();
    expect(session.content.elements[1].id).toBe('undoable');
  });
  it('checks changed content, ABA revision and late access revocation inside execution', () => {
    const session = new EditorSession(content());
    const preview = previewDesignIntents(session.content, intents, {
      baseLocalRevision: session.revision,
    });
    let writable = true;
    const command = prepareDesignIntentApplication(preview.intentProposal, {
      readRevision: () => session.revision,
      writable: () => writable,
    });
    writable = false;
    unchangedFailure(session, command);
    writable = true;
    session.execute(updateElement('frame', { name: 'changed' }));
    unchangedFailure(session, command);
    session.undo();
    expect(session.content).toEqual(preview.baseContent);
    unchangedFailure(session, command);
    unchangedFailure(
      new EditorSession(content()),
      prepareDesignIntentApplication(preview.intentProposal),
    );
    const unversioned = previewDesignIntents(content(), intents);
    const changed = updateElement('frame', { name: 'changed' }).apply(content());
    expect(() => prepareDesignIntentApplication(unversioned.intentProposal).apply(changed)).toThrow(
      /changed/,
    );
  });
  it.each(
    [
      [],
      [{}],
      [{ type: 'execute', source: 'code' }],
      [{ type: 'delete', ids: [] }],
      [{ type: 'update', id: 'x', patch: {}, extra: true }],
      [{ type: 'insert', elementType: 'react' }],
      [{ type: 'insert', elementType: 'text', options: { bounds: { ...box, extra: 1 } } }],
      [{ type: 'transform', ids: ['x'], delta: { dx: 0, dy: 0, dw: 0, dh: '1' } }],
      [{ type: 'set-interactions', id: 'x', interactions: null, definition: true }],
    ].map((value) => ({ value })),
  )('rejects unsupported JSON intent shapes: %j', ({ value }) =>
    expect(() => parseDesignIntents(value)).toThrow(),
  );
  it('rejects executable data without evaluating getters, sparse arrays, cycles and oversized batches', () => {
    let called = false;
    const getter = Object.defineProperty({}, 'type', {
      enumerable: true,
      get() {
        called = true;
        return 'delete';
      },
    });
    for (const value of [
      [getter],
      [
        {
          type: 'delete',
          ids: ['x'],
          toJSON() {
            called = true;
            return {};
          },
        },
      ],
      new Array(2),
      [{ type: 'update', id: 'x', patch: { text: undefined } }],
      Array.from({ length: 1001 }, () => ({ type: 'delete', ids: ['x'] })),
    ])
      expect(() => parseDesignIntents(value)).toThrow();
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(() => parseDesignIntents(cycle)).toThrow();
    expect(called).toBe(false);
    const base = canonicalJson(content());
    expect(() =>
      previewDesignIntents(content(), [
        { type: 'update', id: 'frame', patch: { opacity: Infinity } },
      ]),
    ).toThrow();
    expect(canonicalJson(content())).toBe(base);
  });
  it('keeps the public model and proposal API headless without React, DOM or CSS', async () => {
    const result = await build({
      stdin: {
        contents:
          "export { designIntentCommand, previewDesignIntents, prepareDesignIntentApplication } from '@editor-platform/design/model';",
        resolveDir: process.cwd(),
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      metafile: true,
    });
    expect(
      Object.keys(result.metafile!.inputs).filter((key) =>
        /(?:react-dom|node_modules\/react\/|\.tsx$|\.css$)/.test(key),
      ),
    ).toEqual([]);
  });
});
