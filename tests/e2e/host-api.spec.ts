import type { Page, TestInfo } from '@playwright/test';
import { test, expect, setDocumentText } from './fixtures';
import type { Artifact } from '@editor-platform/artifact-core';
import type { DocumentContent } from '@editor-platform/document/model';
import type { StructuredData } from '@editor-platform/structured-data/model';

// Independent Host fixture (apps/artifact-host/host-api.html): public packages only,
// no Playground state, CSS or build-time source replacement (#400).
test.skip(!!process.env.HOST_STUDIO_URL, 'The Host API fixture belongs to the reference Host.');
// Only the Artifact Host serves the fixture; suites on the Playground ports skip it.
test.skip(
  ({ baseURL }) => !/:(?:4177|5177)$/.test(baseURL ?? ''),
  'Runs in the host suite (E2E_SUITE=host).',
);
test.beforeEach(async ({ page }) => {
  await page.goto('/host-api.html');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Host API fixture' })).toBeVisible();
});
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const output = (page: Page, name: string) => page.getByLabel(name, { exact: true });
async function stored<T>(page: Page, id: string): Promise<Artifact<T>> {
  return JSON.parse((await page.evaluate((key) => localStorage.getItem(key), id))!);
}
async function lastSaved(page: Page) {
  return JSON.parse((await output(page, 'Last saved event').textContent())!);
}
async function shot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(name + '.png'), fullPage: true });
}

test('Document: edit → saved event → saved read → proposal → preview → accept → save → reload', async ({
  page,
}, info) => {
  await setDocumentText(page, '[data-block-id="doc-note"]', 'Owners confirm the dates today.');
  await expect(output(page, 'Draft state')).toHaveText('Unsaved changes');
  await button(page, 'Save version').click();
  await expect(output(page, 'Saved events')).toHaveText('1');
  const event = await lastSaved(page);
  expect(event).toMatchObject({ artifactId: 'host-api-document', committed: true, dirty: false });
  const saved = await stored<DocumentContent>(page, 'host-api-fixture:host-api-document');
  expect(event.versionId).toBe(saved.versions[0].versionId);
  expect(saved.draft.baseVersionId).toBe(event.versionId);

  // The tool's range crosses a native hard_break; textContent would have dropped it.
  await expect(output(page, 'Draft text')).toContainText(
    'Kickoff on Monday.\nReview on Friday.\nShip next week.',
  );
  await button(page, 'Propose from saved version').click();
  const review = page.getByRole('article', { name: /^Proposal Replace/ });
  await expect(review.getByLabel('Proposal preview')).toContainText(
    'Kickoff on Monday.\nReview on Thursday.\nShip next week.',
  );
  // Preview leaves the draft unchanged.
  await expect(output(page, 'Draft text')).toContainText('Review on Friday.');
  await shot(page, info, 'document-review');
  await review.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByLabel('Proposal results').getByRole('listitem')).toHaveText([
    'accepted (unsaved)',
  ]);
  await expect(output(page, 'Draft state')).toHaveText('Unsaved changes');
  await expect(page.locator('[data-block-id="doc-body"]')).toContainText('Review on Thursday.');
  // Keyboard history reaches the retained Host Session: one Undo removes the proposal.
  await page.locator('[data-block-id="doc-body"]').click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('[data-block-id="doc-body"]')).toContainText('Review on Friday.');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(page.locator('[data-block-id="doc-body"]')).toContainText('Review on Thursday.');
  await button(page, 'Save version').click();
  await expect(output(page, 'Saved events')).toHaveText('2');

  await page.reload();
  await expect(output(page, 'Draft state')).toHaveText('Saved');
  await expect(output(page, 'Draft text')).toHaveText(
    'Launch plan\n\nKickoff on Monday.\nReview on Thursday.\nShip next week.\n\nOwners confirm the dates today.',
  );
  const reloaded = await stored<DocumentContent>(page, 'host-api-fixture:host-api-document');
  expect(reloaded.versions).toHaveLength(2);
  expect(reloaded.draft.content.blocks.map((b) => b.id)).toEqual([
    'doc-title',
    'doc-body',
    'doc-note',
  ]);
  expect(reloaded.draft.content.blocks[1].text).toBe(
    'Kickoff on Monday.\nReview on Thursday.\nShip next week.',
  );
  // The hard_break is still a native break in the editor after reload.
  await expect(page.locator('[data-block-id="doc-body"] br')).toHaveCount(2);
});

