import { describe, it, expect } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import { isDesign, updateElement, arrangeDesign } from '@editor-platform/design/model';
import { designReactFixture } from './fixture';
import { checkVector } from '../../../tests/fixtures/design-reuse/content';
import {
  convertDesignToReact,
  exportDesignReact,
  reviewDesignRegeneration,
  applyDesignRegeneration,
  reviewDesignReactDocumentRegeneration,
  designReactGraphicProblems,
  designReactCanvasOwner,
} from './convert';

it('diagnoses vector loss in semantic React output instead of silently exporting a rectangle', () => {
  const content = designReactFixture();
  const target = content.elements.find((e) => e.id === 'heading')!;
  Object.assign(target, { type: 'shape', text: '', vector: checkVector });
  expect(
    convertDesignToReact(content).diagnostics.some(
      (d) => d.code === 'visual-unsupported' && d.path === target.id,
    ),
  ).toBe(true);
  const mapped = mapDesignElementToReact(target.id, referenceComponents[0]).apply(content);
  expect(isDesign(mapped)).toBe(true);
  expect(mapped.elements.find((e) => e.id === target.id)!.vector).toBeUndefined();
  expect(target.vector).toEqual(checkVector);
});
import {
  assignDesignReactSlot,
  adoptDesignReactRevision,
  acceptDesignConversion,
  mapDesignElementToReact,
  applyDesignReactDocumentRegeneration,
} from './commands';
import {
  referenceResolution,
  referenceComponents,
  referenceTextRevision,
} from '../../../apps/react-ui-reference/src/catalog';
import { reactComponentKey } from '@editor-platform/react-ui-core';
import { reviewedNativeCard } from '../../../apps/react-ui-reference/src/design-catalog';
import {
  createArtifact,
  commitVersion,
  serializeArtifact,
  deserializeArtifact,
} from '@editor-platform/artifact-core';
it('native artifact JSON retains draft, committed original pins, settings and accepted conversion', async () => {
  let artifact = createArtifact('design', 'Design Web', designReactFixture());
  artifact = await commitVersion(artifact, 'A', 'Pinned native source');
  artifact.draft.content = acceptDesignConversion(
    exportDesignReact(artifact.draft.content, referenceResolution),
  ).apply(artifact.draft.content);
  const resumed = deserializeArtifact(serializeArtifact(artifact));
  expect(resumed).toEqual(artifact);
  expect(isDesign(resumed.draft.content)).toBe(true);
  expect(isDesign(resumed.versions[0].content)).toBe(true);
});
it('selected multi-root export includes every native root and supports component-only output', () => {
  const d = designReactFixture();
  const multiple = exportDesignReact(d, referenceResolution, { rootIds: ['home', 'contact'] });
  expect(JSON.parse(multiple.files['composition.json']).roots).toEqual(['home', 'contact']);
  expect(multiple.files['DesignComposition.tsx']).toContain('onNameChange');
  expect(multiple.files['ProductPage.tsx']).toBeUndefined();
  const instance = d.elements.find((e) => e.type === 'instance')!;
  expect(
    exportDesignReact(d, referenceResolution, { rootIds: [instance.id] }).files[
      'DesignComposition.tsx'
    ],
  ).toContain('./Component_');
  expect(() => exportDesignReact(d, referenceResolution, { rootIds: [] })).toThrow();
});
it('graphic output checks only its selected subtree, including originals inside native definitions', () => {
  const d = designReactFixture();
  expect(designReactGraphicProblems(d, ['home'])).toContain('buy');
  expect(
    exportDesignReact(d, referenceResolution, { mode: 'svg', rootIds: ['heading'] }).diagnostics[0]
      .code,
  ).toBe('svg-loss');
  d.components[0].elements!.push({
    ...d.elements.find((e) => e.id === 'buy')!,
    id: 'internal-button',
    parentId: 'card-frame',
  });
  expect(designReactGraphicProblems(d, ['card'])).toEqual(['card']);
  expect(() =>
    exportDesignReact(d, referenceResolution, { mode: 'svg', rootIds: ['card'] }),
  ).toThrow('external');
});
it('mapping an ordinary native element keeps stable identity, geometry, hierarchy and original import', () => {
  const d = designReactFixture(),
    before = d.elements.find((e) => e.id === 'link')!;
  const next = mapDesignElementToReact(
    'link',
    referenceComponents.find((c) => c.name === 'Button')!,
  ).apply(d);
  expect(next.elements.find((e) => e.id === 'link')).toMatchObject({
    type: 'react',
    bounds: before.bounds,
    parentId: before.parentId,
    react: { import: { source: '@reference/ui', name: 'Button' } },
  });
  expect(convertDesignToReact(next).diagnostics).toEqual([]);
  expect(() => mapDesignElementToReact('home', referenceComponents[0]).apply(d)).toThrow('leaf');
});
it('removing an original public-slot assignment detaches its native child without deleting it', () => {
  const d = designReactFixture(),
    c = referenceComponents.find((c) => c.name === 'Card')!;
  d.elements.push({
    ...d.elements.find((e) => e.id === 'buy')!,
    id: 'slot-card',
    parentId: 'home',
    react: {
      component: c.ref,
      import: c.import,
      props: { ...c.sampleProps },
      bindings: {},
      slots: {},
    },
  });
  const assigned = assignDesignReactSlot('slot-card', 'body', ['buy']).apply(d);
  expect(assigned.elements.find((e) => e.id === 'buy')?.parentId).toBe('slot-card');
  const detached = assignDesignReactSlot('slot-card', 'body', []).apply(assigned);
  expect(detached.elements.find((e) => e.id === 'buy')?.parentId).toBeUndefined();
  expect(isDesign(detached)).toBe(true);
});
it('an opaque public React slot owns flow and canvas rendering instead of copying stale native global offsets', () => {
  const d = designReactFixture(),
    card = reviewedNativeCard(['product-card']);
  d.web!.registrations.push(card);
  d.elements.push({
    ...d.elements.find((e) => e.id === 'buy')!,
    id: 'original-card',
    parentId: 'home',
    react: {
      component: card.ref,
      import: card.import,
      props: {},
      slots: { body: ['card'] },
      bindings: {},
    },
  });
  const native = d.elements.find((e) => e.id === 'card')!;
  native.parentId = 'original-card';
  native.bounds.y = -900;
  const conversion = convertDesignToReact(d);
  expect(conversion.diagnostics).toEqual([]);
  const node = conversion.document.nodes.find((n) => n.id === 'card')!;
  expect(node.layout.base.position).toEqual({ kind: 'literal', value: 'relative' });
  expect(node.layout.base.top).toBeUndefined();
  expect(designReactCanvasOwner(d, 'card')).toBe('original-card');
  expect(designReactCanvasOwner(d, 'heading')).toBeUndefined();
});
it('required native props have explicit preview samples without becoming production defaults', () => {
  const d = designReactFixture();
  d.components[0].web!.props.title.required = true;
  delete d.components[0].web!.props.title.default;
  d.components[0].web!.sampleProps = { title: 'Preview sample' };
  expect(isDesign(d)).toBe(true);
  const conversion = convertDesignToReact(d);
  expect(conversion.diagnostics).toEqual([]);
  expect(conversion.components[0].registration.props.title.default).toBeUndefined();
  expect(conversion.components[0].registration.sampleProps.title).toBe('Preview sample');
  delete d.components[0].web!.sampleProps;
  expect(isDesign(d)).toBe(false);
});
it('regeneration keeps page-schema edits and rejects changed targets inside the ordinary command', () => {
  const basis = convertDesignToReact(designReactFixture()).document,
    edited = clone(basis),
    native = designReactFixture();
  edited.fixture.name = 'User fixture';
  edited.inputs.extra = { schema: { type: 'string' }, required: false, default: 'Extra' };
  native.elements.find((e) => e.id === 'link')!.text = 'New native link';
  const plan = reviewDesignReactDocumentRegeneration(
    basis,
    edited,
    convertDesignToReact(native).document,
  );
  expect(plan.conflicts).toEqual([]);
  expect(plan.document.inputs.extra).toEqual(edited.inputs.extra);
  expect(plan.document.fixture.name).toBe('User fixture');
  expect(applyDesignReactDocumentRegeneration(plan).apply(edited)).toEqual(plan.document);
  expect(() => applyDesignReactDocumentRegeneration(plan).apply(basis)).toThrow('target changed');
});
it.each(['import', 'ref-hash', 'binding', 'schema', 'breakpoint', 'variant'])(
  'rejects malformed native %s metadata while allowing unresolved valid references',
  (kind) => {
    const d = designReactFixture();
    if (kind === 'import')
      d.elements.find((e) => e.id === 'buy')!.react!.import = {
        ...d.elements.find((e) => e.id === 'buy')!.react!.import,
        source: 'javascript:alert(1)',
      };
    if (kind === 'ref-hash')
      d.elements.find((e) => e.id === 'buy')!.react!.component = {
        ...d.elements.find((e) => e.id === 'buy')!.react!.component,
        implementationHash: 'bad',
      };
    if (kind === 'binding')
      d.elements.find((e) => e.id === 'buy')!.react!.bindings.onPress = {
        kind: 'callback',
        callback: 'bad-name',
      };
    if (kind === 'schema') d.web!.inputs.title.schema = { type: 'unsupported' } as never;
    if (kind === 'breakpoint') d.web!.breakpoints.push({ ...d.web!.breakpoints[0] });
    if (kind === 'variant')
      d.components[0].web!.variants.default = { bad: { bad: 'field' } } as never;
    expect(isDesign(d)).toBe(false);
  },
);
describe('#29 native Design React conversion', () => {
  it('pins native IDs, semantic bodies, public input variants, original imports and routes deterministically', () => {
    const design = designReactFixture();
    expect(isDesign(design)).toBe(true);
    const conversion = convertDesignToReact(design);
    expect(conversion.diagnostics).toEqual([]);
    const out = exportDesignReact(design, referenceResolution);
    expect(exportDesignReact(clone(design), referenceResolution)).toEqual(out);
    expect(out.files['ProductPage.tsx']).toContain('@reference/ui');
    expect(out.files['ProductPage.tsx']).toContain('onPress={props.onBuy}');
    expect(out.files['NativeComponents.tsx']).toContain('<h2');
    expect(out.files['Site.tsx']).toContain('/contact');
    expect(isDesign(JSON.parse(out.files['native.json']))).toBe(true);
    expect(conversion.components[0].registration.props.variant.schema).toEqual({
      type: 'enum',
      values: ['default', 'blue'],
    });
    expect(out.mappings.find((m) => m.nativeId === 'buy')?.nodeId).toBe('buy');
  });
  it('ordinary deletion cleans slots while historical dangling references stay loadable and diagnosed', () => {
    const d = designReactFixture();
    const c = referenceComponents.find((c) => c.name === 'Card')!;
    const ext = {
      ...d.elements.find((e) => e.id === 'buy')!,
      id: 'external-card',
      react: {
        component: c.ref,
        import: c.import,
        props: {},
        bindings: {},
        slots: { body: ['buy'] },
      },
    };
    d.elements = d.elements.map((e) => (e.id === 'buy' ? { ...e, parentId: 'external-card' } : e));
    d.elements.push(ext);
    const deleted = arrangeDesign(['buy'], 'delete').apply(d);
    expect(isDesign(JSON.parse(JSON.stringify(deleted)))).toBe(true);
    expect(deleted.elements.find((e) => e.id === ext.id)!.react!.slots.body).toEqual([]);
    expect(convertDesignToReact(deleted).diagnostics).toEqual([]);
    // Older native data may already contain dangling IDs; loading must retain and diagnose them.
    const historical = { ...d, elements: d.elements.filter((e) => e.id !== 'buy') };
    expect(isDesign(JSON.parse(JSON.stringify(historical)))).toBe(true);
    expect(
      convertDesignToReact(historical).diagnostics.some((e) => e.code === 'node-missing'),
    ).toBe(true);
  });
  it.each(['semantics', 'route', 'dependency', 'binding', 'escaping-css', 'image', 'visual'])(
    'refuses invalid %s atomically with native source retained',
    (kind) => {
      const d = designReactFixture();
      if (kind === 'semantics') delete d.elements[0].web;
      if (kind === 'route') d.web!.pages[1].path = '/';
      if (kind === 'dependency') d.web!.registrations = [];
      if (kind === 'binding')
        d.elements.find((e) => e.id === 'buy')!.react!.bindings.onPress = {
          kind: 'callback',
          callback: 'missing',
        };
      if (kind === 'escaping-css')
        d.elements[0].web!.layout = {
          base: { width: { kind: 'literal', value: '1px; background:url(javascript:bad)' } },
          breakpoints: {},
        };
      if (kind === 'image')
        d.elements.push({
          ...d.elements[0],
          id: 'bad-image',
          type: 'image',
          parentId: 'home',
          web: { tag: 'img' },
          src: 'data:image/svg+xml;base64,PHN2Zz4=',
          alt: 'x',
        });
      if (kind === 'visual') d.elements[0].rotation = 12;
      const before = JSON.stringify(d);
      expect(() => exportDesignReact(d, referenceResolution)).toThrow();
      expect(JSON.stringify(d)).toBe(before);
    },
  );
  it('escapes literal text and keeps functions/accessors out of native metadata', () => {
    const d = designReactFixture();
    d.elements.find((e) => e.id === 'link')!.text = '</script><img src=x onerror=alert(1)>&';
    const out = exportDesignReact(d, referenceResolution);
    expect(out.files['ProductPage.tsx']).not.toContain('</script>');
    expect(out.files['ProductPage.tsx']).toContain('\\u003c');
    let invoked = false;
    Object.defineProperty(d.elements[0].web!, 'tag', {
      enumerable: true,
      get() {
        invoked = true;
        return 'main';
      },
    });
    expect(isDesign(d)).toBe(false);
    expect(invoked).toBe(false);
  });
  it('keeps original pins and adopts a revision explicitly without losing native identity or geometry', () => {
    const d = designReactFixture(),
      text = referenceComponents.find((c) => c.name === 'Text')!;
    d.elements.find((e) => e.id === 'buy')!.react = {
      component: text.ref,
      import: text.import,
      props: { text: 'Retain body' },
      bindings: {},
      slots: {},
    };
    const next = adoptDesignReactRevision(
      'buy',
      referenceTextRevision,
      { text: 'content' },
      {},
    ).apply(d);
    expect(next.elements.find((e) => e.id === 'buy')?.bounds).toEqual(
      d.elements.find((e) => e.id === 'buy')?.bounds,
    );
    expect(next.elements.find((e) => e.id === 'buy')?.react?.props).toEqual({
      content: 'Retain body',
    });
    expect(reactComponentKey(d.elements.find((e) => e.id === 'buy')!.react!.component)).not.toBe(
      reactComponentKey(next.elements.find((e) => e.id === 'buy')!.react!.component),
    );
  });
  it('checks native generated content against original slot constraints', () => {
    const d = designReactFixture(),
      card = referenceComponents.find((c) => c.name === 'Card')!;
    d.elements.push({
      ...d.elements.find((e) => e.id === 'buy')!,
      id: 'outer',
      parentId: 'home',
      react: { component: card.ref, import: card.import, props: {}, bindings: {}, slots: {} },
    });
    expect(() => assignDesignReactSlot('outer', 'body', ['card']).apply(d)).toThrow(
      /slot|accepted|constraint/i,
    );
  });
  it('regenerates by explicit review, rejects changed generated files and preserves handwritten files', () => {
    const d = designReactFixture(),
      before = exportDesignReact(d, referenceResolution),
      edited = updateElement('link', { text: 'Write to us' }).apply(d),
      next = exportDesignReact(edited, referenceResolution);
    const files: Record<string, string> = { ...before.files, 'Host.tsx': 'handwritten' };
    expect(reviewDesignRegeneration(before, next, files).changes.length).toBeGreaterThan(0);
    expect(applyDesignRegeneration(before, next, files, next.fingerprint)['Host.tsx']).toBe(
      'handwritten',
    );
    files['ProductPage.tsx'] += '// local modification';
    expect(() => applyDesignRegeneration(before, next, files, next.fingerprint)).toThrow(/changed/);
    expect(() =>
      applyDesignRegeneration(before, next, { ...before.files }, before.fingerprint),
    ).toThrow();
  });
  it('declares graphic loss and rejects external React in auxiliary SVG', () => {
    const d = designReactFixture();
    expect(() => exportDesignReact(d, referenceResolution, { mode: 'svg' })).toThrow(/external/);
    d.elements = d.elements.filter((e) => e.type !== 'react');
    const out = exportDesignReact(d, referenceResolution, { mode: 'svg' });
    expect(out.diagnostics[0].code).toBe('svg-loss');
    expect(out.files['Graphic.tsx']).toContain('non-interactive');
  });
});

