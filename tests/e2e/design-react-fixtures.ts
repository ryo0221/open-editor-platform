import { expect, type Page } from '@playwright/test';
import { create, nativeArtifact } from './fixtures';
import { value } from './practical-fixtures';
import type { DesignContent } from '@editor-platform/design/model';
export async function jsonApply(page: Page, label: string, value: unknown) {
  await page.getByLabel(label, { exact: true }).fill(JSON.stringify(value));
  await page.getByRole('button', { name: `Apply ${label}`, exact: true }).click();
}
export async function layer(page: Page, name: string) {
  await page.getByRole('button', { name: `Layer ${name}`, exact: true }).click();
}
export async function authorDesignReact(page: Page, url = '/') {
  await page.goto(url);
  await create(page, 'design');
  await page.getByRole('button', { name: 'Enable React Web', exact: true }).click();
  await page.getByRole('button', { name: 'Add frame', exact: true }).click();
  await value(page, 'Layer name', 'Product');
  await page.getByLabel('HTML role', { exact: true }).selectOption('main');
  await page.getByLabel('Layout direction', { exact: true }).selectOption('column');
  await jsonApply(page, 'Web responsive layout', {
    base: { height: { kind: 'literal', value: 'auto' } },
    breakpoints: {},
  });
  await value(page, 'Element width', '800');
  await value(page, 'Element height', '600');
  await jsonApply(page, 'Web responsive layout', {
    base: { height: { kind: 'literal', value: 'auto' } },
    breakpoints: { desktop: { padding: { kind: 'literal', value: 32 } } },
  });
  await page.getByRole('button', { name: 'Insert text', exact: true }).click();
  await value(page, 'Layer name', 'Product title');
  await value(page, 'Text', 'Color study');
  await value(page, 'Font size (px)', '24');
  await page.getByLabel('HTML role', { exact: true }).selectOption('h1');
  await page.getByLabel('Parent layer', { exact: true }).selectOption({ label: 'Product' });
  await layer(page, 'Product');
  await page.getByRole('button', { name: 'Add frame', exact: true }).click();
  await value(page, 'Layer name', 'Native card');
  await page.getByLabel('HTML role', { exact: true }).selectOption('article');
  await page.getByLabel('Layout direction', { exact: true }).selectOption('column');
  await jsonApply(page, 'Web responsive layout', {
    base: { height: { kind: 'literal', value: 'auto' } },
    breakpoints: {},
  });
  await page.getByRole('button', { name: 'Insert text', exact: true }).click();
  await value(page, 'Layer name', 'Native title');
  await value(page, 'Text', 'Native product');
  await value(page, 'Font size (px)', '18');
  await page.getByLabel('HTML role', { exact: true }).selectOption('h2');
  await jsonApply(page, 'Web responsive layout', {
    base: { width: { kind: 'literal', value: '100%' }, height: { kind: 'literal', value: 'auto' } },
    breakpoints: {},
  });
  await layer(page, 'Native card');
  await page.getByRole('button', { name: 'Make component', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel publication settings', exact: true }).click();
  let d = (await nativeArtifact(page)).draft.content as DesignContent;
  const component = d.components[0],
    title = component.elements!.find((e) => e.name === 'Native title')!;
  await jsonApply(page, 'Native React component contract', {
    symbol: 'ProductCard',
    version: '1.0.0',
    props: {
      title: {
        schema: { type: 'string', maxLength: 80 },
        required: false,
        default: 'Native product',
        target: { elementId: title.id, field: 'text' },
      },
    },
    variants: { default: {}, blue: { [title.id]: { fill: '#1266aa' } } },
  });
  await jsonApply(page, 'Native React public props', {
    title: 'Reusable native card',
    variant: 'blue',
  });
  await jsonApply(page, 'Web responsive layout', {
    base: { width: { kind: 'literal', value: '100%' }, height: { kind: 'literal', value: 'auto' } },
    breakpoints: {},
  });
  await page.getByLabel('Parent layer', { exact: true }).selectOption({ label: 'Product' });
  d = (await nativeArtifact(page)).draft.content as DesignContent;
  const nativeInstance = d.elements.find((e) => e.type === 'instance')!;
  await layer(page, 'Product');
  await page.getByRole('button', { name: 'Insert React Card', exact: true }).click();
  await value(page, 'Layer name', 'Original Card');
  await value(page, 'Element height', '160');
  await jsonApply(page, 'Web responsive layout', {
    base: { width: { kind: 'literal', value: '100%' }, height: { kind: 'literal', value: 'auto' } },
    breakpoints: {},
  });
  await jsonApply(page, 'React slot body', [nativeInstance.id]);
  await layer(page, 'Product');
  await page
    .getByLabel('Insert image file', { exact: true })
    .setInputFiles('tests/fixtures/office/images/quadrants.png');
  await value(page, 'Layer name', 'Native image');
  await value(page, 'Image alt text', 'Native PNG sample');
  await page.getByLabel('HTML role', { exact: true }).selectOption('img');
  await value(page, 'Element width', '120');
  await value(page, 'Element height', '80');
  await layer(page, 'Product');
  await page.getByRole('button', { name: 'Insert React Image', exact: true }).click();
  await value(page, 'Layer name', 'Original Image');
  await value(page, 'React prop alt', 'Original React PNG sample');
  await layer(page, 'Product');
  await page.getByRole('button', { name: 'Insert React Button', exact: true }).click();
  await value(page, 'React prop label', 'Buy now');
  await value(page, 'Layer name', 'Buy Button');
  await jsonApply(page, 'React bindings', { onPress: { kind: 'callback', callback: 'onBuy' } });
  await layer(page, 'Product');
  await page.getByRole('button', { name: 'Insert text', exact: true }).click();
  await value(page, 'Layer name', 'Contact link');
  await value(page, 'Text', 'Contact us');
  await value(page, 'Font size (px)', '18');
  await page.getByLabel('HTML role', { exact: true }).selectOption('a');
  // A second root Frame is authored using the ordinary canvas Insert command.
  await page.getByLabel('Parent layer', { exact: true }).selectOption('');
  await page
    .getByRole('application', { name: 'Design canvas', exact: true })
    .click({ position: { x: 20, y: 20 } });
  await page.getByRole('button', { name: 'Add frame', exact: true }).click();
  await value(page, 'Layer name', 'Contact');
  await value(page, 'Element x', '1200');
  await value(page, 'Element width', '800');
  await value(page, 'Element height', '600');
  await page.getByLabel('Parent layer', { exact: true }).selectOption('');
  await page.getByLabel('HTML role', { exact: true }).selectOption('main');
  await page.getByLabel('Layout direction', { exact: true }).selectOption('column');
  await jsonApply(page, 'Web responsive layout', {
    base: { height: { kind: 'literal', value: 'auto' } },
    breakpoints: { desktop: { padding: { kind: 'literal', value: 32 } } },
  });
  await page.getByRole('button', { name: 'Insert text', exact: true }).click();
  await value(page, 'Layer name', 'Form title');
  await value(page, 'Text', 'Contact us');
  await value(page, 'Font size (px)', '24');
  await page.getByLabel('HTML role', { exact: true }).selectOption('h1');
  await jsonApply(page, 'Native Web bindings', {
    text: { kind: 'data', input: 'title', path: [] },
  });
  await layer(page, 'Contact');
  await page.getByRole('button', { name: 'Insert React Input', exact: true }).click();
  await value(page, 'React prop label', 'Name');
  await jsonApply(page, 'React bindings', {
    value: { kind: 'data', input: 'name', path: [] },
    onChange: { kind: 'callback', callback: 'onNameChange' },
  });
  await layer(page, 'Contact');
  await page.getByRole('button', { name: 'Insert React Button', exact: true }).click();
  await value(page, 'React prop label', 'Submit');
  await value(page, 'Layer name', 'Submit Button');
  await jsonApply(page, 'React bindings', { onPress: { kind: 'callback', callback: 'onBuy' } });
  d = (await nativeArtifact(page)).draft.content as DesignContent;
  const settings = {
    ...d.web!,
    inputs: {
      title: { schema: { type: 'string', maxLength: 80 }, required: true },
      name: { schema: { type: 'string', maxLength: 80 }, required: true },
    },
    callbacks: {
      onBuy: { parameters: [], returns: 'void' },
      onNameChange: { parameters: [{ type: 'string', maxLength: 80 }], returns: 'void' },
    },
    fixture: { title: 'Color study', name: '' },
    pages: [
      {
        frameId: d.elements.find((e) => e.name === 'Product')!.id,
        symbol: 'ProductPage',
        path: '/',
      },
      {
        frameId: d.elements.find((e) => e.name === 'Contact')!.id,
        symbol: 'ContactPage',
        path: '/contact',
      },
    ],
  };
  await jsonApply(page, 'React page settings', settings);
  await layer(page, 'Contact link');
  await page.getByLabel('Link page', { exact: true }).selectOption(settings.pages[1].frameId);
  await page.getByLabel('Parent layer', { exact: true }).selectOption(settings.pages[0].frameId);
  await expect(page.getByRole('application', { name: 'Design canvas', exact: true })).toBeVisible();
  return (await nativeArtifact(page)).draft.content as DesignContent;
}
