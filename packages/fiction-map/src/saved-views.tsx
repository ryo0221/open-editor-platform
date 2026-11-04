import { useRef, useState } from 'react';
import { newId } from '@editor-platform/artifact-core';
import { useEditorInput } from '@editor-platform/editor-ui';
import {
  prepareFictionMapChange,
  type FictionMapBase,
  type FictionMapResult,
  type PreparedFictionMapChange,
} from './model';
/** Explicit native named views, separate from camera and temporary layer visibility. */
export function FictionMapSavedViews({
  base,
  readOnly,
  onCommit,
  onError,
}: {
  base: FictionMapBase;
  readOnly: boolean;
  onCommit(p: PreparedFictionMapChange): FictionMapResult<FictionMapBase & { changed: boolean }>;
  onError(message: string): void;
}) {
  const initial = () => ({
    id: '',
    name: '',
    extent: Object.fromEntries(
      Object.entries(base.content.coordinateSpace.bounds).map(([key, value]) => [
        key,
        String(value),
      ]),
    ) as Record<'minX' | 'minY' | 'maxX' | 'maxY', string>,
    visibleLayerIds: base.content.layers.filter((l) => l.visibleByDefault).map((l) => l.id),
  });
  const [draft, setDraft] = useState(initial),
    pinned = useRef(base),
    dirty = useRef(false),
    composing = useRef(false),
    input = useRef<HTMLInputElement>(null);
  function change(next: Partial<typeof draft>) {
    const wasDirty = dirty.current;
    if (!wasDirty) pinned.current = base;
    dirty.current = true;
    setDraft((previous) => ({ ...(wasDirty ? previous : initial()), ...next }));
    inputs?.changed();
  }
  const inputs = useEditorInput({
    label: 'Fiction Map saved view input',
    read: () => ({ dirty: dirty.current, composing: composing.current }),
    prepare() {
      throw Error('Save or cancel the named view input.');
    },
    focus() {
      input.current?.focus();
    },
  });
  function clear() {
    dirty.current = false;
    // The real compositionend event owns IME completion, even after Cancel.
    setDraft(initial());
    inputs?.changed();
  }
  const shown = dirty.current ? draft : initial();
  return (
    <form
      className="fm-saved-views"
      aria-label="Save document map view"
      onCompositionStart={() => {
        composing.current = true;
        inputs?.changed();
      }}
      onCompositionEnd={() => {
        composing.current = false;
        inputs?.changed();
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (readOnly || composing.current) return;
        if (
          Object.values(shown.extent).some(
            (value) => !value.trim() || !Number.isFinite(Number(value)),
          )
        ) {
          onError('Enter a finite value for every view boundary.');
          return;
        }
        const b = pinned.current;
        const view = {
          id: shown.id || newId('view'),
          name: shown.name,
          extent: {
            minX: Number(shown.extent.minX),
            minY: Number(shown.extent.minY),
            maxX: Number(shown.extent.maxX),
            maxY: Number(shown.extent.maxY),
          },
          visibleLayerIds: shown.visibleLayerIds,
        };
        const prep = prepareFictionMapChange(b, {
          namedViews: shown.id
            ? b.content.namedViews.map((v) => (v.id === shown.id ? view : v))
            : [...b.content.namedViews, view],
        });
        if (!prep.ok) {
          onError(prep.diagnostic.code);
          return;
        }
        const result = onCommit(prep.value);
        if (!result.ok) {
          onError(result.diagnostic.code);
          return;
        }
        clear();
      }}
    >
      <label>
        Named document view
        <input
          ref={input}
          aria-label="Named document view"
          disabled={readOnly}
          value={shown.name}
          onChange={(e) => change({ name: e.target.value })}
        />
      </label>
      <fieldset disabled={readOnly}>
        <legend>Saved view extent (native coordinates)</legend>
        {(['minX', 'minY', 'maxX', 'maxY'] as const).map((key) => (
          <label key={key}>
            {key}
            <input
              aria-label={`View ${key}`}
              inputMode="decimal"
              value={shown.extent[key]}
              onChange={(e) => change({ extent: { ...shown.extent, [key]: e.target.value } })}
            />
          </label>
        ))}
        {base.content.layers.map((layer) => (
          <label key={layer.id}>
            <input
              type="checkbox"
              aria-label={`View layer ${layer.name}`}
              checked={shown.visibleLayerIds.includes(layer.id)}
              onChange={(e) =>
                change({
                  visibleLayerIds: e.target.checked
                    ? [...shown.visibleLayerIds, layer.id]
                    : shown.visibleLayerIds.filter((id) => id !== layer.id),
                })
              }
            />
            {layer.name}
          </label>
        ))}
      </fieldset>
      <button disabled={readOnly || !shown.name.trim()}>
        {shown.id ? 'Update named view' : 'Save bounds as named view'}
      </button>
      <button type="button" disabled={!dirty.current} onClick={clear}>
        Cancel view input
      </button>
      <p>
        Saves the explicit extent and layers in native, independently of camera and local
        visibility. Save a version to publish this view.
      </p>
      <ul aria-label="Saved map views">
        {base.content.namedViews.map((view) => (
          <li key={view.id}>
            {view.name}
            <button
              type="button"
              disabled={readOnly || dirty.current}
              onClick={() => {
                pinned.current = base;
                change({
                  id: view.id,
                  name: view.name,
                  extent: {
                    minX: String(view.extent.minX),
                    minY: String(view.extent.minY),
                    maxX: String(view.extent.maxX),
                    maxY: String(view.extent.maxY),
                  },
                  visibleLayerIds: [...view.visibleLayerIds],
                });
              }}
            >
              Edit saved view {view.name}
            </button>
          </li>
        ))}
      </ul>
    </form>
  );
}
