import { test, expect, create, nativeArtifact, save } from './fixtures';
import {
  independentPrototype,
  followPrototype,
  assertStyledPrototypeVisibility,
  assertStyledPrototypeTransform,
} from './design-prototype-fixtures';
import { diagnoseDesignPrototype } from '@editor-platform/design/prototype';
import type { DesignContent } from '@editor-platform/design/model';
import { prototypeFixture } from '../fixtures/design-prototype/content';

test('#27 styled composite transforms keep visible geometry clickable and annotatable', async ({
  page,
}, info) => {
  await assertStyledPrototypeTransform(page, info);
});

test('#27 styled hidden prototype frames reject navigation and stay out of the start picker', async ({
  page,
}, info) => {
  await assertStyledPrototypeVisibility(page, info);
});

test('prototype visits five frames, hints instance parts and keeps native content/history private', async ({
  page,
}, info) => {
  await independentPrototype(page);
  const source = await page.getByTestId('prototype-source').textContent();
  await page.getByLabel('Prototype flow', { exact: true }).selectOption('happy');
  await expect(
    page.getByRole('button', { name: 'Activate Continue', exact: true }),
  ).toHaveAttribute('data-prototype-next', 'true');
  await page.getByRole('button', { name: 'Show hotspots', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Show hotspots', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.screenshot({ path: info.outputPath('prototype-home.png') });
  await page.getByRole('button', { name: 'Activate Continue', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Activate Show state', exact: true }).click();
  await page.getByRole('button', { name: 'Activate Open dialog', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Overlay Dialog', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Activate Go back', exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('prototype-overlay.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'State', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Prototype back', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  await followPrototype(page);
  await expect(page.getByLabel('Host flow completions', { exact: true })).toHaveText('1');
  await expect(
    page.getByRole('region', { name: 'Design prototype', exact: true }).getByRole('status'),
  ).toContainText('Completed');
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('prototype-source')).toHaveText(source!);
  await page.getByRole('button', { name: 'Host save', exact: true }).click();
  await expect(page.getByLabel('Host content hash')).toHaveText(/^[a-f0-9]{64}$/);
  const hash = await page.getByLabel('Host content hash').textContent();
  await page.getByRole('button', { name: 'Restart prototype', exact: true }).click();
  await followPrototype(page);
  await expect(page.getByLabel('Host flow completions')).toHaveText('2');
  await page.getByRole('button', { name: 'Host save', exact: true }).click();
  await expect(page.getByLabel('Host content hash')).toHaveText(hash!);
});

test('ordinary inspector edits instance parts and flows, supports undo/reload and Host rejection', async ({
  page,
}) => {
  await independentPrototype(page, true);
  await page.getByRole('button', { name: 'Layer next/instance', exact: true }).click();
  const target = page.getByLabel('Part interaction Continue click target frame', { exact: true });
  await expect(target).toHaveValue('Review');
  await target.selectOption('Done');
  await expect(page.getByTestId('prototype-source')).toContainText('"frameId":"Done"');
  await page.getByRole('button', { name: 'Host undo', exact: true }).click();
  await expect(target).toHaveValue('Review');
  await page.getByRole('button', { name: 'Host redo', exact: true }).click();
  await expect(target).toHaveValue('Done');
  await page.getByRole('button', { name: 'Use inherited interaction', exact: true }).last().click();
  await expect(target).toHaveValue('Done');
  await page.getByLabel('Saved prototype start frame', { exact: true }).selectOption('Review');
  const flowName = page.getByLabel('Flow name', { exact: true });
  await flowName.fill('Review flow');
  await flowName.press('Enter');
  await page.getByRole('button', { name: 'Host save', exact: true }).click();
  const bytes = await page.getByTestId('prototype-source').textContent();
  await page.reload();
  await expect(page.getByTestId('prototype-source')).toHaveText(bytes!);
  await expect(page.getByLabel('Flow name', { exact: true })).toHaveValue('Review flow');
  await page.getByLabel('Host accepts commands').uncheck();
  await page.getByLabel('Saved prototype start frame', { exact: true }).selectOption('Home');
  await expect(page.getByTestId('prototype-source')).toHaveText(bytes!);
  await page.getByLabel('Host read only').check();
  await expect(page.getByLabel('Saved prototype start frame', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Open prototype', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Activate Show state', exact: true }).click();
  await page.keyboard.press('Control+z');
  await page.getByRole('button', { name: 'Exit prototype', exact: true }).click();
  await expect(page.getByTestId('prototype-source')).toHaveText(bytes!);
});

test('anchors comments to a noninteractive element and arbitrary frame position with Host-owned storage', async ({
  page,
}) => {
  await independentPrototype(page);
  const bytes = await page.getByTestId('prototype-source').textContent();
  await page.getByRole('button', { name: 'Annotate prototype', exact: true }).click();
  await page.getByRole('button', { name: 'Annotate No link', exact: true }).click();
  await expect(page.getByTestId('prototype-anchor')).toContainText('"elementId":"No link"');
  await page.getByLabel('Prototype comment', { exact: true }).fill('Missing destination');
  await page.getByRole('button', { name: 'Add prototype comment', exact: true }).click();
  await expect(page.getByTestId('prototype-annotations')).toContainText('Missing destination');
  await page.getByRole('button', { name: 'Annotate Continue', exact: true }).click();
  await expect(page.getByTestId('prototype-anchor')).toContainText('"elementId":"next/instance"');
  await expect(page.getByTestId('prototype-anchor')).toContainText('"type":"canvas"');
  await page.getByLabel('Annotate any position').check();
  const point = await page
    .getByRole('group', { name: 'Prototype frame Home', exact: true })
    .evaluate((svg) => {
      const p = new DOMPoint(20, 120).matrixTransform((svg as SVGSVGElement).getScreenCTM()!);
      return { x: p.x, y: p.y };
    });
  await page.mouse.click(point.x, point.y);
  const address = JSON.parse((await page.getByTestId('prototype-anchor').textContent())!);
  expect(address).toMatchObject({
    artifactId: 'independent',
    elementId: 'Home',
    region: { type: 'canvas', width: 1, height: 1 },
  });
  expect(Number.isFinite(address.region.x)).toBe(true);
  await page.getByLabel('Host accepts commands').uncheck();
  await page.getByLabel('Prototype comment', { exact: true }).fill('Retained on rejection');
  await page.getByRole('button', { name: 'Add prototype comment', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Host rejected comment');
  await expect(page.getByLabel('Prototype comment', { exact: true })).toHaveValue(
    'Retained on rejection',
  );
  await expect(page.getByTestId('prototype-source')).toHaveText(bytes!);
});

test('normal Host imports, saves and reloads native prototype metadata and reports the same diagnostics', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.goto('/');
  await create(page, 'design');
  const record = await nativeArtifact(page);
  const d = prototypeFixture();
  d.elements.find((e) => e.id === 'No link')!.interactions = [
    { trigger: 'tap', action: { type: 'navigate', frameId: 'missing' } },
  ];
  record.draft.content = d;
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'prototype.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(record)),
  });
  const imported = await nativeArtifact(page);
  expect(imported.draft.content).toEqual(d);
  await page.getByLabel('Saved prototype start frame', { exact: true }).selectOption('Review');
  d.prototyping!.startFrameId = 'Review';

  await page.getByRole('button', { name: 'Open prototype', exact: true }).click();
  const expected = diagnoseDesignPrototype(d).map((x) => `${x.code}: ${x.message}`);
  await page.getByText(`Prototype diagnostics (${expected.length})`, { exact: true }).click();
  const prototype = page.getByRole('region', { name: 'Design prototype', exact: true });
  await expect(prototype.getByRole('listitem')).toHaveText(expected);
  await followPrototype(page);
  await expect(prototype.getByRole('status')).toContainText('Completed');
  await page.getByRole('button', { name: 'Close Design prototype', exact: true }).focus();
  await page.keyboard.press('Control+z');

  await page.getByRole('button', { name: 'Exit prototype', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(d);
  await page.getByRole('button', { name: 'Open prototype', exact: true }).click();
  await page.getByLabel('Prototype start frame', { exact: true }).selectOption('Home');
  await page.getByRole('button', { name: 'Restart prototype', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Annotate prototype', exact: true }).click();
  await page.getByRole('button', { name: 'Annotate No link', exact: true }).click();
  await page.getByLabel('Prototype comment', { exact: true }).fill('Prototype note');
  await page.getByRole('button', { name: 'Add prototype comment', exact: true }).click();
  await expect(page.getByLabel('Prototype comment', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Exit prototype', exact: true }).click();
  await save(page, 1);
  await page.reload();
  const reloaded = await nativeArtifact(page);
  expect(reloaded.draft.content).toEqual(d);
  expect(reloaded.annotations[0]).toMatchObject({
    anchor: { addresses: [{ elementId: 'No link' }] },
    comments: [{ body: 'Prototype note' }],
  });
  expect((reloaded.versions[0].content as DesignContent).prototyping).toEqual(d.prototyping);
});

test('shared normal Design sends interaction and flow metadata through authority and preserves peer edits on undo', async ({
  page: a,
  browser,
  baseURL,
}) => {
  test.setTimeout(120000);
  const { artifactMenu } = await import('./template-fixtures');
  const { reuseHistory } = await import('./reuse-fixtures');
  await a.goto('/');
  await create(a, 'design');
  const record = await nativeArtifact(a);
  const d = prototypeFixture();
  d.elements = d.elements.map((e) =>
    e.id === 'next/instance' ? { ...e, id: 'next-instance' } : e,
  );
  record.draft.content = d;
  await a.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'shared-prototype.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(record)),
  });
  await artifactMenu(a, 'Open collaboratively');
  await a.keyboard.press('Escape');
  await expect(a.locator('.save-status')).toContainText('Shared · confirmed');
  await a.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  const url = await a
    .getByRole('link', { name: 'Open peer editor', exact: true })
    .getAttribute('href');
  await a.keyboard.press('Escape');
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const b = await context.newPage(),
    errors: string[] = [];
  b.on('pageerror', (e) => errors.push(e.message));
  b.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  try {
    await b.goto(url!);
    await expect(b.locator('.save-status')).toContainText('Shared · confirmed');
    for (const p of [a, b])
      await p.getByRole('button', { name: 'Layer No link', exact: true }).click();
    await a
      .getByLabel('Element interaction click action', { exact: true })
      .selectOption('navigate');
    await a
      .getByLabel('Element interaction click target frame', { exact: true })
      .selectOption('Review');
    await expect(
      b.getByLabel('Element interaction click target frame', { exact: true }),
    ).toHaveValue('Review');
    await b.getByLabel('Layer name', { exact: true }).fill('Peer button');
    await b.getByLabel('Layer name', { exact: true }).press('Enter');
    await expect(a.getByLabel('Layer name', { exact: true })).toHaveValue('Peer button');
    await reuseHistory(a, 'Undo');
    await expect(
      b.getByLabel('Element interaction click target frame', { exact: true }),
    ).toHaveValue('Home');
    await expect(b.getByLabel('Layer name', { exact: true })).toHaveValue('Peer button');
    await reuseHistory(a, 'Redo');
    await expect(
      b.getByLabel('Element interaction click target frame', { exact: true }),
    ).toHaveValue('Review');
    // The peer projection may arrive before the originator receives the Redo
    // acknowledgement. Start the next dependent edit after both are confirmed.
    await expect(a.locator('.save-status')).toContainText('Shared · confirmed');
    await expect(b.locator('.save-status')).toContainText('Shared · confirmed');
    await a.getByLabel('Saved prototype start frame', { exact: true }).selectOption('Review');
    await expect(b.getByLabel('Saved prototype start frame', { exact: true })).toHaveValue(
      'Review',
    );
    await a.getByRole('button', { name: 'Open prototype', exact: true }).click();
    const before = (await nativeArtifact(b)).draft.content;
    await followPrototype(a);
    await expect(
      a.getByRole('region', { name: 'Design prototype', exact: true }).getByRole('status'),
    ).toContainText('Completed');
    expect((await nativeArtifact(b)).draft.content).toEqual(before);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('prototype comment typing keeps browser undo and redo separate from native history', async ({
  page,
}) => {
  await independentPrototype(page, true);
  await page.getByLabel('Saved prototype start frame', { exact: true }).selectOption('Review');
  const source = await page.getByTestId('prototype-source').textContent();
  await page.getByRole('button', { name: 'Open prototype', exact: true }).click();
  await page.getByLabel('Prototype start frame', { exact: true }).selectOption('Home');
  await page.getByRole('button', { name: 'Restart prototype', exact: true }).click();
  await page.getByRole('button', { name: 'Annotate prototype', exact: true }).click();
  await page.getByRole('button', { name: 'Annotate No link', exact: true }).click();
  const input = page.getByLabel('Prototype comment', { exact: true });
  await input.click();
  await page.keyboard.type('Review text');
  await page.keyboard.press('Control+z');
  await expect(input).toHaveValue('');
  await page.keyboard.press('Control+y');
  await expect(input).toHaveValue('Review text');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+Shift+z');
  await expect(input).toHaveValue('Review text');
  await expect(page.getByTestId('prototype-source')).toHaveText(source!);
  await page.getByRole('button', { name: 'Exit prototype', exact: true }).click();
  await page.getByRole('button', { name: 'Host undo', exact: true }).click();
  await expect(page.getByLabel('Saved prototype start frame', { exact: true })).toHaveValue('Home');
  await page.getByRole('button', { name: 'Host redo', exact: true }).click();
  await expect(page.getByTestId('prototype-source')).toHaveText(source!);
});

async function commentHost(
  page: import('@playwright/test').Page,
  shared = false,
  loseAcknowledgement = false,
) {
  await page.goto('/');
  await create(page, 'design');
  const record = await nativeArtifact(page);
  const d = prototypeFixture();
  d.elements = d.elements.map((e) =>
    e.id === 'next/instance' ? { ...e, id: 'next-instance' } : e,
  );
  record.draft.content = d;
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'comment-prototype.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(record)),
  });
  if (shared) {
    const { artifactMenu } = await import('./template-fixtures');
    await artifactMenu(page, 'Open collaboratively');
    await page.keyboard.press('Escape');
    await expect(page.locator('.save-status')).toContainText('Shared · confirmed');
    if (loseAcknowledgement) {
      await artifactMenu(page, 'Lose next acknowledgement (reference)');
      await page.keyboard.press('Escape');
    }
  }
  await page.getByRole('button', { name: 'Open prototype', exact: true }).click();
  await page.getByRole('button', { name: 'Annotate prototype', exact: true }).click();
  await page.getByRole('button', { name: 'Annotate No link', exact: true }).click();
  return d;
}

test('normal Host retains prototype comment after local persistence failure and retries once', async ({
  page,
}) => {
  const d = await commentHost(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (sessionStorage.getItem('commentQuota'))
        throw new DOMException('Injected quota failure', 'QuotaExceededError');
      return put.apply(this, args);
    };
    sessionStorage.setItem('commentQuota', 'yes');
  });
  const input = page.getByLabel('Prototype comment', { exact: true });
  await input.fill('Retained local note');
  await page.getByRole('button', { name: 'Add prototype comment', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Design prototype', exact: true }).getByRole('alert'),
  ).toBeVisible();
  await expect(input).toHaveValue('Retained local note');
  await expect(input).toBeEnabled();
  await page.evaluate(() => sessionStorage.removeItem('commentQuota'));
  await input.fill('Retained local note revised');
  await page.getByRole('button', { name: 'Add prototype comment', exact: true }).click();
  await expect(input).toHaveValue('');
  await page.getByRole('button', { name: 'Exit prototype', exact: true }).click();
  await page.reload();
  const record = await nativeArtifact(page);
  expect(record.draft.content).toEqual(d);
  expect(record.annotations).toHaveLength(1);
  expect(record.annotations[0].comments[0].body).toBe('Retained local note revised');
});

test('normal Host waits for delayed authority rejection and preserves comment for retry', async ({
  page,
}) => {
  const d = await commentHost(page, true);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let submitted = false;
  await page.route('**/collaboration-api/submit?*', async (route) => {
    if (!submitted) {
      submitted = true;
      await gate;
    }
    await route.continue();
  });
  const input = page.getByLabel('Prototype comment', { exact: true });
  await input.fill('Retained authority note');
  await page.getByRole('button', { name: 'Add prototype comment', exact: true }).click();
  try {
    await expect.poll(() => submitted).toBe(true);
    await expect(input).toBeDisabled();
    await expect(input).toHaveValue('Retained authority note');
    await page.evaluate(async () => {
      const key = Object.keys(sessionStorage).find((k) => k.startsWith('ep-shared-host:'))!;
      const { token } = JSON.parse(sessionStorage.getItem(key)!);
      const result = await fetch('/collaboration-api/editor/reference-permissions?domain=design', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        // Revoke writes independently of expiry; the expiry/presence race has
        // deterministic authority coverage in editor-recovery.test.ts.
        body: JSON.stringify({ writable: false, expiresAt: Date.now() + 3600000 }),
      });
      if (!result.ok) throw new Error('Failed to revoke reference permission');
    });
  } finally {
    release();
  }
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue('Retained authority note');
  await expect(
    page.getByRole('region', { name: 'Design prototype', exact: true }).getByRole('alert'),
  ).toBeVisible();
  // Restore externally while the prototype stays open; Host polling refreshes the grant.
  await page.evaluate(async () => {
    const key = Object.keys(sessionStorage).find((k) => k.startsWith('ep-shared-host:'))!;
    const { token } = JSON.parse(sessionStorage.getItem(key)!);
    const result = await fetch('/collaboration-api/editor/reference-permissions?domain=design', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ writable: true, expiresAt: Date.now() + 3600000 }),
    });
    if (!result.ok) throw new Error('Failed to restore reference permission');
  });
  await page.getByRole('button', { name: 'Add prototype comment', exact: true }).click();
  await expect(input).toHaveValue('');
  await page.getByRole('button', { name: 'Exit prototype', exact: true }).click();
  const record = await nativeArtifact(page);
  expect(record.draft.content).toEqual(d);
  expect(record.annotations).toHaveLength(1);
  expect(record.annotations[0].comments[0].body).toBe('Retained authority note');
  await expect(page.locator('.save-status')).toContainText('Shared · confirmed');
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Preview retained edit again', exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Save immutable version', exact: true })
    .getByRole('button', { name: 'この版を保存', exact: true })
    .click();
  await expect.poll(async () => (await nativeArtifact(page)).versions.length).toBe(1);
  const { artifactMenu } = await import('./template-fixtures');
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  const peer = await page
    .getByRole('link', { name: 'Open peer editor', exact: true })
    .getAttribute('href');
  await page.keyboard.press('Escape');
  await artifactMenu(page, 'Leave shared session');
  await page.keyboard.press('Escape');
  await expect(page.locator('.save-status')).not.toContainText('Shared');
  // Leaving returns to the original local artifact; inspect the shared artifact
  // through a fresh peer connection to verify its accepted note/version survive.
  await page.goto(peer!);
  await expect(page.locator('.save-status')).toContainText('Shared · confirmed');
  const sharedRecord = await nativeArtifact(page);
  expect(sharedRecord.annotations).toHaveLength(1);
  expect(sharedRecord.versions).toHaveLength(1);
});

test('normal Host reconciles an unconfirmed comment acknowledgement without duplicate threads', async ({
  page,
}) => {
  const d = await commentHost(page, true, true);
  const input = page.getByLabel('Prototype comment', { exact: true });
  await input.fill('Unconfirmed note');
  await page.getByRole('button', { name: 'Add prototype comment', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Design prototype', exact: true }).getByRole('alert'),
  ).toBeVisible();
  await expect(input).toHaveValue('Unconfirmed note');
  await expect(input).toBeEnabled();
  await page.getByRole('button', { name: 'Add prototype comment', exact: true }).click();
  await expect(input).toHaveValue('');
  await page.getByRole('button', { name: 'Exit prototype', exact: true }).click();
  const record = await nativeArtifact(page);
  expect(record.draft.content).toEqual(d);
  expect(record.annotations).toHaveLength(1);
  expect(record.annotations[0].comments[0].body).toBe('Unconfirmed note');
});

async function referenceGrant(page: import('@playwright/test').Page, writable: boolean) {
  await page.evaluate(async (writable) => {
    const key = Object.keys(sessionStorage).find((k) => k.startsWith('ep-shared-host:'))!;
    const { token } = JSON.parse(sessionStorage.getItem(key)!);
    const result = await fetch('/collaboration-api/editor/reference-permissions?domain=design', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ writable, expiresAt: Date.now() + 3600000 }),
    });
    if (!result.ok) throw new Error('Failed to change reference permission');
  }, writable);
}

async function rejectSubmission(
  page: import('@playwright/test').Page,
  submit: () => Promise<void>,
  retainedCount = 1,
) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let submitted = false;
  await page.route('**/collaboration-api/submit?*', async (route) => {
    submitted = true;
    await gate;
    await route.continue();
  });
  try {
    await submit();
    await expect.poll(() => submitted).toBe(true);
    await referenceGrant(page, false);
  } finally {
    release();
  }
  await expect(page.locator('.save-status')).toContainText(`${retainedCount} retained edit(s)`);
  // Keep the released gate as pass-through until page teardown. Toggling
  // interception here can strand a concurrent background polling request.
  // A later rejection installs a newer gate; existing gates are already released.
}

