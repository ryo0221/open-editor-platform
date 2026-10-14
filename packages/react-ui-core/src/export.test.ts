import { expect, it, vi } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import {
  createReferenceDocument,
  referenceResolution,
} from '../../../apps/react-ui-reference/src/catalog';
import {
  exportReactUi,
  exportReactUiFromRuntime,
  prepareReactUiExport,
  sealReactEnvironment,
  loadReactUiDocument,
  reactUiCommand,
} from './index';
it.each(['same', 'case'])(
  'environment refuses %s dependency output paths before export',
  (kind) => {
    const d = clone(createReferenceDocument()),
      { hash: _hash, ...ref } = d.environment.ref;
    const css = d.environment.dependencies.find((d) => d.kind === 'css')!;
    if (css.kind !== 'css') throw new Error('fixture');
    const duplicate = {
      ...css,
      id: 'other-css',
      path: kind === 'same' ? css.path : css.path.toUpperCase(),
    };
    expect(() =>
      sealReactEnvironment({
        ...d.environment,
        ref,
        dependencies: [...d.environment.dependencies, duplicate],
      }),
    ).toThrow(/Duplicate/);
  },
);
it.each(['Screen.css', 'screen.CSS', 'manifest.json'])(
  'preflight refuses dependency collision with %s',
  (path) => {
    const d = clone(createReferenceDocument()),
      { hash: _hash, ...ref } = d.environment.ref;
    d.environment = sealReactEnvironment({
      ...d.environment,
      ref,
      dependencies: d.environment.dependencies.map((dep) =>
        dep.kind === 'css' ? { ...dep, path } : dep,
      ),
    });
    const resolution = { ...referenceResolution, environment: d.environment.ref };
    expect(() => prepareReactUiExport(d, resolution)).toThrow(/collides with generated output/);
    expect(() => exportReactUi(d, resolution)).toThrow(/collides with generated output/);
  },
);
it('renamed output checks its actual CSS path and allows an unrelated Screen.css dependency', () => {
  const d = clone(createReferenceDocument()),
    { hash: _hash, ...ref } = d.environment.ref;
  d.environment = sealReactEnvironment({
    ...d.environment,
    ref,
    dependencies: d.environment.dependencies.map((dep) =>
      dep.kind === 'css' ? { ...dep, path: 'Screen.css' } : dep,
    ),
  });
  const resolution = { ...referenceResolution, environment: d.environment.ref };
  expect(
    exportReactUi(d, resolution, { symbol: 'Page', cssFile: 'Page.css' }).files['Screen.tsx'],
  ).toContain('./Page.css');
  expect(() => prepareReactUiExport(d, resolution, ['Screen.css'])).toThrow(/collides/);
});
it('Host build/provider diagnostics with exact pins block the download preparation without partial output', async () => {
  const document = createReferenceDocument(),
    diagnostics = [
      {
        code: 'host-typecheck',
        severity: 'error' as const,
        path: '$.environment',
        message: 'Pinned build failed typecheck',
        recovery: 'Repair the Host build',
      },
    ];
  const resolve = vi.fn(async () => ({ resolution: referenceResolution, diagnostics }));
  await expect(
    exportReactUiFromRuntime(document, { resolve }, new AbortController().signal),
  ).rejects.toMatchObject({ diagnostics });
  expect(resolve).toHaveBeenCalledOnce();
  resolve.mockResolvedValue({ resolution: referenceResolution, diagnostics: [] });
  expect(
    await exportReactUiFromRuntime(document, { resolve }, new AbortController().signal),
  ).toEqual(exportReactUi(document, referenceResolution));
});
it('encodes real imports and escaped literals deterministically, leaving Host implementation ownership explicit', () => {
  const original = createReferenceDocument();
  const changed = reactUiCommand([
    {
      type: 'set-prop',
      nodeId: 'title',
      prop: 'text',
      value: '</script><script>alert("x")</script>{expression}\u2028',
    },
  ]).apply(original);
  const first = exportReactUi(changed, referenceResolution);
  expect(first).toEqual(
    exportReactUi(
      loadReactUiDocument(JSON.parse(first.files['composition.json'])),
      referenceResolution,
    ),
  );
  expect(first.files['Screen.tsx']).toContain('\\u003c/script\\u003e');
  expect(first.files['Screen.tsx']).not.toMatch(/<script>|data-react-ui-node|@editor-platform/);
  expect(first.files['manifest.json']).toContain(referenceResolution.environment.hash);
  expect(changed.nodes.find((n) => n.id === 'title')!.props.text).toContain('<script>');
  expect(original.nodes.find((n) => n.id === 'title')!.props.text).toBe('Color study');
});
it('returns no partial output when runtime dependencies do not match', () => {
  expect(() =>
    exportReactUi(createReferenceDocument(), { ...referenceResolution, dependencies: [] }),
  ).toThrow();
});
it('named native page/component output has matching function, props and default export', () => {
  const out = exportReactUi(createReferenceDocument(), referenceResolution, {
    symbol: 'ProductPage',
    cssFile: 'ProductPage.css',
  });
  expect(out.files['Screen.tsx']).toContain('export function ProductPage(props: ProductPageProps)');
  expect(out.files['Screen.tsx']).toContain('export default ProductPage;');
  expect(out.files['Screen.tsx']).toContain('./ProductPage.css');
  expect(out.files['Screen.tsx']).not.toContain('export default Screen;');
});
