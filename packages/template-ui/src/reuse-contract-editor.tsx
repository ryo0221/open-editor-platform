import { useState } from 'react';
import { clone } from '@editor-platform/artifact-core';
import type { ComponentContract, JsonValue, PublicProperty } from '@editor-platform/reuse-core';
import {
  publicPropertySuggestions,
  reusableParts,
  reusableRichLimitation,
  type NativeContent,
} from '@editor-platform/templates';
import { TemplateInputForm } from './form';

export function ComponentContractEditor(props: {
  contract: ComponentContract;
  content: NativeContent;
  onChange(value: ComponentContract): void;
}) {
  const { contract, content, onChange } = props;
  const [partId, setPartId] = useState(contract.parts[0]?.id ?? ''),
    [field, setField] = useState('');
  const native = reusableParts(content),
    part = contract.parts.find((p) => p.id === partId);
  const suggestions = part ? publicPropertySuggestions(content, part) : [];
  const patch = (id: string, patch: Partial<PublicProperty>) =>
    onChange({
      ...contract,
      properties: contract.properties.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    });
  const defaults = Object.fromEntries(contract.properties.map((p) => [p.id, p.default ?? null]));
  const inputFields = contract.properties.map((p) => ({ key: p.id, description: '', ...p }));
  return (
    <div className="tp-component-contract">
      <h3>公開する入力</h3>
      {part &&
        native.get(part.nativeId) &&
        reusableRichLimitation(content, native.get(part.nativeId)!) && (
          <p>{reusableRichLimitation(content, native.get(part.nativeId)!)}</p>
        )}
      {contract.properties.map((p) => (
        <details key={p.id}>
          <summary>
            {p.label}（{p.type}）
          </summary>
          <label>
            入力名
            <input
              aria-label={`入力名: ${p.id}`}
              value={p.label}
              onChange={(e) => patch(p.id, { label: e.target.value })}
            />
          </label>
          <TemplateInputForm
            fields={[{ ...inputFields.find((f) => f.key === p.id)!, label: `${p.label}の既定値` }]}
            values={defaults}
            onChange={() => {}}
            onFieldChange={(_key, value) =>
              patch(p.id, { default: p.type === 'asset' && value === '' ? null : value })
            }
          />
          <label>
            <input
              type="checkbox"
              checked={!!p.required}
              onChange={(e) => patch(p.id, { required: e.target.checked })}
            />
            必須入力
          </label>
          {p.type === 'number' && (
            <>
              <label>
                最小値
                <input
                  type="number"
                  value={p.min ?? ''}
                  onChange={(e) =>
                    patch(p.id, { min: e.target.value === '' ? undefined : Number(e.target.value) })
                  }
                />
              </label>
              <label>
                最大値
                <input
                  type="number"
                  value={p.max ?? ''}
                  onChange={(e) =>
                    patch(p.id, { max: e.target.value === '' ? undefined : Number(e.target.value) })
                  }
                />
              </label>
            </>
          )}
          {p.type === 'enum' && (
            <label>
              選択肢（1行に1項目）
              <textarea
                value={p.options?.join('\n') ?? ''}
                onChange={(e) => patch(p.id, { options: e.target.value.split('\n') })}
              />
            </label>
          )}
          <button
            onClick={() =>
              onChange({
                ...contract,
                properties: contract.properties.filter((v) => v.id !== p.id),
                variants: contract.variants.map((v) => ({
                  ...v,
                  values: Object.fromEntries(
                    Object.entries(v.values).filter(([id]) => id !== p.id),
                  ),
                })),
              })
            }
          >
            「{p.label}」の公開をやめる
          </button>
        </details>
      ))}
      <fieldset>
        <legend>公開入力を追加</legend>
        <label>
          対象の部品
          <select
            value={partId}
            onChange={(e) => {
              setPartId(e.target.value);
              setField('');
            }}
          >
            {contract.parts.map((p) => {
              const value = native.get(p.nativeId);
              return (
                <option key={p.id} value={p.id}>
                  {String(value?.name ?? value?.text ?? value?.type ?? p.id).slice(0, 35)} —{' '}
                  {p.nativeId}
                </option>
              );
            })}
          </select>
        </label>
        <label>
          公開する属性
          <select value={field} onChange={(e) => setField(e.target.value)}>
            <option value="">選択</option>
            {suggestions.map((p) => (
              <option key={p.targets[0].field} value={p.targets[0].field}>
                {p.label}（{p.type}）
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={!field || contract.properties.length >= 256}
          onClick={() => {
            const suggested = suggestions.find((p) => p.targets[0].field === field);
            if (!suggested) return;
            const existing = contract.properties.some((p) =>
              p.targets.some((t) => t.partId === partId && t.field === field),
            );
            if (existing) return;
            onChange({
              ...contract,
              properties: [
                ...contract.properties,
                { ...clone(suggested), id: 'property_' + crypto.randomUUID() },
              ],
            });
          }}
        >
          入力を追加
        </button>
      </fieldset>
      <h3>表示バリエーション</h3>
      {contract.variants.map((variant) => (
        <details key={variant.id}>
          <summary>{variant.label}</summary>
          <label>
            バリエーション名
            <input
              value={variant.label}
              onChange={(e) =>
                onChange({
                  ...contract,
                  variants: contract.variants.map((v) =>
                    v.id === variant.id ? { ...v, label: e.target.value } : v,
                  ),
                })
              }
            />
          </label>
          <TemplateInputForm
            fields={inputFields}
            values={{ ...defaults, ...variant.values }}
            onChange={() => {}}
            onFieldChange={(id, value) =>
              onChange({
                ...contract,
                variants: contract.variants.map((v) =>
                  v.id === variant.id
                    ? { ...v, values: { ...v.values, [id]: value as JsonValue } }
                    : v,
                ),
              })
            }
          />
          <button
            onClick={() =>
              onChange({
                ...contract,
                variants: contract.variants.map((v) =>
                  v.id === variant.id ? { ...v, values: {} } : v,
                ),
              })
            }
          >
            このバリエーションを既定値に戻す
          </button>
        </details>
      ))}
      <button
        disabled={contract.variants.length >= 100}
        onClick={() =>
          onChange({
            ...contract,
            variants: [
              ...contract.variants,
              { id: 'variant_' + crypto.randomUUID(), label: '新しい表示', values: {} },
            ],
          })
        }
      >
        バリエーションを追加
      </button>
      <h3>本文・子部品スロット</h3>
      {contract.slots.map((slot) => (
        <details key={slot.id}>
          <summary>
            {slot.label}（{slot.min}〜{slot.max}件）
          </summary>
          <label>
            スロット名
            <input
              value={slot.label}
              onChange={(e) =>
                onChange({
                  ...contract,
                  slots: contract.slots.map((s) =>
                    s.id === slot.id ? { ...s, label: e.target.value } : s,
                  ),
                })
              }
            />
          </label>
          {(['min', 'max'] as const).map((key) => (
            <label key={key}>
              {key === 'min' ? '最小個数' : '最大個数'}
              <input
                type="number"
                min={0}
                max={100}
                value={slot[key]}
                onChange={(e) =>
                  onChange({
                    ...contract,
                    slots: contract.slots.map((s) =>
                      s.id === slot.id ? { ...s, [key]: Number(e.target.value) } : s,
                    ),
                  })
                }
              />
            </label>
          ))}
          {(slot.domain === 'document'
            ? (['body', 'component'] as const)
            : (['component'] as const)
          ).map((kind) => (
            <label key={kind}>
              <input
                type="checkbox"
                checked={slot.accepts.includes(kind)}
                onChange={(e) =>
                  onChange({
                    ...contract,
                    slots: contract.slots.map((s) =>
                      s.id === slot.id
                        ? {
                            ...s,
                            accepts: e.target.checked
                              ? [...s.accepts, kind]
                              : s.accepts.filter((k) => k !== kind),
                          }
                        : s,
                    ),
                  })
                }
              />
              {kind === 'body' ? '本文' : '子部品'}を許可
            </label>
          ))}
        </details>
      ))}
    </div>
  );
}
