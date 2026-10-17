import { test, expect } from '@playwright/test';
import type {} from '../test-host/main';
const errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:4199/'))
      errors.push(`Unexpected request: ${request.url()}`);
  });
  await page.addInitScript(() =>
    addEventListener('pageshow', (event) => {
      const events = JSON.parse(sessionStorage.getItem('geo-cache-events') ?? '[]');
      events.push({ persisted: event.persisted, url: location.href });
      sessionStorage.setItem('geo-cache-events', JSON.stringify(events));
    }),
  );
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready: fixed native capture');
});
test.afterEach(() => expect(errors).toEqual([]));
test('native meaning, inert scalar text, keyboard and narrow layout preserve draft (UC1/FR03/AC04/07/11)', async ({
  page,
}, info) => {
  const id = await page.evaluate(() => window.geoInspectorTest.open('ready', 'legacy'));
  await expect(page.locator('#status')).toHaveText('Ready: fixed native capture');
  const initial = await page.evaluate((id) => window.geoInspectorTest.state(id), id);
  const surface = page.getByRole('region', { name: 'Geo inspector', exact: true });
  await expect(surface).toContainText('1 layers · 3 features · 1 sources');
  await expect(surface).toContainText('OGC:CRS84 · longitude, latitude (degrees)');
  await expect(surface).toContainText('row-01');
  await expect(surface).toContainText('Longitude12Latitude34');
  const summary = page.getByText('Feature site-02', { exact: true });
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(summary.locator('..')).toHaveAttribute('open', '');
  await expect(summary.locator('..')).toContainText('null — location unknown');
  await expect(summary.locator('..')).toContainText(
    JSON.stringify('<img src="https://invalid.example/x" onerror="alert(1)">'),
  );
  await expect(surface.locator('img,script,iframe,canvas,input,textarea')).toHaveCount(0);
  await page.getByText('Source source-1', { exact: true }).click();
  await expect(surface).toContainText('Fixed source versionversion-1');
  await expect(surface).toContainText('Declared source content hashsha256:' + 'b'.repeat(64));
  await expect(surface).toContainText('Declared raw byte hashsha256:' + 'c'.repeat(64));
  await expect(surface).toContainText('Package pin (Host admitted)' + 'a'.repeat(64));
  await expect(surface).toContainText('Computed native snapshot hash' + initial.hash);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await summary.focus();
  await page.keyboard.press('Space');
  await expect(summary.locator('..')).not.toHaveAttribute('open', '');
  const after = await page.evaluate((id) => window.geoInspectorTest.state(id), id);
  for (const key of ['json', 'hash', 'revision', 'canUndo', 'canRedo'] as const)
    expect(after[key]).toEqual(initial[key]);
  await page.screenshot({
    path: `/tmp/geo-inspector-evidence/${info.project.name}.png`,
    fullPage: true,
  });
});
test('read revoke immediately removes ready DOM and drains ownership (AC12 subset)', async ({
  page,
}) => {
  await page.evaluate(() => window.geoInspectorTest.revoke(1));
  await expect(page.locator('.geo-inspector')).toHaveCount(0);
  await expect
    .poll(async () => (await page.evaluate(() => window.geoInspectorTest.drain(1))).state)
    .toBe('drained');
  const state = await page.evaluate(() => window.geoInspectorTest.state(1));
  expect(state.listeners).toBe(0);
  expect(state.canUndo).toBe(false);
});
for (const phase of ['beforePrepare', 'beforeMount', 'afterMount'] as const)
  test(`revoke during ${phase} drops late work (AC12 subset)`, async ({ page }) => {
    const id = await page.evaluate((phase) => window.geoInspectorTest.open(phase), phase);
    await expect
      .poll(async () => (await page.evaluate((id) => window.geoInspectorTest.state(id), id)).phase)
      .toBe(phase);
    await page.evaluate((id) => window.geoInspectorTest.revoke(id), id);
    await expect(page.locator('.geo-inspector')).toHaveCount(0);
    expect((await page.evaluate((id) => window.geoInspectorTest.drain(id), id)).state).toBe(
      'incomplete',
    );
    await page.evaluate((id) => window.geoInspectorTest.release(id), id);
    await expect
      .poll(async () => (await page.evaluate((id) => window.geoInspectorTest.drain(id), id)).state)
      .toBe('drained');
    await expect(page.locator('.geo-inspector')).toHaveCount(0);
    expect((await page.evaluate((id) => window.geoInspectorTest.state(id), id)).error).toBe(
      'ScopeRevoked',
    );
  });
