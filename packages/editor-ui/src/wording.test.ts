import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Plus } from 'lucide-react';
import { expect, it } from 'vitest';
import {
  CommitInput,
  EditorWordingProvider,
  IconButton,
  Section,
  T,
  editorUiWording,
  resolveWording,
  type EditorWordingProps,
  type EditorWordingSet,
} from './index';

const set: EditorWordingSet = {
  ja: {
    'Add field': '項目を追加',
    Fields: '項目',
    'View name': 'ビュー名',
    '{0} of {1}': '{1} 中 {0}',
  },
  en: { 縦書き: 'Vertical' },
};

const render = (props: EditorWordingProps) =>
  renderToStaticMarkup(
    createElement(EditorWordingProvider, {
      ...props,
      sets: [editorUiWording, set],
      children: [
        createElement(IconButton, { key: 1, icon: Plus, label: 'Add field' }),
        createElement(Section, {
          key: 2,
          title: 'Fields',
          children: createElement(T, { children: 'Mermaid' }),
        }),
        createElement(CommitInput, { key: 3, label: 'View name', value: '', onCommit: () => {} }),
        createElement(T, { key: 4, children: '縦書き' }),
      ],
    }),
  );

it('shows the wording as written when no locale is chosen', () => {
  const html = render({});
  expect(html).toContain('title="Add field"');
  expect(html).toContain('<summary>Fields</summary>');
  expect(html).toContain('縦書き');
});

it('follows the locale for visible text and tooltips and keeps accessible names', () => {
  const ja = render({ locale: 'ja' });
  expect(ja).toContain('title="項目を追加"');
  expect(ja).toContain('data-tooltip="項目を追加"');
  expect(ja).toContain('aria-label="Add field"');
  expect(ja).toContain('<summary>項目</summary>');
  expect(ja).toContain('ビュー名<input aria-label="View name"');
  // A term without an entry stays as written.
  expect(ja).toContain('Mermaid');
  const en = render({ locale: 'en' });
  expect(en).toContain('title="Add field"');
  expect(en).toContain('Vertical');
  expect(en).not.toContain('縦書き');
});

it('lets a Host replace any wording, with or without a locale', () => {
  expect(render({ locale: 'ja', labels: { Fields: '欄' } })).toContain('<summary>欄</summary>');
  expect(render({ labels: { Fields: 'Columns' } })).toContain('<summary>Columns</summary>');
});

it('fills numbered places in the order the wording gives them', () => {
  expect(resolveWording('ja', [set])('{0} of {1}', 2, 10)).toBe('10 中 2');
  expect(resolveWording(undefined, [set])('{0} of {1}', 2, 10)).toBe('2 of 10');
  expect(resolveWording('ja', [set], { '{0} of {1}': '{0}/{1}' })('{0} of {1}', 2, 10)).toBe(
    '2/10',
  );
});
