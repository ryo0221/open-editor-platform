import { EditorSession, EditorInputs } from '@editor-platform/editor-core';
import { ReferenceRegistry, type Binding } from '@editor-platform/extension-runtime/draft2';
import { ManualClock } from '@editor-platform/extension-runtime/reference';
import { createControlledSurfaceController } from '@editor-platform/extension-runtime/controlled';
import type { GeoDocument } from '@editor-platform/geo-core';
import type { Grant } from '@editor-platform/extension-contract/draft2';
import { geoPointEditorDefinition, pointEditPort } from '../src/point-edit/definition';
import { pointFixture } from './point-fixture';
import { fixture, budgets, packageHash } from './fixture';
import type { GeoPointEditProfile } from '../src/point-edit/profile';
export type EditMode = 'editable' | 'readonly' | 'no-inputs' | 'source';
export function editFixture(): GeoDocument {
  const content = pointFixture();
  const layer = content.layers[0];
  layer.fields = [
    { id: 'metric', name: 'Metric', type: 'number' },
    ...layer.fields,
    { id: 'active', name: 'Active', type: 'boolean' },
  ];
  for (const feature of layer.features)
    feature.values = { metric: 10, ...feature.values, active: true };
  return content;
}
/** Package-local functional harness, not a new independent/installed product Host or storage backend. */
export function editHarness(
  mode: EditMode = 'editable',
  container?: HTMLElement,
  options: { content?: GeoDocument; profile?: GeoPointEditProfile } = {},
) {
  const content = options.content ?? (mode === 'source' ? fixture() : editFixture()),
    clock = new ManualClock(),
    registry = new ReferenceRegistry(clock),
    errors: unknown[] = [];
  let grants = new Set<Grant>(
    mode === 'readonly' ? ['artifact:read'] : ['artifact:read', 'artifact:edit'],
  );
  const listeners = new Set<() => void>();
  const binding: Binding<GeoDocument, never> = {
    artifactId: 'synthetic-edit',
    artifactKind: 'geo',
    schemaVersion: 1,
    session: new EditorSession(content),
    inputs: new EditorInputs(),
    allowed: (g) => grants.has(g),
    subscribePermissions: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    ...(mode === 'no-inputs'
      ? {}
      : {
          recovery: {
            codecs: [],
            perBoundaryBytes: 2048,
            totalBytes: 8192,
            ttlMs: 1000,
            onRevoke: 'discard' as const,
          },
        }),
  };
  const factory = (context: Parameters<typeof pointEditPort>[0]) =>
    createControlledSurfaceController(context, { onError: (error) => errors.push(error) });
  let mounted:
    | { editor: ReturnType<typeof factory>; port: ReturnType<typeof pointEditPort> }
    | undefined;
  const definition = geoPointEditorDefinition(
    packageHash,
    budgets,
    factory,
    (value) => {
      mounted = value;
    },
    undefined,
    options.profile ? () => options.profile! : undefined,
  );
  const installed = registry.install(definition, {
    trust: 'trusted',
    verifiedPin: definition.manifest,
  });
  const opened = installed.open(binding);
  if (opened.state !== 'opened') throw new Error(opened.code);
  const handle = opened.handle;
  if (container) handle.mount(container);
  const editor = mounted?.editor ?? factory(handle.context),
    port =
      mounted?.port ?? pointEditPort(handle.context, editor, budgets, undefined, options.profile);
  return {
    definition,
    binding,
    handle,
    editor,
    port,
    errors,
    clock,
    revoke() {
      grants = new Set(['artifact:read']);
      for (const fn of [...listeners]) fn();
    },
    close() {
      handle.revoke('host-close');
    },
    drain() {
      return handle.drain({ deadlineMs: clock.now() });
    },
  };
}
