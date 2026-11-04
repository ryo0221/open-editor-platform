import { useEditorInput } from '@editor-platform/editor-ui';
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import {
  replaceGeometry,
  updateFeatureMetadata,
  type FictionMapBase,
  type FictionMapChange,
  type FictionMapFeature,
  type FictionMapResult,
} from './model';

export interface InspectorProps {
  base: FictionMapBase;
  feature: FictionMapFeature;
  disabled: boolean;
  onPendingChange?(dirty: boolean): void;
  apply(base: FictionMapBase, result: FictionMapResult<FictionMapChange>): boolean;
}
function fields(f: FictionMapFeature) {
  return {
    name: f.name,
    description: f.description ?? '',
    category: f.category ?? '',
    layerId: f.layerId,
    color: f.style?.color ?? '#386b80',
    lineWidth: String(f.style?.lineWidth ?? (f.geometry.type === 'polyline' ? 7 : 2)),
    label: f.style?.label !== false,
    x: f.geometry.type === 'point' ? String(f.geometry.coordinates[0]) : '',
    y: f.geometry.type === 'point' ? String(f.geometry.coordinates[1]) : '',
  };
}
/** Dirty text pins its base. Revision updates never remount/commit the IME input. */
export function FeatureInspector({
  base,
  feature,
  disabled,
  apply,
  onPendingChange,
}: InspectorProps) {
  const [draft, setDraft] = useState(() => fields(feature)),
    [dirty, setDirty] = useState(false),
    [inputError, setInputError] = useState('');
  const pinned = useRef(base),
    composing = useRef(false),
    dirtyRef = useRef(false),
    form = useRef<HTMLFormElement>(null);
  const pending = useRef(onPendingChange);
  pending.current = onPendingChange;
  useLayoutEffect(() => () => pending.current?.(false), []);
  const inputs = useEditorInput({
    label: 'Fiction Map feature input',
    read: () => ({ dirty: dirtyRef.current, composing: composing.current }),
    prepare() {
      throw new Error('Apply or cancel the feature input before saving, exporting or switching.');
    },
    focus() {
      form.current?.querySelector('input')?.focus();
    },
  });
  const shown = dirty ? draft : fields(feature);
  function edit<K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) {
    if (!dirty) {
      pinned.current = base;
      setDraft({ ...fields(feature), [key]: value });
    } else setDraft((d) => ({ ...d, [key]: value }));
    dirtyRef.current = true;
    onPendingChange?.(true);
    setDirty(true);
    inputs?.changed();
    setInputError('');
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (composing.current || disabled || !dirty) return;
    const old = pinned.current.content.features.find((f) => f.id === feature.id);
    if (!old) return;
    const before = fields(old),
      set: {
        -readonly [K in keyof NonNullable<
          Parameters<typeof updateFeatureMetadata>[2]['set']
        >]: NonNullable<Parameters<typeof updateFeatureMetadata>[2]['set']>[K];
      } = {};
    if (shown.name !== before.name) set.name = shown.name;
    if (shown.description !== before.description) set.description = shown.description;
    if (shown.category !== before.category) set.category = shown.category;
    if (
      shown.color !== before.color ||
      shown.lineWidth !== before.lineWidth ||
      shown.label !== before.label
    ) {
      const width = shown.lineWidth.trim() ? Number(shown.lineWidth) : NaN;
      if (!Number.isFinite(width)) {
        setInputError('Enter a finite stroke width.');
        return;
      }
      set.style = {
        ...old.style,
        ...(shown.color !== before.color ? { color: shown.color } : {}),
        ...(shown.lineWidth !== before.lineWidth ? { lineWidth: width } : {}),
        ...(shown.label !== before.label ? { label: shown.label } : {}),
      };
    }
    const metadata = updateFeatureMetadata(pinned.current.content, old.id, { set });
    if (!metadata.ok) {
      apply(pinned.current, metadata);
      return;
    }
    let next = metadata.value.update![0];
    if (shown.layerId !== before.layerId) next = { ...next, layerId: shown.layerId };
    if (old.geometry.type === 'point' && (shown.x !== before.x || shown.y !== before.y)) {
      const x = shown.x.trim() ? Number(shown.x) : NaN,
        y = shown.y.trim() ? Number(shown.y) : NaN;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        setInputError('Enter finite coordinates.');
        return;
      }
      const geometry = replaceGeometry(pinned.current.content, old.id, {
        type: 'point',
        coordinates: [x, y],
      });
      if (!geometry.ok) {
        apply(pinned.current, geometry);
        return;
      }
      next = { ...next, geometry: geometry.value.update![0].geometry };
    }
    if (apply(pinned.current, { ok: true, value: { update: [next] } })) {
      dirtyRef.current = false;
      onPendingChange?.(false);
      setDirty(false);
      inputs?.changed();
      setInputError('');
    }
  }
  return (
    <form
      ref={form}
      className="fm-inspector"
      aria-label="Feature inspector"
      onSubmit={submit}
      onCompositionStart={() => {
        composing.current = true;
        inputs?.changed();
      }}
      onCompositionEnd={() => {
        composing.current = false;
        inputs?.changed();
      }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || composing.current || e.nativeEvent.keyCode === 229) {
          e.stopPropagation();
        }
      }}
    >
      <h3>Feature</h3>
      <p className="fm-id">{feature.id}</p>
      <fieldset disabled={disabled}>
        <label>
          Name
          <input
            aria-label="Feature name"
            value={shown.name}
            onChange={(e) => edit('name', e.target.value)}
          />
        </label>
        <label>
          Description
          <textarea
            aria-label="Feature description"
            value={shown.description}
            onChange={(e) => edit('description', e.target.value)}
          />
        </label>
        <label>
          Category
          <input
            aria-label="Feature category"
            value={shown.category}
            onChange={(e) => edit('category', e.target.value)}
          />
        </label>
        <label>
          Layer
          <select
            aria-label="Feature layer"
            value={shown.layerId}
            onChange={(e) => edit('layerId', e.target.value)}
          >
            {base.content.layers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Color
          <input
            aria-label="Feature color"
            value={shown.color}
            onChange={(e) => edit('color', e.target.value)}
          />
        </label>
        <label>
          Stroke width (px)
          <input
            aria-label="Feature stroke width"
            inputMode="decimal"
            value={shown.lineWidth}
            onChange={(e) => edit('lineWidth', e.target.value)}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={shown.label}
            onChange={(e) => edit('label', e.target.checked)}
          />
          Show label
        </label>
        {feature.geometry.type === 'point' && (
          <div className="fm-coordinate-fields">
            {(['x', 'y'] as const).map((k) => (
              <label key={k}>
                {k.toUpperCase()}
                <input
                  aria-label={`Feature ${k}`}
                  value={shown[k]}
                  inputMode="decimal"
                  onChange={(e) => edit(k, e.target.value)}
                />
              </label>
            ))}
          </div>
        )}
        <button type="submit" disabled={!dirty}>
          Apply feature
        </button>
        <button
          type="button"
          disabled={!dirty}
          onClick={() => {
            dirtyRef.current = false;
            onPendingChange?.(false);
            setDirty(false);
            inputs?.changed();
            setInputError('');
          }}
        >
          Cancel edits
        </button>
      </fieldset>
      {inputError && <p role="alert">{inputError}</p>}
      {dirty &&
        (pinned.current.revision.sequence !== base.revision.sequence ||
          pinned.current.revision.sessionId !== base.revision.sessionId) && (
          <p role="status">Map changed. Apply checks the original revision; cancel to reload.</p>
        )}
    </form>
  );
}