async function retainedCheckpoint(page: import('@playwright/test').Page) {
  const { artifactMenu } = await import('./template-fixtures');
  const { readFile } = await import('node:fs/promises');
  const download = page.waitForEvent('download');
  await artifactMenu(page, 'Export pending checkpoint');
  const file = await download;
  await page.keyboard.press('Escape');
  return JSON.parse(await readFile((await file.path())!, 'utf8')) as ReturnType<
    import('@editor-platform/collaboration-adapters').SharedEditorSession<DesignContent>['checkpoint']
  >;
}

test('comment retry preserves unrelated rejected input and retained replay cannot duplicate the note', async ({
  page,
}) => {
  const d = await commentHost(page, true);
  const { artifactMenu } = await import('./template-fixtures');
  await page.getByRole('button', { name: 'Exit prototype', exact: true }).click();
  await page.getByRole('button', { name: 'Layer No link', exact: true }).click();
  const name = page.getByLabel('Layer name', { exact: true });
  await rejectSubmission(page, async () => {
    await name.fill('Retained unrelated rename');
    await name.press('Enter');
  });
  const unrelated = (await retainedCheckpoint(page)).rejected;
  expect(unrelated).toHaveLength(1);
  await referenceGrant(page, true);
  await expect(name).toBeEnabled();
  await page.getByRole('button', { name: 'Open prototype', exact: true }).click();
  await page.getByRole('button', { name: 'Annotate prototype', exact: true }).click();
  await page.getByRole('button', { name: 'Annotate No link', exact: true }).click();
  const input = page.getByLabel('Prototype comment', { exact: true });
  await input.fill('Retried beside unrelated input');
  await rejectSubmission(
    page,
    async () => {
      await page.getByRole('button', { name: 'Add prototype comment', exact: true }).click();
    },
    2,
  );
  await expect(input).toBeEnabled();
  await referenceGrant(page, true);
  // Lose the first accepted retry response. Reconciliation must reuse the
  // proposal identity even though its original rejected entry still exists.
  await page.evaluate(() => {
    const original = window.fetch;
    const attempts: string[] = [];
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (String(args[0]).includes('/proposal/apply')) {
        attempts.push(JSON.parse(String(args[1]?.body)).id);
        sessionStorage.setItem('commentRetryProposals', JSON.stringify(attempts));
        if (attempts.length === 1) {
          await response.clone().json();
          throw new Error('Injected accepted retry acknowledgement loss');
        }
      }
      return response;
    };
  });
  await page.getByRole('button', { name: 'Add prototype comment', exact: true }).click();
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue('Retried beside unrelated input');
  await expect(
    page.getByRole('region', { name: 'Design prototype', exact: true }).getByRole('alert'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Add prototype comment', exact: true }).click();
  await expect(input).toHaveValue('');
  const proposals = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem('commentRetryProposals')!),
  );
  expect(proposals).toHaveLength(2);
  expect(proposals[0]).toBe(proposals[1]);
  await page.getByRole('button', { name: 'Exit prototype', exact: true }).click();
  const checkpoint = await retainedCheckpoint(page);
  expect(checkpoint.rejected).toEqual(unrelated);
  expect(checkpoint.client.confirmed.threads).toHaveLength(1);
  expect(checkpoint.client.confirmed.content).toEqual(d);
  await artifactMenu(page, 'Leave shared session');
  await page.keyboard.press('Escape');
  await expect(page.locator('.save-status')).toContainText('1 retained edit(s)');
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Save immutable version', exact: true })
    .getByRole('button', { name: 'この版を保存', exact: true })
    .click();
  expect((await retainedCheckpoint(page)).rejected).toEqual(unrelated);
  expect((await nativeArtifact(page)).versions).toHaveLength(0);
  await artifactMenu(page, 'Preview retained edit again');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Apply shared proposal', exact: true }).click();
  await expect(page.locator('.save-status')).toContainText('Shared · confirmed');
  const resolved = await retainedCheckpoint(page);
  expect(resolved.rejected).toEqual([]);
  expect(resolved.client.confirmed.threads).toEqual(checkpoint.client.confirmed.threads);
  expect(resolved.client.confirmed.content.elements.find((e) => e.id === 'No link')!.name).toBe(
    'Retained unrelated rename',
  );
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Save immutable version', exact: true })
    .getByRole('button', { name: 'この版を保存', exact: true })
    .click();
  await expect.poll(async () => (await nativeArtifact(page)).versions.length).toBe(1);
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  const peer = await page
    .getByRole('link', { name: 'Open peer editor', exact: true })
    .getAttribute('href');
  await page.keyboard.press('Escape');
  await artifactMenu(page, 'Leave shared session');
  await page.keyboard.press('Escape');
  await expect(page.locator('.save-status')).not.toContainText('Shared');
  // Leaving returns to the original local artifact; inspect the shared artifact
  // through a fresh peer connection to verify its accepted note/version survive.
  await page.goto(peer!);
  await expect(page.locator('.save-status')).toContainText('Shared · confirmed');
  const sharedRecord = await nativeArtifact(page);
  expect(sharedRecord.annotations).toHaveLength(1);
  expect(sharedRecord.versions).toHaveLength(1);
});

