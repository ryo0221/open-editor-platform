import { describe, expect, it } from 'vitest';
import { REFERENCES_ADDON, type ReferenceSnapshot } from '@editor-platform/extension-contract';
import { counterExtension, counterReferenceExtension } from '@editor-platform/extension-sample';
import { ExtensionRegistry, parseManifest } from './index';

const hash = `sha256:${'3'.repeat(64)}`;
const admission = { trust: 'trusted' as const, verifiedPackageHash: hash };
const definition = () => counterReferenceExtension(hash);
const snapshot = (value: number): ReferenceSnapshot => ({
  artifactId: 'one',
  domain: 'example.counter',
  versionId: `v${value}`,
  revision: value,
  contentHash: 'a'.repeat(64),
  content: { id: 'counter', value },
  dependencies: [],
});

describe('references add-on', () => {
  it('validates exact declarations and adapter agreement', () => {
    expect(parseManifest(definition().manifest).addons?.references?.version).toBe(REFERENCES_ADDON);
    for (const value of [
      { version: 'references@1' },
      { version: REFERENCES_ADDON, extra: true },
      null,
    ])
      expect(() =>
        parseManifest({ ...definition().manifest, addons: { references: value } }),
      ).toThrow();
    expect(() =>
      new ExtensionRegistry().install({ ...definition(), references: undefined }, admission),
    ).toThrow('mismatch');
    expect(() =>
      new ExtensionRegistry().install({ ...definition(), references: {} as never }, admission),
    ).toThrow('mismatch');
    expect(() =>
      new ExtensionRegistry().install(
        { ...counterExtension(hash), references: definition().references },
        admission,
      ),
    ).toThrow('mismatch');
  });
  it('lists targets and computes values from the requested saved version', () => {
    const registration = new ExtensionRegistry().install(definition(), admission);
    const refs = registration.references!;
    const target = { kind: 'value' as const, targetId: 'counter', metricId: 'double' };
    expect(refs.list(snapshot(1))).toEqual([
      { ...target, label: 'Double' },
      { kind: 'figure', figureId: 'tally', label: 'Counter tally' },
    ]);
    expect(refs.resolve(snapshot(1), target)).toEqual({ kind: 'value', value: 2 });
    expect(refs.resolve(snapshot(2), target)).toEqual({ kind: 'value', value: 4 });
    expect(() => refs.resolve(snapshot(1), { ...target, metricId: 'missing' })).toThrow();
    expect(() =>
      refs.resolve({ ...snapshot(1), content: { id: 'counter', value: -1 } }, target),
    ).toThrow();
    expect(() => refs.list({ ...snapshot(1), revision: 0 })).toThrow();
    registration.uninstall();
    expect(() => refs.list(snapshot(1))).toThrow('revoked');
  });
  it('rejects an unsupported add-on name at registration', () => {
    const extension = definition();
    const registry = new ExtensionRegistry();
    expect(() =>
      registry.install(
        {
          ...extension,
          manifest: {
            ...extension.manifest,
            addons: { ...extension.manifest.addons, unknown: { version: REFERENCES_ADDON } },
          } as typeof extension.manifest,
        },
        admission,
      ),
    ).toThrow('Unsupported add-ons');
    expect(registry.install(extension, admission).references).toBeDefined();
  });
  it('refuses unsafe projections and malformed results', () => {
    const base = definition();
    const registration = new ExtensionRegistry().install(
      {
        ...base,
        references: {
          ...base.references!,
          resolve: () => ({ kind: 'figure', label: 'x', src: '<script>' }),
        },
      },
      admission,
    );
    expect(() =>
      registration.references!.resolve(snapshot(1), { kind: 'figure', figureId: 'f' }),
    ).toThrow();
  });
});
