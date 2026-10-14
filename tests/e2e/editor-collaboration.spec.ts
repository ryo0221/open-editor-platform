import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
  create,
  nativeArtifact,
  comments,
  save,
  artifactView,
  tinyPng,
  insertDoc,
} from './fixtures';
import type { SlideContent } from '@editor-platform/slide/model';
import { mkdir } from 'node:fs/promises';
async function menu(page: Page, action: string) {
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('button', { name: action, exact: true }).click();
  await page.keyboard.press('Escape');
}
async function confirmed(page: Page) {
  await expect(page.locator('.save-status')).toContainText('Shared · confirmed');
}
async function shape(page: Page, name: string) {
  await page.getByRole('button', { name: 'Insert shapes', exact: true }).click();
  await page.getByRole('button', { name: `Insert ${name.toLowerCase()}`, exact: true }).click();
  await page.keyboard.press('Escape');
}
test('EI-Q02/Q09/Q12 normal Slide: shape picker, independent peers, proposal, Undo, save and export', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120000);
  const contexts: BrowserContext[] = [],
    errors: string[] = [];
  async function open() {
    const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
    contexts.push(context);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    return page;
  }
  const a = await open();
  await a.goto('/');
  await create(a, 'slide');
  await shape(a, 'rectangle');
  const original = await nativeArtifact(a);
  await menu(a, 'Open collaboratively');
  await confirmed(a);
  await a.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  const peer = await a.getByRole('link', { name: 'Open peer editor' }).getAttribute('href');
  await a.keyboard.press('Escape');
  const b = await open();
  await b.goto(peer!);
  await confirmed(b);
  const deck = original.draft.content as SlideContent;
  await shape(a, 'ellipse');
  await confirmed(a);
  await expect
    .poll(
      async () =>
        ((await nativeArtifact(b)).draft.content as SlideContent).slides[0].objects.length,
    )
    .toBe(2);
  // B edits the original object through the same property control used in single-user mode.
  await b.getByRole('button', { name: 'Layers', exact: true }).click();
  await b.getByRole('button', { name: 'Select shape object 1', exact: true }).click();
  await b.getByLabel('Fill', { exact: true }).fill('#335577');
  await b.getByLabel('Fill', { exact: true }).press('Tab');
  await confirmed(b);
  await expect
    .poll(
      async () =>
        ((await nativeArtifact(a)).draft.content as SlideContent).slides[0].objects[0].fill,
    )
    .toBe('#335577');
  await menu(a, 'Agent proposal demo');
  await expect(a.getByRole('complementary', { name: 'Shared proposal preview' })).toBeVisible();
  await a.getByRole('button', { name: 'Apply shared proposal', exact: true }).click();
  await confirmed(a);
  await expect
    .poll(
      async () =>
        ((await nativeArtifact(b)).draft.content as SlideContent).slides[0].objects[0].fill,
    )
    .toBe('#a78bfa');
  await a.getByRole('button', { name: 'Undo', exact: true }).click();
  await confirmed(a);
  await expect
    .poll(
      async () =>
        ((await nativeArtifact(b)).draft.content as SlideContent).slides[0].objects[0].fill,
    )
    .toBe('#335577');
  await a.getByRole('button', { name: 'Save version', exact: true }).click();
  await a.getByRole('dialog').getByRole('button', { name: 'Save version', exact: true }).click();
  await expect.poll(async () => (await nativeArtifact(a)).versions.length).toBe(1);
  const saved = await nativeArtifact(a),
    content = saved.draft.content as SlideContent;
  expect(content.slides[0].objects[0].id).toBe(deck.slides[0].objects[0].id);
  expect(content.slides[0].objects).toHaveLength(2);
  expect(JSON.stringify(saved)).not.toMatch(/sessionId|operationId|stamps|token|Room/);
  await mkdir('docs/screenshots/issue-5', { recursive: true });
  await a.screenshot({ path: 'docs/screenshots/issue-5/slide-shared-desktop.png', fullPage: true });
  await a.reload();
  await confirmed(a);
  expect((await nativeArtifact(a)).draft.content).toEqual(content);
  await Promise.all(contexts.map((c) => c.close()));
  expect(errors).toEqual([]);
});