for (const resolution of ['apply', 'discard'] as const)
  test(`comment retry reconciles an explicit retained ${resolution} without duplicate delivery`, async ({
    page,
  }) => {
    await commentHost(page, true);
    const { artifactMenu } = await import('./template-fixtures');
    const input = page.getByLabel('Prototype comment', { exact: true });
    const note = `Retained ${resolution} note`;
    await input.fill(note);
    await rejectSubmission(page, async () => {
      await page.getByRole('button', { name: 'Add prototype comment', exact: true }).click();
    });
    await expect(input).toBeEnabled();
    await page.getByRole('button', { name: 'Exit prototype', exact: true }).click();
    await referenceGrant(page, true);
    if (resolution === 'apply') {
      await artifactMenu(page, 'Preview retained edit again');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Apply shared proposal', exact: true }).click();
    } else {
      await artifactMenu(page, 'Discard retained input');
      await page.keyboard.press('Escape');
    }
    await expect(page.locator('.save-status')).toContainText('Shared · confirmed');
    const before = await retainedCheckpoint(page);
    expect(before.rejected).toEqual([]);
    expect(before.client.confirmed.threads).toHaveLength(resolution === 'apply' ? 1 : 0);
    await page.getByRole('button', { name: 'Open prototype', exact: true }).click();
    await page.getByRole('button', { name: 'Annotate prototype', exact: true }).click();
    await page.getByRole('button', { name: 'Annotate No link', exact: true }).click();
    await input.fill(note);
    await page.getByRole('button', { name: 'Add prototype comment', exact: true }).click();
    if (resolution === 'discard') {
      await expect(input).toBeEnabled();
      await expect(input).toHaveValue(note);
      await expect(
        page.getByRole('region', { name: 'Design prototype', exact: true }).getByRole('alert'),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Add prototype comment', exact: true }).click();
    }
    await expect(input).toHaveValue('');
    await page.getByRole('button', { name: 'Exit prototype', exact: true }).click();
    const after = await retainedCheckpoint(page);
    expect(after.rejected).toEqual([]);
    expect(after.client.confirmed.threads).toHaveLength(1);
    if (resolution === 'apply')
      expect(after.client.confirmed.threads).toEqual(before.client.confirmed.threads);
  });
