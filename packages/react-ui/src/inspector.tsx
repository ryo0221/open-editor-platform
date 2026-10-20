import { useEffect, useState } from 'react';
import {
  reactUiCommand,
  schemaAssignable,
  valueMatches,
  reactUiStyleProperties,
  reactUiStyleProblem,
  type JsonValue,
  type ReactFieldSchema,
  type ReactUiDocument,
  type ReactUiNode,
  type RegisteredReactComponent,
  type ReactUiStyle,
  type ReactUiStyleProperty,
  type ReactValueSchema,
  type ReactUiEdit,
} from '@editor-platform/react-ui-core';
import { immutableCommand, type EditorCommand } from '@editor-platform/editor-core';
import { inspectReactUiDocument } from '@editor-platform/react-ui-core';

export function checkedReactUiCommand(
  label: string,
  apply: (content: ReactUiDocument) => ReactUiDocument,
) {
  return immutableCommand<ReactUiDocument>('react-ui.edit', label, (content) => {
    const result = inspectReactUiDocument(apply(content));
    if (!result.document || result.diagnostics.length)
      throw new Error(result.diagnostics.map((d) => d.message).join('; '));
    return result.document;
  });
}
function ValueField({
  name,
  field,
  value,
  assets,
  disabled,
  change,
}: {
  name: string;
  field: ReactFieldSchema;
  value: JsonValue | undefined;
  assets: string[];
  disabled: boolean;
  change(value: JsonValue): void;
}) {
  const [text, setText] = useState(
    JSON.stringify(value === undefined ? (field.default ?? null) : value),
  );
  const [error, setError] = useState('');
  useEffect(
    () => setText(JSON.stringify(value === undefined ? (field.default ?? null) : value)),
    [value, field.default],
  );
  const schema = field.schema;
  const check = (value: JsonValue) => {
    if (!valueMatches(schema, value)) {
      setError('Value does not match the published type');
      return;
    }
    setError('');
    change(value);
  };
  const current = value === undefined ? field.default : value;
  let control;
  if (schema.type === 'enum' || schema.type === 'asset')
    control = (
      <select
        aria-label={`Prop ${name}`}
        disabled={disabled}
        value={String(current ?? '')}
        onChange={(e) => check(e.target.value)}
      >
        <option value="" disabled>
          Select
        </option>
        {(schema.type === 'enum' ? schema.values : assets).map((v) => (
          <option key={v}>{v}</option>
        ))}
      </select>
    );
  else if (schema.type === 'boolean')
    control = (
      <input
        aria-label={`Prop ${name}`}
        type="checkbox"
        disabled={disabled}
        checked={current === true}
        onChange={(e) => check(e.target.checked)}
      />
    );
  else if (schema.type === 'string')
    control = (
      <input
        aria-label={`Prop ${name}`}
        disabled={disabled}
        maxLength={schema.maxLength}
        value={String(current ?? '')}
        onChange={(e) => check(e.target.value)}
      />
    );
  else if (schema.type === 'number')
    control = (
      <input
        aria-label={`Prop ${name}`}
        type="number"
        disabled={disabled}
        min={schema.minimum}
        max={schema.maximum}
        value={typeof current === 'number' ? current : ''}
        onChange={(e) => {
          if (e.target.value) check(Number(e.target.value));
        }}
      />
    );
  else
    control = (
      <>
        <textarea
          aria-label={`Prop ${name} JSON`}
          disabled={disabled}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          disabled={disabled}
          onClick={() => {
            try {
              check(JSON.parse(text));
            } catch {
              setError('Invalid JSON');
            }
          }}
        >
          Apply {name}
        </button>
      </>
    );
  return (
    <label>
      {name}
      {control}
      {schema.nullable && (
        <button disabled={disabled} onClick={() => check(null)}>
          Set {name} null
        </button>
      )}
      {error && <span role="alert">{error}</span>}
    </label>
  );
}
function LayoutField({
  name,
  value,
  disabled,
  change,
}: {
  name: string;
  value: string;
  disabled: boolean;
  change(value: string): void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      aria-label={`Layout ${name}`}
      disabled={disabled}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== value) change(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          change(draft);
        }
      }}
    />
  );
}
function paths(
  schema: ReactValueSchema,
  prefix: string[] = [],
): { path: string[]; schema: ReactValueSchema }[] {
  return [
    { path: prefix, schema },
    ...(schema.type === 'object' && !schema.nullable
      ? Object.entries(schema.fields)
          .filter(([, field]) => field.required)
          .flatMap(([key, field]) => paths(field.schema, [...prefix, key]))
      : []),
  ];
}
export function ReactUiInspector({
  document,
  node,
  registered,
  readOnly,
  execute,
  onEditInput,
}: {
  document: ReactUiDocument;
  node: ReactUiNode;
  registered: RegisteredReactComponent;
  readOnly: boolean;
  execute(command: EditorCommand<ReactUiDocument>): void;
  onEditInput?(input: string): void;
}) {
  const [breakpoint, setBreakpoint] = useState('base');
  const [layoutText, setLayoutText] = useState('');
  const [error, setError] = useState('');
  const style =
    breakpoint === 'base' ? node.layout.base : (node.layout.breakpoints[breakpoint] ?? {});
  useEffect(() => {
    setLayoutText(JSON.stringify(style, null, 2));
  }, [node.id, node.layout, breakpoint]); // Input buffer is not an artifact/history.
  const run = (command: EditorCommand<ReactUiDocument>) => {
    try {
      if (readOnly) throw new Error('Read only');
      execute(command);
      setError('');
    } catch (error) {
      setError(String(error));
    }
  };
  const bindings = Object.fromEntries(
    [...Object.keys(registered.props), ...Object.keys(registered.events)].map((key) => [
      key,
      node.bindings[key] ? JSON.stringify(node.bindings[key]) : '',
    ]),
  );
  const [draftBindings, setDraftBindings] = useState<Record<string, string>>(bindings);
  const bindingsKey = JSON.stringify(bindings);
  useEffect(
    // Autosave/admission and unrelated prop edits may publish new objects with
    // identical bindings. Preserve pending choices until their committed basis,
    // selected node or published contract actually changes.
    () => setDraftBindings(JSON.parse(bindingsKey) as Record<string, string>),
    [node.id, bindingsKey, registered.ref.contractHash],
  );
  const setStyle = (property: ReactUiStyleProperty, raw: string) => {
    const value = raw.startsWith('token:')
      ? { kind: 'token' as const, tokenId: raw.slice(6) }
      : { kind: 'literal' as const, value: /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw };
    const next = { ...style };
    if (!raw) delete next[property];
    else next[property] = value;
    run(
      reactUiCommand(
        [
          {
            type: 'set-layout',
            nodeId: node.id,
            breakpoint: breakpoint === 'base' ? null : breakpoint,
            style: next,
          },
        ],
        `Set ${property}`,
      ),
    );
  };
  const structural: Partial<Record<ReactUiStyleProperty, string[]>> = {
    display: ['flex', 'grid', 'block', 'inline-flex', 'none'],
    flexDirection: ['row', 'column', 'row-reverse', 'column-reverse'],
    alignItems: ['stretch', 'start', 'center', 'end', 'baseline'],
    justifyContent: ['start', 'center', 'end', 'space-between', 'space-around', 'space-evenly'],
    flexWrap: ['nowrap', 'wrap', 'wrap-reverse'],
    position: ['static', 'relative', 'absolute'],
    gridTemplateColumns: ['1fr', 'repeat(2, minmax(0, 1fr))', 'repeat(3, minmax(0, 1fr))'],
  };
  return (
    <>
      <h3>Props & bindings</h3>
      {Object.entries(registered.props).map(([key, field]) => (
        <div key={key}>
          <ValueField
            name={key}
            field={field}
            value={node.props[key]}
            assets={document.environment.dependencies
              .filter((d) => d.kind === 'asset')
              .map((d) => d.id)}
            disabled={readOnly || !!node.bindings[key]}
            change={(value) =>
              run(
                reactUiCommand(
                  [{ type: 'set-prop', nodeId: node.id, prop: key, value }],
                  `Set ${key}`,
                ),
              )
            }
          />
          {node.bindings[key]?.kind === 'data' && (
            <p>
              データ「{node.bindings[key].input}
              {node.bindings[key].path.length ? '.' + node.bindings[key].path.join('.') : ''}
              」から表示しています。 文字を変えるにはプレビュー入力を編集してください。
              {onEditInput && (
                <button
                  type="button"
                  onClick={() => {
                    const binding = node.bindings[key];
                    if (binding?.kind === 'data') onEditInput(binding.input);
                  }}
                >
                  プレビュー入力を編集: {node.bindings[key].input}
                </button>
              )}
            </p>
          )}
          <button
            disabled={readOnly || (field.required && !Object.hasOwn(field, 'default'))}
            onClick={() =>
              run(
                reactUiCommand(
                  [{ type: 'reset-prop', nodeId: node.id, prop: key }],
                  `Reset ${key}`,
                ),
              )
            }
          >
            Reset {key}
          </button>
        </div>
      ))}
      <fieldset disabled={readOnly}>
        <legend>Data & callbacks</legend>
        {Object.entries(registered.props).map(([key, field]) => (
          <label key={key}>
            Data {key}
            <select
              aria-label={`Data binding ${key}`}
              value={draftBindings[key] ?? ''}
              onChange={(e) =>
                setDraftBindings((current) => ({ ...current, [key]: e.target.value }))
              }
            >
              <option value="">Literal / default</option>
              {Object.entries(document.inputs)
                .filter(([, input]) => input.required || Object.hasOwn(input, 'default'))
                .flatMap(([input, fieldInput]) =>
                  paths(fieldInput.schema)
                    .filter((p) => schemaAssignable(p.schema, field.schema))
                    .map((p) => (
                      <option
                        key={JSON.stringify([input, p.path])}
                        value={JSON.stringify({ kind: 'data', input, path: p.path })}
                      >
                        {input}
                        {p.path.length ? '.' + p.path.join('.') : ''}
                      </option>
                    )),
                )}
            </select>
          </label>
        ))}
        {Object.entries(registered.events).map(([key, event]) => (
          <label key={key}>
            Callback {key}
            <select
              aria-label={`Callback binding ${key}`}
              value={draftBindings[key] ?? ''}
              onChange={(e) =>
                setDraftBindings((current) => ({ ...current, [key]: e.target.value }))
              }
            >
              <option value="">Unbound</option>
              {Object.entries(document.callbacks)
                .filter(
                  ([, callback]) =>
                    callback.parameters.length === event.parameters.length &&
                    event.parameters.every((p, i) => schemaAssignable(p, callback.parameters[i])),
                )
                .map(([callback]) => (
                  <option key={callback} value={JSON.stringify({ kind: 'callback', callback })}>
                    {callback}
                  </option>
                ))}
            </select>
          </label>
        ))}
        <button
          onClick={() => {
            const edits: ReactUiEdit[] = [];
            for (const key of Object.keys(bindings)) {
              const selected = draftBindings[key];
              if (selected)
                edits.push({
                  type: 'set-binding',
                  nodeId: node.id,
                  prop: key,
                  binding: JSON.parse(selected),
                });
              else if (node.bindings[key]) {
                edits.push({ type: 'set-binding', nodeId: node.id, prop: key, binding: null });
                if (registered.props[key]) {
                  const field = registered.props[key];
                  const value = registered.sampleProps[key] ?? field.default;
                  if (value !== undefined)
                    edits.push({ type: 'set-prop', nodeId: node.id, prop: key, value });
                }
              }
            }
            run(reactUiCommand(edits, 'Connect typed bindings'));
          }}
        >
          Apply bindings
        </button>
      </fieldset>
      <h3>Responsive layout</h3>
      <label>
        Breakpoint
        <select
          aria-label="Layout breakpoint"
          value={breakpoint}
          onChange={(e) => setBreakpoint(e.target.value)}
        >
          <option value="base">Base</option>
          {document.breakpoints.map((bp) => (
            <option key={bp.id} value={bp.id}>
              {bp.id} ≥ {bp.minWidth}px
            </option>
          ))}
        </select>
      </label>
      {registered.layout === 'none' ? (
        <p>This component does not publish layout support.</p>
      ) : (
        <fieldset disabled={readOnly}>
          <legend>
            {document.environment.stylePolicy === 'tokens-only'
              ? 'Host design tokens'
              : 'Layout values'}
          </legend>
          {reactUiStyleProperties.map((property) => {
            const value = style[property],
              raw = value?.kind === 'token' ? `token:${value.tokenId}` : String(value?.value ?? '');
            const options = structural[property];
            return (
              <label key={property}>
                {property}
                {options || document.environment.stylePolicy === 'tokens-only' ? (
                  <select
                    aria-label={`Layout ${property}`}
                    value={raw}
                    onChange={(e) => setStyle(property, e.target.value)}
                  >
                    <option value="">Inherited</option>
                    {(
                      options ??
                      Object.keys(document.environment.tokenVariables)
                        .filter(
                          (id) =>
                            !reactUiStyleProblem(document.environment, property, {
                              kind: 'token',
                              tokenId: id,
                            }),
                        )
                        .map((id) => `token:${id}`)
                    ).map((option) => (
                      <option key={option}>{option}</option>
                    ))}
                  </select>
                ) : (
                  <LayoutField
                    name={property}
                    value={raw}
                    disabled={readOnly}
                    change={(value) => setStyle(property, value)}
                  />
                )}
              </label>
            );
          })}
          {document.environment.stylePolicy !== 'tokens-only' && (
            <details>
              <summary>Typed layout JSON</summary>
              <textarea
                aria-label="Layout JSON"
                value={layoutText}
                onChange={(e) => setLayoutText(e.target.value)}
              />
              <button
                onClick={() => {
                  try {
                    run(
                      reactUiCommand([
                        {
                          type: 'set-layout',
                          nodeId: node.id,
                          breakpoint: breakpoint === 'base' ? null : breakpoint,
                          style: JSON.parse(layoutText) as ReactUiStyle,
                        },
                      ]),
                    );
                  } catch (error) {
                    setError(String(error));
                  }
                }}
              >
                Apply layout JSON
              </button>
            </details>
          )}
        </fieldset>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
