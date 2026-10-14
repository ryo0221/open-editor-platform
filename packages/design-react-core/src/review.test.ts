import { afterEach, expect, it, vi } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import { arrangeDesign, isDesign, makeDesignElement } from '@editor-platform/design/model';
import { reactComponentKey, sealReactComponent } from '@editor-platform/react-ui-core';
import { designReactFixture } from './fixture';
import {
  convertDesignToReact,
  exportDesignReact,
  reviewDesignReactDocumentRegeneration,
} from './convert';
import { acceptDesignConversion, retainDesignPublications, configureDesignWeb } from './commands';
import {
  referenceComponents,
  referenceResolution,
} from '../../../apps/react-ui-reference/src/catalog';
import {
  referenceDesignRuntime,
  referenceDesignOriginalResolution,
  referenceReviewedCardFunctions,
  reviewedNativeCard,
} from '../../../apps/react-ui-reference/src/design-catalog';

afterEach(() => vi.unstubAllGlobals());
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
it.each(['Site', 'NativeComponents', 'generated-component', 'generated-variant'])(
  'rejects %s output-path collisions before returning a bundle',
  (symbol) => {
    const d = designReactFixture();
    const files = Object.keys(exportDesignReact(d, referenceResolution).files);
    if (symbol === 'generated-component')
      symbol = files.find((p) => p.startsWith('Component_') && p.endsWith('.tsx'))!.slice(0, -4);
    if (symbol === 'generated-variant')
      symbol = files.find((p) => /^N[0-9a-f]+\.tsx$/.test(p))!.slice(0, -4);
    d.web!.pages[0].symbol = symbol;
    expect(() => exportDesignReact(d, referenceResolution)).toThrow(/collision|reserved/i);
  },
);
it.each(['react', 'instance', 'image'])(
  'diagnoses unsupported native public-slot target %s',
  (type) => {
    const d = designReactFixture(),
      c = d.components[0];
    const target =
      type === 'react'
        ? clone(d.elements.find((e) => e.id === 'buy')!)
        : type === 'instance'
          ? clone(d.elements.find((e) => e.id === 'card')!)
          : {
              ...makeDesignElement('image'),
              src: png,
              alt: 'Slot image',
              web: { tag: 'img' as const },
            };
    target.id = 'unsupported-slot';
    target.parentId = 'card-frame';
    if (type === 'instance') {
      const nested = clone(c);
      nested.id = 'nested';
      nested.web!.symbol = 'NestedCard';
      d.components.push(nested);
      target.componentId = nested.id;
    }
    c.elements!.push(target);
    c.web!.slots = {
      body: {
        prop: 'children',
        accepts: [{ registryId: 'reference', componentId: 'Button' }],
        minimum: 0,
        maximum: 3,
        elementId: target.id,
      },
    };
    const conversion = convertDesignToReact(d);
    expect(
      conversion.diagnostics.some((x) => x.code === 'slot-target' && x.path.includes(target.id)),
    ).toBe(true);
    expect(() => exportDesignReact(d, referenceResolution)).toThrow(/slot/i);
  },
);
it.each([
  ['article', 'src'],
  ['article', 'alt'],
  ['img', 'text'],
  ['img', 'fill'],
] as const)('refuses non-rendered public field %s.%s', (tag, field) => {
  const d = designReactFixture(),
    c = d.components[0],
    target = c.elements!.find((e) => e.id === 'card-title')!;
  target.web = { tag };
  if (tag === 'img') {
    target.src = png;
    target.alt = 'Public image';
  }
  c.web!.props.title.target.field = field;
  expect(
    convertDesignToReact(d).diagnostics.some(
      (x) => x.code === 'public-target' && x.path.includes(target.id),
    ),
  ).toBe(true);
  expect(() => exportDesignReact(d, referenceResolution)).toThrow();
});
it.each(['home', 'contact'])(
  'refuses hidden routed frame %s without advertising an empty route',
  (id) => {
    const d = designReactFixture();
    d.elements.find((e) => e.id === id)!.hidden = true;
    expect(convertDesignToReact(d).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'page-hidden', path: id }),
    );
    expect(() => exportDesignReact(d, referenceResolution)).toThrow(/hidden/i);
  },
);
it.each(['react', 'native'])(
  'ordinary duplicate remaps %s slots and preserves the original subtree',
  (kind) => {
    const d = designReactFixture(),
      button = clone(d.elements.find((e) => e.id === 'buy')!);
    button.id = 'slot-child';
    button.parentId = 'slot-owner';
    const owner = clone(d.elements.find((e) => e.id === (kind === 'react' ? 'buy' : 'card'))!);
    owner.id = 'slot-owner';
    if (kind === 'react') {
      const card = referenceComponents.find((c) => c.name === 'Card')!;
      owner.react = {
        component: card.ref,
        import: card.import,
        props: {},
        bindings: {},
        slots: { body: [button.id] },
      };
    } else {
      d.components[0].web!.slots = {
        body: {
          prop: 'children',
          accepts: [{ registryId: 'reference', componentId: button.react!.component.componentId }],
          minimum: 0,
          maximum: 4,
          elementId: 'card-frame',
        },
      };
      owner.webSlots = { body: [button.id] };
    }
    d.elements.push(owner, button);
    const before = clone(d);
    const duplicated = arrangeDesign([owner.id], 'duplicate').apply(d);
    const copy = duplicated.elements.find((e) => e.name === owner.name + ' copy')!;
    const child = duplicated.elements.find((e) => e.parentId === copy.id)!;
    expect(Object.values(copy.react?.slots ?? copy.webSlots!)).toEqual([[child.id]]);
    expect(duplicated.elements.find((e) => e.id === owner.id)).toEqual(
      before.elements.find((e) => e.id === owner.id),
    );
    child.react!.props.label = 'Independent copy';
    expect(duplicated.elements.find((e) => e.id === button.id)!.react!.props.label).not.toBe(
      'Independent copy',
    );
    expect(isDesign(JSON.parse(JSON.stringify(duplicated)))).toBe(true);
    expect(convertDesignToReact(duplicated).diagnostics).toEqual([]);
    expect(exportDesignReact(duplicated, referenceResolution).files['ProductPage.tsx']).toContain(
      'Independent copy',
    );
  },
);
it.each(['reorder', 'prepend', 'between'])(
  'regeneration preserves React root %s during an independent native text edit',
  (kind) => {
    const d = designReactFixture(),
      basis = convertDesignToReact(d).document,
      edited = clone(basis);
    if (kind === 'reorder') edited.roots.reverse();
    else {
      const node = clone(basis.nodes.find((n) => n.id === 'heading')!);
      node.id = 'banner';
      node.bindings = {};
      node.props.text = 'Banner';
      edited.nodes.push(node);
      edited.roots.splice(kind === 'prepend' ? 0 : 1, 0, node.id);
    }
    d.elements.find((e) => e.id === 'link')!.text = 'Native text update';
    const plan = reviewDesignReactDocumentRegeneration(
      basis,
      edited,
      convertDesignToReact(d).document,
    );
    expect(plan.conflicts).toEqual([]);
    expect(plan.document.roots).toEqual(edited.roots);
    expect(plan.document.nodes.find((n) => n.id === 'link')!.props.text).toBe('Native text update');
  },
);
it('regeneration reports incompatible root orders as an explicit conflict', () => {
  const d = designReactFixture(),
    third = clone(d.elements.find((e) => e.id === 'home')!);
  third.id = 'third';
  d.elements.push(third);
  d.web!.pages.push({ frameId: 'third', symbol: 'ThirdPage', path: '/third' });
  const basis = convertDesignToReact(d).document,
    edited = clone(basis),
    next = clone(basis);
  edited.roots = ['contact', 'home', 'third'];
  next.roots = ['home', 'third', 'contact'];
  expect(reviewDesignReactDocumentRegeneration(basis, edited, next).conflicts).toContain('roots');
});
it('large embedded images accept only bounded hashes and remain native-importable', () => {
  const d = designReactFixture();
  d.elements.push({
    ...makeDesignElement('image'),
    id: 'large-image',
    parentId: 'home',
    src:
      'data:image/png;base64,' +
      Buffer.concat([
        Buffer.from(png.split(',')[1], 'base64'),
        Buffer.alloc(2 * 1024 * 1024),
      ]).toString('base64'),
    alt: 'Large PNG',
    web: { tag: 'img' },
  });
  const bundle = exportDesignReact(d, referenceResolution),
    accepted = acceptDesignConversion(bundle).apply(d);
  expect(isDesign(accepted)).toBe(true);
  expect(isDesign(JSON.parse(JSON.stringify(accepted)))).toBe(true);
  expect(JSON.stringify(accepted.web).length).toBeLessThan(100000);
  expect(accepted.web!.accepted!.files).toBeUndefined();
});
it('accepted publications block changed definitions at the same version and retain previous identities', () => {
  let d = designReactFixture();
  d = acceptDesignConversion(exportDesignReact(d, referenceResolution)).apply(d);
  d.components[0].elements![0].layout!.gap = 29;
  expect(() => exportDesignReact(d, referenceResolution)).toThrow(/version|immutable/i);
  d.components[0].web!.version = '2.0.0';
  const next = acceptDesignConversion(exportDesignReact(d, referenceResolution)).apply(d);
  expect(next.web!.publications!.map((p) => p.version)).toEqual(['1.0.0', '2.0.0']);
  next.components[0].web!.version = '1.0.0';
  expect(() => exportDesignReact(next, referenceResolution)).toThrow(/version|immutable/i);
});
it('adding native component B retains the already published A identity', () => {
  let d = designReactFixture();
  d = acceptDesignConversion(exportDesignReact(d, referenceResolution)).apply(d);
  const old = clone(d.web!.publications![0]),
    b = clone(d.components[0]);
  b.id = 'second-card';
  b.web!.symbol = 'SecondCard';
  d.components.push(b);
  const conversion = convertDesignToReact(d);
  expect(conversion.diagnostics).toEqual([]);
  expect(
    conversion.components.find((c) => c.sourceId === 'product-card')!.registration.ref,
  ).toEqual(old);
});
it('registration retains immutable publication references through native settings and JSON', () => {
  let d = designReactFixture();
  const review = convertDesignToReact(d);
  d = retainDesignPublications(review).apply(d);
  const settings = clone(d.web!);
  delete settings.publications;
  d = configureDesignWeb(settings).apply(d);
  expect(d.web!.publications).toEqual(review.components.map((c) => c.registration.ref));
  d = JSON.parse(JSON.stringify(d));
  d.components[0].web!.props.title.default = 'New public default';
  expect(() => exportDesignReact(d, referenceResolution)).toThrow(
    /immutable.*version|version.*immutable/i,
  );
  expect(() => retainDesignPublications(review).apply(d)).toThrow(/changed/);
});
it('legacy accepted file receipts retain native version identity and upgrade to bounded hashes', () => {
  const d = designReactFixture(),
    bundle = exportDesignReact(d, referenceResolution);
  d.web!.accepted = {
    sourceHash: bundle.sourceHash,
    fingerprint: bundle.fingerprint,
    files: clone(bundle.files),
  };
  expect(isDesign(d)).toBe(true);
  const next = acceptDesignConversion(exportDesignReact(d, referenceResolution)).apply(d);
  expect(next.web!.accepted!.files).toBeUndefined();
  expect(next.web!.publications).toEqual(bundle.publications);
  d.components[0].web!.props.title.default = 'Changed legacy publication';
  expect(() => exportDesignReact(d, referenceResolution)).toThrow(/immutable/);
});
it('bounded acceptance preserves auxiliary SVG output without requiring Web semantics', () => {
  const d = designReactFixture();
  d.elements = d.elements.filter((e) => e.type !== 'react');
  delete d.elements.find((e) => e.id === 'home')!.web;
  expect(convertDesignToReact(d).diagnostics.length).toBeGreaterThan(0);
  const bundle = exportDesignReact(d, referenceResolution, { mode: 'svg' });
  const accepted = acceptDesignConversion(bundle).apply(d);
  expect(isDesign(accepted)).toBe(true);
  expect(accepted.web!.accepted!.files).toBeUndefined();
  expect(accepted.web!.publications).toEqual([]);
});
it('a forged retained reviewed Card contract is not resolved as original Host code', async () => {
  const d = designReactFixture(),
    forged = clone(reviewedNativeCard(['product-card']));
  forged.props.extra = { schema: { type: 'string' }, required: false };
  const { contractHash: _contractHash, ...ref } = forged.ref;
  const invalid = sealReactComponent({ ...forged, ref });
  d.web!.registrations.push(invalid);
  const result = await referenceDesignRuntime(d).resolve({
    environment: d.web!.environment.ref,
    components: [invalid.ref],
    signal: new AbortController().signal,
  });
  expect(result.resolution).toBeUndefined();
  expect(result.diagnostics[0].code).toBe('runtime-unresolved');
});
it('previously pinned reviewed Cards resolve, export and keep their runtime function after B is added', async () => {
  const d = designReactFixture(),
    old = reviewedNativeCard(['product-card']),
    b = clone(d.components[0]);
  b.id = 'second-card';
  b.web!.symbol = 'SecondCard';
  d.components.push(b);
  d.web!.registrations.push(old);
  d.elements.push({
    ...clone(d.elements.find((e) => e.id === 'buy')!),
    id: 'retained-card',
    react: {
      component: old.ref,
      import: old.import,
      props: {},
      bindings: {},
      slots: { body: ['card'] },
    },
  });
  d.elements.find((e) => e.id === 'card')!.parentId = 'retained-card';
  const runtime = referenceDesignRuntime(d),
    result = await runtime.resolve({
      environment: d.web!.environment.ref,
      components: d.web!.registrations.map((c) => c.ref),
      signal: new AbortController().signal,
    });
  expect(result.diagnostics).toEqual([]);
  expect(result.resolution!.components).toContainEqual(old.ref);
  const conversion = convertDesignToReact(d);
  expect(referenceDesignOriginalResolution([conversion]).components).toContainEqual(old.ref);
  const Card = () => null;
  expect(referenceReviewedCardFunctions([conversion], Card)[reactComponentKey(old.ref)]).toBe(Card);
  expect(exportDesignReact(d, result.resolution!).files['ProductPage.tsx']).toContain(
    '@reference/ui',
  );
});
