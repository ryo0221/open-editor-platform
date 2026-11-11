// Independent Node Host: public tarball entrypoints only; no repository tooling.
import assert from 'node:assert/strict';
import { readFile, rename } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import { TextEncoder } from 'node:util';
import { commitVersion, createArtifact } from '@editor-platform/artifact-core';
import { ReferenceRegistry, TOKEN } from '@editor-platform/extension-runtime/draft2';
import { ManualClock, referenceBinding } from '@editor-platform/extension-runtime/reference';
import {
  migratePrototypeDraftToV1,
  SCHEMA,
  TICKS_PER_SECOND_V1,
  EVALUATOR_V1,
} from '@editor-platform/animation-core';
import { RECTANGLE_PLAYER_CONTRACT_V1 } from '@editor-platform/animation-player/v1';
import {
  rectanglePrototypeFixture,
  rectangleViewerExtension,
} from '@editor-platform/extension-sample/animation-viewer';
const evidence = JSON.parse(await readFile(new URL('./provenance.json', import.meta.url)));
assert.equal(TOKEN, evidence.runtime);
const sample = evidence.packages.find((p) => p.name === '@editor-platform/extension-sample');
const retained = await commitVersion(
  createArtifact('animation', 'Original', rectanglePrototypeFixture()),
  null,
  'Retained original',
);
const migration = await migratePrototypeDraftToV1(
  retained.draft,
  retained.versions[0].contentHash,
  '2026-10-12T00:00:00.000Z',
);
const provenance = {
  artifactId: retained.id,
  compositionId: 'root',
  baseVersionId: retained.draft.baseVersionId,
  sourceContentHash: migration.sourceContentHash,
  targetContentHash: migration.targetContentHash,
  sourceSchema: SCHEMA,
  schemaVersion: 1,
  ticksPerSecond: TICKS_PER_SECOND_V1,
  evaluatorVersion: EVALUATOR_V1,
  playerVersion: RECTANGLE_PLAYER_CONTRACT_V1,
};
const definition = rectangleViewerExtension(sample.sha256, provenance);
// Trusted fixture-specific least-privilege admission; not a new generic contract rule.
function reviewedManifest(value) {
  assert.deepEqual(value.permissions, ['artifact:read'], 'reviewed read-only permissions');
  assert.deepEqual(
    value.addons,
    { lifecycle: { version: 'lifecycle@0-draft', requirement: 'required' } },
    'reviewed capabilities',
  );
}
reviewedManifest(definition.manifest);
const registry = () => new ReferenceRegistry(new ManualClock());
const admission = {
  trust: 'trusted',
  verifiedPin: {
    id: definition.manifest.id,
    version: definition.manifest.version,
    packageHash: sample.sha256,
  },
};
const binding = () => {
  const value = referenceBinding(migration.draft.content, retained.id);
  value.artifactKind = 'animation';
  value.setGrants(['artifact:read']);
  return value;
};
const installed = registry().install(definition, admission);
const opened = installed.open(binding());
assert.equal(opened.state, 'opened');
assert.equal(opened.handle.context.basic.read().content.schemaVersion, 1);
for (const addon of ['edit', 'inputs', 'save', 'resources'])
  assert.equal(opened.handle.context.addons[addon].state, 'unavailable');
