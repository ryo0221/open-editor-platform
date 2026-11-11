import { describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { command } from '@editor-platform/editor-core';
import { createArtifact, type Artifact } from '@editor-platform/artifact-core';
import { ArtifactEditor, type EditorHostAdapter } from '@editor-platform/editor-host';
import { CONTRACT_VERSION, OPERATIONS_ADDON } from '@editor-platform/extension-contract';
import { counterExtension, createCounter, setCounter } from '@editor-platform/extension-sample';
import { ExtensionRegistry } from './index';
import { artifactEditorHost } from './editor-host';
import {
  describeExtensionPackage,
  installVerifiedExtension,
  loadVerifiedExtension,
  verifyExtensionPackage,
  type ExtensionPackage,
  type PackageManifest,
} from './package';

const importData = (bytes: Uint8Array) =>
  import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(bytes).toString('base64')}`);
const encode = (text: string) => new TextEncoder().encode(text);

function manifest(overrides: Partial<PackageManifest>): PackageManifest {
  return {
    contractVersion: CONTRACT_VERSION,
    id: 'example.package',
    version: '1.0.0',
    artifactKind: 'example.package',
    schemaVersion: 1,
    capabilities: ['local-edit', 'persistence'],
    permissions: ['artifact:read', 'artifact:write'],
    licenseNotices: ['Test fixture; no license grant.'],
    ...overrides,
  };
}
/** Closed ESM entry source. `validate` is the Editor's own domain check. */
function entrySource(m: PackageManifest, validate: string) {
  return `const manifest = ${JSON.stringify(m)};
export function definition(packageHash) {
  return { manifest: { ...manifest, packageHash }, validate: ${validate} };
}`;
}
function pkg(m: PackageManifest, validate: string): ExtensionPackage {
  return {
    manifest: structuredClone(m),
    entry: 'entry.js',
    files: [
      { path: 'entry.js', bytes: encode(entrySource(m, validate)) },
      { path: 'NOTICE.txt', bytes: encode('Fixture notice.') },
    ],
  };
}
/** Same native format as the bundled Counter, a different (headless) Editor package. */
const altCounterManifest = manifest({
  id: 'example.counter-alt-ui',
  artifactKind: 'example.counter',
});
const altCounter = () =>
  pkg(
    altCounterManifest,
    `(v) => !!v && typeof v === 'object' && v.id === 'counter' && Number.isSafeInteger(v.value) && Object.keys(v).length === 2`,
  );
/** A new native format owned entirely by the package. */
interface Checklist {
  items: { id: string; done: boolean }[];
}
const checklistManifest = manifest({
  id: 'example.checklist-editor',
  artifactKind: 'example.checklist',
  capabilities: ['local-edit', 'persistence', 'selection'],
  permissions: ['artifact:read', 'artifact:write', 'selection:write'],
});
const checklist = () =>
  pkg(
    checklistManifest,
    `(v) => !!v && typeof v === 'object' && Array.isArray(v.items) && v.items.every((i) => typeof i.id === 'string' && typeof i.done === 'boolean')`,
  );
const checklistHostAdapter: EditorHostAdapter<Checklist> = {
  kind: 'example.checklist',
  validate: (v): v is Checklist =>
    !!v && typeof v === 'object' && Array.isArray((v as Checklist).items),
  capabilities: { undo: true, nativeJson: true, formats: [], preview: 'none', shared: false },
};

async function pinned(input: ExtensionPackage) {
  const hash = (await describeExtensionPackage(input)).hash;
  const pins = new Map([[`${input.manifest.id}@${input.manifest.version}`, hash]]);
  return {
    hash,
    pins,
    lookup: (id: string, version: string) => pins.get(`${id}@${version}`),
  };
}

describe('loadVerifiedExtension', () => {
  it('carries the operations add-on from verified bytes and prepares/commits through the registry', async () => {
    const m = manifest({
      id: 'example.checklist-ops',
      artifactKind: 'example.checklist',
      addons: {
        operations: {
          version: OPERATIONS_ADDON,
          declarations: [
            {
              id: 'item.check',
              version: '1.0.0',
              title: 'Mark an item done',
              inputSchema: {
                type: 'object',
                properties: { item: { type: 'string', maxLength: 64 } },
                required: ['item'],
                additionalProperties: false,
              },
            },
          ],
        },
      },
    });
    const source = `const manifest = ${JSON.stringify(m)};
