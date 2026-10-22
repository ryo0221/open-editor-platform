import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { PropertyInput, type PropertyInputProps } from './index';

const render = (props: Partial<PropertyInputProps> = {}) =>
  renderToStaticMarkup(
    createElement(PropertyInput, { label: 'Value', value: '', onChange: () => {}, ...props }),
  );

it.each(['', '-', '1.', '-0.25'])('retains the unparsed numeric editing buffer %j', (value) => {
  const html = render({ type: 'number', value });
  expect(html).toContain('type="text"');
  expect(html).toContain('inputMode="decimal"');
  expect(html).toContain(`value="${value}"`);
});

it('distinguishes the select placeholder from a legitimate empty option', () => {
  const html = render({
    type: 'select',
    value: '',
    emptyValue: '__unset__',
    options: [
      { value: '', label: 'Empty value' },
      { value: 'a', label: 'A' },
    ],
  });
  expect(html).toContain('<option value="__unset__">—</option>');
  expect(html).toContain('<option value="" selected="">Empty value</option>');
});

it('renders JSON as escaped editable text rather than executable markup', () => {
  const html = render({ type: 'json', value: '<script>alert(1)</script>' });
  expect(html).toContain('<textarea');
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(html).not.toContain('<script>');
});

it.each(['text', 'number', 'date', 'select', 'json'] as const)(
  'disables read-only %s controls',
  (type) => {
    expect(render({ type, readOnly: true })).toContain('disabled=""');
    expect(render({ type })).not.toContain('disabled=');
  },
);

it('connects the visible label, description and diagnostics to the same control', () => {
  const html = render({
    showLabel: true,
    required: true,
    description: 'Use a number',
    diagnostics: ['Invalid value'],
  });
  const id = html.match(/<input id="([^"]+)"/)![1];
  expect(html).toContain(`<label for="${id}">Value *</label>`);
  expect(html).toContain(`aria-describedby="${id}-messages"`);
  expect(html).toContain(`id="${id}-messages"`);
  expect(html).toContain('aria-invalid="true"');
  expect(html).toContain('<small>Use a number</small>');
  expect(html).toContain('<div role="alert">Invalid value</div>');
});

it('does not mark a valid compact input invalid or reference absent diagnostics', () => {
  const html = render({ value: 'Ready' });
  expect(html).toContain('aria-label="Value"');
  expect(html).not.toContain('aria-invalid');
  expect(html).not.toContain('aria-describedby');
});

it('preserves native date semantics', () => {
  expect(render({ type: 'date', value: '2026-10-21' })).toContain('type="date"');
  expect(render({ type: 'date', value: '2026-10-21' })).toContain('value="2026-10-21"');
});
