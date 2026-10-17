import { commitVersion, createArtifact } from '@editor-platform/artifact-core';
import { migratePrototypeDraftToV1, SCHEMA, EVALUATOR_V1 } from '@editor-platform/animation-core';
import { ReferenceRegistry } from '@editor-platform/extension-runtime/draft2';
import { ManualClock, referenceBinding } from '@editor-platform/extension-runtime/reference';
import {
  rectangleViewerExtension,
  rectanglePrototypeFixture,
  type ViewerMount,
} from '@editor-platform/extension-sample/animation-viewer';
// Injected only after offline install and byte inventory verification by the local kit.
declare const PACKAGED_SAMPLE_HASH: string;
declare const PACKAGING_NOTICE: string;
const retained = await commitVersion(
  createArtifact('animation', 'Original', rectanglePrototypeFixture()),
  null,
  'Retained',
);
const migrated = await migratePrototypeDraftToV1(
  retained.draft,
  retained.versions[0].contentHash,
  '2026-10-12T00:00:00.000Z',
);
let mount: ViewerMount | undefined;
const definition = rectangleViewerExtension(
  PACKAGED_SAMPLE_HASH,
  {
    artifactId: retained.id,
    compositionId: 'root',
    baseVersionId: retained.draft.baseVersionId!,
    sourceContentHash: migrated.sourceContentHash,
    targetContentHash: migrated.targetContentHash,
    sourceSchema: SCHEMA,
    schemaVersion: 1,
    ticksPerSecond: 240000,
    evaluatorVersion: EVALUATOR_V1,
    playerVersion: 'animation-rectangle-player-1',
  },
  {
    observe: (value) => {
      mount = value;
    },
  },
);
const binding = referenceBinding(migrated.draft.content, retained.id);
binding.artifactKind = 'animation';
binding.setGrants(['artifact:read']);
const registry = new ReferenceRegistry(new ManualClock());
const opened = registry
  .install(definition, { trust: 'trusted', verifiedPin: definition.manifest })
  .open({ ...binding, resources: undefined });
if (opened.state !== 'opened') throw new Error(opened.code);
const surface = document.querySelector<HTMLElement>('#surface')!;
opened.handle.mount(surface);
if (!mount) throw new Error('Viewer did not mount');
await mount.ready;
document.querySelector('#status')!.textContent = 'Ready';
document.querySelector('#notice')!.textContent =
  PACKAGING_NOTICE + '\n' + definition.manifest.licenseNotices.join('\n');
document.querySelector('#hash')!.textContent = PACKAGED_SAMPLE_HASH;
document.querySelector('#revoke')!.addEventListener('click', () => {
  opened.handle.revoke('host-close');
  document.querySelector('#status')!.textContent = 'Revoked';
});
