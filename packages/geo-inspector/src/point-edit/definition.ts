import type {
  Context,
  DefinitionD2,
  LocalReadSnapshot,
} from '@editor-platform/extension-contract/draft2';
import type {
  ControlledSurfaceController,
  SurfaceOperation,
} from '@editor-platform/extension-contract/controlled-surface';
import { assertGeo, type Budgets, type GeoDocument } from '@editor-platform/geo-core';
import { preparePointEdit } from './model';
import {
  assertPointEditProfile,
  capturePointEditProfile,
  type GeoPointEditProfile,
} from './profile';
import { createGeoPointEditorSurface } from './surface';
export type PointControllerFactory = (
  context: Context<GeoDocument, never>,
) => ControlledSurfaceController<GeoDocument>;
/** Domain-specific entry. Host injects existing public createControlledSurfaceController; no new shared API. */
export function pointEditPort(
  context: Context<GeoDocument, never>,
  editor: ControlledSurfaceController<GeoDocument>,
  budgets: Budgets,
  checkCapacity?: (snapshot: LocalReadSnapshot<GeoDocument>, next: GeoDocument) => void,
  profile?: GeoPointEditProfile,
) {
  const editProfile = capturePointEditProfile(profile);
  const prepare = (snapshot: LocalReadSnapshot<GeoDocument>, draft: unknown) =>
    preparePointEdit(
      snapshot,
      draft,
      () => {
        if (context.addons.lifecycle.state !== 'granted') throw new Error('LifecycleUnavailable');
        context.addons.lifecycle.api.assertCurrent();
        const fresh = context.basic.read();
        return {
          revision: fresh.revision,
          canEdit:
            context.addons.edit.state === 'granted' && context.addons.inputs.state === 'granted',
          budgets,
        };
      },
      budgets,
      checkCapacity,
      editProfile,
    );
  const history = (direction: 'undo' | 'redo'): SurfaceOperation => {
    try {
      assertPointEditProfile(context.basic.read().content, editProfile, 'history');
      return editor[direction]();
    } catch (error) {
      return {
        state: 'refused',
        code: 'GeoHistoryRefused',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };
  return {
    undo: () => history('undo'),
    redo: () => history('redo'),
    prepare,
    execute(draft: unknown): SurfaceOperation {
      const view = editor.getSnapshot();
      if (view.state !== 'open')
        return { state: 'refused', code: 'ScopeRevoked', message: 'ScopeRevoked' };
      try {
        return editor.execute(prepare(view.snapshot, draft));
      } catch (error) {
        return {
          state: 'refused',
          code: 'GeoEditRefused',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
export function geoPointEditorDefinition(
  packageHash: string,
  budgets: Budgets,
  factory: PointControllerFactory,
  observe?: (value: {
    editor: ControlledSurfaceController<GeoDocument>;
    port: ReturnType<typeof pointEditPort>;
  }) => void,
  checkCapacity?: (snapshot: LocalReadSnapshot<GeoDocument>, next: GeoDocument) => void,
  profileForOpen?: (context: Context<GeoDocument, never>) => GeoPointEditProfile,
): DefinitionD2<GeoDocument, never> {
  if (typeof packageHash !== 'string' || !/^[a-f0-9]{64}$/.test(packageHash))
    throw new Error('GeoPackagePin');
  assertGeo({ schemaVersion: 1, layers: [], sources: [] }, budgets);
  const limits = Object.freeze({ ...budgets });
  return {
    manifest: {
      id: 'example.geo-point-editor',
      version: '0.0.0-experiment.1',
      packageHash,
      contractVersion: '1.0.0-draft.2',
      artifactKind: 'geo',
      schemaVersion: 1,
      surface: true,
      permissions: ['artifact:read', 'artifact:edit'],
      addons: {
        lifecycle: { version: 'lifecycle@0-draft', requirement: 'required' },
        edit: { version: 'local-edit@0-draft', requirement: 'optional' },
        inputs: { version: 'inputs@0-draft', requirement: 'optional' },
      },
      licenseNotices: [
        'Local experimental source-free Point editing; repository license scope unchanged.',
      ],
    },
    validate(value): value is GeoDocument {
      try {
        assertGeo(value, limits);
        return true;
      } catch {
        return false;
      }
    },
    mount(container, context) {
      if (context.addons.lifecycle.state !== 'granted') throw new Error('LifecycleUnavailable');
      const lifecycle = context.addons.lifecycle.api;
      let closed = false,
        surface: ReturnType<typeof createGeoPointEditorSurface> | undefined;
      const dispose = () => {
        if (closed) return;
        closed = true;
        surface?.dispose(lifecycle.signal.aborted);
      };
      lifecycle.registerDisposable('geo-point-editor-surface', dispose);
      lifecycle.signal.addEventListener('abort', dispose, { once: true });
      lifecycle.registerDisposable('geo-point-editor-abort-listener', () =>
        lifecycle.signal.removeEventListener('abort', dispose),
      );
      try {
        lifecycle.assertCurrent();
        const editor = factory(context);
        lifecycle.assertCurrent();
        if (closed) throw new Error('ScopeRevoked');
        const profile = capturePointEditProfile(profileForOpen?.(context));
        const port = pointEditPort(context, editor, limits, checkCapacity, profile);
        surface = createGeoPointEditorSurface(
          container.ownerDocument,
          editor,
          port.prepare,
          port,
          profile,
        );
        lifecycle.assertCurrent();
        if (closed) {
          surface.dispose();
          throw new Error('ScopeRevoked');
        }
        container.append(surface.element);
        lifecycle.assertCurrent();
        observe?.({ editor, port });
        lifecycle.assertCurrent();
      } catch (error) {
        dispose();
        throw error;
      }
    },
  };
}
