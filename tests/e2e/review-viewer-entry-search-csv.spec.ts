import { replaceFileSource, test, expect } from './fixtures';
import { readFile } from 'node:fs/promises';

test('Code Review adds a comment from the inspector and lays out the jump button beside the thread meta', async ({
  page,
}, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New Code Review', exact: true }).click();
  const inspector = page.getByRole('complementary', { name: 'Review inspector' });
  const body = inspector.getByLabel('Comment on selected lines', { exact: true });
  const add = inspector.getByRole('button', { name: 'Add line comment', exact: true });
  await expect(body).toBeDisabled();
  await page.getByRole('button', { name: 'removed old line 2', exact: true }).click();
  await body.fill('Inspector comment');
  await add.click();
  await expect(body).toHaveValue('');
  await expect(
    inspector.getByRole('button', { name: /^Inspector comment · Current/ }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('button', { name: /^Comments \(1\)/ }).click();
  await page.keyboard.press('Escape');
  const thread = page.locator('.comment-thread').first();
  await expect(thread).toContainText('old · lines 2–2');
  await expect(thread).toContainText('Inspector comment');
  // The meta text and the jump button never overlap, at the default and a narrow width.
  for (const width of [1440, 1000]) {
    await page.setViewportSize({ width, height: 900 });
    const meta = await thread
      .locator('.comment-thread-meta small')
      .evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().toJSON()));
    const jump = await thread
      .getByRole('button', { name: 'Jump to annotation', exact: true })
      .boundingBox();
    for (const box of meta) {
      const overlaps =
        box.x < jump!.x + jump!.width &&
        jump!.x < box.x + box.width &&
        box.y < jump!.y + jump!.height &&
        jump!.y < box.y + box.height;
      expect(overlaps).toBe(false);
    }
    expect(
      await thread
        .getByRole('button', { name: 'Jump to annotation', exact: true })
        .evaluate((b) => b.scrollWidth <= b.clientWidth),
    ).toBe(true);
  }
  await page.screenshot({ path: info.outputPath('comments-thread.png') });
  await page.getByRole('button', { name: 'Close comments', exact: true }).click();

  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByLabel('Read only', { exact: true }).check();
  await page.keyboard.press('Escape');
  await expect(body).toBeDisabled();
});

test('File Viewer moves to matches with Enter, marks them, and shows CSV as a table', async ({
  page,
}, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New File Viewer', exact: true }).click();
  const text = Buffer.from(
    Array.from({ length: 200 }, (_, i) =>
      i === 99 ? 'beta match' : i === 179 ? 'MATCH delta' : `line ${i + 1}`,
    ).join('\n'),
  );
  await replaceFileSource(page, { name: 'notes.txt', mimeType: 'text/plain', buffer: text });
  const search = page.getByLabel('Search file', { exact: true });
  await search.fill('match');
  const lines = page.getByRole('region', { name: 'Text file' });
  // Enter moves through the matching lines and wraps back to the first.
  for (const line of [100, 180, 100]) {
    await search.press('Enter');
    await expect(search).toBeFocused();
    await expect(
      page.getByRole('button', { name: `File line ${line}`, exact: true }),
    ).toBeInViewport();
  }
  await expect(lines.locator('mark')).toHaveText(['match']);
  await search.press('Enter');
  await expect(lines.locator('mark')).toHaveText(['MATCH']);
  await page.screenshot({ path: info.outputPath('text-search.png') });

  const csv = Buffer.from(
    'name,note,count\r\nTurbine,"blade, long, with a note far longer than its heading",3\r\nHub,"line one\nline two",1\r\n"Say ""hi""",,2\r\n',
  );
  // Some systems report CSV as a spreadsheet type; it still opens as CSV.
  await replaceFileSource(page, {
    name: 'parts.csv',
    mimeType: 'application/vnd.ms-excel',
    buffer: csv,
  });
  await expect(page.getByLabel('CSV layout', { exact: true })).toHaveValue('table');
  const table = page.getByRole('region', { name: 'CSV table' });
  await expect(table.locator('.ep-csv-row.header .ep-csv-cell')).toHaveText([
    'name',
    'note',
    'count',
  ]);
  await expect(page.getByRole('button', { name: 'CSV row 2', exact: true })).toContainText(
    'blade, long',
  );
  await expect(
    page.getByRole('button', { name: 'CSV row 3', exact: true }).locator('.ep-csv-cell').nth(1),
  ).toHaveText('line one\nline two');
  await expect(
    page.getByRole('button', { name: 'CSV row 4', exact: true }).locator('.ep-csv-cell').first(),
  ).toHaveText('Say "hi"');
  // Every row shares the header's column edges, however long its values are.
  const edges = await table
    .locator('.ep-csv-row')
    .evaluateAll((rows) =>
      rows.map((row) =>
        [...row.querySelectorAll('.ep-csv-cell')].map((c) =>
          Math.round(c.getBoundingClientRect().x),
        ),
      ),
    );
  for (const row of edges) expect(row).toEqual(edges[0]);
  // The table searches the decoded cells it shows, so an escaped quote is found as displayed.
  await search.fill('Say "hi"');
  await expect(page.getByRole('button', { name: 'Next file match', exact: true })).toBeEnabled();
  await search.press('Enter');
  await expect(table.locator('mark')).toHaveText(['Say "hi"']);
  await search.fill('two');
  await expect(table.locator('mark')).toHaveText(['two']);
  await page.screenshot({ path: info.outputPath('csv-table.png') });

  // A table row anchors its source lines, so the comment matches the text view.
  await page.getByRole('button', { name: 'CSV row 3', exact: true }).click();
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('button', { name: /^Comments \(/ }).click();
  await page.keyboard.press('Escape');
  await page.getByLabel('Comment', { exact: true }).fill('Check the hub note');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await expect(page.locator('.comment-thread').first()).toContainText('text · lines 3–4');
  await page.getByRole('button', { name: 'Close comments', exact: true }).click();

  await page.getByLabel('CSV layout', { exact: true }).selectOption('text');
  await expect(page.getByRole('button', { name: 'File line 3', exact: true })).toContainText(
    'Hub,"line one',
  );
  await expect(page.getByRole('button', { name: 'File line 3', exact: true })).toHaveClass(
    /selected/,
  );
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download original file', exact: true }).click();
  expect(await readFile((await (await pending).path())!)).toEqual(csv);
});