for (const kind of ['document', 'slide', 'whiteboard', 'design'] as const)
  test(`EI-Q04 ${kind}: normal shared text engine converges simultaneous input and marks`, async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(90000);
    const contexts: BrowserContext[] = [],
      errors: string[] = [];
    async function open() {
      const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
      contexts.push(context);
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      return page;
    }
    const a = await open();
    await a.goto('/');
    await create(a, kind);
    if (kind !== 'document')
      await a.getByRole('button', { name: 'Insert text', exact: true }).click();
    await menu(a, 'Open collaboratively');
    await confirmed(a);
    const b = await open();
    await b.goto(a.url().replace('actor=A', 'actor=B'));
    await confirmed(b);
    async function editor(page: Page) {
      if (kind === 'document')
        return page.getByRole('textbox', { name: 'Document body', exact: true });
      const canvas = page.getByRole('application', {
        name: `${kind[0].toUpperCase() + kind.slice(1)} canvas`,
        exact: true,
      });
      await canvas
        .getByRole('button')
        .filter({ has: page.locator('text') })
        .first()
        .dblclick();
      return page.getByRole('textbox', { name: 'Edit canvas text', exact: true });
    }
    const x = await editor(a),
      y = await editor(b);
    await x.press('Control+Home');
    await y.press('Control+Home');
    await Promise.all([a.keyboard.insertText('Alpha'), b.keyboard.insertText('Beta')]);
    await confirmed(a);
    await confirmed(b);
    await expect(x).toContainText('Alpha');
    await expect(x).toContainText('Beta');
    const text = (editor: typeof x) =>
      editor.evaluate((node) => {
        const clone = node.cloneNode(true) as Element;
        clone.querySelectorAll('[data-presence]').forEach((n) => n.remove());
        return clone.textContent;
      });
    await expect.poll(async () => (await text(x)) === (await text(y))).toBe(true);
    await b.bringToFront();
    await y.press('Control+Home');
    await y.press('Shift+ArrowRight');
    await expect.poll(() => y.evaluate(() => window.getSelection()?.toString())).not.toBe('');
    await y.press('Control+b');
    await expect.poll(async () => x.locator('strong').count()).toBeGreaterThan(0);
    await x.press('Control+End');
    await x.dispatchEvent('compositionstart', { data: '' });
    await a.keyboard.insertText('日本語');
    await x.dispatchEvent('compositionend', { data: '日本語' });
    await confirmed(a);
    await expect(y).toContainText('日本語');
    await mkdir('docs/screenshots/issue-5', { recursive: true });
    await a.screenshot({
      path: `docs/screenshots/issue-5/${kind}-shared-text.png`,
      fullPage: true,
    });
    if (kind !== 'document') {
      await x.press('Control+Enter');
      await y.press('Control+Enter');
    }
    await confirmed(a);
    await confirmed(b);
    expect((await nativeArtifact(a)).draft.content).toEqual(
      (await nativeArtifact(b)).draft.content,
    );
    await Promise.all(contexts.map((c) => c.close()));
    expect(errors).toEqual([]);
  });

async function sharedPair(
  browser: import('@playwright/test').Browser,
  baseURL: string | undefined,
  kind: string,
  setup?: (page: Page) => Promise<void>,
) {
  const contexts: BrowserContext[] = [],
    errors: string[] = [];
  const open = async () => {
    const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
    contexts.push(context);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    return page;
  };
  const a = await open();
  await a.goto('/');
  await create(a, kind);
  await setup?.(a);
  await menu(a, 'Open collaboratively');
  await confirmed(a);
  const b = await open();
  await b.goto(a.url().replace('actor=A', 'actor=B'));
  await confirmed(b);
  return {
    a,
    b,
    open,
    close: async () => {
      await Promise.all(contexts.map((c) => c.close()));
      expect(errors).toEqual([]);
    },
  };
}
async function value(page: Page, label: string, text: string) {
  await page.getByLabel(label, { exact: true }).fill(text);
  await page.getByLabel(label, { exact: true }).press('Enter');
}
async function equalContent(a: Page, b: Page) {
  await confirmed(a);
  await confirmed(b);
  await expect
    .poll(
      async () =>
        JSON.stringify((await nativeArtifact(a)).draft.content) ===
        JSON.stringify((await nativeArtifact(b)).draft.content),
    )
    .toBe(true);
}
async function capture(page: Page, name: string) {
  await mkdir('docs/screenshots/issue-5', { recursive: true });
  await page.screenshot({ path: `docs/screenshots/issue-5/${name}.png`, fullPage: true });
}
test('R5-01 normal Slide supports repeated Undo and Redo while preserving a peer style', async ({
  browser,
  baseURL,
}) => {
  const { a, b, close } = await sharedPair(browser, baseURL, 'slide', async (p) => {
    await shape(p, 'rectangle');
  });
  const initial = ((await nativeArtifact(a)).draft.content as SlideContent).slides[0].objects[0];
  for (const page of [a, b]) {
    await page.getByRole('button', { name: 'Layers', exact: true }).click();
    await page.getByRole('button', { name: 'Select shape object 1', exact: true }).click();
  }
  for (const fill of ['#ff0000', '#0000ff']) {
    await value(a, 'Fill', fill);
    await confirmed(a);
  }
  await value(b, 'Stroke', '#abcdef');
  await confirmed(b);
  for (const [direction, fill] of [
    ['Undo', '#ff0000'],
    ['Undo', initial.fill],
    ['Redo', '#ff0000'],
    ['Redo', '#0000ff'],
  ] as const) {
    await a.getByRole('button', { name: direction, exact: true }).click();
    await expect
      .poll(
        async () =>
          ((await nativeArtifact(b)).draft.content as SlideContent).slides[0].objects[0].fill,
      )
      .toBe(fill);
    await equalContent(a, b);
    expect(
      ((await nativeArtifact(a)).draft.content as SlideContent).slides[0].objects[0].stroke,
    ).toBe('#abcdef');
  }
  await capture(a, 'r5-01-history');
  await close();
});