export function definition(packageHash) {
  return {
    manifest: { ...manifest, packageHash },
    validate: (v) => !!v && Array.isArray(v.items),
    operations: {
      checkInput: (op, input, content) => content.items.some((i) => i.id === input.item && !i.done) ? [] : ['no open item ' + input.item],
      command: (op, input) => ({ type: op, label: 'Check', apply: (c) => {
        if (!c.items.some((i) => i.id === input.item && !i.done)) throw new Error('item changed');
        return { items: c.items.map((i) => (i.id === input.item ? { ...i, done: true } : i)) };
      } }),
    },
  };
}`;
    const input: ExtensionPackage = {
      manifest: structuredClone(m),
      entry: 'entry.js',
      files: [{ path: 'entry.js', bytes: encode(source) }],
    };
    const { lookup } = await pinned(input);
    const loaded = await loadVerifiedExtension<Checklist>(
      await verifyExtensionPackage(input, lookup),
      {
        importModule: importData,
      },
    );
    expect(loaded.manifest.addons?.operations?.declarations.map((d) => d.id)).toEqual([
      'item.check',
    ]);
    const registration = installVerifiedExtension(new ExtensionRegistry(), loaded);
    let content: Checklist = { items: [{ id: 'a', done: false }] };
    const handle = registration.open({
      artifactKind: 'example.checklist',
      schemaVersion: 1,
      allowed: () => true,
      readOnly: () => false,
      read: () => content,
      execute: (c) => void (content = c.apply(structuredClone(content))),
      undo: () => {},
      redo: () => {},
      save: async () => {},
      select: () => {},
    });
    const op = { id: 'item.check', version: '1.0.0' };
    expect(handle.operations!.check(op, { item: 'b' })).toEqual(['no open item b']);
    expect(handle.operations!.check(op, { item: 'a', extra: 1 })).toEqual([
      'input: unknown property extra',
    ]);
    handle.operations!.prepare(op, { item: 'a' }).commit();
    expect(content.items[0].done).toBe(true);
    registration.uninstall();
  });

  it('loads the bundled Counter from verified bytes and installs it with the verified hash', async () => {
    const built = await build({
      stdin: {
        contents: `import { counterExtension } from '@editor-platform/extension-sample';
export const definition = counterExtension;`,
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'esm',
      metafile: true,
    });
    expect(Object.values(built.metafile!.outputs).flatMap((o) => o.imports)).toEqual([]);
    const { packageHash: _h, ...m } = counterExtension(`sha256:${'0'.repeat(64)}`).manifest;
    const input: ExtensionPackage = {
      manifest: m,
      entry: 'counter.js',
      files: [{ path: 'counter.js', bytes: built.outputFiles![0].contents }],
    };
    const { hash, lookup } = await pinned(input);
    const loaded = await loadVerifiedExtension(await verifyExtensionPackage(input, lookup), {
      importModule: importData,
    });
    const registration = installVerifiedExtension(new ExtensionRegistry(), loaded);
    expect(registration.manifest.packageHash).toBe(hash);
    registration.uninstall();
  });

  it('loads a different Editor for an existing format and an Editor with its own format', async () => {
    const registry = new ExtensionRegistry();
    const counterHash = `sha256:${'1'.repeat(64)}`;
    registry.install(counterExtension(counterHash), {
      trust: 'trusted',
      verifiedPackageHash: counterHash,
    });
    for (const input of [altCounter(), checklist()]) {
      const { hash, lookup } = await pinned(input);
      const loaded = await loadVerifiedExtension(await verifyExtensionPackage(input, lookup), {
        importModule: importData,
      });
      expect(loaded.manifest).toEqual({ ...input.manifest, packageHash: hash });
      // Both install beside the bundled Counter in one registry, keyed by Editor/package id.
      expect(installVerifiedExtension(registry, loaded).manifest.id).toBe(input.manifest.id);
    }
  });

  it('owns the verified definition against later factory or caller changes', async () => {
    const m = manifest({ id: 'review.readonly', capabilities: [], permissions: ['artifact:read'] });
    const source = `const manifest = ${JSON.stringify(m)};
