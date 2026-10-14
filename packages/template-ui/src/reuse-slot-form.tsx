import { useState } from 'react';
import { definitionRef, resolveComponentProperties } from '@editor-platform/reuse-core';
import type {
  ComponentDefinition,
  ComponentSlotValue,
  TemplateCatalog,
} from '@editor-platform/templates';
import { TemplateInputForm } from './form';
function inputValues(value: Extract<ComponentSlotValue, { kind: 'component' }>) {
  try {
    return resolveComponentProperties(
      value.definition.payload.contract,
      value.inputs ?? {},
      value.variant,
    ).values;
  } catch {
    return value.inputs ?? {};
  } // The normal preparation path reports invalid in-progress input.
}

export function ComponentSlotsForm(props: {
  definition: ComponentDefinition;
  values: Record<string, ComponentSlotValue[]>;
  items: ComponentDefinition[];
  catalog: TemplateCatalog;
  depth?: number;
  onChange(values: Record<string, ComponentSlotValue[]>): void;
}) {
  const [choices, setChoices] = useState<Record<string, string>>({}),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const depth = props.depth ?? 0;
  if (depth >= 16) return <p role="alert">子部品は16段階までです。</p>;
  return (
    <div>
      {error && <p role="alert">{error}</p>}
      {props.definition.payload.contract.slots.map((slot) => {
        const values = props.values[slot.id] ?? [];
        const change = (values: ComponentSlotValue[]) =>
          props.onChange({ ...props.values, [slot.id]: values });
        const children = props.items.filter((d) => d.domain === slot.domain);
        const choice =
          choices[slot.id] ?? (slot.accepts.includes('body') ? 'body' : (children[0]?.hash ?? ''));
        return (
          <fieldset key={slot.id}>
            <legend>
              {slot.label}（{slot.min}〜{slot.max}件）
            </legend>
            {values.map((value, index) => (
              <div className="tp-row" key={index}>
                {value.kind === 'body' ? (
                  <label>
                    挿入する本文
                    <textarea
                      value={value.content.blocks[0]?.text ?? ''}
                      onChange={(e) =>
                        change(
                          values.map((v, i) =>
                            i === index
                              ? {
                                  kind: 'body',
                                  content: {
                                    schemaVersion: 2,
                                    blocks: [
                                      { id: 'body', type: 'paragraph', text: e.target.value },
                                    ],
                                  },
                                }
                              : v,
                          ),
                        )
                      }
                    />
                  </label>
                ) : (
                  <details open>
                    <summary>{value.definition.name}</summary>
                    <label>
                      子部品のバリエーション
                      <select
                        value={
                          value.variant ?? value.definition.payload.contract.defaultVariant ?? ''
                        }
                        onChange={(e) =>
                          change(
                            values.map((v, i) =>
                              i === index ? { ...value, variant: e.target.value || undefined } : v,
                            ),
                          )
                        }
                      >
                        <option value="">既定</option>
                        {value.definition.payload.contract.variants.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <TemplateInputForm
                      fields={value.definition.payload.contract.properties.map((p) => ({
                        ...p,
                        key: p.id,
                        description: '',
                      }))}
                      values={inputValues(value)}
                      onChange={() => {}}
                      onFieldChange={(key, input) =>
                        change(
                          values.map((v, i) =>
                            i === index
                              ? {
                                  ...value,
                                  inputs: {
                                    ...value.inputs,
                                    [key]:
                                      value.definition.payload.contract.properties.find(
                                        (p) => p.id === key,
                                      )?.type === 'asset' && input === ''
                                        ? null
                                        : input,
                                  },
                                }
                              : v,
                          ),
                        )
                      }
                    />
                    <ComponentSlotsForm
                      definition={value.definition}
                      values={value.slots ?? {}}
                      catalog={props.catalog}
                      items={props.items}
                      depth={depth + 1}
                      onChange={(slots) =>
                        change(values.map((v, i) => (i === index ? { ...value, slots } : v)))
                      }
                    />
                  </details>
                )}
                <button onClick={() => change(values.filter((_v, i) => index !== i))}>
                  {slot.label}の内容 {index + 1} を削除
                </button>
              </div>
            ))}
            <label>
              追加する内容
              <select
                value={choice}
                onChange={(e) => setChoices({ ...choices, [slot.id]: e.target.value })}
              >
                {slot.accepts.includes('body') && <option value="body">本文</option>}
                {slot.accepts.includes('component') &&
                  children.map((d) => (
                    <option key={d.hash} value={d.hash}>
                      {d.name} v{d.version}
                    </option>
                  ))}
              </select>
            </label>
            <button
              disabled={busy || values.length >= slot.max || !choice}
              onClick={() => {
                void (async () => {
                  setBusy(true);
                  setError('');
                  try {
                    if (choice === 'body')
                      change([
                        ...values,
                        {
                          kind: 'body',
                          content: {
                            schemaVersion: 2,
                            blocks: [{ id: 'body', type: 'paragraph', text: '' }],
                          },
                        },
                      ]);
                    else {
                      const definition = children.find((d) => d.hash === choice)!;
                      change([
                        ...values,
                        {
                          kind: 'component',
                          definition,
                          closure: await props.catalog.closure(definitionRef(definition)),
                        },
                      ]);
                    }
                  } catch (error) {
                    setError((error as Error).message);
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              「{slot.label}」の内容を追加
            </button>
          </fieldset>
        );
      })}
    </div>
  );
}