for (const kind of ['slide', 'whiteboard', 'design'] as const)
  test(`R5-02 ${kind}: create and type in an unconfirmed box, reconnect and reload once`, async ({
    browser,
    baseURL,
  }) => {
    const { a, b, close } = await sharedPair(browser, baseURL, kind);
    await menu(a, 'Pause transport (reference)');
    await a.getByRole('button', { name: 'Insert text', exact: true }).click();
    const canvas = a.getByRole('application', {
      name: `${kind[0].toUpperCase() + kind.slice(1)} canvas`,
      exact: true,
    });
    await canvas
      .getByRole('button')
      .filter({ has: a.locator('text') })
      .first()
      .dblclick();
    const text = a.getByRole('textbox', { name: 'Edit canvas text', exact: true });
    await expect(text).toBeVisible();
    await text.press('Control+Home');
    await a.keyboard.insertText('挿入待ちの入力');
    await expect(text).toContainText('挿入待ちの入力');
    await expect(a.locator('.save-status')).toContainText('pending');
    await capture(a, `r5-02-${kind}-pending`);
    await text.press('Control+Enter');
    await menu(a, 'Resume transport (reference)');
    await equalContent(a, b);
    const record = await nativeArtifact(b);
    const content = record.draft.content as unknown as {
      slides?: { objects: { id: string; text: string }[] }[];
      nodes?: { id: string; text: string }[];
      elements?: { id: string; text: string }[];
    };
    const objects = content.slides?.[0].objects ?? content.nodes ?? content.elements!;
    expect(objects).toHaveLength(1);
    expect(objects[0].text.match(/挿入待ちの入力/g)).toHaveLength(1);
    await a.reload();
    await equalContent(a, b);
    expect((await nativeArtifact(a)).draft.content).toEqual(record.draft.content);
    await close();
  });

