import { beforeAll, describe, expect, it } from 'vitest';
import {
  clone,
  commitVersion,
  createArtifact,
  serializeArtifact,
} from '@editor-platform/artifact-core';
import { reactUiContractFixture } from '../../../tests/fixtures/react-ui/contracts';
import {
  inspectReactUiDocument,
  loadReactUiDocument,
  parseReactUiDocument,
  prepareReactUiExport,
  ReactUiError,
  schemaAssignable,
  sealReactComponent,
  sealReactEnvironment,
  serializeReactUiDocument,
  validateReactComponent,
  validateReactEnvironment,
  valueMatches,
  type RegisteredReactComponent,
  type ReactUiDocument,
  type ReactRuntimeResolution,
} from './index';

let base: ReactUiDocument, resolution: ReactRuntimeResolution;
beforeAll(async () => {
  ({ document: base, resolution } = await reactUiContractFixture());
});
const copy = () => clone(base);
function unsealComponent(component: RegisteredReactComponent) {
  const { contractHash: _hash, ...ref } = component.ref;
  return { ...clone(component), ref };
}
function resealEnvironment(doc: ReactUiDocument) {
  const { hash: _hash, ...ref } = doc.environment.ref;
  doc.environment = sealReactEnvironment({ ...doc.environment, ref });
}
function expectIssue(doc: ReactUiDocument, code: string) {
  const original = JSON.stringify(doc),
    result = inspectReactUiDocument(doc);
  expect(result.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code,
        severity: 'error',
        recovery: expect.any(String),
        path: expect.any(String),
      }),
    ]),
  );
  expect(JSON.stringify(doc)).toBe(original);
  expect(() => prepareReactUiExport(doc, resolution)).toThrow(ReactUiError);
  return result;
}
describe('React UI W1 registration/integrity', () => {
  it('loads pinned components, named slots, controlled input, Provider, assets and existing tokens', () => {
    expect(inspectReactUiDocument(base).diagnostics).toEqual([]);
    const owned = loadReactUiDocument(base);
    expect(owned).toEqual(base);
    expect(owned).not.toBe(base);
    expect(Object.isFrozen(owned.nodes[0].slots.body)).toBe(true);
    expect(Object.isFrozen(owned.environment.tokens!.payload.tokens)).toBe(true);
  });
  it('owns and seals registrations without changing callers', () => {
    const input = unsealComponent(base.components[1]),
      component = sealReactComponent(input);
    input.sampleProps.label = 'Changed';
    expect(component.sampleProps.label).toBe('Sample');
    expect(validateReactComponent(component)).toEqual(base.components[1]);
    expect(validateReactEnvironment(base.environment)).toEqual(base.environment);
  });
  it.each(['latest', 'LATEST', 'main', '^1.0.0', '*'])(
    'rejects floating component version %s',
    (version) => {
      const input = unsealComponent(base.components[1]);
      input.ref.version = version;
      expect(() => sealReactComponent(input)).toThrow(ReactUiError);
    },
  );
  it('rejects altered metadata under the same contract hash and duplicate immutable identity', () => {
    const doc = copy();
    doc.components[1].sampleProps.label = 'Tampered';
    expectIssue(doc, 'registration-hash');
    const duplicate = copy();
    duplicate.components.push(clone(duplicate.components[1]));
    expectIssue(duplicate, 'duplicate');
  });
  it('checks environment hash including tokens-only policy and Provider order', () => {
    const doc = copy();
    doc.environment.stylePolicy = 'allow-literals';
    expectIssue(doc, 'environment-hash');
    const missingProvider = copy();
    missingProvider.environment.providerOrder = [];
    expect(() => resealEnvironment(missingProvider)).toThrow(ReactUiError);
  });
  it('does not overwrite an already sealed published identity', () => {
    expect(() => sealReactComponent(base.components[0])).toThrow(ReactUiError);
    expect(() => sealReactEnvironment(base.environment)).toThrow(ReactUiError);
  });
  it('rejects code-like imports, traversal and unsupported export names', () => {
    for (const source of ['https://example.test/ui', '../ui', './ui/../secret', 'ui";alert(1)//']) {
      const input = unsealComponent(base.components[1]);
      input.import.source = source;
      expect(() => sealReactComponent(input)).toThrow(ReactUiError);
    }
    const input = unsealComponent(base.components[1]);
    input.import.name = 'button';
    expect(() => sealReactComponent(input)).toThrow(ReactUiError);
    input.import = { source: './Button', export: 'default' };
    expect(sealReactComponent(input).import.export).toBe('default');
  });
  it('validates sample/default and controlled callback schemas', () => {
    const button = unsealComponent(base.components[1]);
    button.props.variant.default = 'missing';
    expect(() => sealReactComponent(button)).toThrow(ReactUiError);
    const input = unsealComponent(base.components[4]);
    input.events.onChange.parameters = [{ type: 'number' }];
    expect(() => sealReactComponent(input)).toThrow(ReactUiError);
  });
  it('diagnoses corrupted retained tokens and does not synthesize nested defaults', () => {
    const doc = copy();
    doc.environment.tokens!.payload.tokens['space.base'].value = { value: 24, unit: 'px' };
    expect(() => resealEnvironment(doc)).toThrow(ReactUiError);
    const input = unsealComponent(base.components[1]);
    input.props.settings = {
      required: false,
      schema: {
        type: 'object',
        fields: { title: { schema: { type: 'string' }, required: true, default: 'hidden' } },
      },
    };
    expect(() => sealReactComponent(input)).toThrow(ReactUiError);
  });
  it('keeps functions/events/ReactNode/layout out of JSON props', () => {
    for (const name of [
      'onClick',
      'children',
      'style',
      'className',
      'dangerouslySetInnerHTML',
      'toString',
    ]) {
      const input = unsealComponent(base.components[1]);
      input.props[name] = { schema: { type: 'string' }, required: false };
      expect(() => sealReactComponent(input)).toThrow(ReactUiError);
    }
  });
});
describe('React UI composition/diagnostics', () => {
  it('preserves unresolved external references in native JSON while blocking output', () => {
    const doc = copy();
    doc.components.splice(2, 1);
    const result = expectIssue(doc, 'component-missing');
    expect(result.document?.nodes[1].component).toEqual(base.nodes[1].component);
    expect(parseReactUiDocument(serializeReactUiDocument(doc))).toEqual(doc);
  });
  it('never treats preview sample props as production defaults', () => {
    const doc = copy();
    delete doc.nodes[4].props.label;
    expectIssue(doc, 'prop-required');
  });
  it.each(['prop-unknown', 'prop-type', 'component-mismatch', 'asset-missing'])(
    'diagnoses %s',
    (code) => {
      const doc = copy();
      if (code === 'prop-unknown') doc.nodes[4].props.extra = true;
      if (code === 'prop-type') doc.nodes[4].props.variant = 'unsupported';
      if (code === 'component-mismatch') doc.nodes[4].component.implementationHash = 'f'.repeat(64);
      if (code === 'asset-missing') doc.nodes[1].props.source = 'missing-image';
      expectIssue(doc, code);
    },
  );
  it('diagnoses a missing declared CSS dependency after an explicit environment revision', () => {
    const doc = copy();
    doc.environment.dependencies = doc.environment.dependencies.filter((d) => d.id !== 'theme-css');
    resealEnvironment(doc);
    expectIssue(doc, 'dependency-missing');
  });
  it('does not claim two implementation versions are exportable through the same import', () => {
    const doc = copy(),
      changed = unsealComponent(doc.components[1]);
    changed.ref.version = '2.0.0';
    changed.ref.implementationHash = 'f'.repeat(64);
    doc.components.push(sealReactComponent(changed));
    expectIssue(doc, 'import-conflict');
    changed.import.source = '@fixture/ui-v2';
    doc.components[doc.components.length - 1] = sealReactComponent(changed);
    expect(inspectReactUiDocument(doc).diagnostics).toEqual([]);
  });
  it.each([
    'node-missing',
    'node-parent',
    'node-orphan',
    'slot-count',
    'slot-unknown',
    'slot-component',
    'slot-cycle',
  ])('diagnoses %s without modifying data', (code) => {
    const doc = copy();
    if (code === 'node-missing') doc.nodes[0].slots.body.push('absent');
    if (code === 'node-parent') doc.roots.push('buy');
    if (code === 'node-orphan')
      doc.nodes[0].slots.body = doc.nodes[0].slots.body.filter((id) => id !== 'buy');
    if (code === 'slot-count') doc.nodes[0].slots.body = [];
    if (code === 'slot-unknown') doc.nodes[4].slots.extra = [];
    if (code === 'slot-component') {
      const card = unsealComponent(doc.components[0]);
      card.slots.body.accepts = [{ registryId: 'fixture', componentId: 'Card' }];
      doc.components[0] = sealReactComponent(card);
      doc.nodes[0].component = doc.components[0].ref;
    }
    if (code === 'slot-cycle') doc.nodes[0].slots.body.push('card');
    expectIssue(doc, code);
  });
  it('checks cycles in disconnected subgraphs and limits nested component trees', () => {
    const cycle = copy();
    cycle.roots = [];
    cycle.nodes[0].slots.body.push('card');
    expectIssue(cycle, 'slot-cycle');
    const deep = copy();
    const root = deep.nodes[0];
    for (let i = 0; i < 33; i++) {
      const node = { ...clone(root), id: `nested-${i}`, slots: { body: [] } };
      deep.nodes.push(node);
      (i === 0 ? root : deep.nodes[deep.nodes.length - 2]).slots.body.push(node.id);
    }
    expectIssue(deep, 'tree-depth');
  });
  it('checks data-path assignability rather than only the fixture value', () => {
    const doc = copy();
    doc.inputs.product.schema = {
      type: 'object',
      fields: { title: { required: true, schema: { type: 'string' } } },
    };
    expectIssue(doc, 'binding-type');
    const missing = copy();
    missing.nodes[2].bindings.text = { kind: 'data', input: 'product', path: ['unknown'] };
    expectIssue(missing, 'binding-type');
    const nullable = copy();
    nullable.inputs.product.schema.nullable = true;
    expectIssue(nullable, 'binding-type');
  });
  it('rejects simultaneous literals/bindings, unpaired controlled inputs and wrong callbacks', () => {
    const doc = copy();
    doc.nodes[3].props.value = 'literal';
    expectIssue(doc, 'binding-ownership');
    const unpaired = copy();
    delete unpaired.nodes[3].bindings.onChange;
    expectIssue(unpaired, 'controlled-binding');
    const wrong = copy();
    wrong.callbacks.onNameChange.parameters = [{ type: 'number' }];
    expectIssue(wrong, 'callback-type');
  });
  it('checks fixtures and required page inputs', () => {
    const wrong = copy();
    wrong.fixture.name = 12;
    expectIssue(wrong, 'fixture-type');
    const missing = copy();
    delete missing.fixture.product;
    expectIssue(missing, 'fixture-required');
    const extra = copy();
    extra.fixture.unknown = true;
    expectIssue(extra, 'fixture-input');
  });
  it('enforces tokens-only across responsive overrides and CSS types', () => {
    const raw = copy();
    raw.nodes[0].layout.breakpoints.desktop.gap = { kind: 'literal', value: 20 };
    expectIssue(raw, 'style-value');
    const missing = copy();
    missing.nodes[0].layout.base.gap = { kind: 'token', tokenId: 'space.missing' };
    expectIssue(missing, 'style-value');
    const wrong = copy();
    wrong.nodes[0].layout.base.gap = { kind: 'token', tokenId: 'brand.color' };
    expectIssue(wrong, 'style-value');
    const bp = copy();
    bp.nodes[0].layout.breakpoints.unregistered = {};
    expectIssue(bp, 'layout-breakpoint');
  });
  it('supports bounded literal CSS only when Host explicitly permits it', () => {
    const doc = copy();
    doc.environment.stylePolicy = 'allow-literals';
    resealEnvironment(doc);
    doc.nodes[0].layout.base.padding = { kind: 'literal', value: '16px' };
    expect(inspectReactUiDocument(doc).diagnostics).toEqual([]);
    for (const value of [
      '0; background:url(https://bad.test)',
      'calc(1px + 2px)',
      '-1px',
      '10001px',
    ]) {
      doc.nodes[0].layout.base.padding = { kind: 'literal', value };
      expectIssue(doc, 'style-value');
    }
  });
  it('does not silently add a wrapper to an unsupported component', () => {
    const doc = copy();
    const card = unsealComponent(doc.components[0]);
    card.layout = 'none';
    doc.components[0] = sealReactComponent(card);
    doc.nodes[0].component = doc.components[0].ref;
    expectIssue(doc, 'layout-capability');
  });
});
describe('native lifecycle / export preflight / hostile inputs', () => {
  it('round-trips native composition and the existing immutable Artifact lifecycle', async () => {
    const escaped = copy();
    escaped.nodes[5].props.text = '"}; </script> 購入する';
    expect(parseReactUiDocument(serializeReactUiDocument(escaped))).toEqual(escaped);
    const artifact = await commitVersion(
      createArtifact('react-ui', 'Screen', escaped),
      'fixture-actor',
      'W1 test',
    );
    const restored = JSON.parse(serializeArtifact(artifact));
    expect(loadReactUiDocument(restored.versions[0].content)).toEqual(escaped);
    expect(restored.versions[0].contentHash).toBe(artifact.versions[0].contentHash);
  });
  it('creates an owned deterministic plan with no files or Editor runtime', () => {
    const a = prepareReactUiExport(base, resolution),
      b = prepareReactUiExport(parseReactUiDocument(serializeReactUiDocument(base)), resolution);
    expect(a).toEqual(b);
    expect(a.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(a.files).toEqual([
      'Screen.tsx',
      'Screen.css',
      'manifest.json',
      'composition.json',
      'README.md',
    ]);
    expect(a.ownership).toBe('generated-directory-only');
    expect(Object.isFrozen(a.document.nodes)).toBe(true);
    expect(a.document).not.toBe(base);
  });
  it('requires exact runtime environment, component and CSS/Provider/asset resolution', () => {
    for (const mutate of [
      (r: ReactRuntimeResolution) => {
        r.environment.hash = 'f'.repeat(64);
      },
      (r: ReactRuntimeResolution) => {
        r.components[0].implementationHash = 'f'.repeat(64);
      },
      (r: ReactRuntimeResolution) => {
        r.dependencies = r.dependencies.filter((d) => d.id !== 'theme-provider');
      },
      (r: ReactRuntimeResolution) => {
        r.dependencies = r.dependencies.filter((d) => d.id !== 'theme-css');
      },
      (r: ReactRuntimeResolution) => {
        r.dependencies = r.dependencies.filter((d) => d.id !== 'product-image');
      },
    ]) {
      const r = clone(resolution);
      mutate(r);
      expect(() => prepareReactUiExport(base, r)).toThrow(ReactUiError);
    }
    expect(() => prepareReactUiExport(base, undefined)).toThrow(ReactUiError);
  });
  it('rejects non-JSON code, cycles, sparse arrays, reserved keys and unsupported schema fields', () => {
    const mutations: ((doc: Record<string, unknown>) => void)[] = [
      (d) => {
        d.expression = 'window.location';
      },
      (d) => {
        d.execute = () => 1;
      },
      (d) => {
        d.cycle = d;
      },
      (d) => {
        const a = [0, 1];
        delete a[0];
        d.fixture = a;
      },
      (d) => {
        d.fixture = JSON.parse('{"__proto__":{}}');
      },
      (d) => {
        d.fixture = { value: Infinity };
      },
      (d) => {
        d.fixture = { value: new Date() };
      },
    ];
    for (const mutate of mutations) {
      const d = copy() as unknown as Record<string, unknown>;
      mutate(d);
      expect(() => loadReactUiDocument(d)).toThrow(ReactUiError);
    }
    const expression = copy();
    (expression.nodes[2].bindings.text as unknown as Record<string, unknown>).expression =
      'product.title';
    expectIssue(expression, 'schema-fields');
  });
  it('never invokes getters or toJSON hooks on untrusted objects', () => {
    let invoked = false;
    const getter = copy();
    Object.defineProperty(getter.fixture, 'secret', {
      enumerable: true,
      get: () => {
        invoked = true;
        return 'no';
      },
    });
    expect(() => loadReactUiDocument(getter)).toThrow(ReactUiError);
    const hook = copy();
    Object.defineProperty(hook.fixture, 'toJSON', {
      value: () => {
        invoked = true;
        return {};
      },
    });
    expect(() => loadReactUiDocument(hook)).toThrow(ReactUiError);
    expect(valueMatches({ type: 'object', fields: {} }, getter.fixture)).toBe(false);
    expect(invoked).toBe(false);
  });
  it('bounds JSON input bytes and unknown/duplicate breakpoint schemas', () => {
    expect(() => parseReactUiDocument('"' + 'x'.repeat(4 * 1024 * 1024) + '"')).toThrow(
      ReactUiError,
    );
    const doc = copy();
    doc.breakpoints[1].minWidth = 1024;
    expectIssue(doc, 'breakpoints');
  });
  it('checks nested value shape and structural assignability', () => {
    expect(
      valueMatches(
        {
          type: 'object',
          fields: {
            items: {
              required: true,
              schema: { type: 'array', maxItems: 2, items: { type: 'number', minimum: 0 } },
            },
          },
        },
        { items: [1, -1] },
      ),
    ).toBe(false);
    expect(
      schemaAssignable(
        { type: 'enum', values: ['small'] },
        { type: 'enum', values: ['small', 'large'] },
      ),
    ).toBe(true);
    expect(
      schemaAssignable(
        { type: 'number', minimum: 0, maximum: 10 },
        { type: 'number', minimum: 1, maximum: 10 },
      ),
    ).toBe(false);
    expect(
      schemaAssignable(
        { type: 'array', maxItems: 3, items: { type: 'boolean' } },
        { type: 'array', maxItems: 2, items: { type: 'boolean' } },
      ),
    ).toBe(false);
    expect(
      schemaAssignable(
        { type: 'object', fields: { value: { required: false, schema: { type: 'boolean' } } } },
        { type: 'object', fields: { value: { required: true, schema: { type: 'boolean' } } } },
      ),
    ).toBe(false);
  });
});