test('replacement wins over late old mount, stale capture rejects before insertion (AC12 subset)', async ({
  page,
}) => {
  const old = await page.evaluate(() => window.geoInspectorTest.open('beforeMount'));
  await expect
    .poll(async () => (await page.evaluate((id) => window.geoInspectorTest.state(id), old)).phase)
    .toBe('beforeMount');
  const next = await page.evaluate(() => window.geoInspectorTest.open());
  await expect(page.locator('#status')).toHaveText('Ready: fixed native capture');
  await page.evaluate((id) => window.geoInspectorTest.release(id), old);
  await expect
    .poll(async () => (await page.evaluate((id) => window.geoInspectorTest.drain(id), old)).state)
    .toBe('drained');
  await expect(page.locator('.geo-inspector')).toHaveCount(1);
  await expect(page.locator('.geo-inspector')).toContainText(`synthetic-geo-${next}`);
  const stale = await page.evaluate(() => window.geoInspectorTest.open('beforeMount'));
  await expect
    .poll(async () => (await page.evaluate((id) => window.geoInspectorTest.state(id), stale)).phase)
    .toBe('beforeMount');
  await page.evaluate((id) => {
    window.geoInspectorTest.change(id);
    window.geoInspectorTest.release(id);
  }, stale);
  await expect(page.locator('#status')).toContainText('GeoInspectorSourceChanged');
  await expect(page.locator('.geo-inspector')).toHaveCount(0);
});
test('fixed capture does not subscribe; next interaction refuses changed native revision', async ({
  page,
}) => {
  await page.evaluate(() => window.geoInspectorTest.change(1));
  await expect(page.locator('.geo-inspector')).toContainText('Synthetic sites');
  await page.getByText('Feature point-2', { exact: true }).click();
  await expect(page.locator('.geo-inspector')).toHaveCount(0);
  expect((await page.evaluate(() => window.geoInspectorTest.state(1))).revision.sequence).toBe(1);
});
test('Basic size refusal is visible and preserves native; delayed/failed cleanup stays observable', async ({
  page,
}) => {
  const large = await page.evaluate(() => window.geoInspectorTest.open('oversize'));
  await expect(page.locator('#status')).toContainText('DataLimit');
  await expect(page.locator('.geo-inspector')).toHaveCount(0);
  const state = await page.evaluate((id) => window.geoInspectorTest.state(id), large);
  expect(JSON.parse(state.json).layers[0].name.length).toBe(65536);
  expect(state.canUndo).toBe(false);
  const delayed = await page.evaluate(() => window.geoInspectorTest.open('afterDispose'));
  await expect(page.locator('#status')).toHaveText('Ready: fixed native capture');
  await page.evaluate((id) => window.geoInspectorTest.revoke(id), delayed);
  await expect(page.locator('.geo-inspector')).toHaveCount(0);
  expect((await page.evaluate((id) => window.geoInspectorTest.drain(id), delayed)).state).toBe(
    'incomplete',
  );
  await page.evaluate((id) => window.geoInspectorTest.release(id), delayed);
  await expect
    .poll(
      async () => (await page.evaluate((id) => window.geoInspectorTest.drain(id), delayed)).state,
    )
    .toBe('drained');
  const failed = await page.evaluate(() => window.geoInspectorTest.open('failDispose'));
  await expect(page.locator('#status')).toHaveText('Ready: fixed native capture');
  await page.evaluate((id) => window.geoInspectorTest.revoke(id), failed);
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.geoInspectorTest.drain(id), failed)).failed.length,
    )
    .toBe(1);
});

