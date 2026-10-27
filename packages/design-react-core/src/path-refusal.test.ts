import { expect, it } from 'vitest';
import {
  createDesign,
  insertDesignPath,
  presetDesignPath,
  designIntentCommand,
  previewDesignIntents,
} from '@editor-platform/design/model';
import { convertDesignToReact } from './convert';
import { configureDesignWeb } from './commands';
import type { DesignWebSettings } from '@editor-platform/design/web-contract';
it('refuses path/schema3 in conversion, React commands and external intent/proposal preparation', () => {
  const content = insertDesignPath(presetDesignPath('cubic')).apply(createDesign());
  expect(() => convertDesignToReact(content)).toThrow('Structured paths/schema3');
  expect(() => configureDesignWeb({} as DesignWebSettings).apply(content)).toThrow('schema3');
  expect(() =>
    designIntentCommand([
      { type: 'update', id: content.elements[0].id, patch: { path: content.elements[0].path } },
    ]),
  ).toThrow('path proposals');
  expect(() =>
    designIntentCommand([{ type: 'delete', ids: [content.elements[0].id] }]).apply(content),
  ).toThrow('Schema3 proposals');
  expect(() =>
    previewDesignIntents(content, [{ type: 'delete', ids: [content.elements[0].id] }]),
  ).toThrow('Schema3 proposals');
});
