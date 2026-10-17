/** Test-only preparation: existing runtime/storage/controller, no new product Save capability. */
import { assertGeo, parseGeo, type GeoDocument } from '@editor-platform/geo-core';
import { contentHash } from '@editor-platform/artifact-core';
import { ReferenceRegistry } from '@editor-platform/extension-runtime/draft2';
import {
  FakeStorage,
  ManualClock,
  referenceBinding,
} from '@editor-platform/extension-runtime/reference';
import { createControlledSurfaceController } from '@editor-platform/extension-runtime/controlled';
import type { DefinitionD2 } from '@editor-platform/extension-contract/draft2';
import { editFixture } from './edit-fixture';
import { budgets, packageHash } from './fixture';
import { geoPointEditorDefinition, pointEditPort } from '../src/point-edit/definition';
import { assertSourceFree } from '../src/point-edit/model';
export { budgets } from './fixture';
export function saveFixture(): GeoDocument {
  const value = editFixture();
  value.layers[0].features[1].values.metric = null;
  value.layers[0].features[2].values.active = false;
  return value;
}
export function assertTrialProfile(value: unknown): asserts value is GeoDocument {
  assertGeo(value, budgets);
  assertSourceFree(value);
}
/** Preparation assertion, not a durable file/envelope format or new shared API. */
export async function checkedReopen(text: string, expectedContentHash: string) {
  const value = parseGeo(text, budgets);
  assertTrialProfile(value);
  if ((await contentHash(value)) !== expectedContentHash) throw new Error('CaptureHashMismatch');
  return value;
}
export function saveHarness(content = saveFixture()) {
  assertTrialProfile(content);
  const clock = new ManualClock(),
    registry = new ReferenceRegistry(clock);
  const binding = referenceBinding(content, 'synthetic-save');
  binding.artifactKind = 'geo';
  binding.setGrants(['artifact:read', 'artifact:edit', 'artifact:save']);
  binding.recovery = {
    codecs: [],
    perBoundaryBytes: 2048,
    totalBytes: 8192,
    ttlMs: 1000,
    onRevoke: 'discard',
  };
  const storage = new FakeStorage<GeoDocument>(binding.artifactId);
  binding.storage = storage;
  const errors: unknown[] = [];
  const base = geoPointEditorDefinition(packageHash, budgets, (context) =>
    createControlledSurfaceController(context, { onError: (error) => errors.push(error) }),
  );
  const definition: DefinitionD2<GeoDocument, string> = {
    manifest: {
      ...base.manifest,
      id: 'test.geo-save-preparation',
      surface: false,
      permissions: ['artifact:read', 'artifact:edit', 'artifact:save'],
      addons: {
        ...base.manifest.addons,
        save: { version: 'local-persistence@0-draft', requirement: 'required' },
      },
    },
    validate(value): value is GeoDocument {
      try {
        assertTrialProfile(value);
        return true;
      } catch {
        return false;
      }
    },
  };
  const installed = registry.install(definition, {
    trust: 'trusted',
    verifiedPin: definition.manifest,
  });
  const opened = installed.open(binding);
  if (opened.state !== 'opened') throw new Error(opened.code);
  const handle = opened.handle;
  const editor = createControlledSurfaceController(handle.context, {
    onError: (e) => errors.push(e),
  });
  // Resource-less context: reference binding's generic Ref is string, no resource slot is granted.
  const resources = handle.context.addons.resources;
  if (resources.state === 'granted') throw new Error('UnexpectedResources');
  const port = pointEditPort(
    {
      ...handle.context,
      addons: {
        ...handle.context.addons,
        resources,
      },
    },
    editor,
    budgets,
  );
  const slot = handle.context.addons.save;
  if (slot.state !== 'granted') throw new Error('SaveNotGranted');
  return { binding, storage, clock, registry, handle, editor, port, errors, save: slot.api };
}