test('R5-03 normal Slide commits concurrent moves on separate pages', async ({
  browser,
  baseURL,
}) => {
  const { a, b, close } = await sharedPair(browser, baseURL, 'slide', async (p) => {
    await shape(p, 'rectangle');
    await p.getByRole('button', { name: 'Add slide', exact: true }).click();
    await shape(p, 'ellipse');
  });
  await a.getByRole('button', { name: /^Slide 1:/ }).click();
  await b.getByRole('button', { name: /^Slide 2:/ }).click();
  for (const page of [a, b]) {
    await page.getByRole('button', { name: 'Layers', exact: true }).click();
    await page.getByRole('button', { name: 'Select shape object 1', exact: true }).click();
  }
  // Both operations must be prepared before either request is delivered to the authority.
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: string[] = [];
  for (const page of [a, b])
    await page.route('**/collaboration-api/submit?*', async (route) => {
      requests.push(route.request().postData()!);
      await barrier;
      await route.continue();
    });
  await value(a, 'Element x', '100');
  await value(b, 'Element x', '500');
  await expect.poll(() => requests.length).toBe(2);
  expect(JSON.parse(requests[0]).baseRevision).toBe(JSON.parse(requests[1]).baseRevision);
  release();
  await equalContent(a, b);
  expect(
    ((await nativeArtifact(a)).draft.content as SlideContent).slides.map(
      (s) => s.objects[0].bounds.x,
    ),
  ).toEqual([100, 500]);
  await capture(b, 'r5-03-independent-pages');
  await close();
});
test('EI-Q05 normal Whiteboard: Sections, connectors, move/resize and private camera', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(90000);
  const { a, b, close } = await sharedPair(browser, baseURL, 'whiteboard');
  await a.getByRole('button', { name: 'Add sticky', exact: true }).click();
  await confirmed(a);
  await value(a, 'Text', 'Research');
  await confirmed(a);
  await a.getByRole('button', { name: 'Board actions', exact: true }).click();
  await a.getByRole('button', { name: 'Section around selected objects', exact: true }).click();
  await a.keyboard.press('Escape');
  await confirmed(a);
  await value(a, 'Section title', 'Discovery');
  await confirmed(a);
  await expect(
    b.getByRole('button', { name: 'Go to Section Discovery', exact: true }),
  ).toBeVisible();
  await b.getByRole('button', { name: 'Add sticky', exact: true }).click();
  await confirmed(b);
  await b.getByRole('button', { name: 'Layer sticky 1', exact: true }).click();
  await b
    .getByRole('button', { name: 'Layer sticky 2', exact: true })
    .click({ modifiers: ['Shift'] });
  await b.getByRole('button', { name: 'Connect selected', exact: true }).click();
  await confirmed(b);
  await expect(a.getByTestId('board-connector')).toHaveCount(1);
  await a.getByRole('button', { name: 'Go to Section Discovery', exact: true }).click();
  await value(a, 'Section width', '800');
  await confirmed(a);
  await value(a, 'Section x', '-1200');
  await confirmed(a);
  await equalContent(a, b);
  const peerZoom = await b.getByLabel('Canvas zoom', { exact: true }).inputValue();
  await a.getByLabel('Canvas zoom', { exact: true }).selectOption('0.5');
  expect(await b.getByLabel('Canvas zoom', { exact: true }).inputValue()).toBe(peerZoom);
  await expect(a.locator('[data-space=infinite]')).toBeVisible();
  await a.getByRole('button', { name: 'Fit board', exact: true }).click();
  await capture(a, 'whiteboard-shared-desktop');
  await close();
});
test('EI-Q06 normal Design: Frame layout, component definition and instance override', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(90000);
  const { a, b, close } = await sharedPair(browser, baseURL, 'design');
  await a.getByRole('button', { name: 'Add frame', exact: true }).click();
  await confirmed(a);
  await value(a, 'Layer name', 'Frame');
  await confirmed(a);
  await shape(a, 'rectangle');
  await confirmed(a);
  await value(a, 'Layer name', 'Card');
  await confirmed(a);
  await a.getByRole('button', { name: 'Make component', exact: true }).click();
  await a.getByRole('button', { name: 'Cancel publication settings', exact: true }).click();
  await confirmed(a);
  await b.getByRole('button', { name: 'Components', exact: true }).click();
  await b.getByRole('button', { name: 'Insert Card', exact: true }).click();
  await confirmed(b);
  await b.getByRole('button', { name: 'Layers', exact: true }).click();
  await b.getByRole('button', { name: 'Layer Card instance', exact: true }).click();
  await value(b, 'Fill', '#8877aa');
  await confirmed(b);
  await a.getByRole('button', { name: 'Layer Frame', exact: true }).click();
  await a.getByLabel('Layout direction').selectOption('column');
  await confirmed(a);
  await value(a, 'Layout gap (px)', '32');
  await confirmed(a);
  await equalContent(a, b);
  await capture(a, 'design-shared-desktop');
  await close();
});
test('EI-Q07 normal Data: independent cells, atomic paste, schema, named view and private browsing', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(90000);
  const { a, b, close } = await sharedPair(browser, baseURL, 'data');
  await a.getByRole('button', { name: 'Add records', exact: true }).click();
  await a.getByRole('button', { name: 'Add 1 record', exact: true }).click();
  await a.keyboard.press('Escape');
  await confirmed(a);
  await expect(b.getByRole('gridcell', { name: 'Name · record 1', exact: true })).toBeVisible();
  await b.getByRole('gridcell', { name: 'Name · record 1', exact: true }).dblclick();
  await value(b, 'Edit Name', 'Shared record');
  await confirmed(b);
  await a.getByRole('gridcell', { name: 'Quantity · record 1', exact: true }).click();
  await a.getByRole('grid', { name: 'Data grid' }).evaluate((el) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', '7\t11');
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData }));
  });
  await confirmed(a);
  await expect(b.getByRole('gridcell', { name: 'Total · record 1', exact: true })).toHaveText('77');
  await a.getByRole('button', { name: 'Add field', exact: true }).click();
  await a.getByLabel('New field name').fill('Owner');
  await a.getByRole('button', { name: 'Create field', exact: true }).click();
  await confirmed(a);
  await expect(b.getByRole('columnheader', { name: /Owner/ })).toBeVisible();
  await value(a, 'View name', 'Team view');
  await a.getByRole('button', { name: 'Save view', exact: true }).click();
  await confirmed(a);
  await expect(b.getByRole('button', { name: 'Team view', exact: true })).toBeVisible();
  await a.getByLabel('Search records', { exact: true }).fill('no-match');
  expect(await b.getByLabel('Search records', { exact: true }).inputValue()).toBe('');
  await equalContent(a, b);
  await capture(b, 'data-shared-desktop');
  await a.getByLabel('Search records', { exact: true }).fill('');
  await menu(a, 'Pause transport (reference)');
  await a.getByRole('gridcell', { name: 'Name · record 1', exact: true }).dblclick();
  await value(a, 'Edit Name', 'Retained conflict');
  await b.getByRole('gridcell', { name: 'Name · record 1', exact: true }).dblclick();
  await value(b, 'Edit Name', 'Remote winner');
  await confirmed(b);
  await menu(a, 'Resume transport (reference)');
  await expect(a.locator('.save-status')).toContainText('Rejected');
  await expect(a.getByRole('gridcell', { name: 'Name · record 1', exact: true })).toHaveText(
    'Remote winner',
  );
  await menu(a, 'Discard retained input');
  await confirmed(a);
  await equalContent(a, b);
  await close();
});
test('EI-Q11 normal Slide retains disconnected input, deduplicates a lost ack and enforces Host read only', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(90000);
  const { a, b, close } = await sharedPair(browser, baseURL, 'slide');
  await menu(a, 'Pause transport (reference)');
  await a.keyboard.press('Escape');
  await shape(a, 'rectangle');
  await expect(a.locator('.save-status')).toContainText('pending');
  expect(((await nativeArtifact(b)).draft.content as SlideContent).slides[0].objects).toHaveLength(
    0,
  );
  await menu(a, 'Resume transport (reference)');
  await a.keyboard.press('Escape');
  await confirmed(a);
  await expect
    .poll(
      async () =>
        ((await nativeArtifact(b)).draft.content as SlideContent).slides[0].objects.length,
    )
    .toBe(1);
  await menu(a, 'Lose next acknowledgement (reference)');
  await a.keyboard.press('Escape');
  await shape(a, 'ellipse');
  await expect(a.locator('.save-status')).toContainText('disconnected');
  await menu(a, 'Resume transport (reference)');
  await a.keyboard.press('Escape');
  await confirmed(a);
  await expect
    .poll(
      async () =>
        ((await nativeArtifact(b)).draft.content as SlideContent).slides[0].objects.length,
    )
    .toBe(2);
  await menu(a, 'Make session read only (reference)');
  await a.keyboard.press('Escape');
  await expect(a.locator('.save-status')).toContainText('Read only');
  await expect(a.getByRole('button', { name: 'Insert text', exact: true })).toBeDisabled();
  await shape(b, 'diamond');
  await confirmed(b);
  await expect
    .poll(
      async () =>
        ((await nativeArtifact(a)).draft.content as SlideContent).slides[0].objects.length,
    )
    .toBe(3);
  await capture(a, 'slide-read-only');
  await close();
});

