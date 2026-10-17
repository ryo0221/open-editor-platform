import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page, TestInfo } from '@playwright/test';
import { test as base, expect } from './fixtures';

export const test = base.extend<{ officeRuntime: void }>({
  officeRuntime: [
    async ({ page }, use, info) => {
      const attach = recordOfficeRuntime(page, info);
      try {
        await use();
      } finally {
        await attach();
      }
    },
    { auto: true },
  ],
});

/** Record cold/warm conditions externally; never warm or reload the application here. */
export function recordOfficeRuntime(page: Page, info: TestInfo) {
  const events: object[] = [];
  page.on('framenavigated', (frame) => {
    events.push({ type: 'navigation', main: frame === page.mainFrame(), url: frame.url() });
  });
  page.on('console', (message) => {
    if (message.type() === 'error' || message.text().startsWith('[vite]'))
      events.push({ type: 'console', level: message.type(), text: message.text() });
  });
  page.context().on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('.wasm'))
      events.push({ type: 'wasm-request', url: request.url() });
  });
  return () =>
    info.attach('office-runtime-events', {
      body: JSON.stringify(events, null, 2),
      contentType: 'application/json',
    });
}

/** Match only the same-origin resvg asset, then verify its exact installed bytes. */
export async function breakOfficeRenderer(context: BrowserContext, page: Page) {
  const file = fileURLToPath(import.meta.resolve('@resvg/resvg-wasm/index_bg.wasm'));
  const expectedHash = createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
  const origin = new URL(page.url()).origin;
  const matches = (url: URL) =>
    url.origin === origin &&
    url.search === '' &&
    (url.pathname === '/@fs' + file ||
      /^\/assets\/index_bg-[A-Za-z0-9_-]+\.wasm$/.test(url.pathname));
  const blocked: { url: string; sha256: string }[] = [];
  await context.route(matches, async (route) => {
    const response = await route.fetch();
    expect(response.ok(), 'resvg asset must exist before fault injection').toBe(true);
    const hash = createHash('sha256')
      .update(await response.body())
      .digest('hex');
    expect(hash, 'only the actual installed resvg WASM may be replaced').toBe(expectedHash);
    blocked.push({ url: route.request().url(), sha256: hash });
    await route.fulfill({ contentType: 'application/wasm', body: Buffer.from('broken') });
  });
  return { blocked, stop: () => context.unroute(matches) };
}
