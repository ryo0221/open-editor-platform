import { expect, it } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { clone } from '@editor-platform/artifact-core';
import { exportReactUi } from '@editor-platform/react-ui-core';
import { createReferenceDocument, referenceResolution } from '../../../apps/react-ui-reference/src/catalog';
import { ReactComposition } from './index';

it('preview omits optional empty slots so nullish and truthy defaults match generated TSX', () => {
  const doc = clone(createReferenceDocument());
  const card = doc.nodes.find(n => n.id === 'card')!;
  const removed = new Set(card.slots.footer);
  doc.nodes = doc.nodes.filter(n => !removed.has(n.id));
  card.slots.footer = [];
  const components = Object.fromEntries(doc.components.map(c => [JSON.stringify([c.ref.registryId, c.ref.componentId, c.ref.version]),
    c.ref.componentId === 'Card' ? ({ children, footer }: { children?: ReactNode; footer?: ReactNode }) => createElement('section', null, children,
      createElement('p', null, footer ?? 'Default footer'), createElement('p', null, footer ? 'Custom footer' : 'Absent footer')) : () => createElement('span')]));
  const html = renderToStaticMarkup(createElement(ReactComposition, { document: doc, width: 390,
    runtime: { components, providers: { 'theme-provider': ({ children }: { children?: ReactNode }) => children }, assets: { 'product-image': 'data:image/png;base64,AA==' }, resolution: referenceResolution } }));
  expect(html).toContain('Default footer');
  expect(html).toContain('Absent footer');
  expect(exportReactUi(doc, referenceResolution).files['Screen.tsx']).not.toContain('footer={');
});
