import { afterEach, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { clone } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import { arrangeDesign, makeDesignElement } from '@editor-platform/design/model';
import {
  reactComponentKey,
  sealReactComponent,
  sealReactEnvironment,
} from '@editor-platform/react-ui-core';
import { ReactComposition } from '@editor-platform/react-ui-preview';
import { nativeDesignRuntime } from '@editor-platform/design-react-preview';
import { designReactFixture } from './fixture';
import { convertDesignToReact, exportDesignReact } from './convert';
import {
  acceptDesignConversion,
  assignDesignNativeSlot,
  assignDesignReactSlot,
  insertDesignReact,
} from './commands';
import {
  referenceComponents,
  referenceResolution,
  referenceEnvironmentRevision,
  createReferenceDocument,
} from '../../../apps/react-ui-reference/src/catalog';
import {
  referenceRegisteredRuntimeAdapter,
  registerReferenceNative,
} from '../../../apps/react-ui-reference/src/generated-registry';
afterEach(() => vi.unstubAllGlobals());
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
it('blocks strict output of an existing native image carrying non-image semantics', () => {
  const d = designReactFixture();
  d.elements.push({
    ...makeDesignElement('image'),
    id: 'wrong-image',
    parentId: 'home',
    src: png,
    alt: 'Retained image',
    web: { tag: 'div' },
  });
  expect(convertDesignToReact(d).diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: 'image-semantics', path: 'wrong-image' }),
    ]),
  );
  expect(() => exportDesignReact(d, referenceResolution)).toThrow(/image|img/i);
});
it.each(['ProductPage.css', 'productpage.CSS'])(
  'Design refuses dependency collision with actual named output %s before acceptance',
  (path) => {
    const d = designReactFixture(),
      env = d.web!.environment,
      { hash: _hash, ...ref } = env.ref;
    d.web!.environment = sealReactEnvironment({
      ...env,
      ref,
      dependencies: env.dependencies.map((dep) => (dep.kind === 'css' ? { ...dep, path } : dep)),
    });
    expect(() =>
      exportDesignReact(d, { ...referenceResolution, environment: d.web!.environment.ref }),
    ).toThrow(/collides with generated output/);
  },
);
it('Design allows a Screen.css dependency when the bundle only contains named page CSS', () => {
  const d = designReactFixture(),
    env = d.web!.environment,
    { hash: _hash, ...ref } = env.ref;
  d.web!.environment = sealReactEnvironment({
    ...env,
    ref,
    dependencies: env.dependencies.map((dep) =>
      dep.kind === 'css' ? { ...dep, path: 'Screen.css' } : dep,
    ),
  });
  const files = exportDesignReact(d, {
    ...referenceResolution,
    environment: d.web!.environment.ref,
  }).files;
  expect(files['ProductPage.css']).toBeDefined();
  expect(files['Screen.css']).toBeUndefined();
});
it('accepts exactly the reviewed selected roots without pages and still refuses a changed source', () => {
  const d = designReactFixture();
  d.web!.pages = [];
  const bundle = exportDesignReact(d, referenceResolution, { rootIds: ['card'] });
  expect(bundle.rootIds).toEqual(['card']);
  expect(acceptDesignConversion(bundle).apply(d).web!.accepted!.fingerprint).toBe(
    bundle.fingerprint,
  );
  d.elements.find((e) => e.id === 'buy')!.name = 'Changed';
  expect(() => acceptDesignConversion(bundle).apply(d)).toThrow(/source changed/i);
});
it.each(['input', 'callback'])('refuses the reserved Site path %s', (kind) => {
  const d = designReactFixture();
  if (kind === 'input')
    d.web!.inputs.path = { schema: { type: 'number' }, required: false, default: 4 };
  else d.web!.callbacks.path = { parameters: [], returns: 'void' };
  expect(() => exportDesignReact(d, referenceResolution)).toThrow(/reserves path/);
});
it('refuses a public variant input when named variants already own the selector', () => {
  const d = designReactFixture();
  d.components[0].web!.props.variant = clone(d.components[0].web!.props.title);
  expect(() => exportDesignReact(d, referenceResolution)).toThrow(/reserve.*variant/);
});
it.each(['react', 'instance', 'img'])('refuses ineffective variant patches on %s parts', (kind) => {
  const d = designReactFixture(),
    c = d.components[0];
  const part =
    kind === 'react'
      ? clone(d.elements.find((e) => e.id === 'buy')!)
      : kind === 'instance'
        ? clone(d.elements.find((e) => e.id === 'card')!)
        : { ...makeDesignElement('image'), src: png, alt: 'Image', web: { tag: 'img' as const } };
  part.id = 'unsupported';
  part.parentId = 'card-frame';
  if (kind === 'instance') {
    const nested = clone(c);
    nested.id = 'nested';
    nested.web!.symbol = 'Nested';
    d.components.push(nested);
    part.componentId = nested.id;
  }
  c.elements!.push(part);
  c.web!.variants.blue[part.id] = { fill: '#123456' };
  expect(convertDesignToReact(d).diagnostics).toContainEqual(
    expect.objectContaining({ code: 'variant-target', path: c.id + '/' + part.id }),
  );
});
it.each(['AAAA', 'iVBORw0KGgo=', 'iVBORw0KGgo===', 'iVBORw0KGgp=', '/9j/AA=='])(
  'refuses broken PNG payload %s',
  (payload) => {
    const d = designReactFixture();
    d.elements.push({
      ...makeDesignElement('image'),
      id: 'broken',
      parentId: 'home',
      src: 'data:image/png;base64,' + payload,
      alt: 'Broken',
      web: { tag: 'img' },
    });
    expect(() => exportDesignReact(d, referenceResolution)).toThrow(/asset/);
  },
);
it.each([
  ['png', png.split(',')[1]],
  ['jpeg', '/9j/AA=='],
  ['webp', 'UklGRgQAAABXRUJQ'],
])('accepts correctly encoded %s signatures', (type, payload) => {
  const d = designReactFixture();
  d.elements.push({
    ...makeDesignElement('image'),
    id: 'image',
    parentId: 'home',
    src: `data:image/${type};base64,${payload}`,
    alt: 'Retained',
    web: { tag: 'img' },
  });
  expect(convertDesignToReact(d).diagnostics).toEqual([]);
});
it.each(['form', 'a', 'p', 'span', 'h1', 'h2', 'label'] as const)(
  'diagnoses invalid known descendants of %s',
  (tag) => {
    const d = designReactFixture(),
      root = d.elements.find((e) => e.id === 'home')!;
    root.web = { tag, ...(tag === 'a' ? { linkPageId: 'contact' } : {}) };
    const child = {
      ...makeDesignElement('frame'),
      id: 'bad-child',
      parentId: root.id,
      web: {
        tag: tag === 'form' || tag === 'a' || tag === 'label' ? tag : ('div' as const),
        ...(tag === 'a' ? { linkPageId: 'contact' } : {}),
      },
    };
    d.elements.push(child);
    expect(
      convertDesignToReact(d).diagnostics.some(
        (x) => x.code === 'html-content' && x.path === child.id,
      ),
    ).toBe(true);
  },
);
it('includes exact nested-only original refs and import hashes once in the manifest', () => {
  const d = designReactFixture(),
    c = d.components[0];
  const nested = clone(d.elements.find((e) => e.id === 'buy')!);
  nested.id = 'inner-only';
  nested.parentId = 'card-frame';
  nested.react!.bindings = {};
  d.elements = d.elements.filter((e) => e.id !== 'buy' && e.id !== 'submit');
  c.elements!.push(nested);
  const manifest = JSON.parse(exportDesignReact(d, referenceResolution).files['manifest.json']);
  const refs = manifest.components.filter(
    (c: { ref: { componentId: string } }) => c.ref.componentId === 'Button',
  );
  expect(refs).toEqual([d.web!.registrations.find((r) => r.ref.componentId === 'Button')]);
});
function slotFixture(kind: 'react' | 'native', maximum = 4) {
  const d = designReactFixture(),
    button = d.elements.find((e) => e.id === 'buy')!;
  const c = d.components[0];
  c.web!.slots = {
    body: {
      elementId: 'card-frame',
      prop: 'children',
      minimum: 0,
      maximum,
      accepts: [{ registryId: 'reference', componentId: 'Button' }],
    },
  };
  const card = referenceComponents.find((c) => c.name === 'Card')!;
  d.elements.push({
    ...makeDesignElement('react'),
    id: 'external',
    parentId: 'home',
    react: {
      component: card.ref,
      import: card.import,
      props: {},
      bindings: {},
      slots: { body: [] },
    },
  });
  button.parentId = kind === 'native' ? 'card' : 'external';
  if (kind === 'native') d.elements.find((e) => e.id === 'card')!.webSlots = { body: [button.id] };
  else d.elements.find((e) => e.id === 'external')!.react!.slots.body = [button.id];
  return d;
}
it.each(['react', 'native'] as const)(
  'ordinary Delete cleans %s slot ownership and Undo restores it',
  (kind) => {
    const d = slotFixture(kind),
      session = new EditorSession(d);
    const next = session.execute(arrangeDesign(['buy'], 'delete'));
    const owner = next.elements.find((e) => e.id === (kind === 'native' ? 'card' : 'external'))!;
    expect(owner.react?.slots.body ?? owner.webSlots!.body).toEqual([]);
    expect(convertDesignToReact(next).diagnostics).toEqual([]);
    expect(exportDesignReact(next, referenceResolution).files['composition.json']).not.toContain(
      '"id":"buy"',
    );
    expect(session.undo()).toEqual(d);
    expect(session.redo()).toEqual(next);
  },
);
it.each(['react', 'native'] as const)(
  'Delete refuses required %s children but permits deleting the owner subtree',
  (kind) => {
    const d = slotFixture(kind),
      owner = kind === 'native' ? 'card' : 'external';
    if (kind === 'native') d.components[0].web!.slots!.body.minimum = 1;
    else {
      const old = d.web!.registrations.find((c) => c.name === 'Card')!;
      const { contractHash: _hash, ...ref } = old.ref;
      const c = sealReactComponent({
        ...old,
        ref,
        slots: { ...old.slots, body: { ...old.slots.body, minimum: 1 } },
      });
      d.web!.registrations = d.web!.registrations.map((r) => (r === old ? c : r));
      d.elements.find((e) => e.id === owner)!.react!.component = c.ref;
    }
    const session = new EditorSession(d);
    expect(() => session.execute(arrangeDesign(['buy'], 'delete'))).toThrow(/minimum.*body/);
    expect(session.content).toEqual(d);
    expect(session.canUndo).toBe(false);
    const deleted = session.execute(arrangeDesign([owner], 'delete'));
    expect(deleted.elements.some((e) => e.id === 'buy' || e.id === owner)).toBe(false);
    expect(convertDesignToReact(deleted).diagnostics).toEqual([]);
  },
);
it.each(['full', 'unsupported', 'unknown', 'missing-ref'] as const)(
  'React insert refuses %s destination without draft/history changes',
  (fault) => {
    const d = slotFixture('react');
    const old = d.web!.registrations.find((c) => c.name === 'Card')!;
    const { contractHash: _hash, ...ref } = old.ref;
    const c = sealReactComponent({
      ...old,
      ref,
      slots: { ...old.slots, body: { ...old.slots.body, maximum: fault === 'full' ? 1 : 4 } },
    });
    d.web!.registrations = d.web!.registrations.map((r) => (r === old ? c : r));
    d.elements.find((e) => e.id === 'external')!.react!.component = c.ref;
    if (fault === 'missing-ref') d.web!.registrations = d.web!.registrations.filter((r) => r !== c);
    const registration = referenceComponents.find(
      (c) => c.name === (fault === 'unsupported' ? 'Input' : 'Button'),
    )!;
    // Card normally accepts all originals; pin a narrower retained contract for the refusal.
    if (fault === 'unsupported') {
      const narrowed = sealReactComponent({
        ...c,
        ref,
        slots: {
          ...c.slots,
          body: { ...c.slots.body, accepts: [{ registryId: 'reference', componentId: 'Button' }] },
        },
      });
      d.web!.registrations = d.web!.registrations.map((r) => (r === c ? narrowed : r));
      d.elements.find((e) => e.id === 'external')!.react!.component = narrowed.ref;
    }
    const session = new EditorSession(d);
    expect(() =>
      session.execute(
        insertDesignReact(
          registration,
          'new',
          'external',
          fault === 'unknown' ? 'missing' : 'body',
        ),
      ),
    ).toThrow();
    expect(session.content).toEqual(d);
    expect(session.canUndo).toBe(false);
  },
);
it('React insert uses the retained destination contract and exports after atomic Undo/Redo', () => {
  const d = slotFixture('react'),
    session = new EditorSession(d);
  const next = session.execute(
    insertDesignReact(
      referenceComponents.find((c) => c.name === 'Button')!,
      'new',
      'external',
      'body',
    ),
  );
  expect(next.elements.find((e) => e.id === 'external')!.react!.slots.body).toEqual(['buy', 'new']);
  expect(convertDesignToReact(next).diagnostics).toEqual([]);
  expect(exportDesignReact(next, referenceResolution).files['composition.json']).toContain('"new"');
  expect(session.undo()).toEqual(d);
  expect(session.redo()).toEqual(next);
});
it.each(['react', 'native'] as const)(
  'child-only duplicate updates %s slot atomically, keeps order and Undo',
  (kind) => {
    const d = slotFixture(kind),
      session = new EditorSession(d),
      owner = kind === 'native' ? 'card' : 'external';
    const duplicated = session.execute(arrangeDesign(['buy'], 'duplicate'));
    const copy = duplicated.elements.find((e) => e.name === 'buy copy')!;
    const parent = duplicated.elements.find((e) => e.id === owner)!;
    expect(parent.react?.slots.body ?? parent.webSlots!.body).toEqual(['buy', copy.id]);
    copy.react!.props.label = 'Independent';
    expect(exportDesignReact(duplicated, referenceResolution).files['ProductPage.tsx']).toContain(
      'Independent',
    );
    expect(session.undo()).toEqual(d);
  },
);
it('rejects child-only duplicate at a native slot maximum with no mutation/history', () => {
  const d = slotFixture('native', 1),
    session = new EditorSession(d);
  expect(() => session.execute(arrangeDesign(['buy'], 'duplicate'))).toThrow(/limits/);
  expect(session.content).toEqual(d);
  expect(session.canUndo).toBe(false);
});
it.each(['native-to-react', 'react-to-native', 'native-to-native', 'react-to-react'])(
  'slot reassignment removes previous ownership for %s',
  (direction) => {
    let d = slotFixture(direction.startsWith('native') ? 'native' : 'react');
    const old = direction.startsWith('native') ? 'card' : 'external';
    const next = direction.endsWith('native') ? 'other-native' : 'other-react';
    const owner = clone(
      d.elements.find((e) => e.id === (direction.endsWith('native') ? 'card' : 'external'))!,
    );
    owner.id = next;
    if (owner.react) owner.react.slots = { body: [] };
    else owner.webSlots = { body: [] };
    d.elements.push(owner);
    d = (direction.endsWith('native') ? assignDesignNativeSlot : assignDesignReactSlot)(
      next,
      'body',
      ['buy'],
    ).apply(d);
    const beforeOwner = d.elements.find((e) => e.id === old)!;
    expect(beforeOwner.react?.slots.body ?? beforeOwner.webSlots!.body).toEqual([]);
    expect(d.elements.find((e) => e.id === 'buy')!.parentId).toBe(next);
    expect(convertDesignToReact(d).diagnostics).toEqual([]);
  },
);
it('generated resolution refuses another supported environment before preview success', async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
  });
  const d = designReactFixture(),
    doc = registerReferenceNative(d);
  const requested = doc.components.map((c) => c.ref);
  expect(
    (
      await referenceRegisteredRuntimeAdapter.resolve({
        environment: d.web!.environment.ref,
        components: requested,
        signal: new AbortController().signal,
      })
    ).diagnostics,
  ).toEqual([]);
  const rejected = await referenceRegisteredRuntimeAdapter.resolve({
    environment: referenceEnvironmentRevision.ref,
    components: requested,
    signal: new AbortController().signal,
  });
  expect(rejected.resolution).toBeUndefined();
  expect(rejected.diagnostics[0].message).toMatch(/environment differs/);
});
it('preview supplies callbacks only for bound events, matching generated output', () => {
  const document = clone(createReferenceDocument('product'));
  const button = document.nodes.find((n) => n.id === 'buy')!;
  button.bindings = {};
  const handlers: unknown[] = [];
  const runtime = {
    resolution: referenceResolution,
    components: Object.fromEntries(
      document.components.map((c) => [
        reactComponentKey(c.ref),
        (props: Record<string, unknown>) => {
          if (c.name === 'Button') handlers.push(props.onPress);
          return createElement('div', null, props.children as ReactNode, props.footer as ReactNode);
        },
      ]),
    ),
    providers: { 'theme-provider': ({ children }: { children?: ReactNode }) => children },
    assets: { 'product-image': 'image.png' },
  };
  renderToStaticMarkup(createElement(ReactComposition, { document, runtime, width: 800 }));
  expect(handlers).toContain(undefined);
  handlers.length = 0;
  button.bindings = { onPress: { kind: 'callback', callback: 'onBuy' } };
  renderToStaticMarkup(createElement(ReactComposition, { document, runtime, width: 800 }));
  expect(typeof handlers[0]).toBe('function');
});
it('native nullable public input preserves explicit null and uses the default only for undefined', () => {
  const d = designReactFixture(),
    c = d.components[0];
  const base = referenceComponents.find((c) => c.name === 'Text')!;
  const nullable = sealReactComponent({
    ...base,
    ref: {
      registryId: base.ref.registryId,
      componentId: 'NullableText',
      version: '1',
      implementationHash: base.ref.implementationHash,
    },
    props: {
      text: { schema: { type: 'string', nullable: true }, required: false, default: 'Default' },
    },
    sampleProps: { text: 'Default' },
  });
  d.web!.registrations.push(nullable);
  const part = c.elements!.find((e) => e.id === 'card-title')!;
  part.type = 'react';
  delete part.web;
  part.react = {
    component: nullable.ref,
    import: nullable.import,
    props: {},
    bindings: {},
    slots: {},
  };
  c.web!.variants = { default: {} };
  c.web!.props.title.schema = { type: 'string', nullable: true };
  c.web!.props.title.default = 'Default';
  d.elements.find((e) => e.id === 'card')!.webProps = { title: null };
  const conversion = convertDesignToReact(d);
  expect(conversion.diagnostics).toEqual([]);
  const resolution = {
    ...referenceResolution,
    components: [...referenceResolution.components, nullable.ref],
  };
  const components = Object.fromEntries(
    d.web!.registrations.map((c) => [
      reactComponentKey(c.ref),
      (props: Record<string, unknown>) =>
        createElement(
          'span',
          null,
          c.ref.componentId === 'NullableText' ? JSON.stringify(props.text) : null,
        ),
    ]),
  );
  const runtime = nativeDesignRuntime(
    conversion,
    {
      resolution,
      components,
      providers: { 'theme-provider': ({ children }: { children?: ReactNode }) => children },
      assets: {},
    },
    800,
  );
  expect(
    renderToStaticMarkup(
      createElement(ReactComposition, { document: conversion.document, runtime, width: 800 }),
    ),
  ).toContain('null');
  const program = conversion.components[0];
  expect(
    renderToStaticMarkup(
      createElement(runtime.components[reactComponentKey(program.registration.ref)], {
        title: undefined,
      }),
    ),
  ).toContain('Default');
  expect(
    Object.values(exportDesignReact(d, resolution).files).some((text) =>
      text.includes('=== undefined'),
    ),
  ).toBe(true);
});
it('external child-only duplicate refuses the slot maximum atomically', () => {
  const d = slotFixture('react', 1),
    owner = d.elements.find((e) => e.id === 'external')!;
  const base = d.web!.registrations.find(
    (c) => reactComponentKey(c.ref) === reactComponentKey(owner.react!.component),
  )!;
  const { contractHash: _hash, ...ref } = base.ref;
  const limited = sealReactComponent({
    ...base,
    ref,
    slots: { ...base.slots, body: { ...base.slots.body, maximum: 1 } },
  });
  d.web!.registrations = d.web!.registrations.map((c) => (c === base ? limited : c));
  owner.react!.component = limited.ref;
  const session = new EditorSession(d);
  expect(() => session.execute(arrangeDesign(['buy'], 'duplicate'))).toThrow(/slot limits/);
  expect(session.content).toEqual(d);
  expect(session.canUndo).toBe(false);
});
it('known HTML diagnostics cross a generated component boundary', () => {
  const d = designReactFixture();
  d.elements.find((e) => e.id === 'home')!.web = { tag: 'form' };
  d.components[0].elements![0].web = { tag: 'form' };
  expect(convertDesignToReact(d).diagnostics).toContainEqual(
    expect.objectContaining({ code: 'html-content', path: 'product-card--card-frame' }),
  );
});
it('a public variant input without named variants stays a normal input in preview and output', () => {
  const d = designReactFixture(),
    c = d.components[0];
  c.web!.props = { variant: clone(c.web!.props.title) };
  c.web!.variants = {};
  d.elements.find((e) => e.id === 'card')!.webProps = { variant: 'Plain public variant' };
  const conversion = convertDesignToReact(d);
  expect(conversion.diagnostics).toEqual([]);
  const runtime = nativeDesignRuntime(
    conversion,
    {
      resolution: referenceResolution,
      components: Object.fromEntries(
        d.web!.registrations.map((c) => [reactComponentKey(c.ref), () => null]),
      ),
      providers: { 'theme-provider': ({ children }: { children?: ReactNode }) => children },
      assets: {},
    },
    800,
  );
  expect(
    renderToStaticMarkup(
      createElement(ReactComposition, { document: conversion.document, runtime, width: 800 }),
    ),
  ).toContain('Plain public variant');
  const files = exportDesignReact(d, referenceResolution).files;
  expect(Object.values(files).join('')).not.toContain('if((props.variant??');
});