for (const kind of ['review', 'file'] as const)
  test(`EI-Q08 ${kind}: fixed-source annotations, replies and resolve converge`, async ({
    browser,
    baseURL,
  }) => {
    const { a, b, close } = await sharedPair(browser, baseURL, kind);
    const source = (await nativeArtifact(a)).draft.content;
    await a
      .getByRole('button', {
        name: kind === 'review' ? 'added new line 2' : 'File line 2',
        exact: true,
      })
      .click();
    await comments(a);
    await a.getByLabel('Comment', { exact: true }).fill('固定された原本への注釈');
    await a.getByRole('button', { name: 'Add comment', exact: true }).click();
    await confirmed(a);
    await comments(b);
    await expect(b.locator('.comment-thread')).toContainText('固定された原本への注釈');
    await b.locator('.comment-thread').getByText('Reply', { exact: true }).click();
    await b.getByLabel('Reply text').fill('確認済み');
    await b.getByRole('button', { name: 'Post reply' }).click();
    await confirmed(b);
    await expect(a.locator('.comment-thread')).toContainText('確認済み');
    await b.getByRole('button', { name: 'Resolve', exact: true }).click();
    await confirmed(b);
    await a.getByLabel('Show resolved').check();
    await b.getByLabel('Show resolved').check();
    await expect(a.locator('.comment-thread')).toContainText('Resolved');
    const one = await nativeArtifact(a),
      two = await nativeArtifact(b);
    expect(one.draft.content).toEqual(source);
    expect(two.draft.content).toEqual(source);
    expect(one.annotations).toEqual(two.annotations);
    await capture(a, `${kind}-shared-desktop`);
    await close();
  });

