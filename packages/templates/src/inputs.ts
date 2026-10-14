import { clone } from '@editor-platform/artifact-core';
import { type Diagnostic, type InputField, type InputValue } from './types';
import { templateLimits } from './limits';
export function inputDefaults(fields: InputField[], samples = false): Record<string, InputValue> {
  return Object.fromEntries(
    fields.flatMap((f) => {
      const value = samples ? (f.example ?? f.default) : f.default;
      if (value !== undefined) return [[f.key, clone(value)]];
      if (f.type === 'object') return [[f.key, inputDefaults(f.fields ?? [], samples)]];
      return [];
    }),
  );
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export function validateInputs(
  fields: InputField[],
  input: unknown,
): { values: Record<string, InputValue>; diagnostics: Diagnostic[]; valid: boolean } {
  const diagnostics: Diagnostic[] = [];
  const error = (path: string, message: string) =>
    diagnostics.push({ code: 'invalid-input', path, message, severity: 'error' });
  const checkObject = (
    definitions: InputField[],
    raw: unknown,
    prefix: string,
  ): Record<string, InputValue> => {
    if (!record(raw)) {
      error(prefix, 'Expected an object');
      return {};
    }
    for (const key of Object.keys(raw))
      if (!definitions.some((f) => f.key === key)) error(`${prefix}${key}`, 'Unknown input field');
    return Object.fromEntries(
      definitions.flatMap((f) => {
        const path = `${prefix}${f.key}`,
          value = raw[f.key] === undefined ? clone(f.default) : raw[f.key];
        if (
          value === undefined ||
          value === null ||
          (value === '' && !['text', 'url', 'asset'].includes(f.type))
        ) {
          if (f.required) error(path, 'This input is required');
          return value === undefined ? [] : [[f.key, value as InputValue]];
        }
        const checked = check(f, value, path);
        return [[f.key, checked]];
      }),
    );
  };
  const check = (f: InputField, value: unknown, path: string): InputValue => {
    if (f.type === 'object') return checkObject(f.fields ?? [], value, `${path}.`);
    if (['list', 'table', 'chart', 'rich-text'].includes(f.type)) {
      if (!Array.isArray(value)) {
        error(path, 'Expected a list');
        return [];
      }
      if (value.length < (f.min ?? (f.required ? 1 : 0)) || value.length > (f.max ?? 100))
        error(path, `Use ${f.min ?? 0}–${f.max ?? 100} items`);
      if (f.type === 'rich-text')
        return value.map((span, i) => {
          if (
            !record(span) ||
            typeof span.text !== 'string' ||
            Object.keys(span).some(
              (k) =>
                ![
                  'text',
                  'bold',
                  'italic',
                  'underline',
                  'strike',
                  'code',
                  'link',
                  'color',
                  'highlight',
                ].includes(k),
            )
          ) {
            error(`${path}.${i}`, 'Invalid rich text span');
            return { text: '' };
          }
          for (const k of ['bold', 'italic', 'underline', 'strike', 'code'])
            if (span[k] !== undefined && typeof span[k] !== 'boolean')
              error(`${path}.${i}.${k}`, 'Expected boolean');
          if (span.link && (typeof span.link !== 'string' || !/^(https?:|mailto:)/.test(span.link)))
            error(`${path}.${i}.link`, 'Use an HTTP(S) or mail link');
          if (span.text.length > (f.maxLength ?? 2000))
            error(path, 'Rich text exceeds the text limit');
          return clone(span) as InputValue;
        });
      return value.map((v, i) =>
        check(
          f.item ?? { key: 'item', label: 'Item', description: '', type: 'text', maxLength: 500 },
          v,
          `${path}.${i}`,
        ),
      );
    }
    if (f.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value))
        error(path, 'Expected a finite number');
      else if (value < (f.min ?? -Infinity) || value > (f.max ?? Infinity))
        error(path, `Number must be between ${f.min ?? '−∞'} and ${f.max ?? '∞'}`);
    } else if (f.type === 'boolean') {
      if (typeof value !== 'boolean') error(path, 'Expected a boolean');
    } else if (typeof value !== 'string') error(path, 'Expected text');
    else {
      if (f.required && !value.trim()) error(path, 'This input is required');
      const limit =
        f.type === 'asset'
          ? Math.min(f.maxLength ?? templateLimits.assetCharacters, templateLimits.assetCharacters)
          : (f.maxLength ?? 5000);
      if (value.length > limit) error(path, `Maximum ${limit} characters`);
      if (f.type === 'enum' && !f.options?.includes(value)) error(path, 'Choose a listed option');
      if (
        f.type === 'date' &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
          !Number.isFinite(Date.parse(value)) ||
          (Number.isFinite(Date.parse(value)) &&
            new Date(value).toISOString().slice(0, 10) !== value))
      )
        error(path, 'Use a valid YYYY-MM-DD date');
      if (f.type === 'url' && value && !/^https?:\/\//.test(value))
        error(path, 'Use an HTTP(S) URL');
      if (
        f.type === 'asset' &&
        value &&
        !/^(asset:\/\/[^\s]+|data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+)$/.test(
          value,
        )
      )
        error(path, 'Choose a portable image, not a temporary URL');
    }
    return clone(value) as InputValue;
  };
  const values = checkObject(fields, input, '');
  return { values, diagnostics, valid: diagnostics.length === 0 };
}
export function fieldAt(fields: InputField[], key: string): InputField | undefined {
  const [first, ...rest] = key.split('.');
  const field = fields.find((f) => f.key === first);
  return rest.length ? fieldAt(field?.fields ?? [], rest.join('.')) : field;
}
export function inputAt(input: unknown, key: string): unknown {
  if (key === '$') return input;
  return key.split('.').reduce<unknown>((v, part) => (record(v) ? v[part] : undefined), input);
}