it('#29 external React becomes a native compound component with typed public prop and callback, retaining original import', () => {
  const d = designReactFixture(),
    original = d.elements.find((e) => e.id === 'buy')!;
  const part = { ...clone(original), id: 'button-part' };
  delete part.parentId;
  d.components.push({
    id: 'action-component',
    name: 'ActionComponent',
    width: 320,
    height: 80,
    template: { type: 'frame', text: '', fill: '#ffffff' },
    elements: [part],
    web: {
      symbol: 'ActionComponent',
      version: '1.0.0',
      props: {
        label: {
          schema: { type: 'string', maxLength: 80 },
          required: false,
          default: 'Original button',
          target: { elementId: 'button-part', field: 'label' },
        },
      },
      variants: {},
      callbacks: { onBuy: { parameters: [], returns: 'void' } },
    },
  });
  d.elements.push({
    ...clone(original),
    type: 'instance',
    id: 'action-instance',
    parentId: 'home',
    componentId: 'action-component',
    webProps: { label: 'Composed button' },
    web: { bindings: { onBuy: { kind: 'callback', callback: 'onBuy' } } },
  });
  delete d.elements.at(-1)!.react;
  const conversion = convertDesignToReact(d);
  expect(conversion.diagnostics).toEqual([]);
  const c = conversion.components.find((c) => c.sourceId === 'action-component')!;
  expect(c.registration.events.onBuy).toEqual({ parameters: [], returns: 'void' });
  expect(c.documents.default.nodes[0].bindings.label).toEqual({
    kind: 'data',
    input: 'label',
    path: [],
  });
  const out = exportDesignReact(d, referenceResolution);
  expect(Object.values(out.files).some((file) => file.includes('import { Button as'))).toBe(true);
});
it('#29 native component public slots retain original children and reject wrong native ownership atomically', () => {
  const d = designReactFixture();
  d.components[0].web!.slots = {
    actions: {
      elementId: 'card-frame',
      prop: 'children',
      minimum: 1,
      maximum: 2,
      accepts: [{ registryId: 'reference', componentId: 'Button' }],
    },
  };
  d.elements.find((e) => e.id === 'card')!.webSlots = { actions: ['buy'] };
  d.elements.find((e) => e.id === 'buy')!.parentId = 'card';
  const converted = convertDesignToReact(d);
  expect(converted.diagnostics).toEqual([]);
  expect(converted.components[0].slotTargets.actions.elementId).toBe('product-card--card-frame');
  const out = exportDesignReact(d, referenceResolution);
  expect(Object.values(out.files).some((file) => file.includes('NativeSlotContext.Provider'))).toBe(
    true,
  );
  const invalid = clone(d);
  invalid.elements.find((e) => e.id === 'card')!.webSlots = { actions: ['heading'] };
  expect(convertDesignToReact(invalid).diagnostics.length).toBeGreaterThan(0);
});
it('#29 mapped React UI edits survive independent source edits and conflict on overlapping changes', () => {
  const d = designReactFixture(),
    basis = convertDesignToReact(d).document,
    edited = clone(basis);
  edited.nodes.find((n) => n.id === 'buy')!.props.label = 'User edit';
  const next = convertDesignToReact(
    updateElement('link', { text: 'Updated source link' }).apply(d),
  ).document;
  const reviewed = reviewDesignReactDocumentRegeneration(basis, edited, next);
  expect(reviewed.conflicts).toEqual([]);
  expect(reviewed.document.nodes.find((n) => n.id === 'buy')?.props.label).toBe('User edit');
  const changed = clone(d);
  changed.elements.find((e) => e.id === 'buy')!.react!.props.label = 'Source edit';
  expect(
    reviewDesignReactDocumentRegeneration(basis, edited, convertDesignToReact(changed).document)
      .conflicts,
  ).toContain('buy/props');
});
it('#29 implementation identities pin program dependencies and resume exports do not nest previous output', () => {
  const d = designReactFixture(),
    before = exportDesignReact(d, referenceResolution),
    converted = convertDesignToReact(d);
  const resumed = acceptDesignConversion(before).apply(d);
  expect(exportDesignReact(resumed, referenceResolution)).toEqual(before);
  expect(converted.components[0].registration.ref.implementationHash).not.toBe(
    JSON.parse(before.files['manifest.json']).generatedImplementationBundleHash,
  );
  d.components[0].elements![0].fill = '#122334';
  expect(convertDesignToReact(d).components[0].registration.ref.implementationHash).not.toBe(
    converted.components[0].registration.ref.implementationHash,
  );
});
