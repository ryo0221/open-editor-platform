import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { clone } from '@editor-platform/artifact-core';
import { sealReactComponent } from '@editor-platform/react-ui-core';
import { createReferenceDocument } from '../../../apps/react-ui-reference/src/catalog';
import { ReactUiTree } from './tree';
it('required-slot Library action is disabled and has an accessible addressed recovery', () => {
  const document = clone(createReferenceDocument()),
    old = document.components.find((c) => c.name === 'Card')!;
  const { contractHash: _hash, ...ref } = old.ref;
  const c = sealReactComponent({
    ...old,
    ref,
    slots: { ...old.slots, body: { ...old.slots.body, minimum: 1 } },
  });
  document.components = document.components.map((r) => (r === old ? c : r));
  document.nodes.find((n) => n.id === 'card')!.component = c.ref;
  const html = renderToStaticMarkup(
    createElement(ReactUiTree, { document, readOnly: false, execute: () => {}, select: () => {} }),
  );
  expect(html).toMatch(
    /<button disabled="" aria-describedby="react-ui-insert-recovery-0">Insert Card/,
  );
  expect(html).toContain('Card requires body (at least 1)');
  expect(html).toContain('Import composition JSON');
  expect(html).toMatch(/<button>Insert Button<\/button>/);
});
