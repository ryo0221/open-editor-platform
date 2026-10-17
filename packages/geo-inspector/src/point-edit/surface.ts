import {
  assertPointEditProfile,
  capturePointEditProfile,
  type GeoPointEditProfile,
} from './profile';
import type {
  ControlledSurfaceController,
  SurfaceOperation,
} from '@editor-platform/extension-contract/controlled-surface';
import type { GeoDocument } from '@editor-platform/geo-core';
import { createPointMap, preparePointScene } from '../point-map';
import { PointInputBuffer, type PreparePoint } from './buffer';
import { editablePoint, type PointTarget } from './model';
import { POINT_INPUT_LIMITS } from './draft-boundary';
import { createFeatureTable } from '../feature-table';
/** Domain controlled Surface: no session, history, storage or external effects. */
export function createGeoPointEditorSurface(
  doc: Document,
  editor: ControlledSurfaceController<GeoDocument>,
  prepare: PreparePoint,
  history: { undo(): SurfaceOperation; redo(): SurfaceOperation },
  profile?: GeoPointEditProfile,
) {
  const editProfile = capturePointEditProfile(profile);
  const root = doc.createElement('section');
  root.className = 'geo-point-editor';
  root.setAttribute('aria-label', 'Geo Point editor');
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const n = doc.createElement(tag);
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const style = node(
    'style',
    `.geo-point-editor{font:15px/1.5 system-ui,sans-serif;background:#fff;color:#173247;border:1px solid #aac0cf;border-radius:8px;padding:16px;overflow-wrap:anywhere}.geo-point-editor *{box-sizing:border-box;max-width:100%;min-width:0}.geo-point-editor button,.geo-point-editor input,.geo-point-editor select{font:inherit;padding:8px;margin:4px;border:1px solid #66879a;border-radius:4px}.geo-point-editor button{cursor:pointer;background:#edf5fa}.geo-point-editor button[aria-pressed=true]{background:#fbe0bd;border-color:#874700}.geo-point-editor :focus-visible{outline:3px solid #195f99;outline-offset:2px}.geo-point-editor label{display:block;margin-top:8px}.geo-point-editor input:not([type=checkbox]){display:block;width:100%}.geo-point-editor svg{display:block;width:100%;height:auto;max-height:320px}.geo-point-editor circle{fill:#176a93;stroke:#fff;stroke-width:3}.geo-point-editor [aria-pressed=true] circle{fill:#ad4c00;stroke:#351a00;stroke-width:4}.geo-point-editor [role=button]:focus circle{stroke:#000;stroke-width:5}.geo-point-editor [role=button]{cursor:pointer}.geo-point-editor fieldset{margin:12px 0;border:1px solid #aac0cf}.geo-point-editor button:disabled{opacity:.5;cursor:default}`,
  );
  const initialView = editor.getSnapshot();
  const capability =
    initialView.state === 'open' && initialView.canSave ? '' : ' No Save capability.';
  const message = node(
    'p',
    editProfile
      ? 'Choose a Point; editing requires Host-verified retained sources. Save is Host-owned.'
      : 'Choose a Point; editing is local and source-free.' + capability,
  );
  message.setAttribute('role', 'status');
  message.setAttribute('aria-label', 'Geo edit status');
  const toolbar = node('div'),
    form = node('div'),
    mapsHost = node('div');
  root.append(
    style,
    node('h2', 'Geo Point editor · experiment'),
    node(
      'p',
      `Trial input limits: numbers ${POINT_INPUT_LIMITS.numericCodeUnits} UTF-16 units; scalar ${POINT_INPUT_LIMITS.scalarCodeUnits}; whole draft ${POINT_INPUT_LIMITS.jsonUtf8Bytes} UTF-8 JSON bytes. Oversize input is refused, not truncated.`,
    ),
    message,
    toolbar,
    form,
    mapsHost,
  );
  let closed = false,
    generation = 0;
  const tables: ReturnType<typeof createFeatureTable>[] = [];
  const selections: { layerId: string; update(featureId: string | null): void }[] = [];
  const formStops: (() => void)[] = [],
    maps: ReturnType<typeof createPointMap>[] = [];
  const buffer = new PointInputBuffer(prepare, () => form.querySelector('input')?.focus());
  const binding = editor.bindInputs(buffer);
  const tell = (error: unknown) => {
    message.textContent = error instanceof Error ? error.message : String(error);
  };
  const open = () => {
    const v = editor.getSnapshot();
    if (closed || v.state !== 'open') throw new Error('ScopeRevoked');
    return v;
  };
  const pending = () => {
    const r = buffer.read();
    return r.dirty || r.composing;
  };
  const action = (work: () => void | SurfaceOperation) => {
    try {
      const result = work();
      if (result)
        message.textContent =
          result.state === 'refused' ? `${result.code}: ${result.message}` : result.state;
    } catch (error) {
      tell(error);
    }
    updateButtons();
  };
  const button = (text: string, work: () => void | SurfaceOperation) => {
    const b = node('button', text);
    b.type = 'button';
    b.onclick = () => {
      if (!closed) action(work);
    };
    return b;
  };
  const apply = button('Apply', () => editor.applyInputs());
  const cancel = button('Cancel', () => {
    const view = open();
    buffer.cancel(view.snapshot);
    binding.changed();
    renderForm();
    message.textContent = 'Cancelled. Native unchanged.';
  });
  const undo = button('Undo', () => history.undo()),
    redo = button('Redo', () => history.redo());
  toolbar.append(apply, cancel, undo, redo);
  const updateButtons = () => {
    const v = editor.getSnapshot();
    let profile = true;
    try {
      if (v.state === 'open') assertPointEditProfile(v.snapshot.content, editProfile);
    } catch {
      profile = false;
    }
    const allowed = !closed && v.state === 'open' && v.canEdit && profile;
    apply.disabled = !allowed || !pending() || buffer.read().composing;
    cancel.disabled = !pending() || buffer.read().composing;
    undo.disabled = !allowed || pending();
    redo.disabled = !allowed || pending();
  };
  const choose = (target: PointTarget) => {
    const view = open();
    buffer.select(view.snapshot, target);
    renderForm();
    for (const selection of selections)
      selection.update(selection.layerId === target.layerId ? target.featureId : null);
    message.textContent = `Selected ${target.layerId}/${target.featureId}; field ${target.fieldId}.`;
  };
  function renderForm() {
    for (const stop of formStops.splice(0)) stop();
    generation++;
    form.replaceChildren();
    const token = generation;
    const view = open(),
      draft = buffer.draft();
    if (!draft) {
      form.append(node('p', 'No field/feature selected.'));
      return;
    }
    let reason = '';
    try {
      editablePoint(view.snapshot.content, draft.target, editProfile);
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    if (!view.canEdit) reason = 'Read-only: edit and Inputs capabilities are required.';
    const target = node('p', `Target ${draft.target.layerId}/${draft.target.featureId}`);
    form.append(target);
    if (reason) form.append(node('p', reason));
    const fields = view.snapshot.content.layers.find((l) => l.id === draft.target.layerId)!.fields;
    const selector = node('select');
    selector.setAttribute('aria-label', 'Scalar field');
    for (const f of fields) {
      const o = node('option', `${f.name} (${f.type})`);
      o.value = f.id;
      selector.append(o);
    }
    selector.value = draft.target.fieldId;
    selector.disabled = !!reason;
    selector.onchange = () => {
      if (closed || token !== generation) return;
      const hadFocus = doc.activeElement === selector;
      action(() => choose({ ...draft.target, fieldId: selector.value }));
      if (hadFocus) form.querySelector('select')?.focus({ preventScroll: true });
      selector.value = buffer.draft()!.target.fieldId;
    };
    form.append(selector);
    formStops.push(() => {
      selector.onchange = null;
    });
    const fieldset = node('fieldset');
    fieldset.disabled = !!reason;
    fieldset.append(node('legend', 'Apply coordinates and one scalar together'));
    form.append(fieldset);
    for (const key of ['longitude', 'latitude', 'scalar'] as const) {
      const label = node(
          'label',
          key === 'scalar' ? 'Scalar value' : key === 'longitude' ? 'Longitude' : 'Latitude',
        ),
        input = node('input');
      input.type = 'text';
      input.value = draft[key];
      if (key !== 'scalar') input.inputMode = 'decimal';
      label.append(input);
      fieldset.append(label);
      const valid = () => !closed && token === generation;
      const changed = () => {
        if (!valid()) return;
        action(() => {
          buffer.change({ [key]: input.value });
          binding.changed();
        });
      };
      const start = () => {
        if (!valid()) return;
        action(() => {
          buffer.composition(key, true);
          binding.changed();
        });
      };
      const end = () => {
        if (!valid()) return;
        action(() => {
          buffer.change({ [key]: input.value });
          buffer.composition(key, false);
          binding.changed();
        });
      };
      input.addEventListener('input', changed);
      input.addEventListener('compositionstart', start);
      input.addEventListener('compositionend', end);
      formStops.push(() => {
        input.removeEventListener('input', changed);
        input.removeEventListener('compositionstart', start);
        input.removeEventListener('compositionend', end);
      });
    }
    const label = node('label', 'Scalar is null'),
      nil = node('input');
    nil.type = 'checkbox';
    nil.checked = draft.scalarNull;
    label.prepend(nil);
    fieldset.append(label);
    nil.onchange = () => {
      if (closed || token !== generation) return;
      action(() => {
        buffer.change({ scalarNull: nil.checked });
        binding.changed();
      });
    };
    formStops.push(() => {
      nil.onchange = null;
    });
  }
  function render() {
    if (closed) return;
    const view = editor.getSnapshot();
    if (view.state === 'revoked') {
      dispose(true);
      return;
    }
    selections.length = 0;
    for (const table of tables.splice(0)) table.dispose();
    for (const map of maps.splice(0)) map.dispose();
    mapsHost.replaceChildren();
    if (!pending()) {
      // History may remove the clean selected target. Refresh it, or clear it
      // before choosing a surviving feature; never retarget dirty/composing input.
      buffer.cancel(view.snapshot);
      const target =
        buffer.draft()?.target ??
        view.snapshot.content.layers
          .flatMap((l) =>
            l.features.map((f) => ({ layerId: l.id, featureId: f.id, fieldId: l.fields[0]?.id })),
          )
          .find((t) => t.fieldId);
      if (target) buffer.select(view.snapshot, target);
      renderForm();
    }
    for (const layer of view.snapshot.content.layers) {
      const section = node('section');
      section.setAttribute('aria-label', `Edit layer ${layer.id}`);
      section.append(node('h3', layer.name));
      const select = (featureId: string) =>
        action(() => {
          const fieldId =
            buffer.draft()?.target.layerId === layer.id
              ? buffer.draft()!.target.fieldId
              : layer.fields[0]?.id;
          if (!fieldId) throw new Error('GeoNoScalarField');
          choose({ layerId: layer.id, featureId, fieldId });
        });
      const map = createPointMap(doc, preparePointScene(layer), select);
      maps.push(map);
      map.select(
        buffer.draft()?.target.layerId === layer.id ? buffer.draft()!.target.featureId : null,
      );
      section.append(map.element);
      const table = createFeatureTable(doc, layer, select);
      tables.push(table);
      table.select(
        buffer.draft()?.target.layerId === layer.id ? buffer.draft()!.target.featureId : null,
      );
      section.append(table.element);
      selections.push({
        layerId: layer.id,
        update(featureId) {
          map.select(featureId);
          table.select(featureId);
        },
      });
      mapsHost.append(section);
    }
    updateButtons();
  }
  const unsubscribe = editor.subscribe(() => {
    try {
      render();
    } catch (error) {
      tell(error);
    }
  });
  function dispose(scopeRevoked = false) {
    if (closed) return;
    closed = true;
    generation++;
    selections.length = 0;
    for (const table of tables.splice(0)) table.dispose();
    unsubscribe();
    for (const stop of formStops.splice(0)) stop();
    for (const map of maps.splice(0)) map.dispose();
    for (const b of [apply, cancel, undo, redo]) b.onclick = null;
    try {
      if (!scopeRevoked) binding.unregister();
    } finally {
      root.remove();
    }
  }
  try {
    render();
  } catch (error) {
    dispose();
    throw error;
  }
  return { element: root, dispose, buffer };
}