test('source-free local Point map links stable IDs and keyboard selection without native writes', async ({
  page,
}, info) => {
  const before = await page.evaluate(() => window.geoInspectorTest.state(1));
  expect(JSON.parse(before.json).sources).toEqual([]);
  const map = page.getByRole('region', { name: 'Local point map synthetic-sites', exact: true });
  await expect(map).toContainText('3 displayed · 2 non-Point/null retained');
  await expect(map).toContainText('Distances, areas and projection accuracy are not guaranteed');
  const markers = map.getByRole('button');
  await expect(markers).toHaveCount(3);
  const second = map.getByRole('button', { name: 'Select point point-2;', exact: false });
  await map.getByRole('button', { name: 'Select point point-1;', exact: false }).focus();
  await page.keyboard.press('Tab');
  await expect(second).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(second).toHaveAttribute('aria-pressed', 'true');
  const row = page.getByText('Feature point-2', { exact: true }).locator('..');
  await expect(row).toHaveAttribute('open', '');
  await expect(row.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('status', { name: 'Geo selection' })).toContainText(
    'feature point-2',
  );
  // Coincident point is a distinct keyboard target; no deduplication by position.
  const third = map.getByRole('button', { name: 'Select point point-3;', exact: false });
  await third.focus();
  await page.keyboard.press('Space');
  await expect(third).toHaveAttribute('aria-pressed', 'true');
  await expect(second).toHaveAttribute('aria-pressed', 'false');
  const firstRow = page.getByText('Feature point-1', { exact: true }).locator('..');
  await firstRow.getByRole('button').click();
  await expect(
    map.getByRole('button', { name: 'Select point point-1;', exact: false }),
  ).toHaveAttribute('aria-pressed', 'true');
  // Unknown location remains selectable from the native list; all map markers clear.
  await page.getByText('Feature point-4', { exact: true }).click();
  await page.getByRole('button', { name: 'Select feature point-4', exact: true }).click();
  await expect(map.locator('[aria-pressed=true]')).toHaveCount(0);
  await expect(page.getByRole('status', { name: 'Geo selection' })).toContainText('point-4');
  await expect(map).toContainText('point-4: null geometry');
  await expect(map).toContainText('point-5: LineString');
  const after = await page.evaluate(() => window.geoInspectorTest.state(1));
  for (const key of ['json', 'hash', 'revision', 'canUndo', 'canRedo'] as const)
    expect(after[key]).toEqual(before[key]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await second.focus();
  await page.keyboard.press('Enter');
  await page.screenshot({
    path: `/tmp/geo-inspector-evidence/point-map-${info.project.name}.png`,
    fullPage: true,
  });
});
test('unsupported dateline/polar/wide/geometry data is retained with explicit diagnostics', async ({
  page,
}) => {
  for (const [kind, message] of [
    ['dateline', 'Dateline/wide'],
    ['polar', 'Polar/high'],
    ['wide', 'Local frame exceeded'],
    ['unsupported', 'No Point geometry'],
  ] as const) {
    const id = await page.evaluate((kind) => window.geoInspectorTest.open('ready', kind), kind);
    await expect(page.locator('#status')).toHaveText('Ready: fixed native capture');
    const before = await page.evaluate((id) => window.geoInspectorTest.state(id), id);
    const map = page.getByRole('region', { name: 'Local point map synthetic-sites', exact: true });
    await expect(map).toContainText(message);
    await expect(map.locator('svg')).toHaveCount(0);
    await page.getByRole('button', { name: 'Select feature point-1', exact: true }).click();
    const after = await page.evaluate((id) => window.geoInspectorTest.state(id), id);
    expect(after.json).toBe(before.json);
    expect(after.hash).toBe(before.hash);
    expect(after.canUndo).toBe(false);
  }
});
test('stale map events are blocked before selection; detached disposed callbacks are inert', async ({
  page,
}) => {
  await page.evaluate(() => window.geoInspectorTest.change(1));
  const marker = page.getByRole('button', { name: 'Select point point-2;', exact: false });
  await marker.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.geo-inspector')).toHaveCount(0);
  const id = await page.evaluate(() => window.geoInspectorTest.open());
  await expect(page.locator('#status')).toHaveText('Ready: fixed native capture');
  const result = await page.evaluate((id) => {
    const root = document.querySelector('.geo-inspector')!,
      marker = root.querySelector('svg [role=button]')!,
      selection = root.querySelector('[aria-label="Geo selection"]')!;
    const before = selection.textContent;
    window.geoInspectorTest.revoke(id);
    marker.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    marker.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return { before, after: selection.textContent, connected: root.isConnected };
  }, id);
  expect(result.after).toBe(result.before);
  expect(result.connected).toBe(false);
});
test('actual BFCache allowed/denied restoration and separate synthetic denied restore', async ({
  page,
}) => {
  const instance = await page.evaluate(() => window.geoInspectorTest.instance);
  await page.goto('/away.html');
  await page.goBack({ waitUntil: 'commit' });
  await page.waitForFunction(
    (previous) =>
      window.geoInspectorTest?.instance !== previous &&
      document.querySelector('#status')?.textContent === 'Ready: fixed native capture',
    instance,
  );
  await expect(page.locator('.geo-point-map svg')).toHaveCount(1);
  await page.evaluate(() => window.geoInspectorTest.revoke(1));
  const deniedInstance = await page.evaluate(() => window.geoInspectorTest.instance);
  await page.goto('/away.html');
  await page.goBack({ waitUntil: 'commit' });
  await page.waitForFunction(
    (previous) =>
      window.geoInspectorTest?.instance !== previous &&
      document.querySelector('#status')?.textContent === 'Read permission denied',
    deniedInstance,
  );
  await expect(page.locator('.geo-inspector')).toHaveCount(0);
  const actual = await page.evaluate(
    () =>
      JSON.parse(sessionStorage.getItem('geo-cache-events') ?? '[]').filter(
        (v: { persisted: boolean; url: string }) => v.persisted && v.url === location.href,
      ).length,
  );
  expect(actual).toBeGreaterThanOrEqual(2);
  const last = await page.evaluate(() => window.geoInspectorTest.instance);
  await page.evaluate(() => {
    dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await page.waitForFunction(
    (previous) =>
      window.geoInspectorTest?.instance !== previous &&
      document.querySelector('#status')?.textContent === 'Read permission denied',
    last,
  );
  await expect(page.locator('.geo-inspector')).toHaveCount(0);
});