export let last;
export function definition(packageHash) {
  last = { manifest: { ...manifest, packageHash }, validate: () => true };
  return last;
}`;
    const input: ExtensionPackage = {
      manifest: m,
      entry: 'entry.js',
      files: [{ path: 'entry.js', bytes: encode(source) }],
    };
    const { lookup } = await pinned(input);
    let module: { last: Record<string, unknown> & { manifest: Record<string, unknown> } };
    const loaded = await loadVerifiedExtension(await verifyExtensionPackage(input, lookup), {
      importModule: async (bytes) => (module = (await importData(bytes)) as typeof module),
    });
    const escalated = {
      ...loaded.definition.manifest,
      id: 'review.not-pinned',
      capabilities: ['local-edit'],
      permissions: ['artifact:read', 'artifact:write'],
    };
    // Factory-retained reference.
    module!.last.manifest = escalated;
    module!.last.validate = () => false;
    (module!.last.manifest.permissions as string[]).push('selection:write');
    // Caller reference.
    const attempt = (fn: () => void) => {
      try {
        fn();
      } catch {
        /* frozen */
      }
    };
    attempt(() => Object.assign(loaded.definition, { manifest: escalated }));
    attempt(() =>
      Object.assign(loaded.definition, { validate: () => false, mount: () => () => {} }),
    );
    attempt(() => (loaded.definition.manifest.permissions as string[]).push('artifact:write'));
    attempt(() =>
      Object.assign(loaded, { definition: { ...loaded.definition, manifest: escalated } }),
    );
    const registration = installVerifiedExtension(new ExtensionRegistry(), loaded);
    expect(registration.manifest).toEqual({ ...m, packageHash: loaded.manifest.packageHash });
    expect(loaded.definition.validate({})).toBe(true);
    expect('mount' in loaded.definition).toBe(false);
    // Look-alike objects that were not returned by loadVerifiedExtension are refused.
    expect(() =>
      installVerifiedExtension(new ExtensionRegistry(), {
        ...loaded,
        definition: {
          ...loaded.definition,
          manifest: { ...escalated, packageHash: loaded.manifest.packageHash },
        } as never,
      }),
    ).toThrow('Not a definition returned');
  });

  it('imports only the verified entry bytes, never the caller copy', async () => {
    const input = checklist();
    const original = new TextDecoder().decode(input.files[0].bytes);
    const { lookup } = await pinned(input);
    const verified = await verifyExtensionPackage(input, lookup);
    input.files[0].bytes.fill(32);
    const importModule = vi.fn(importData);
    await loadVerifiedExtension(verified, { importModule });
    expect(new TextDecoder().decode(importModule.mock.calls[0][0])).toBe(original);
  });

  it.each([
    ['tampered entry', (p: ExtensionPackage) => void (p.files[0].bytes[0] ^= 1)],
    ['tampered notice', (p: ExtensionPackage) => void (p.files[1].bytes[0] ^= 1)],
    ['changed manifest', (p: ExtensionPackage) => void (p.manifest.schemaVersion = 2)],
    [
      'added file',
      (p: ExtensionPackage) => void p.files.push({ path: 'x.js', bytes: encode('1') }),
    ],
  ])('refuses a %s under the original pin before importing', async (_name, mutate) => {
    const input = checklist();
    const { lookup } = await pinned(input);
    mutate(input);
    const importModule = vi.fn(importData);
    await expect(
      verifyExtensionPackage(input, lookup).then((v) => loadVerifiedExtension(v, { importModule })),
    ).rejects.toThrow('Untrusted');
    expect(importModule).not.toHaveBeenCalled();
  });

  it('refuses an unpinned package and a pin revoked during import or before install', async () => {
    const input = checklist();
    await expect(verifyExtensionPackage(input, () => undefined)).rejects.toThrow('Untrusted');
    const { pins, lookup } = await pinned(input);
    const verified = await verifyExtensionPackage(input, lookup);
    const key = [...pins.keys()][0];
    const saved = pins.get(key)!;
    await expect(
      loadVerifiedExtension(verified, {
        importModule: async (bytes) => {
          pins.delete(key);
          return importData(bytes);
        },
      }),
    ).rejects.toThrow('Untrusted');
    pins.set(key, saved);
    const loaded = await loadVerifiedExtension(verified, { importModule: importData });
    pins.delete(key);
    expect(() => installVerifiedExtension(new ExtensionRegistry(), loaded)).toThrow('Untrusted');
  });

  it.each([
    ['no definition export', 'export const value = 1;'],
    ['definition that is not a function', 'export const definition = {};'],
    [
      'manifest differing from the verified one',
      `export function definition(packageHash) { return { manifest: { ...${JSON.stringify(checklistManifest)}, version: '9.9.9', packageHash }, validate: () => true }; }`,
    ],
    [
      'extra manifest field',
      `export function definition(packageHash) { return { manifest: { ...${JSON.stringify(checklistManifest)}, extra: 1, packageHash }, validate: () => true }; }`,
    ],
  ])('refuses an entry with %s', async (_name, source) => {
    const input: ExtensionPackage = {
      manifest: checklistManifest,
      entry: 'entry.js',
      files: [{ path: 'entry.js', bytes: encode(source) }],
    };
    const { lookup } = await pinned(input);
    await expect(
      loadVerifiedExtension(await verifyExtensionPackage(input, lookup), {
        importModule: importData,
      }),
    ).rejects.toThrow(/definition|Definition/);
  });
});

describe('artifactEditorHost', () => {
  async function openChecklist(options: { editable?: () => boolean } = {}) {
    const input = checklist();
    const { lookup } = await pinned(input);
    const loaded = await loadVerifiedExtension<Checklist>(
      await verifyExtensionPackage(input, lookup),
      { importModule: importData },
    );
    const registration = installVerifiedExtension(new ExtensionRegistry(), loaded);
    const stored: Artifact<Checklist>[] = [];
    const editor = new ArtifactEditor(
      createArtifact<Checklist>('example.checklist', 'List', { items: [] }),
      checklistHostAdapter,
      { put: async (a) => void stored.push(a) },
      options.editable,
    );
    const handle = registration.open(
      artifactEditorHost(editor, { schemaVersion: 1, allowed: () => true }),
    );
    return { registration, editor, handle, stored };
  }
  const add = (id: string) =>
    command<Checklist>('checklist.add', 'Add item', (c) => ({
      items: [...c.items, { id, done: false }],
    }));

  it('edits, undoes, selects and saves through the one Host-owned ArtifactEditor session', async () => {
    const { editor, handle, stored, registration } = await openChecklist();
    handle.api.execute(add('a'));
    handle.api.execute(add('b'));
    expect(editor.content.items.map((i) => i.id)).toEqual(['a', 'b']);
    handle.api.undo();
    expect(handle.api.read().items).toHaveLength(1);
    handle.api.redo();
    handle.api.select(['b']);
    expect(editor.snapshot.selection.addresses).toEqual([
      { artifactId: editor.id, elementId: 'b' },
    ]);
    await handle.api.save();
    expect(stored.at(-1)!.draft.content.items).toHaveLength(2);
    expect(editor.snapshot.dirty).toBe(false);
    registration.uninstall();
    expect(() => handle.api.read()).toThrow('revoked');
    expect(editor.content.items).toHaveLength(2);
  });

  it('keeps the Host edit permission and the Editor domain validator authoritative', async () => {
    let editable = true;
    const { editor, handle } = await openChecklist({ editable: () => editable });
    expect(() =>
      handle.api.execute(command<Checklist>('bad', 'Bad', () => ({ items: 'x' }) as never)),
    ).toThrow('Invalid domain');
    editable = false;
    expect(() => handle.api.execute(add('a'))).toThrow('Permission denied');
    expect(editor.content.items).toEqual([]);
  });

  it('rejects capabilities the package does not declare and a mismatched schema', async () => {
    const input = altCounter();
    const { lookup } = await pinned(input);
    const loaded = await loadVerifiedExtension<ReturnType<typeof createCounter>>(
      await verifyExtensionPackage(input, lookup),
      { importModule: importData },
    );
    const registration = installVerifiedExtension(new ExtensionRegistry(), loaded);
    const editor = new ArtifactEditor(
      createArtifact('example.counter', 'Counter', createCounter()),
      {
        kind: 'example.counter',
        validate: (v): v is ReturnType<typeof createCounter> => !!v,
        capabilities: { undo: true, nativeJson: true, formats: [], preview: 'none', shared: false },
      },
      { put: async () => {} },
    );
    expect(() =>
      registration.open(artifactEditorHost(editor, { schemaVersion: 2, allowed: () => true })),
    ).toThrow('kind/schema');
    const handle = registration.open(
      artifactEditorHost(editor, { schemaVersion: 1, allowed: () => true }),
    );
    handle.api.execute(setCounter(3));
    expect(editor.content.value).toBe(3);
    expect(() => handle.api.select(['counter'])).toThrow('Unsupported capability: selection');
    expect(() => handle.mount({} as HTMLElement)).toThrow('Unsupported capability: surface');
  });
});

describe('several Editors for one format', () => {
  it('switches A/B on one ArtifactEditor, keeping session and history; A changes never revoke B', async () => {
    const counterHash = `sha256:${'1'.repeat(64)}`;
    const registry = new ExtensionRegistry();
    let a = registry.install(counterExtension(counterHash), {
      trust: 'trusted',
      verifiedPackageHash: counterHash,
    });
    const input = altCounter();
    const { lookup } = await pinned(input);
    const b = installVerifiedExtension(
      registry,
      await loadVerifiedExtension<ReturnType<typeof createCounter>>(
        await verifyExtensionPackage(input, lookup),
        { importModule: importData },
      ),
    );
    const editor = new ArtifactEditor(
      createArtifact('example.counter', 'Counter', createCounter()),
      {
        kind: 'example.counter',
        validate: (v): v is ReturnType<typeof createCounter> => !!v,
        capabilities: { undo: true, nativeJson: true, formats: [], preview: 'none', shared: false },
      },
      { put: async () => {} },
    );
    const host = artifactEditorHost(editor, { schemaVersion: 1, allowed: () => true });
    const handleA = a.open(host);
    handleA.api.execute(setCounter(1));
    handleA.close();
    const handleB = b.open(host);
    expect(handleB.api.read().value).toBe(1);
    handleB.api.execute(setCounter(2));
    handleB.api.undo();
    expect(editor.content.value).toBe(1);
    // Replacing and uninstalling A leaves B's registration and handle live.
    const nextHash = `sha256:${'2'.repeat(64)}`;
    const next = counterExtension(nextHash);
    next.manifest.version = '0.0.2';
    a = registry.install(next, { trust: 'trusted', verifiedPackageHash: nextHash, replace: true });
    a.uninstall();
    handleB.api.redo();
    expect(handleB.api.read().value).toBe(2);
    handleB.api.undo();
    handleB.close();
    const reopenedA = registry.install(counterExtension(counterHash), {
      trust: 'trusted',
      verifiedPackageHash: counterHash,
    });
    const handleA2 = reopenedA.open(host);
    handleA2.api.redo();
    expect(editor.content.value).toBe(2);
    b.uninstall();
    expect(handleA2.api.read().value).toBe(2);
  });
});

describe('independent consumer', () => {
  it('builds against public exports only and cannot reach private runtime paths', async () => {
    const consumer = await build({
      stdin: {
        contents: `export * from '@editor-platform/extension-runtime/package';
export { artifactEditorHost } from '@editor-platform/extension-runtime/editor-host';
export { ExtensionRegistry } from '@editor-platform/extension-runtime';`,
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      platform: 'neutral',
      format: 'esm',
      logLevel: 'silent',
    });
    const api = await importData(consumer.outputFiles![0].contents);
    const input = checklist();
    const { lookup } = await pinned(input);
    const loaded = await api.loadVerifiedExtension(
      await api.verifyExtensionPackage(input, lookup),
      {
        importModule: importData,
      },
    );
    expect(api.installVerifiedExtension(new api.ExtensionRegistry(), loaded).manifest.id).toBe(
      'example.checklist-editor',
    );
    await expect(
      build({
        stdin: {
          contents: `export * from '@editor-platform/extension-runtime/src/package';`,
          resolveDir: process.cwd(),
        },
        bundle: true,
        write: false,
        logLevel: 'silent',
      }),
    ).rejects.toThrow();
  });
});
