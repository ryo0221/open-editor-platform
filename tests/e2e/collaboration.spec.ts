import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { readFile, mkdir, copyFile } from 'node:fs/promises';
const evidence = 'docs/screenshots/issue-3';
async function pair(browser: Browser, baseURL: string | undefined, domain: string) {
  const room = `co-${domain}-${Date.now()}`,
    contexts: BrowserContext[] = [],
    pages: Page[] = [],
    errors: string[] = [];
  const traffic: unknown[] = [];
  for (const actor of ['A', 'B']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, baseURL });
    contexts.push(context);
    const page = await context.newPage();
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/collaboration-api/') && !url.pathname.endsWith('/session'))
        traffic.push({ actor, phase: 'request', path: url.pathname + url.search });
    });
    page.on('requestfailed', (request) =>
      traffic.push({
        actor,
        phase: 'failed',
        path: new URL(request.url()).pathname,
        error: request.failure()?.errorText,
      }),
    );
    page.on('response', async (response) => {
      const url = new URL(response.url());
      if (!url.pathname.startsWith('/collaboration-api/') || url.pathname.endsWith('/session'))
        return;
      try {
        if (url.pathname.endsWith('/permissions')) {
          traffic.push({ actor, path: url.pathname + url.search, status: response.status() });
          return;
        }
        const body = await response.json();
        traffic.push({
          actor,
          path: url.pathname + url.search,
          status: response.status(),
          result: Array.isArray(body)
            ? body.map((p) => ({ name: p.name, basis: p.basis, anchor: p.anchor }))
            : body.events
              ? { revisions: body.events.map((e: { revision: number }) => e.revision) }
              : body,
        });
      } catch {
        /* Context may have closed. */
      }
    });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`${m.text()} ${m.location().url ?? ''}`);
    });
    await page.goto(`/collaboration.html?room=${room}&actor=${actor}&domain=${domain}`);
    await expect(page.getByRole('status')).toContainText('Connected');
    pages.push(page);
  }
  return {
    a: pages[0],
    b: pages[1],
    errors,
    traffic,
    close: async () => {
      await Promise.all(contexts.map((c) => c.close()));
      expect(errors).toEqual([]);
    },
  };
}
async function same(a: Page, b: Page) {
  await expect
    .poll(async () => {
      const [left, right] = await Promise.all([
        a.getByTestId('confirmed-content').textContent(),
        b.getByTestId('confirmed-content').textContent(),
      ]);
      return left === right;
    })
    .toBe(true);
}
async function fill(page: Page, label: string, value: string) {
  const input = page.getByRole('textbox', { name: label, exact: true });
  await input.fill(value);
  await input.press('Tab');
}
test('CO-Q18 independent A/B and agent C: canvas, checked proposal, reconnect, Undo and SVG export', async ({
  browser,
  baseURL,
}, testInfo) => {
  const { a, b, errors, close } = await pair(browser, baseURL, 'slide');
  await a.getByRole('button', { name: 'Move right', exact: true }).click();
  await expect(b.getByTestId('shape1').locator('rect')).toHaveAttribute('x', '100');
  await b.getByLabel('Selected shape').selectOption('shape2');
  await b.getByRole('button', { name: 'Set my color' }).click();
  await expect(a.getByTestId('shape2').locator('rect')).toHaveAttribute('fill', '#4268bb');
  await a.getByRole('button', { name: 'Undo my edit' }).click();
  await expect(b.getByTestId('shape1').locator('rect')).toHaveAttribute('x', '80');
  await expect(a.getByTestId('shape2').locator('rect')).toHaveAttribute('fill', '#4268bb');
  await a.getByRole('button', { name: 'Redo my edit' }).click();
  await expect(b.getByTestId('shape1').locator('rect')).toHaveAttribute('x', '100');
  await a.getByRole('button', { name: 'Generate proposal' }).click();
  await a.getByRole('button', { name: 'Preview proposal' }).click();
  await expect(a.getByTestId('proposal-diff')).toContainText('shape2/fill');
  await b.getByLabel('Selected shape').selectOption('shape1');
  await b.getByRole('button', { name: 'Set my color' }).click();
  await expect(a.getByTestId('shape1').locator('rect')).toHaveAttribute('fill', '#4268bb');
  await a.getByRole('button', { name: 'Apply proposal' }).click();
  await expect(a.getByRole('status')).toContainText('stale-precondition');
  await expect(a.getByTestId('shape2').locator('rect')).toHaveAttribute('fill', '#4268bb');
  await a.getByRole('button', { name: 'Generate proposal' }).click();
  await a.getByRole('button', { name: 'Preview proposal' }).click();
  await b.getByRole('button', { name: 'Move right', exact: true }).click();
  await a.getByRole('button', { name: 'Apply proposal' }).click();
  await expect(b.getByTestId('shape2').locator('rect')).toHaveAttribute('fill', '#cf7a46');
  await a.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await a.getByRole('button', { name: 'Move right', exact: true }).click();
  await expect(a.getByTestId('pending')).toHaveText('Pending 1');
  await b.getByRole('button', { name: 'Move right', exact: true }).click();
  await a.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect(a.getByTestId('pending')).toHaveText('Pending 0');
  await expect(b.getByTestId('shape1').locator('rect')).toHaveAttribute('x', '160');
  await same(a, b);
  await a.getByLabel('Comment text').fill('A and B preserved; C adopted after review.');
  await a.getByRole('button', { name: 'Add comment' }).click();
  await expect(b.getByText('A and B preserved; C adopted after review.')).toBeVisible();
  await a.getByLabel('Private zoom').fill('80');
  await expect(b.getByLabel('Private zoom')).toHaveValue('100');
  const downloadPromise = a.waitForEvent('download');
  await a.getByRole('button', { name: 'Export confirmed' }).click();
  const download = await downloadPromise;
  const svg = await readFile((await download.path())!, 'utf8');
  expect(svg).toContain('#cf7a46');
  expect(svg).not.toMatch(/sessionId|operationId|stamps/);
  await mkdir('docs/exports/issue-3', { recursive: true });
  await copyFile((await download.path())!, 'docs/exports/issue-3/collaboration-slide.svg');
  await mkdir(evidence, { recursive: true });
  await a.screenshot({ path: `${evidence}/canvas-agent.png`, fullPage: true });
  await testInfo.attach('canvas', {
    path: `${evidence}/canvas-agent.png`,
    contentType: 'image/png',
  });
  expect(errors).toEqual([]);
  await close();
});
test('CO-Q18 data clients preserve independent cells and reject an in-flight conflicting cell', async ({
  browser,
  baseURL,
}, testInfo) => {
  const { a, b, close } = await pair(browser, baseURL, 'data');
  await fill(a, 'row1 value', '11');
  await fill(b, 'row2 value', '22');
  await expect(a.getByLabel('row2 value', { exact: true })).toHaveValue('22');
  await expect(b.getByLabel('row1 value', { exact: true })).toHaveValue('11');
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived!: () => void;
  const intercepted = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await a.route('**/submit?domain=data', async (route) => {
    arrived();
    await held;
    await route.continue();
  });
  await fill(a, 'row1 value', '99');
  await intercepted;
  await fill(b, 'row1 value', '77');
  await expect(b.getByTestId('confirmed-content')).toContainText('77');
  release();
  await expect(a.getByRole('status')).toContainText('stale-precondition');
  await a.unroute('**/submit?domain=data');
  await expect(a.getByLabel('row1 value', { exact: true })).toHaveValue('77');
  await same(a, b);
  await a.getByRole('button', { name: 'Generate proposal' }).click();
  await a.getByRole('button', { name: 'Preview proposal' }).click();
  await a.getByRole('button', { name: 'Apply proposal' }).click();
  await expect(b.getByLabel('row2 name', { exact: true })).toHaveValue('Agent C reviewed');
  await mkdir(evidence, { recursive: true });
  await a.screenshot({ path: `${evidence}/data-conflict.png`, fullPage: true });
  await testInfo.attach('data', {
    path: `${evidence}/data-conflict.png`,
    contentType: 'image/png',
  });
  await close();
});
test('CO-Q02/18 real text editors rebase concurrent typing, composition, marks and anchored comments', async ({
  browser,
  baseURL,
}, testInfo) => {
  const { a, b, close, traffic } = await pair(browser, baseURL, 'document');
  try {
    const ea = a.getByRole('textbox', { name: 'Shared document' }),
      eb = b.getByRole('textbox', { name: 'Shared document' });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived!: () => void;
    const intercepted = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    await b.route('**/submit?domain=document', async (route) => {
      arrived();
      await held;
      await route.continue();
    });
    await eb.click();
    await eb.press('Control+Home');
    await b.keyboard.insertText('B: ');
    await intercepted;
    await ea.click();
    await ea.press('Control+Home');
    await a.keyboard.insertText('A: ');
    await expect(a.getByTestId('confirmed-content')).toContainText('A: ');
    release();
    await expect(ea).toContainText('B: ');
    await expect(eb).toContainText('A: ');
    await same(a, b);
    // Keep fault routes active for the entire flow, including background polls.
    let releaseComposition!: () => void;
    const delayedComposition = new Promise<void>((resolve) => {
      releaseComposition = resolve;
    });
    await a.route('**/submit?domain=document', async (route) => {
      await delayedComposition;
      await route.continue();
    });
    let presenceResponses = 0;
    a.on('response', (response) => {
      if (response.url().includes('/presence?domain=document')) presenceResponses++;
    });
    await ea.press('Control+End');
    await ea.dispatchEvent('compositionstart', { data: '' });
    await a.keyboard.insertText('日本語');
    await ea.dispatchEvent('compositionend', { data: '日本語' });
    await expect(a.getByTestId('pending')).not.toHaveText('Pending 0');
    const before = presenceResponses;
    await expect.poll(() => presenceResponses).toBeGreaterThanOrEqual(before + 3);
    releaseComposition();
    await expect(eb).toContainText('日本語');
    await ea.press('Control+Home');
    await ea.press('Control+Shift+ArrowRight');
    await expect.poll(() => ea.evaluate(() => window.getSelection()?.toString())).not.toBe('');
    const selected = await ea.evaluate(() => window.getSelection()?.toString());
    const selectionPoll = presenceResponses;
    await expect.poll(() => presenceResponses).toBeGreaterThanOrEqual(selectionPoll + 3);
    expect(await ea.evaluate(() => window.getSelection()?.toString())).toBe(selected);
    await ea.press('Control+b');
    await expect(ea.locator('strong')).toHaveCount(1);
    await expect(eb.locator('strong')).toHaveCount(1);
    await a.getByLabel('Comment text').fill('Shared range follows the engine.');
    await a.getByRole('button', { name: 'Add comment' }).click();
    await expect(b.getByText('Shared range follows the engine.')).toBeVisible();
    await expect(eb.locator('.comment-range')).toHaveCount(1);
    await eb.click();
    await eb.press('Control+Home');
    await b.keyboard.insertText('先頭 ');
    await expect(ea).toContainText('先頭');
    await same(a, b);
    await expect(ea.locator('.remote-caret')).toHaveCount(1);
    await mkdir(evidence, { recursive: true });
    await a.screenshot({ path: `${evidence}/text-presence.png`, fullPage: true });
    await testInfo.attach('text', {
      path: `${evidence}/text-presence.png`,
      contentType: 'image/png',
    });
    await close();
  } catch (error) {
    await testInfo.attach('sync-traffic', {
      body: JSON.stringify(traffic, null, 2),
      contentType: 'application/json',
    });
    throw error;
  }
});
test('other surfaces share representative edits and fixed-source annotations through independent contexts', async ({
  browser,
  baseURL,
}) => {
  for (const domain of ['design', 'whiteboard', 'review', 'file']) {
    const { a, b, close } = await pair(browser, baseURL, domain);
    if (domain === 'design' || domain === 'whiteboard') {
      await a.getByRole('button', { name: 'Set my color' }).click();
      await expect(
        b.getByTestId(domain === 'design' ? 'child' : 'one').locator('rect'),
      ).toHaveAttribute('fill', '#cf5548');
    }
    await a.getByLabel('Comment text').fill(`${domain} shared annotation`);
    await a.getByRole('button', { name: 'Add comment' }).click();
    await expect(b.getByText(`${domain} shared annotation`)).toBeVisible();
    await same(a, b);
    await close();
  }
});
