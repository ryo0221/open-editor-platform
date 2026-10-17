// Independent Node Host: public tarball entrypoints only; no repository tooling.
import assert from 'node:assert/strict';
import { readFile, rename } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';
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
console.log('LICENSE NOTICE:', evidence.notice.trim());
console.log('MANIFEST NOTICES:', JSON.stringify(definition.manifest.licenseNotices));
console.log(
  'PASS: public imports, actual migration/read/revoke, private-path/permission/schema/runtime/hash/trust/missing-dependency rejection',
);
console.log(
  'NOT RUN: DOM mount/render, editable sample acceptance, production Host, sandbox, performance, legal eligibility',
);
console.log('HOST:', fileURLToPath(new URL('.', import.meta.url)));
