/** Adapts the ordinary Playground session/Inputs; creates no second history. */
import {
  sameLocalRevision,
  type EditorInputs,
  type EditorSession,
  type EditorCommand,
} from '@editor-platform/editor-core';
import type { GeoDocument } from '@editor-platform/geo-core';
import {
  CONTROLLED_SURFACE_VERSION,
  type ControlledSurfaceController,
  type AtomicSurfaceInputs,
  type PreparedSurfaceCommand,
  type SurfaceOperation,
} from '@editor-platform/extension-contract/controlled-surface';
import type { LocalReadSnapshot } from '@editor-platform/extension-contract/draft2';
export function geoController(options: {
  id: string;
  session: EditorSession<GeoDocument>;
  inputs: EditorInputs;
  canEdit(): boolean;
  execute(command: EditorCommand<GeoDocument>): boolean;
  history(direction: 'undo' | 'redo'): void;
  save(): Promise<void>;
}) {
  const abort = new AbortController(),
    listeners = new Set<() => void>();
  const generation = crypto.randomUUID();
  let group: AtomicSurfaceInputs<GeoDocument> | undefined,
    epoch = 0;
  const snapshot = (): LocalReadSnapshot<GeoDocument> => ({
    scope: { artifactId: options.id, sessionId: options.session.revision.sessionId, generation },
    revision: options.session.revision,
    content: options.session.content,
  });
  const assert = () => {
    if (abort.signal.aborted || !options.canEdit()) throw Error('GeoAuthorityChanged');
  };
  const notify = () => {
    epoch++;
    for (const l of listeners) l();
  };
  const operation = (work: () => void): SurfaceOperation => {
    try {
      assert();
      work();
      notify();
      return { state: 'applied' };
    } catch (e) {
      return {
        state: 'refused',
        code: 'GeoOperationRefused',
        message: String(e instanceof Error ? e.message : e),
      };
    }
  };
  const apply = (prepared: PreparedSurfaceCommand<GeoDocument>) => {
    assert();
    if (!sameLocalRevision(prepared.baseRevision, options.session.revision))
      throw Error('GeoStaleInput');
    if (prepared.command && !options.execute(prepared.command)) throw Error('Geo command refused');
  };
  const controller: ControlledSurfaceController<GeoDocument> = {
    version: CONTROLLED_SURFACE_VERSION,
    getSnapshot: () =>
      abort.signal.aborted
        ? { state: 'revoked', code: 'ScopeRevoked' }
        : {
            state: 'open',
            snapshot: snapshot(),
            canEdit: options.canEdit(),
            canSave: options.canEdit(),
            saving: false,
          },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    execute: (prepared) =>
      operation(() => {
        if (group?.read().dirty || group?.read().composing)
          throw Error('Apply or Cancel pending input');
        apply(prepared);
      }),
    applyInputs: () =>
      operation(() => {
        if (group?.read().composing) throw Error('Finish composition');
        if (group) {
          const prepared = group.prepare(snapshot());
          apply(prepared);
          group.committed(snapshot());
          options.inputs.changed();
        }
      }),
    undo: () =>
      operation(() => {
        options.inputs.flush();
        options.history('undo');
      }),
    redo: () =>
      operation(() => {
        options.inputs.flush();
        options.history('redo');
      }),
    async save() {
      assert();
      options.inputs.flush();
      return {
        state: 'refused',
        code: 'UseHostSave',
        message: 'Use the Playground version list for the saved native version',
      };
    },
    bindInputs(value) {
      if (group) throw Error('Geo input group already bound');
      group = value;
      const unregister = options.inputs.register({
        label: value.label,
        read: value.read,
        focus: value.focus,
        prepare() {
          assert();
          const prepared = value.prepare(snapshot());
          return () => {
            apply(prepared);
            value.committed(snapshot());
            notify();
          };
        },
      });
      return {
        changed() {
          epoch++;
          options.inputs.changed();
        },
        unregister() {
          group = undefined;
          unregister();
        },
      };
    },
  };
  return {
    controller,
    snapshot,
    signal: abort.signal,
    notify,
    inputChanged() {
      epoch++;
    },
    stamp() {
      assert();
      const pending = options.inputs.getSnapshot();
      if (pending.dirty || pending.composing) throw Error('GeoPendingInputs');
      return JSON.stringify([generation, options.session.revision, epoch]);
    },
    dispose() {
      abort.abort();
      notify();
      listeners.clear();
    },
  };
}