opened.handle.revoke('host-close');
assert.throws(() => opened.handle.context.basic.read(), /ScopeRevoked/);
assert.throws(() => registry().install(definition, { ...admission, trust: 'untrusted' }), /trust/);
assert.throws(
  () =>
    registry().install(definition, {
      ...admission,
      verifiedPin: { ...admission.verifiedPin, packageHash: '0'.repeat(64) },
    }),
  /pin/,
);
assert.throws(
  () =>
    registry().install(
      { ...definition, manifest: { ...definition.manifest, contractVersion: 'unknown' } },
      admission,
    ),
  /contract/,
);
assert.throws(
  () =>
    registry().install(
      { ...definition, manifest: { ...definition.manifest, permissions: ['artifact:admin'] } },
      admission,
    ),
  /manifest/,
);
assert.throws(
  () =>
    reviewedManifest({ ...definition.manifest, permissions: ['artifact:read', 'artifact:edit'] }),
  /permissions/,
);
assert.throws(
  () => rectangleViewerExtension(sample.sha256, { ...provenance, playerVersion: 'unknown' }),
  /ViewerContractPin/,
);
const unknownSchema = binding();
unknownSchema.schemaVersion = 999;
assert.deepEqual(installed.open(unknownSchema), { state: 'refused', code: 'schema' });
const noRead = binding();
noRead.setGrants([]);
assert.deepEqual(installed.open(noRead), { state: 'refused', code: 'grant' });
const unknownAddon = {
  ...definition,
  manifest: {
    ...definition.manifest,
    addons: { lifecycle: { version: 'unknown', requirement: 'required' } },
  },
};
assert.deepEqual(registry().install(unknownAddon, admission).open(binding()), {
  state: 'refused',
  code: 'required-addon',
  addon: 'lifecycle',
});
const missingPermission = {
  ...definition,
  manifest: {
    ...definition.manifest,
    addons: {
      ...definition.manifest.addons,
      edit: { version: 'local-edit@0-draft', requirement: 'required' },
    },
  },
};
assert.deepEqual(registry().install(missingPermission, admission).open(binding()), {
  state: 'refused',
  code: 'required-addon',
  addon: 'edit',
});
for (const pkg of evidence.packages) {
  for (const entry of Object.keys(pkg.exports).filter((key) => !key.endsWith('.css')))
    await import(pkg.name + (entry === '.' ? '' : entry.slice(1)));
  await assert.rejects(import(pkg.name + '/src/index.ts'), {
    code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  });
  const notice = await readFile(
    new URL('./node_modules/' + pkg.name + '/NOTICE.txt', import.meta.url),
    'utf8',
  );
  assert.match(notice, /No distribution permission or license exception/);
  console.log(
    'IMPORTED',
    pkg.name,
    JSON.stringify(Object.keys(pkg.exports)),
    'sha256=' + pkg.sha256,
  );
}
if (evidence.profile !== 'baseline') {
  const { defaultGeoBackgroundSettings, resolveGeoBackgrounds } = await import(
    '@editor-platform/geo-core/backgrounds'
  );
  const resolved = resolveGeoBackgrounds(
    defaultGeoBackgroundSettings().map((setting) => ({ ...setting, enabled: true })),
  );
  assert.deepEqual(resolved.diagnostics, []);
  assert.deepEqual(
    resolved.layers.map((layer) => layer.geometries.length),
    [177, 4596, 1742],
  );
  const notice = await readFile(
    new URL('./node_modules/@editor-platform/geo-core/BOUNDARY-DATA-NOTICE.md', import.meta.url),
    'utf8',
  );
  assert.match(notice, /CC BY-SA 2\.0/);
  assert.match(notice, /OpenStreetMap, Wambacher/);
  console.log(
    'PASS: installed offline boundary export, all three exact datasets and retained data terms',
  );
}
// Resolution fails without a packed dependency; no ancestor workspace may rescue it.
const dependency = new URL('./node_modules/@editor-platform/editor-core', import.meta.url);
const hidden = new URL('./node_modules/@editor-platform/editor-core.hidden', import.meta.url);
await rename(dependency, hidden);
try {
  const missing = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "import '@editor-platform/extension-sample/animation-viewer'"],
    {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: '' },
    },
  );
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /ERR_MODULE_NOT_FOUND/);
  assert.match(missing.stderr, /@editor-platform\/editor-core/);
} finally {
  await rename(hidden, dependency);
}
// #500 E1: verified-package loader and ArtifactEditor binding from installed public entrypoints.
{
  const { CONTRACT_VERSION } = await import('@editor-platform/extension-contract');
  const { ExtensionRegistry } = await import('@editor-platform/extension-runtime');
  const pkgApi = await import('@editor-platform/extension-runtime/package');
  const { artifactEditorHost } = await import('@editor-platform/extension-runtime/editor-host');
  const { ArtifactEditor } = await import('@editor-platform/editor-host');
  const { command } = await import('@editor-platform/editor-core');
  const manifest = {
    contractVersion: CONTRACT_VERSION,
    id: 'kit.checklist-editor',
    version: '1.0.0',
    artifactKind: 'kit.checklist',
    schemaVersion: 1,
    capabilities: ['local-edit', 'persistence'],
    permissions: ['artifact:read', 'artifact:write'],
    licenseNotices: ['Kit fixture; no license grant.'],
  };
  const entry = `const manifest = ${JSON.stringify(manifest)};
export function definition(packageHash) {
  return { manifest: { ...manifest, packageHash }, validate: (v) => !!v && Array.isArray(v.items) };
}`;
  const input = () => ({
    manifest: JSON.parse(JSON.stringify(manifest)),
    entry: 'entry.js',
    files: [{ path: 'entry.js', bytes: new TextEncoder().encode(entry) }],
  });
  const importModule = (bytes) =>
    import(`data:text/javascript;base64,${Buffer.from(bytes).toString('base64')}`);
  const pin = (await pkgApi.describeExtensionPackage(input())).hash;
  const lookup = (id, version) =>
    id === manifest.id && version === manifest.version ? pin : undefined;
  const loaded = await pkgApi.loadVerifiedExtension(
    await pkgApi.verifyExtensionPackage(input(), lookup),
    { importModule },
  );
  // #500 E2: retained exact bytes reopen through the Host pin only; nothing else is trusted.
  const store = await import('@editor-platform/extension-runtime/package-store');
  const memory = store.createMemoryPackageStorage();
  assert.equal(
    await store.retainVerifiedPackage(memory, await pkgApi.verifyExtensionPackage(input(), lookup)),
    'retained',
  );
  const restored = await store.restoreRetainedPackage(
    memory,
    manifest.id,
    manifest.version,
    lookup,
  );
  assert.equal(restored.manifest.packageHash, pin);
  memory.active.get(`${manifest.id}@${manifest.version}`).files[0].bytes[0] ^= 1;
  await assert.rejects(
    store.restoreRetainedPackage(memory, manifest.id, manifest.version, lookup),
    { code: 'corrupt' },
  );
  await assert.rejects(
    store.removeRetainedPackage(memory, manifest.id, manifest.version, () => []),
    { code: 'corrupt' },
  );
  assert.equal(
    await store.repairRetainedPackage(memory, await pkgApi.verifyExtensionPackage(input(), lookup)),
    'repaired',
  );
  await store.restoreRetainedPackage(memory, manifest.id, manifest.version, lookup);
  const kept = store.createMemoryPackageStorage();
  await store.retainVerifiedPackage(kept, await pkgApi.verifyExtensionPackage(input(), lookup));
  await assert.rejects(
    store.removeRetainedPackage(kept, manifest.id, manifest.version, () => ['saved version']),
    { code: 'referenced', holders: ['saved version'] },
  );
  const registration = pkgApi.installVerifiedExtension(new ExtensionRegistry(), loaded);
  const saved = [];
  const editor = new ArtifactEditor(
    createArtifact('kit.checklist', 'Kit list', { items: [] }),
    {
      kind: 'kit.checklist',
      validate: (v) => !!v && Array.isArray(v.items),
      capabilities: { undo: true, nativeJson: true, formats: [], preview: 'none', shared: false },
    },
    { put: async (a) => void saved.push(a) },
  );
  const handle = registration.open(
    artifactEditorHost(editor, { schemaVersion: 1, allowed: () => true }),
  );
  handle.api.execute(command('kit.add', 'Add', (c) => ({ items: [...c.items, 'a'] })));
  handle.api.execute(command('kit.add', 'Add', (c) => ({ items: [...c.items, 'b'] })));
  handle.api.undo();
  await handle.api.save();
  assert.deepEqual(saved.at(-1).draft.content.items, ['a']);
  registration.uninstall();
  assert.throws(() => handle.api.read(), /revoked/);
  // Uninstalling the Editor keeps its retained bytes; removing them is a separate Host step.
  await store.restoreRetainedPackage(kept, manifest.id, manifest.version, lookup);
  assert.equal(
    await store.removeRetainedPackage(kept, manifest.id, manifest.version, () => []),
    'removed',
  );
  assert.equal(await kept.removed(manifest.id, manifest.version), pin);
  const tampered = input();
  tampered.files[0].bytes[0] ^= 1;
  await assert.rejects(pkgApi.verifyExtensionPackage(tampered, lookup), /Untrusted/);
  await assert.rejects(
    pkgApi.verifyExtensionPackage(input(), () => undefined),
    /Untrusted/,
  );
  for (const name of ['/src/package.ts', '/src/editor-host.ts'])
    await assert.rejects(import('@editor-platform/extension-runtime' + name), {
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    });
  console.log(
    'PASS: installed /package + /package-store + /editor-host verify/retain/restore/repair/load/install/edit/undo/save/revoke/remove; tampered, corrupt retained, referenced removal, unpinned and private paths refused',
  );
}
console.log('LICENSE NOTICE:', evidence.notice.trim());
console.log('MANIFEST NOTICES:', JSON.stringify(definition.manifest.licenseNotices));
console.log(
  'PASS: public imports, actual migration/read/revoke, private-path/permission/schema/runtime/hash/trust/missing-dependency rejection',
);
console.log(
  'NOT RUN: DOM mount/render, editable sample acceptance, production Host, sandbox, performance, legal eligibility',
);
console.log('HOST:', fileURLToPath(new URL('.', import.meta.url)));
