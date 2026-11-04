import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { createRelationGraph, relationProfile } from './reference';
import { GraphSurface, type GraphSurfaceProps } from './view';

/** The toolbar's markup alone; the Inspector repeats some wording. */
const toolbarOf = (html: string) =>
  html.slice(html.indexOf('role="toolbar"'), html.indexOf('ep-graph-view-controls'));
const render = (props: Partial<GraphSurfaceProps> = {}) =>
  renderToStaticMarkup(
    createElement(GraphSurface, {
      content: createRelationGraph(),
      profile: relationProfile,
      stamp: 'stamp',
      onEdit: () => true,
      select: () => {},
      ...props,
    }),
  );

it('words the toolbar and Inspector in the locale, with Host replacements', () => {
  const ja = render({ locale: 'ja' });
  for (const text of ['ノードを追加', 'グラフの設定', '選択を削除', '表示を戻す', '全体を表示'])
    expect(ja).toContain(text);
  for (const text of ['ノードを接続', '関係の種類', '属性を適用']) expect(ja).toContain(text);
  expect(ja).not.toContain('>Add node<');
  const en = render({ locale: 'en' });
  for (const text of ['>Add node<', '>Connect nodes<', '>Apply attributes<'])
    expect(en).toContain(text);
  expect(en).not.toContain('ノードを追加');
  const replaced = render({ locale: 'ja', labels: { addNode: '工程を追加' } });
  expect(replaced).toContain('工程を追加');
  expect(replaced).toContain('グラフの設定');
  // Accessible names given by aria-label stay stable across locales.
  expect(ja).toContain('aria-label="Node type"');
  expect(ja).toContain('aria-label="Relation type"');
});

it('hides toolbar items without making the Surface read-only', () => {
  const zoomOnly = render({
    locale: 'en',
    toolbar: {
      source: false,
      addNode: false,
      addSection: false,
      arrange: false,
      properties: false,
      delete: false,
    },
  });
  for (const text of [
    '>Add node<',
    '>Graph properties<',
    '>Delete selection<',
    '>Arrange diagram<',
  ])
    expect(toolbarOf(zoomOnly)).not.toContain(text);
  expect(zoomOnly).toContain('aria-label="Zoom in"');
  expect(zoomOnly).toContain('>Fit graph<');
  // Editing stays in the Inspector.
  expect(zoomOnly).toContain('>Add connection<');
  expect(zoomOnly).toContain('>Apply attributes<');
  const none = render({ locale: 'en', toolbar: false });
  expect(none).not.toContain('role="toolbar"');
  expect(none).not.toContain('>Fit graph<');
  expect(none).toContain('>Add connection<');
  const noZoom = render({ locale: 'en', toolbar: { zoom: false } });
  expect(noZoom).toContain('>Add node<');
  expect(noZoom).not.toContain('aria-label="Zoom in"');
});