test('EI-Q09 preview preserves independent edits, refuses dependency ABA, supports re-preview and cancel', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(90000);
  const { a, b, close } = await sharedPair(browser, baseURL, 'slide', async (p) => {
    await shape(p, 'rectangle');
    await shape(p, 'ellipse');
  });
  await menu(a, 'Agent proposal demo');
  const preview = a.getByRole('complementary', { name: 'Shared proposal preview' });
  await expect(preview).toBeVisible();
  await b.getByRole('button', { name: 'Layers', exact: true }).click();
  await b.getByRole('button', { name: 'Select shape object 2', exact: true }).click();
  await value(b, 'Fill', '#abcdef');
  await confirmed(b);
  await a.getByRole('button', { name: 'Apply shared proposal', exact: true }).click();
  await expect(preview).toHaveCount(0);
  await confirmed(a);
  await expect
    .poll(
      async () =>
        ((await nativeArtifact(a)).draft.content as SlideContent).slides[0].objects[1].fill,
    )
    .toBe('#abcdef');
  // The next step intentionally changes a dependency of a new proposal. First
  // observe the previous proposal on B so this edit is not itself stale.
  await equalContent(a, b);
  await menu(a, 'Agent proposal demo');
  // Establish the proposal's read basis before starting the dependency-change/Undo ABA.
  await expect(preview).toBeVisible();
  await b.getByRole('button', { name: 'Select shape object 1', exact: true }).click();
  await value(b, 'Fill', '#112233');
  await confirmed(b);
  await b.getByRole('button', { name: 'Undo', exact: true }).click();
  await confirmed(b);
  await a.getByRole('button', { name: 'Apply shared proposal', exact: true }).click();
  await expect(a.getByRole('alert')).toContainText(/changed|stale|conflict/i);
  await a.getByRole('button', { name: 'Request revised proposal', exact: true }).click();
  await a.getByRole('button', { name: 'Cancel shared proposal', exact: true }).click();
  await expect(a.getByRole('complementary', { name: 'Shared proposal preview' })).toHaveCount(0);
  await equalContent(a, b);
  await close();
});

test('EI-Q10/Q12 immutable local versions survive sharing; another actor restore blocks stale Undo', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(90000);
  let archive: unknown;
  const { a, b, close } = await sharedPair(browser, baseURL, 'slide', async (p) => {
    await shape(p, 'rectangle');
    await save(p, 1);
    archive = (await nativeArtifact(p)).versions;
  });
  expect((await nativeArtifact(a)).versions).toEqual(archive);
  await shape(a, 'ellipse');
  await confirmed(a);
  await equalContent(a, b);
  await artifactView(b, 'History');
  await b.getByRole('button', { name: 'Restore to draft', exact: true }).click();
  await confirmed(b);
  await artifactView(b, 'Editor');
  await equalContent(a, b);
  await a.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(a.getByRole('alert')).toContainText('undo-conflict');
  expect(((await nativeArtifact(b)).draft.content as SlideContent).slides[0].objects).toHaveLength(
    1,
  );
  await b.getByRole('button', { name: 'Undo', exact: true }).click();
  await confirmed(b);
  await expect
    .poll(
      async () =>
        ((await nativeArtifact(a)).draft.content as SlideContent).slides[0].objects.length,
    )
    .toBe(2);
  await b.getByRole('button', { name: 'Redo', exact: true }).click();
  await confirmed(b);
  await expect
    .poll(
      async () =>
        ((await nativeArtifact(a)).draft.content as SlideContent).slides[0].objects.length,
    )
    .toBe(1);
  await close();
});

