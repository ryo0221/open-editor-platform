import { test, expect, nativeArtifact, save, create } from './fixtures';
import { authorDesignReact, jsonApply, layer } from './design-react-fixtures';
import { value } from './practical-fixtures';
import type { DesignContent } from '@editor-platform/design/model';
import type { ReactUiDocument } from '@editor-platform/react-ui-core';
import type { Page } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import { unzipSync, strFromU8 } from 'fflate';
const run = promisify(execFile);
async function design(page: Page) {
  return (await nativeArtifact(page)).draft.content as DesignContent;
}
async function activate(page: Page, name: string) {
  const nav = page.getByRole('navigation', { name: 'Artifacts', exact: true });
  if (!(await nav.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await nav.getByRole('button').filter({ hasText: name }).click();
}
async function reviewedZip(page: Page, name: string, selected = false) {
  await page
    .getByRole('button', {
      name: selected ? 'Review selected React export' : 'Review React export',
      exact: true,
    })
    .click();
  const review = page.getByRole('dialog', { name: 'Review Design React export', exact: true });
  await expect(review).toBeVisible();
  await review.getByRole('button', { name: 'Accept reviewed conversion', exact: true }).click();
  const pending = page.waitForEvent('download');
  await review.getByRole('button', { name: 'Download React bundle', exact: true }).click();
  const download = await pending;
  await mkdir('work/issue-29-review', { recursive: true });
  const path = `work/issue-29-review/${name}.zip`;
  await download.saveAs(path);
  await review.getByRole('button', { name: 'Close export review', exact: true }).click();
  return { path, files: unzipSync(new Uint8Array(await readFile(path))) };
}
test('#30 normal duplicate remaps external and native slots, keeps retained Card pins and exports independent edits', async ({
  page,
  context,
}, info) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(12000);
  let d = await authorDesignReact(page);
  const native = d.elements.find((e) => e.type === 'instance')!,
    c = d.components[0];
  const oldCard = d.elements.find((e) => e.name === 'Original Card')!.react!.component;
  await layer(page, 'Original Card');
  await jsonApply(page, 'React slot body', []);
  await layer(page, native.name);
  await page.getByLabel('Parent layer', { exact: true }).selectOption({ label: 'Product' });
  await jsonApply(page, 'Native React component contract', {
    ...c.web,
    slots: {
      body: {
        prop: 'children',
        minimum: 0,
        maximum: 4,
        accepts: [{ registryId: 'reference', componentId: 'Button' }],
        elementId: c.elements!.find((e) => e.type === 'frame')!.id,
      },
    },
  });
  await layer(page, 'Product');
  await page.getByRole('button', { name: 'Insert React Button', exact: true }).click();
  await value(page, 'Layer name', 'Slot button');
  await value(page, 'React prop label', 'Original slot button');
  d = await design(page);
  const child = d.elements.find((e) => e.name === 'Slot button')!;
  await layer(page, native.name);
  await jsonApply(page, 'Native React slot body', [child.id]);
  await page.getByRole('button', { name: 'Edit selection', exact: true }).click();
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  d = await design(page);
  const copy = d.elements.find((e) => e.name === native.name + ' copy')!,
    copiedChild = d.elements.find((e) => e.parentId === copy.id)!;
  expect(copy.webSlots!.body).toEqual([copiedChild.id]);
  expect(copy.webSlots!.body).not.toContain(child.id);
  await layer(page, copiedChild.name);
  await value(page, 'Layer name', 'Native duplicate button');
  await value(page, 'React prop label', 'Independent native copy');
  await layer(page, 'Original Card');
  await jsonApply(page, 'React slot body', [native.id]);
  await page.getByRole('button', { name: 'Edit selection', exact: true }).click();
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  d = await design(page);
  const externalCopy = d.elements.find((e) => e.name === 'Original Card copy')!;
  const nestedCopy = d.elements.find((e) => e.parentId === externalCopy.id)!;
  const deepChild = d.elements.find((e) => e.parentId === nestedCopy.id)!;
  expect(externalCopy.react!.slots.body).toEqual([nestedCopy.id]);
  expect(nestedCopy.webSlots!.body).toEqual([deepChild.id]);
  await layer(page, deepChild.name);
  await value(page, 'React prop label', 'Independent external copy');
  await layer(page, 'Product');
  await page.getByRole('button', { name: 'Add frame', exact: true }).click();
  await value(page, 'Layer name', 'Native B');
  await page.getByLabel('HTML role', { exact: true }).selectOption('article');
  await page.getByRole('button', { name: 'Make component', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel publication settings', exact: true }).click();
  await jsonApply(page, 'Native React component contract', {
    symbol: 'SecondCard',
    version: '1.0.0',
    props: {},
    variants: { default: {} },
  });
  await page.getByLabel('Parent layer', { exact: true }).selectOption({ label: 'Product' });
  await save(page, 1);
  d = await design(page);
  await page.reload();
  expect(await design(page)).toEqual(d);
  expect(d.elements.find((e) => e.name === 'Original Card')!.react!.component).toEqual(oldCard);
  const { path, files } = await reviewedZip(page, 'duplicates');
  const composition = JSON.parse(strFromU8(files['composition.json'])) as ReactUiDocument;
  expect(composition.nodes.find((n) => n.id === child.id)!.props.label).toBe(
    'Original slot button',
  );
  expect(composition.nodes.find((n) => n.id === copiedChild.id)!.props.label).toBe(
    'Independent native copy',
  );
  expect(composition.nodes.find((n) => n.id === deepChild.id)!.props.label).toBe(
    'Independent external copy',
  );
  await run(process.execPath, ['scripts/design-react-export-host.mjs', path], {
    maxBuffer: 1024 * 1024,
  });
  const app = await context.newPage();
  const errors: string[] = [];
  app.on('pageerror', (e) => errors.push(e.message));
  app.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  try {
    await app.goto('http://127.0.0.1:4176/');
    for (const text of [
      'Original slot button',
      'Independent native copy',
      'Independent external copy',
    ])
      await expect(app.getByRole('button', { name: text, exact: true })).toBeVisible();
    await app.screenshot({
      path: info.outputPath('review-duplicates-independent.png'),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
  await page
    .getByRole('button', { name: 'Register native components for React UI', exact: true })
    .click();
  const frame = page.frameLocator('iframe[title="React component preview"]');
  await expect(
    frame.getByRole('button', { name: 'Independent external copy', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    frame.getByRole('button', { name: 'Independent native copy', exact: true }),
  ).toBeVisible();
});
for (const kind of ['reorder', 'prepend', 'between'])
  test(`#30 ordinary React root ${kind} survives independent native regeneration`, async ({
    page,
  }) => {
    test.setTimeout(120000);
    page.setDefaultTimeout(12000);
    await authorDesignReact(page);
    const designName = await page.getByLabel('Artifact name').inputValue();
    await page
      .getByRole('button', { name: 'Register native components for React UI', exact: true })
      .click();
    const targetName = await page.getByLabel('Artifact name').inputValue(),
      target = await nativeArtifact(page);
    const basis = target.draft.content as ReactUiDocument;
    if (kind === 'reorder')
      await page
        .getByRole('button', { name: `${basis.roots[1]} · element-${basis.roots[1]}`, exact: true })
        .click();
    else {
      await page.getByRole('button', { name: 'Insert Button', exact: true }).click();
      await page.getByLabel('Prop label', { exact: true }).fill('Independent root banner');
    }
    await page.getByRole('button', { name: 'Move up', exact: true }).click();
    if (kind === 'prepend')
      await page.getByRole('button', { name: 'Move up', exact: true }).click();
    const edited = (await nativeArtifact(page)).draft.content as ReactUiDocument;
    await activate(page, designName);
    await layer(page, 'Contact link');
    await value(page, 'Text', 'Independent native root update');
    await page.getByLabel('React UI regeneration target', { exact: true }).selectOption(target.id);
    await page.getByRole('button', { name: 'Review React UI regeneration', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Review React UI regeneration', exact: true });
    await expect(
      dialog.getByRole('button', { name: 'Accept React UI regeneration' }),
    ).toBeEnabled();
    await dialog.getByRole('button', { name: 'Accept React UI regeneration' }).click();
    await activate(page, targetName);
    const updated = (await nativeArtifact(page)).draft.content as ReactUiDocument;
    expect(updated.roots).toEqual(edited.roots);
    expect(updated.nodes.some((n) => n.props.text === 'Independent native root update')).toBe(true);
    if (kind !== 'reorder')
      await expect(
        page
          .frameLocator('iframe[title="React component preview"]')
          .getByRole('button', { name: 'Independent root banner' }),
      ).toBeVisible();
    await save(page, 1);
    await page.reload();
    expect(((await nativeArtifact(page)).draft.content as ReactUiDocument).roots).toEqual(
      edited.roots,
    );
  });
test('#30 ordinary conflicting root orders block regeneration', async ({ page }, info) => {
  test.setTimeout(120000);
  page.setDefaultTimeout(12000);
  let d = await authorDesignReact(page);
  const designName = await page.getByLabel('Artifact name').inputValue();
  await layer(page, 'Contact');
  await page.getByRole('button', { name: 'Add frame', exact: true }).click();
  await value(page, 'Layer name', 'Third page');
  await page.getByLabel('Parent layer', { exact: true }).selectOption('');
  await page.getByLabel('HTML role', { exact: true }).selectOption('main');
  d = await design(page);
  const settings = {
    ...d.web!,
    pages: [
      ...d.web!.pages,
      {
        frameId: d.elements.find((e) => e.name === 'Third page')!.id,
        symbol: 'ThirdPage',
        path: '/third',
      },
    ],
  };
  await jsonApply(page, 'React page settings', settings);
  await page
    .getByRole('button', { name: 'Register native components for React UI', exact: true })
    .click();
  const target = await nativeArtifact(page),
    roots = (target.draft.content as ReactUiDocument).roots;
  await page
    .getByRole('button', { name: `${roots[1]} · element-${roots[1]}`, exact: true })
    .click();
  await page.getByRole('button', { name: 'Move up', exact: true }).click();
  await activate(page, designName);
  await jsonApply(page, 'React page settings', {
    ...settings,
    pages: [settings.pages[0], settings.pages[2], settings.pages[1]],
  });
  await page.getByLabel('React UI regeneration target', { exact: true }).selectOption(target.id);
  await page.getByRole('button', { name: 'Review React UI regeneration', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review React UI regeneration', exact: true });
  await expect(dialog.locator('pre')).toContainText('roots');
  await expect(dialog.getByRole('button', { name: 'Accept React UI regeneration' })).toBeDisabled();
  await page.screenshot({ path: info.outputPath('review-roots-conflict.png') });
});
/** Deterministic, valid ~1.2 MiB PNG. Actual bytes are uploaded through the normal image input. */
function largePng() {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(640, 0);
  header.writeUInt32BE(640, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc((640 * 3 + 1) * 640);
  let state = 123456789;
  for (let row = 0; row < 640; row++)
    for (let x = 1; x <= 640 * 3; x++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      pixels[row * (640 * 3 + 1) + x] = state & 255;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
test('#30 ordinary Inspector diagnoses unsupported slots/props, hidden routes and output name collisions', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(12000);
  let d = await authorDesignReact(page);
  const native = d.elements.find((e) => e.type === 'instance')!;
  await layer(page, 'Original Card');
  await jsonApply(page, 'React slot body', []);
  await layer(page, 'Product');
  await page.getByRole('button', { name: 'Add frame', exact: true }).click();
  await value(page, 'Layer name', 'Target component');
  await page.getByLabel('HTML role', { exact: true }).selectOption('article');
  await page.getByRole('button', { name: 'Insert React Button', exact: true }).click();
  await value(page, 'Layer name', 'Target original');
  await layer(page, 'Target component');
  await page
    .getByLabel('Insert image file', { exact: true })
    .setInputFiles('tests/fixtures/office/images/quadrants.png');
  await value(page, 'Layer name', 'Target image');
  await value(page, 'Image alt text', 'Target PNG');
  await page.getByLabel('HTML role', { exact: true }).selectOption('img');
  await layer(page, native.name);
  await page
    .getByLabel('Parent layer', { exact: true })
    .selectOption({ label: 'Target component' });
  await layer(page, 'Target component');
  await page.getByRole('button', { name: 'Make component', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel publication settings', exact: true }).click();
  d = await design(page);
  const c = d.components.find((c) => c.id !== native.componentId)!;
  await layer(page, d.elements.find((e) => e.componentId === c.id)!.name);
  await jsonApply(page, 'Native React public props', {});
  const base = {
    symbol: 'TargetComponent',
    version: '1.0.0',
    props: {},
    variants: { default: {} },
  };
  for (const type of ['react', 'instance', 'image']) {
    const target = c.elements!.find((e) => e.type === type)!;
    await jsonApply(page, 'Native React component contract', {
      ...base,
      slots: {
        body: {
          prop: 'children',
          minimum: 0,
          maximum: 4,
          accepts: [{ registryId: 'reference', componentId: 'Button' }],
          elementId: target.id,
        },
      },
    });
    await page.getByRole('button', { name: 'Review React export', exact: true }).click();
    await expect(page.locator('.surface-error[role="alert"]')).toContainText(target.id);
    await expect(page.locator('.surface-error[role="alert"]')).toContainText(
      /slot.*requires.*non-image/i,
    );
    await expect(
      page.getByRole('dialog', { name: 'Review Design React export', exact: true }),
    ).toHaveCount(0);
  }
  for (const type of ['react', 'instance', 'image']) {
    const target = c.elements!.find((e) => e.type === type)!;
    await jsonApply(page, 'Native React component contract', {
      ...base,
      variants: { default: { [target.id]: { fill: '#123456' } } },
    });
    await page.getByRole('button', { name: 'Review React export', exact: true }).click();
    await expect(page.locator('.surface-error[role="alert"]')).toContainText(target.id);
    await expect(page.locator('.surface-error[role="alert"]')).toContainText(
      /Variant .*not render/,
    );
  }
  const frame = c.elements!.find((e) => e.type === 'frame')!;
  await jsonApply(page, 'Native React component contract', {
    ...base,
    props: {
      source: {
        schema: { type: 'string' },
        required: false,
        target: { elementId: frame.id, field: 'src' },
      },
    },
  });
  await page.getByRole('button', { name: 'Review React export', exact: true }).click();
  await expect(page.locator('.surface-error[role="alert"]')).toContainText(frame.id);
  await expect(page.locator('.surface-error[role="alert"]')).toContainText(
    /public.*targets.*not rendered/i,
  );
  await jsonApply(page, 'Native React component contract', base);
  const { files } = await reviewedZip(page, 'diagnostics-baseline');
  d = await design(page);
  const names = [
    'Site',
    'NativeComponents',
    Object.keys(files)
      .find((p) => p.startsWith('Component_') && p.endsWith('.tsx'))!
      .slice(0, -4),
    Object.keys(files)
      .find((p) => /^N[0-9a-f]+\.tsx$/.test(p))!
      .slice(0, -4),
  ];
  for (const symbol of names) {
    await jsonApply(page, 'React page settings', {
      ...d.web!,
      pages: d.web!.pages.map((p, i) => (i === 0 ? { ...p, symbol } : p)),
    });
    await page.getByRole('button', { name: 'Review React export', exact: true }).click();
    await expect(page.locator('.surface-error[role="alert"]')).toContainText(/collision|reserved/i);
    await expect(
      page.getByRole('dialog', { name: 'Review Design React export', exact: true }),
    ).toHaveCount(0);
  }
  await jsonApply(page, 'React page settings', d.web!);
  await page.getByRole('button', { name: 'Hide Contact', exact: true }).click();
  await page.getByRole('button', { name: 'Review React export', exact: true }).click();
  await expect(page.locator('.surface-error[role="alert"]')).toContainText(/hidden/i);
  await expect(
    page.getByRole('dialog', { name: 'Review Design React export', exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('review-hidden-route-diagnostic.png') });
});
test('#30 large image acceptance stays native-importable and refuses same-version publication changes', async ({
  page,
  context,
}, info) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(12000);
  let d = await authorDesignReact(page);
  const c = d.components[0],
    native = d.elements.find((e) => e.type === 'instance')!;
  const png = largePng();
  expect(png.length).toBeGreaterThan(1024 * 1024);
  await layer(page, 'Product');
  await page
    .getByLabel('Insert image file', { exact: true })
    .setInputFiles({ name: 'large.png', mimeType: 'image/png', buffer: png });
  await value(page, 'Layer name', 'Large native image');
  await value(page, 'Image alt text', 'Large PNG roundtrip');
  await page.getByLabel('HTML role', { exact: true }).selectOption('img');
  await value(page, 'Element width', '120');
  await value(page, 'Element height', '80');
  const { path } = await reviewedZip(page, 'large-v1');
  await run(process.execPath, ['scripts/design-react-export-host.mjs', path], {
    maxBuffer: 1024 * 1024,
  });
  const app = await context.newPage();
  try {
    await app.goto('http://127.0.0.1:4176/');
    const img = app.getByRole('img', { name: 'Large PNG roundtrip' });
    await expect(img).toBeVisible();
    expect(await img.evaluate((e) => (e as HTMLImageElement).naturalWidth)).toBe(640);
    await app.screenshot({
      path: info.outputPath('review-large-image-independent.png'),
      fullPage: true,
    });
  } finally {
    await app.close();
  }
  d = await design(page);
  expect(JSON.stringify(d.web).length).toBeLessThan(100000);
  expect(d.web!.accepted!.files).toBeUndefined();
  await save(page, 1);
  await page.reload();
  expect(await design(page)).toEqual(d);
  await layer(page, native.name);
  const updated = {
    ...c.web!,
    variants: {
      default: {},
      blue: { [c.elements!.find((e) => e.name === 'Native title')!.id]: { fill: '#aa2255' } },
    },
  };
  await jsonApply(page, 'Native React component contract', updated);
  await page.getByRole('button', { name: 'Review React export', exact: true }).click();
  await expect(page.locator('.surface-error[role="alert"]')).toContainText(
    /version.*immutable|immutable.*version/i,
  );
  await expect(
    page.getByRole('dialog', { name: 'Review Design React export', exact: true }),
  ).toHaveCount(0);
  await jsonApply(page, 'Native React component contract', { ...updated, version: '2.0.0' });
  await reviewedZip(page, 'large-v2');
  d = await design(page);
  expect(d.web!.publications!.map((p) => p.version)).toEqual(['1.0.0', '2.0.0']);
  await save(page, 2);
  const exported = await nativeArtifact(page);
  if (!(await page.getByLabel('Import artifact', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'large-native.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(exported)),
  });
  await expect.poll(async () => (await nativeArtifact(page)).id).not.toBe(exported.id);
  expect((await nativeArtifact(page)).draft.content).toEqual(d);
  await page.reload();
  await layer(page, 'Product');
  await page.getByRole('button', { name: 'Preview selected Design as React', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Design React preview', exact: true });
  await expect(
    dialog.frameLocator('iframe').getByRole('img', { name: 'Large PNG roundtrip' }),
  ).toBeVisible();
});
test('#30 ordinary auxiliary SVG review accepts a bounded receipt without Web semantics', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'design');
  await page.getByRole('button', { name: 'Enable React Web', exact: true }).click();
  await page.getByRole('button', { name: 'Insert text', exact: true }).click();
  await value(page, 'Text', 'Auxiliary native graphic');
  await page.getByLabel('React SVG graphic', { exact: true }).check();
  const { files } = await reviewedZip(page, 'auxiliary-svg');
  expect(files['Graphic.tsx']).toBeDefined();
  expect(files['Site.tsx']).toBeUndefined();
  const d = await design(page);
  expect(d.web!.accepted!.files).toBeUndefined();
  expect(d.web!.publications).toEqual([]);
  await save(page, 1);
  await page.reload();
  expect(await design(page)).toEqual(d);
});

test('#30 followup selected component without pages accepts, downloads and builds the actual ZIP', async ({
  page,
  context,
}, info) => {
  test.setTimeout(180000);
  const d = await authorDesignReact(page),
    native = d.elements.find((e) => e.type === 'instance')!;
  await jsonApply(page, 'React page settings', { ...d.web, pages: [] });
  await layer(page, native.name);
  const { path, files } = await reviewedZip(page, 'selected-no-pages', true);
  const composition = JSON.parse(strFromU8(files['composition.json'])) as ReactUiDocument;
  expect(composition.roots).toEqual([native.id]);
  expect(Object.keys(files)).toContain('DesignComposition.tsx');
  await save(page, 1);
  const accepted = await design(page);
  expect(accepted.web!.accepted!.fingerprint).toBeTruthy();
  await page.reload();
  expect(await design(page)).toEqual(accepted);
  await run(process.execPath, ['scripts/design-react-export-host.mjs', path], {
    maxBuffer: 1024 * 1024,
  });
  const app = await context.newPage();
  const errors: string[] = [];
  app.on('pageerror', (e) => errors.push(e.message));
  app.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  try {
    await app.goto('http://127.0.0.1:4176/');
    await expect(app.getByRole('heading', { name: 'Reusable native card' })).toBeVisible();
    await expect(app.getByRole('button', { name: 'Buy now' })).toHaveCount(0);
    await app.screenshot({ path: info.outputPath('selected-component.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
for (const kind of ['native', 'react'] as const)
  test(`#30 followup child-only ${kind} slot duplicate, atomic Undo, independent edits and output`, async ({
    page,
    context,
  }, info) => {
    test.setTimeout(180000);
    let d = await authorDesignReact(page);
    const native = d.elements.find((e) => e.type === 'instance')!,
      c = d.components[0];
    const owner = kind === 'native' ? native : d.elements.find((e) => e.name === 'Original Card')!;
    if (kind === 'native') {
      await layer(page, 'Original Card');
      await jsonApply(page, 'React slot body', []);
      await layer(page, native.name);
      await page.getByLabel('Parent layer', { exact: true }).selectOption({ label: 'Product' });
      await jsonApply(page, 'Native React component contract', {
        ...c.web,
        slots: {
          body: {
            prop: 'children',
            minimum: 0,
            maximum: 2,
            accepts: [{ registryId: 'reference', componentId: 'Button' }],
            elementId: c.elements!.find((e) => e.type === 'frame')!.id,
          },
        },
      });
    }
    const child = d.elements.find((e) => e.name === 'Buy Button')!;
    await layer(page, owner.name);
    await jsonApply(page, kind === 'native' ? 'Native React slot body' : 'React slot body', [
      child.id,
    ]);
    d = await design(page);
    await layer(page, child.name);
    await page.getByRole('button', { name: 'Edit selection', exact: true }).click();
    await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
    const duplicated = await design(page),
      copy = duplicated.elements.find((e) => e.name === child.name + ' copy')!;
    const parent = duplicated.elements.find((e) => e.id === owner.id)!;
    expect(parent.react?.slots.body ?? parent.webSlots!.body).toEqual([child.id, copy.id]);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect(await design(page)).toEqual(d);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    expect(await design(page)).toEqual(duplicated);
    if (kind === 'native') {
      await layer(page, copy.name);
      await page.getByRole('button', { name: 'Edit selection', exact: true }).click();
      await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
      await expect(page.locator('.surface-error[role="alert"]')).toContainText(/slot limits/);
      expect(await design(page)).toEqual(duplicated);
    }
    await layer(page, child.name);
    await value(page, 'React prop label', `Original ${kind} child`);
    await layer(page, copy.name);
    await value(page, 'React prop label', `Independent ${kind} child`);
    await save(page, 1);
    const saved = await design(page);
    await page.reload();
    expect(await design(page)).toEqual(saved);
    const { path } = await reviewedZip(page, `child-only-${kind}`);
    await run(process.execPath, ['scripts/design-react-export-host.mjs', path], {
      maxBuffer: 1024 * 1024,
    });
    const app = await context.newPage();
    const errors: string[] = [];
    app.on('pageerror', (e) => errors.push(e.message));
    app.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    try {
      await app.goto('http://127.0.0.1:4176/');
      await expect(app.getByRole('button', { name: `Original ${kind} child` })).toBeVisible();
      await expect(app.getByRole('button', { name: `Independent ${kind} child` })).toBeVisible();
      await app.getByRole('button', { name: `Independent ${kind} child` }).click();
      await expect(app.locator('#app-status')).toContainText('Submitted 1');
      await app.screenshot({ path: info.outputPath(`child-only-${kind}.png`), fullPage: true });
      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });
test('#30 followup ordinary Inspector refuses reserved props and invalid known HTML', async ({
  page,
}) => {
  test.setTimeout(180000);
  let d = await authorDesignReact(page);
  const error = page.locator('.surface-error[role="alert"]');
  const prepare = async () => {
    await page.getByRole('button', { name: 'Review React export', exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: 'Review Design React export', exact: true }),
    ).toHaveCount(0);
  };
  await jsonApply(page, 'React page settings', {
    ...d.web,
    inputs: { ...d.web!.inputs, path: { schema: { type: 'number' }, required: false, default: 4 } },
  });
  await prepare();
  await expect(error).toContainText(/reserves path/);
  await jsonApply(page, 'React page settings', d.web);
  const native = d.elements.find((e) => e.type === 'instance')!,
    c = d.components[0];
  await layer(page, native.name);
  await jsonApply(page, 'Native React component contract', {
    ...c.web,
    props: { ...c.web!.props, variant: c.web!.props.title },
  });
  await prepare();
  await expect(error).toContainText(/reserve.*variant/);
  await jsonApply(page, 'Native React component contract', c.web);
  // Move a native frame and its existing heading under a phrasing-only container.
  await layer(page, 'Product');
  await page.getByLabel('HTML role', { exact: true }).selectOption('p');
  await prepare();
  await expect(error).toContainText(/HTML .* not allowed/);
  await page.getByLabel('HTML role', { exact: true }).selectOption('main');
  await reviewedZip(page, 'followup-diagnostics-repaired');
  d = await design(page);
  expect(d.web!.accepted).toBeTruthy();
});
for (const kind of ['native', 'react'] as const)
  test(`#30 premerge ordinary ${kind} slot Delete/Cut keeps export valid and Undo atomic`, async ({
    page,
  }, info) => {
    test.setTimeout(180000);
    let d = await authorDesignReact(page);
    const native = d.elements.find((e) => e.type === 'instance')!,
      c = d.components[0];
    const owner = kind === 'native' ? native : d.elements.find((e) => e.name === 'Original Card')!;
    if (kind === 'native') {
      await layer(page, 'Original Card');
      await jsonApply(page, 'React slot body', []);
      await layer(page, native.name);
      await page.getByLabel('Parent layer', { exact: true }).selectOption({ label: 'Product' });
      await jsonApply(page, 'Native React component contract', {
        ...c.web,
        slots: {
          body: {
            prop: 'children',
            minimum: 0,
            maximum: 1,
            accepts: [{ registryId: 'reference', componentId: 'Button' }],
            elementId: c.elements!.find((e) => e.type === 'frame')!.id,
          },
        },
      });
    }
    const child = d.elements.find((e) => e.name === 'Buy Button')!;
    await layer(page, owner.name);
    await jsonApply(page, kind === 'native' ? 'Native React slot body' : 'React slot body', [
      child.id,
    ]);
    const before = await design(page);
    const children = (content: DesignContent) => {
      const parent = content.elements.find((e) => e.id === owner.id)!;
      return parent.react?.slots.body ?? parent.webSlots!.body;
    };
    for (const action of ['Delete', 'Cut']) {
      await layer(page, child.name);
      await page.getByRole('button', { name: 'Edit selection', exact: true }).click();
      await page.getByRole('button', { name: action, exact: true }).click();
      d = await design(page);
      expect(children(d)).toEqual([]);
      expect(d.elements.some((e) => e.id === child.id)).toBe(false);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      expect(await design(page)).toEqual(before);
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      expect(await design(page)).toEqual(d);
      if (action === 'Delete') {
        await page.getByRole('button', { name: 'Undo', exact: true }).click();
        expect(await design(page)).toEqual(before);
      }
    }
    await save(page, 1);
    d = await design(page);
    await page.reload();
    expect(await design(page)).toEqual(d);
    const { files } = await reviewedZip(page, `premerge-delete-cut-${kind}`);
    const doc = JSON.parse(strFromU8(files['composition.json'])) as ReactUiDocument;
    expect(doc.nodes.some((n) => n.id === child.id)).toBe(false);
    expect(doc.nodes.find((n) => n.id === owner.id)!.slots.body).toEqual([]);
    await page.screenshot({
      path: info.outputPath(`premerge-delete-cut-${kind}.png`),
      fullPage: true,
    });
  });
test('#30 premerge ordinary React insertion respects maximum and recovers after Delete', async ({
  page,
}) => {
  test.setTimeout(180000);
  await authorDesignReact(page);
  await layer(page, 'Original Card');
  // The ordinary Library selects the first published slot. Retained Card body allows 32 children.
  for (let i = 1; i < 32; i++) {
    await page.getByRole('button', { name: 'Insert React Button', exact: true }).click();
    await value(page, 'Layer name', `Slot addition ${i}`);
    await layer(page, 'Original Card');
  }
  const before = await design(page);
  await layer(page, 'Original Card');
  await page.getByRole('button', { name: 'Insert React Button', exact: true }).click();
  await expect(page.locator('.surface-error[role="alert"]')).toContainText(
    /cardinality outside limits/,
  );
  expect(await design(page)).toEqual(before);
  // Free one slot using the ordinary Delete and verify a valid insertion succeeds again.
  const owner = before.elements.find((e) => e.name === 'Original Card')!;
  const child = before.elements.find((e) => e.id === owner.react!.slots.body.at(-1))!;
  await layer(page, child.name);
  await page.getByRole('button', { name: 'Edit selection', exact: true }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await layer(page, 'Original Card');
  await page.getByRole('button', { name: 'Insert React Button', exact: true }).click();
  expect(
    (await design(page)).elements.find((e) => e.id === owner.id)!.react!.slots.body,
  ).toHaveLength(32);
  await reviewedZip(page, 'premerge-insert-limit');
});
