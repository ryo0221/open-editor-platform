import { useState, useRef, useEffect, useContext } from 'react';
import { canonicalJson, clone } from '@editor-platform/artifact-core';
import { EditorInputsContext } from '@editor-platform/editor-ui';
import { PropertyInput } from '@editor-platform/property-input';
import { type Attributes, type GraphDiagnostic } from './model';
import { type AttributeSchema, type AttributeUi } from './profile';
import { type GraphIntent } from './commands';
import {
  emptyAttributeValue,
  formatAttribute,
  prepareGraphAttributeDraft,
  type GraphAttributeDraft,
} from './attribute-draft';
/** The Surface retains per-element buffers across selection changes. */
export function GraphAttributes({
  attributes,
  schema,
  ui,
  scope,
  id,
  stamp,
  readOnly,
  viewOnly = false,
  onEdit,
  diagnostics = [],
  drafts,
}: {
  attributes: Attributes;
  schema: Record<string, AttributeSchema>;
  ui?: AttributeUi;
  scope: 'graph' | 'node' | 'edge' | 'section';
  id: string;
  stamp: string;
  readOnly: boolean;
  viewOnly?: boolean;
  onEdit: (intents: GraphIntent[], base: string) => boolean;
  diagnostics?: GraphDiagnostic[];
  drafts: Map<string, GraphAttributeDraft>;
}) {
  const inputs = useContext(EditorInputsContext);
  const initial = () =>
    Object.fromEntries(
      Object.entries(schema).map(([key, field]) => [key, formatAttribute(attributes[key], field)]),
    );
  const [draft, setDraft] = useState(() => drafts.get(id)?.values ?? initial());
  const [error, setError] = useState('');
  const original = useRef(drafts.get(id)?.original ?? clone(attributes));
  const originalSchema = useRef(drafts.get(id)?.schema ?? clone(schema));
  const composing = useRef(false);
  const latestInputs = useRef(inputs);
  latestInputs.current = inputs;
  useEffect(() => {
    // A disabled/removed input cannot reliably deliver compositionend. Retain its
    // text as an uncommitted draft, but release the transient selection guard.
    const releaseComposition = () => {
      composing.current = false;
      const retained = drafts.get(id);
      if (retained?.composing) {
        const changed = Object.entries(retained.schema).some(
          ([key, field]) => retained.values[key] !== formatAttribute(retained.original[key], field),
        );
        if (changed) drafts.set(id, { ...retained, composing: false });
        else drafts.delete(id);
        latestInputs.current?.changed();
      }
    };
    if (readOnly || viewOnly) releaseComposition();
    return releaseComposition;
  }, [readOnly, viewOnly, drafts, id]);
  const dirty = Object.entries(schema).some(
    ([key, field]) => draft[key] !== formatAttribute(original.current[key], field),
  );
  const stale =
    canonicalJson(attributes) !== canonicalJson(original.current) ||
    canonicalJson(schema) !== canonicalJson(originalSchema.current);
  useEffect(() => {
    if (!drafts.has(id) && stale) {
      original.current = clone(attributes);
      originalSchema.current = clone(schema);
      setDraft(initial());
    }
  }, [attributes, schema, stale, drafts, id]);
  function retain(values = draft) {
    if (
      composing.current ||
      Object.entries(originalSchema.current).some(
        ([key, field]) => values[key] !== formatAttribute(original.current[key], field),
      )
    )
      drafts.set(id, {
        id,
        scope,
        values,
        original: original.current,
        schema: originalSchema.current,
        composing: composing.current,
      });
    else drafts.delete(id);
    inputs?.changed();
  }
  function reset() {
    drafts.delete(id);
    original.current = clone(attributes);
    originalSchema.current = clone(schema);
    setDraft(initial());
    setError('');
    inputs?.changed();
  }
  const order = [
    ...(ui?.order ?? []).filter((key) => Object.hasOwn(schema, key)),
    ...Object.keys(schema).filter((key) => !ui?.order?.includes(key)),
  ];
  if (viewOnly)
    return (
      <dl className="ep-graph-attribute-values" aria-label="Graph attributes">
        {[...order, ...Object.keys(attributes).filter((key) => !Object.hasOwn(schema, key))].map(
          (key) => (
            <div key={key}>
              <dt>{ui?.fields?.[key]?.label ?? key}</dt>
              <dd>
                {attributes[key] === undefined || attributes[key] === null || attributes[key] === ''
                  ? '—'
                  : typeof attributes[key] === 'string'
                    ? attributes[key]
                    : JSON.stringify(attributes[key])}
              </dd>
            </div>
          ),
        )}
      </dl>
    );
  return (
    <form
      className="ep-graph-attributes"
      aria-label="Graph attributes"
      onCompositionStart={() => {
        composing.current = true;
        retain();
      }}
      onCompositionEnd={() => {
        composing.current = false;
        retain();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (readOnly || composing.current) return;
        try {
          const intents = prepareGraphAttributeDraft(
            {
              id,
              scope,
              values: draft,
              original: original.current,
              schema: originalSchema.current,
            },
            attributes,
            schema,
          );
          if (intents.length && onEdit(intents, stamp)) {
            drafts.delete(id);
            inputs?.changed();
            setError('');
          }
        } catch (error) {
          setError(String(error instanceof Error ? error.message : error));
        }
      }}
      onKeyDown={(event) => {
        if (!event.nativeEvent.isComposing && event.key === 'Escape') {
          event.preventDefault();
          reset();
        }
      }}
    >
      {order.map((key) => {
        const field = schema[key],
          item = ui?.fields?.[key];
        return (
          <PropertyInput
            key={key}
            label={item?.label ?? key}
            showLabel
            description={item?.description}
            value={draft[key] ?? emptyAttributeValue(field)}
            onChange={(value) => {
              const next = { ...draft, [key]: value };
              retain(next);
              setDraft(next);
            }}
            type={
              field.type === 'array' || field.type === 'object'
                ? 'json'
                : field.type === 'boolean' || field.type === 'enum'
                  ? 'select'
                  : field.type === 'number'
                    ? 'number'
                    : 'text'
            }
            emptyValue={emptyAttributeValue(field)}
            options={
              field.type === 'boolean'
                ? [
                    { value: 'true', label: 'true' },
                    { value: 'false', label: 'false' },
                  ]
                : field.enum?.map((value) => ({
                    value: String(value),
                    label:
                      item?.options?.find((option) => option.value === value)?.label ??
                      String(value),
                  }))
            }
            required={field.required}
            readOnly={readOnly || field.readOnly}
            diagnostics={diagnostics
              .filter((diagnostic) => diagnostic.path[0] === key)
              .map((diagnostic) => diagnostic.message)}
          />
        );
      })}
      {stale && (
        <p role="status">属性または定義が変更されています。キャンセルで現在値を読み込みます。</p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="ep-graph-actions">
        <button disabled={readOnly || stale || !dirty} type="submit">
          Apply attributes
        </button>
        <button type="button" onClick={reset}>
          Cancel attributes
        </button>
      </div>
      <small>Undeclared attributes are retained.</small>
      <output className="ep-graph-hidden" aria-label="Canonical attributes">
        {canonicalJson(attributes)}
      </output>
    </form>
  );
}
