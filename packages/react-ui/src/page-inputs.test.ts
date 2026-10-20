import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { clone } from '@editor-platform/artifact-core';
import { createReferenceDocument } from '../../../apps/react-ui-reference/src/catalog';
import { ReactUiPageInputs } from './page-inputs';

it('explicit null preview fixtures override defaults while missing fixtures use them', () => {
  const document = clone(createReferenceDocument());
  document.inputs = {
    nullFlag: { required: false, schema: { type: 'boolean', nullable: true }, default: true },
    missingFlag: { required: false, schema: { type: 'boolean', nullable: true }, default: true },
    nullText: {
      required: false,
      schema: { type: 'string', nullable: true },
      default: 'default text',
    },
    missingText: {
      required: false,
      schema: { type: 'string', nullable: true },
      default: 'default text',
    },
  };
  document.fixture = { nullFlag: null, nullText: null };
  const html = renderToStaticMarkup(
    createElement(ReactUiPageInputs, { document, readOnly: false, execute: () => {} }),
  );
  expect(html).toMatch(/aria-label="Preview input nullFlag"\/>/);
  expect(html).toMatch(/aria-label="Preview input missingFlag" checked=""\/>/);
  expect(html).toMatch(/aria-label="Preview input nullText"[^>]*value=""/);
  expect(html).toMatch(/aria-label="Preview input missingText"[^>]*value="default text"/);
  expect(document.fixture).toEqual({ nullFlag: null, nullText: null });
});