test('EI-Q11/Q12 queued reload and session expiry retain input; recovery is explicit', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(90000);
  const { a, b, close } = await sharedPair(browser, baseURL, 'slide');
  await menu(a, 'Pause transport (reference)');
  await shape(a, 'rectangle');
  await expect(a.locator('.save-status')).toContainText('pending');
  a.on('dialog', (d) => d.accept());
  await a.reload();
  await confirmed(a);
  await expect
    .poll(
      async () =>
        ((await nativeArtifact(b)).draft.content as SlideContent).slides[0].objects.length,
    )
    .toBe(1);
  await menu(a, 'Pause transport (reference)');
  await shape(a, 'ellipse');
  // External permission change happens while the UI still holds an earlier grant.
  await a.evaluate(async () => {
    const key = Object.keys(sessionStorage).find((k) => k.startsWith('ep-shared-host:'))!;
    const { token } = JSON.parse(sessionStorage.getItem(key)!);
    await fetch('/collaboration-api/editor/reference-permissions?domain=slide', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ writable: false, expiresAt: Date.now() - 1 }),
    });
  });
  await menu(a, 'Resume transport (reference)');
  await expect(a.locator('.save-status')).toContainText('Rejected');
  expect(((await nativeArtifact(b)).draft.content as SlideContent).slides[0].objects).toHaveLength(
    1,
  );
  await menu(a, 'Export pending checkpoint');
  await menu(a, 'Restore write access (reference)');
  await menu(a, 'Preview retained edit again');
  await a.getByRole('button', { name: 'Apply shared proposal', exact: true }).click();
  await confirmed(a);
  await expect
    .poll(
      async () =>
        ((await nativeArtifact(b)).draft.content as SlideContent).slides[0].objects.length,
    )
    .toBe(2);
  await close();
});

test('EI-Q12 images use reference envelopes; pending registration can be cancelled then retried', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(90000);
  const { a, b, close } = await sharedPair(browser, baseURL, 'slide');
  const envelopes: unknown[] = [];
  a.on('request', (r) => {
    if (r.url().includes('/submit?')) envelopes.push(r.postDataJSON());
  });
  await menu(a, 'Pause transport (reference)');
  await a
    .getByLabel('Insert image file', { exact: true })
    .setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: tinyPng });
  await expect(a.locator('.save-status')).toContainText('pending');
  await menu(a, 'Cancel unsubmitted edits');
  await menu(a, 'Resume transport (reference)');
  await confirmed(a);
  expect(((await nativeArtifact(b)).draft.content as SlideContent).slides[0].objects).toHaveLength(
    0,
  );
  await a
    .getByLabel('Insert image file', { exact: true })
    .setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: tinyPng });
  await confirmed(a);
  await equalContent(a, b);
  const content = (await nativeArtifact(b)).draft.content as SlideContent;
  expect(content.slides[0].objects[0].src).toMatch(/^data:image\/png/);
  expect(JSON.stringify(envelopes)).toContain('$editorAsset');
  expect(JSON.stringify(envelopes)).not.toContain('base64');
  await a.getByRole('button', { name: 'Undo', exact: true }).click();
  await confirmed(a);
  await a.getByRole('button', { name: 'Redo', exact: true }).click();
  await confirmed(a);
  await equalContent(a, b);
  await close();
});

test('EI-Q14 independent Host injects opaque adapter credentials into the same Slide surface', async ({
  browser,
  baseURL,
}) => {
  const { a, b, open, close } = await sharedPair(browser, baseURL, 'slide');
  const injected = await b.evaluate(() => {
    const key = Object.keys(sessionStorage).find((k) => k.startsWith('ep-shared-host:'))!;
    return { ...JSON.parse(sessionStorage.getItem(key)!), domain: 'slide' };
  });
  await b.close();
  const host = await open();
  await host.goto('/embed.html');
  await host.evaluate(
    (config) => sessionStorage.setItem('ep-independent-host', JSON.stringify(config)),
    injected,
  );
  await host.reload();
  await expect(host.getByLabel('Host sync status')).toContainText('confirmed');
  await shape(a, 'rectangle');
  await confirmed(a);
  await expect(
    host.getByRole('application', { name: 'Slide canvas' }).getByRole('button'),
  ).toHaveCount(1);
  await shape(host, 'ellipse');
  await expect(host.getByLabel('Host sync status')).toContainText('confirmed');
  await expect
    .poll(
      async () =>
        ((await nativeArtifact(a)).draft.content as SlideContent).slides[0].objects.length,
    )
    .toBe(2);
  await host.getByRole('button', { name: 'Host Undo', exact: true }).click();
  await expect
    .poll(
      async () =>
        ((await nativeArtifact(a)).draft.content as SlideContent).slides[0].objects.length,
    )
    .toBe(1);
  await capture(host, 'independent-host-shared');
  await close();
});

