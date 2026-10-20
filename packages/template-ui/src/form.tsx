import { useId } from 'react';
import { TemplateRichInput } from './rich-input';
import {
  inputDefaults,
  type InputField,
  type InputValue,
  type Diagnostic,
  type TemplateAsset,
} from '@editor-platform/templates';
export interface TemplateFormProps {
  fields: InputField[];
  values: Record<string, InputValue>;
  onChange(value: Record<string, InputValue>): void;
  onFieldChange?(key: string, value: InputValue): void;
  diagnostics?: Diagnostic[];
  assets?: TemplateAsset[];
}
export function TemplateInputForm({
  fields,
  values,
  onChange,
  onFieldChange,
  diagnostics = [],
  assets = [],
}: TemplateFormProps) {
  const prefix = useId();
  // Repeat diagnostics address stable item IDs, while the form addresses the
  // current row index. Resolve against current values so reordering keeps errors
  // on the right input without changing the public diagnostic or native IDs.
  const fieldDiagnostics = diagnostics.map((diagnostic) => {
    let value: unknown = values;
    const path = diagnostic.path.split('.').map((part) => {
      if (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(part)) {
        const index = value.findIndex(
          (item) => item && typeof item === 'object' && item.id === part,
        );
        if (index >= 0) part = String(index);
      }
      value =
        value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
      return part;
    });
    return { ...diagnostic, path: path.join('.') };
  });
  return (
    <div className="tp-input-form">
      {fields.map((field) => (
        <Field
          key={field.key}
          field={field}
          value={values[field.key]}
          path={field.key}
          prefix={prefix}
          change={(value) => {
            onFieldChange?.(field.key, value);
            onChange({ ...values, [field.key]: value });
          }}
          diagnostics={fieldDiagnostics}
          assets={assets}
        />
      ))}
    </div>
  );
}
function Field({
  field: f,
  value,
  path,
  prefix,
  change,
  diagnostics,
  assets,
}: {
  field: InputField;
  value: InputValue | undefined;
  path: string;
  prefix: string;
  change(value: InputValue): void;
  diagnostics: Diagnostic[];
  assets: TemplateAsset[];
}) {
  const id = `${prefix}-${path}`,
    errors = diagnostics.filter((d) => d.path === path || d.path.startsWith(`${path}.`));
  if (f.type === 'object') {
    const object = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return (
      <fieldset>
        <legend>{f.label}</legend>
        {f.fields?.map((child) => (
          <Field
            key={child.key}
            field={child}
            value={object[child.key]}
            path={`${path}.${child.key}`}
            prefix={prefix}
            change={(next) => change({ ...object, [child.key]: next })}
            diagnostics={diagnostics}
            assets={assets}
          />
        ))}
      </fieldset>
    );
  }
  if (['list', 'table', 'chart'].includes(f.type)) {
    const array = Array.isArray(value) ? value : [];
    if (f.item?.type === 'text' || !f.item)
      return (
        <label htmlFor={id}>
          {f.label}
          <small>{f.description}（1行に1項目）</small>
          <textarea
            id={id}
            data-slot={path}
            value={array.join('\n')}
            onChange={(e) => change(e.target.value ? e.target.value.split('\n') : [])}
            rows={Math.min(7, Math.max(3, array.length))}
            aria-invalid={!!errors.length}
          />
          {errors.map((e, i) => (
            <span className="tp-field-error" key={i}>
              {e.message}
            </span>
          ))}
        </label>
      );
    return (
      <fieldset>
        <legend>{f.label}</legend>
        <p>{f.description}</p>
        {array.map((item, i) => (
          <div className="tp-row" key={i}>
            <Field
              field={{ ...f.item!, label: `${f.item!.label} ${i + 1}` }}
              value={item}
              path={`${path}.${i}`}
              prefix={prefix}
              change={(next) => change(array.map((v, j) => (i === j ? next : v)))}
              diagnostics={diagnostics}
              assets={assets}
            />
            <button
              type="button"
              aria-label={`${f.label} ${i + 1} を削除`}
              onClick={() => change(array.filter((_, j) => j !== i))}
            >
              削除
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            change([
              ...array,
              f.item?.type === 'object'
                ? inputDefaults(f.item.fields ?? [])
                : f.item?.type === 'list'
                  ? Array(f.item.min ?? 0).fill('')
                  : (f.item?.default ?? ''),
            ])
          }
        >
          ＋ {f.label}を追加
        </button>
        {errors
          .filter((e) => e.path === path)
          .map((e, i) => (
            <span role="alert" key={i}>
              {e.message}
            </span>
          ))}
      </fieldset>
    );
  }
  const common = { id, 'data-slot': path, 'aria-invalid': !!errors.length };
  if (f.type === 'rich-text')
    return (
      <div className="tp-rich-field">
        <label htmlFor={id}>{f.label}</label>
        <small>{f.description}</small>
        <TemplateRichInput
          id={id}
          path={path}
          label={f.label}
          value={value}
          invalid={!!errors.length}
          onChange={change}
        />
        {errors.map((error, index) => (
          <span className="tp-field-error" role="alert" key={index}>
            {error.message}
          </span>
        ))}
      </div>
    );
  const assetSource =
    typeof value === 'string'
      ? value.startsWith('data:')
        ? value
        : value.startsWith('asset://')
          ? assets.find((asset) => asset.id === value.slice(8))?.data
          : undefined
      : undefined;
  return (
    <label htmlFor={id}>
      {f.label}
      <small>{f.description}</small>
      {f.type === 'boolean' ? (
        <input
          {...common}
          type="checkbox"
          checked={value === true}
          onChange={(e) => change(e.target.checked)}
        />
      ) : f.type === 'enum' ? (
        <select {...common} value={String(value ?? '')} onChange={(e) => change(e.target.value)}>
          <option value="">選択</option>
          {f.options?.map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      ) : f.type === 'asset' ? (
        <>
          <input
            {...common}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = () => change(String(reader.result));
              reader.readAsDataURL(file);
            }}
          />
          {value && (
            <>
              {assetSource ? (
                <img className="tp-asset" alt={`${f.label}の選択画像`} src={assetSource} />
              ) : (
                <small>保存済みの画像。適用前プレビューで確認できます。</small>
              )}
              <button type="button" onClick={() => change('')}>
                画像を省略
              </button>
            </>
          )}
        </>
      ) : f.type === 'number' ? (
        <input
          {...common}
          type="number"
          value={typeof value === 'number' ? value : ''}
          min={f.min}
          max={f.max}
          onChange={(e) => change(e.target.value === '' ? null : Number(e.target.value))}
        />
      ) : f.type === 'date' ? (
        <input
          {...common}
          type="date"
          value={String(value ?? '')}
          onChange={(e) => change(e.target.value)}
        />
      ) : (
        <textarea
          {...common}
          value={String(value ?? '')}
          onChange={(e) => change(e.target.value)}
          rows={f.maxLength && f.maxLength <= 80 ? 2 : 3}
        />
      )}{' '}
      {errors
        .filter((e) => e.path === path)
        .map((e, i) => (
          <span className="tp-field-error" key={i}>
            {e.message}
          </span>
        ))}
    </label>
  );
}