test('Data: reject leaves content; accept by API saves and reloads; text read is unsupported', async ({
  page,
}, info) => {
  await button(page, 'Data').click();
  await expect(output(page, 'Draft text')).toHaveText(/^unsupported: /);
  await button(page, 'Save version').click();
  await expect(output(page, 'Saved events')).toHaveText('1');
  await button(page, 'Propose from saved version').click();
  const review = page.getByRole('article', { name: 'Proposal Mark the first record Active' });
  await expect(review.getByLabel('Proposal preview')).toContainText('Design review | Active');
  await review.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect(output(page, 'Draft state')).toHaveText('Saved');
  await button(page, 'Propose from saved version').click();
  await shot(page, info, 'data-review');
  await review.getByRole('button', { name: 'Accept by API', exact: true }).click();
  await expect(page.getByLabel('Proposal results').getByRole('listitem')).toHaveText([
    'rejected',
    'accepted (unsaved)',
  ]);
  await button(page, 'Save version').click();
  await expect(output(page, 'Draft state')).toHaveText('Saved');
  await page.reload();
  const data = await stored<StructuredData>(page, 'host-api-fixture:host-api-data');
  const status = data.draft.content.columns[1].id;
  expect(data.draft.content.rows.map((r) => [r.id, r.values[status]])).toEqual([
    ['row-1', 'Active'],
    ['row-2', 'Planned'],
  ]);
  expect(data.versions).toHaveLength(2);
});

test('a failed save sends no event; a held save completes without overwriting newer edits', async ({
  page,
}) => {
  await setDocumentText(page, '[data-block-id="doc-note"]', 'First edit.');
  await page.getByLabel('Fail next save', { exact: true }).check();
  await button(page, 'Save version').click();
  await expect(page.getByRole('alert')).toContainText('save-failed');
  await expect(output(page, 'Saved events')).toHaveText('0');
  await expect(output(page, 'Draft state')).toHaveText('Unsaved changes');

  await page.getByLabel('Hold next save', { exact: true }).check();
  await button(page, 'Save version').click();
  await expect(output(page, 'Draft state')).toHaveText('Saving');
  await setDocumentText(page, '[data-block-id="doc-note"]', 'Second edit while saving.');
  await button(page, 'Finish held save').click();
  await expect(output(page, 'Saved events')).toHaveText('1');
  const event = await lastSaved(page);
  expect(event.dirty).toBe(true);
  expect(event.currentRevision).toBeGreaterThan(event.revision);
  await expect(output(page, 'Draft state')).toHaveText('Unsaved changes');
  await expect(output(page, 'Draft text')).toContainText('Second edit while saving.');
  const saved = await stored<DocumentContent>(page, 'host-api-fixture:host-api-document');
  expect(saved.draft.content.blocks[2].text).toBe('First edit.');
});

test('stale, read-only and unconfirmed-input refusals use the same accept path', async ({
  page,
}) => {
  await button(page, 'Save version').click();
  await expect(output(page, 'Saved events')).toHaveText('1');
  await button(page, 'Propose from saved version').click();
  const review = page.getByRole('article', { name: /^Proposal Replace/ });
  await setDocumentText(page, '[data-block-id="doc-note"]', 'Edited after the preview.');
  await expect(review).toContainText('(stale: the draft changed)');
  await review.getByRole('button', { name: 'Accept by API', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('proposal-stale');
  await expect(review).toHaveCount(0);
  await expect(output(page, 'Draft text')).toContainText('Review on Friday.');
  // A proposal from a saved event older than the draft is refused at registration.
  await button(page, 'Propose from saved version').click();
  await expect(page.getByRole('alert')).toContainText('proposal-stale');

  await button(page, 'Save version').click();
  await expect(output(page, 'Saved events')).toHaveText('2');
  await button(page, 'Propose from saved version').click();
  await page.getByLabel('Read only (Host permission)', { exact: true }).check();
  await review.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('read-only');
  await expect(review).toHaveCount(1);
  await page.getByLabel('Read only (Host permission)', { exact: true }).uncheck();
  await page.getByLabel('Hold unconfirmed input', { exact: true }).check();
  await review.getByRole('button', { name: 'Accept by API', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('input-pending');
  await expect(output(page, 'Draft text')).toContainText('Review on Friday.');
  await page.getByLabel('Hold unconfirmed input', { exact: true }).uncheck();
  await review.getByRole('button', { name: 'Accept by API', exact: true }).click();
  await expect(output(page, 'Draft text')).toContainText('Review on Thursday.');
  await expect(page.getByLabel('Proposal results').getByRole('listitem')).toHaveText([
    'stale (unsaved)',
    'accepted (unsaved)',
  ]);
});

test('switching editors detaches listeners: one save sends one event', async ({ page }) => {
  // Unconfirmed input blocks switching, which would unmount the Surface.
  await page.getByLabel('Hold unconfirmed input', { exact: true }).check();
  await button(page, 'Data').click();
  await expect(page.getByRole('alert')).toContainText('input-pending');
  await expect(button(page, 'Document')).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('Hold unconfirmed input', { exact: true }).uncheck();
  for (let i = 0; i < 3; i++) {
    await button(page, 'Data').click();
    await button(page, 'Document').click();
  }
  await setDocumentText(page, '[data-block-id="doc-note"]', 'Once.');
  await button(page, 'Save version').click();
  await expect(output(page, 'Draft state')).toHaveText('Saved');
  await expect(output(page, 'Saved events')).toHaveText('1');
  await button(page, 'Data').click();
  await button(page, 'Save version').click();
  await expect(output(page, 'Saved events')).toHaveText('2');
  expect((await lastSaved(page)).artifactId).toBe('host-api-data');
});