test('EI-Q03 normal Slide groups, geometry, duplication and pages are atomic with remote styles', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(90000);
  const { a, b, close } = await sharedPair(browser, baseURL, 'slide', async (p) => {
    await shape(p, 'rectangle');
    await shape(p, 'ellipse');
  });
  await a.getByRole('button', { name: 'Layers', exact: true }).click();
  await a.getByRole('button', { name: 'Select shape object 1', exact: true }).click();
  await a
    .getByRole('button', { name: 'Select shape object 2', exact: true })
    .click({ modifiers: ['Shift'] });
  await a.getByRole('button', { name: 'Arrange', exact: true }).click();
  await a.getByRole('button', { name: 'Group', exact: true }).click();
  await a.keyboard.press('Escape');
  await confirmed(a);
  await equalContent(a, b);
  const grouped = (await nativeArtifact(a)).draft.content as SlideContent;
  expect(grouped.slides[0].objects.filter((o) => o.groupId)).toHaveLength(2);
  await a.getByRole('application', { name: 'Slide canvas' }).press('ArrowRight');
  await confirmed(a);
  await b.getByRole('button', { name: 'Layers', exact: true }).click();
  await b.getByRole('button', { name: 'Select shape object 2', exact: true }).click();
  await value(b, 'Fill', '#336699');
  await confirmed(b);
  await a.getByRole('button', { name: 'Undo', exact: true }).click();
  await confirmed(a);
  await equalContent(a, b);
  expect(
    ((await nativeArtifact(a)).draft.content as SlideContent).slides[0].objects.find(
      (o) => o.type === 'shape',
    )?.fill,
  ).toBe('#336699');
  await a.getByRole('button', { name: 'Slides', exact: true }).click();
  await a.getByRole('button', { name: 'Duplicate slide', exact: true }).click();
  await confirmed(a);
  await equalContent(a, b);
  expect(((await nativeArtifact(a)).draft.content as SlideContent).slides).toHaveLength(2);
  await a.getByRole('button', { name: 'Undo', exact: true }).click();
  await confirmed(a);
  await equalContent(a, b);
  expect(((await nativeArtifact(a)).draft.content as SlideContent).slides).toHaveLength(1);
  await close();
});

test('EI-Q04/Q10 Document shares headings, lists, table, paste, image and mapped comments', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120000);
  const { a, b, close } = await sharedPair(browser, baseURL, 'document');
  const x = a.getByRole('textbox', { name: 'Document body' }),
    y = b.getByRole('textbox', { name: 'Document body' });
  await a.bringToFront();
  await x.press('Control+Home');
  await a.getByLabel('Text style').selectOption('heading-2');
  await confirmed(a);
  await expect(y.locator('h2')).toHaveCount(1);
  await x.press('Control+Home');
  await x.press('Shift+ArrowRight');
  await expect.poll(() => x.evaluate(() => window.getSelection()?.toString())).not.toBe('');
  await comments(a);
  await a.getByLabel('Comment', { exact: true }).fill('Follow this character');
  await a.getByRole('button', { name: 'Add comment', exact: true }).click();
  await confirmed(a);
  await expect(y.locator('.ep-comment-range')).toHaveCount(1);
  const quote = await y.locator('.ep-comment-range').textContent();
  await b.bringToFront();
  await y.press('Control+Home');
  await b.keyboard.insertText('前方');
  await confirmed(b);
  await expect(x.locator('.ep-comment-range')).toHaveText(quote!);
  await a.getByRole('button', { name: 'Close comments', exact: true }).click();
  await x.press('Control+End');
  await a.getByRole('button', { name: 'Bulleted list', exact: true }).click();
  await confirmed(a);
  await a.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await a.evaluate(() => navigator.clipboard.writeText('one\ntwo'));
  await x.press('Control+v');
  await confirmed(a);
  await expect(y.locator('ul').first()).toContainText('two');
  await insertDoc(a, 'Table');
  await confirmed(a);
  await expect(y.locator('table')).toHaveCount(1);
  await x.locator('th').first().click();
  await a.getByRole('button', { name: 'Add table row', exact: true }).click();
  await confirmed(a);
  await a
    .getByLabel('Document image file')
    .setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: tinyPng });
  await confirmed(a);
  await expect(y.getByRole('img', { name: 'dot.png' })).toBeVisible();
  await equalContent(a, b);
  await a.getByRole('button', { name: 'Save version', exact: true }).click();
  await a.getByRole('dialog').getByRole('button', { name: 'Save version', exact: true }).click();
  await expect.poll(async () => (await nativeArtifact(b)).versions.length).toBe(1);
  await value(a, 'Page margin', '110');
  await confirmed(a);
  await equalContent(a, b);
  await artifactView(b, 'History');
  await b.getByRole('button', { name: 'Restore to draft', exact: true }).click();
  await confirmed(b);
  await artifactView(b, 'Editor');
  await equalContent(a, b);
  await expect(a.getByLabel('Page margin')).toHaveValue('64');
  await a.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(a.getByRole('alert')).toContainText('undo-conflict');
  await capture(a, 'document-shared-desktop');
  await close();
});
