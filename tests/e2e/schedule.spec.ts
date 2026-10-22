import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect, create } from './fixtures';

// Schedule (IN-17) through its independent reference Host and the Playground. The Host's
// calendar ports are the deterministic mock: synthetic data, no network, no real people.
const host = '/schedule-host.html?date=2026-10-26&zone=Asia/Tokyo';
const details = (page: Page) => page.getByRole('complementary', { name: 'Event details' });

async function newEvent(page: Page, title: string) {
  await page.getByRole('button', { name: 'New event', exact: true }).click();
  const title_ = details(page).getByLabel('Event title', { exact: true });
  await expect(title_).toBeFocused();
  await title_.fill(title);
  await title_.press('Enter');
}
async function setTime(page: Page, start: string, end: string) {
  await details(page).getByLabel('Start time', { exact: true }).fill(start);
  await details(page).getByLabel('End time', { exact: true }).fill(end);
  await details(page).getByRole('button', { name: 'Apply time', exact: true }).click();
}
async function addLane(page: Page, mode: 'Pin this version' | 'Follow new versions') {
  await page.getByRole('button', { name: 'Add lane', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add lane', exact: true });
  await dialog.getByLabel('Data view', { exact: true }).selectOption({
    label: 'Release plan data · Release plan · Timeline',
  });
  await dialog.getByLabel('Lane version', { exact: true }).selectOption({ label: mode });
  await dialog.getByRole('button', { name: 'Add lane', exact: true }).click();
  await expect(page.getByLabel('Lane Release plan', { exact: true })).toBeVisible();
}

test('creates, times and undoes events, keeping the event zone separate from the display zone (ST-24)', async ({
  page,
}) => {
  await page.goto(host);
  await expect(page.getByText('No events yet. Use New event to add one.')).toBeVisible();
  await newEvent(page, 'Design review');
  await setTime(page, '2026-10-27T15:00', '2026-10-27T16:00');
  const event = page.getByRole('button', { name: /^Design review, 2026-10-27 15:00–16:00/ });
  await expect(event).toBeVisible();

  // Display in UTC: the same instant at 06:00, the stored wall time is unchanged.
  await page.getByLabel('Display time zone', { exact: true }).selectOption('UTC');
  await expect(
    page.getByRole('button', {
      name: /^Design review, 2026-10-27 06:00–07:00 \(15:00 Asia\/Tokyo\)/,
    }),
  ).toBeVisible();
  await page.getByLabel('Display time zone', { exact: true }).selectOption('Asia/Tokyo');

  // End before start is refused without changing the event.
  await setTime(page, '2026-10-27T17:00', '2026-10-27T16:00');
  await expect(page.getByRole('alert')).toContainText(/end/i);
  await expect(event).toBeVisible();

  // Keyboard moves by a day; Undo returns it.
  await event.focus();
  await page.keyboard.press('ArrowRight');
  await expect(
    page.getByRole('button', { name: /^Design review, 2026-10-28 15:00/ }),
  ).toBeFocused();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(event).toBeVisible();

  // A timed event crossing midnight into the next week shows there too.
  await newEvent(page, 'Night deploy');
  await setTime(page, '2026-11-01T23:00', '2026-11-02T01:00');
  await page.getByRole('button', { name: 'Next week', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Night deploy,/ })).toBeVisible();
  await page.getByRole('button', { name: 'Previous week', exact: true }).click();

  // A new event lands at 10:00 on the shown day in the display zone, not the Schedule zone.
  await page.getByLabel('Display time zone', { exact: true }).selectOption('America/Los_Angeles');
  await newEvent(page, 'West coast sync');
  await expect(
    page.getByRole('button', { name: /^West coast sync, 2026-10-26 10:00–11:00/ }),
  ).toBeVisible();
  await page.getByLabel('Display time zone', { exact: true }).selectOption('Asia/Tokyo');

  // An all-day event shows its last day inclusively.
  await newEvent(page, 'Offsite');
  await details(page).getByLabel('All day', { exact: true }).check();
  await details(page).getByLabel('Start date', { exact: true }).fill('2026-10-29');
  await details(page).getByLabel('Last day', { exact: true }).fill('2026-10-30');
  await details(page).getByRole('button', { name: 'Apply time', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Offsite, 2026-10-29 – 2026-10-30 · All day', exact: true }),
  ).toBeVisible();
});

test('a multi-day drag previews one column per day and commits the same move (ST-24)', async ({
  page,
}) => {
  await page.goto(host);
  await newEvent(page, 'Workshop');
  await details(page).getByLabel('All day', { exact: true }).check();
  await details(page).getByLabel('Start date', { exact: true }).fill('2026-10-27');
  await details(page).getByLabel('Last day', { exact: true }).fill('2026-10-29');
  await details(page).getByRole('button', { name: 'Apply time', exact: true }).click();
  const card = page.getByRole('button', { name: /^Workshop, 2026-10-27 – 2026-10-29/ });
  const week = await page.getByRole('grid', { name: 'Week', exact: true }).boundingBox();
  const box = (await card.boundingBox())!;
  const day = week!.width / 7;
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 10 + day, box.y + box.height / 2, { steps: 5 });
  // The preview moves by one day column, not by the card's own (three-day) width.
  const shift = await card.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41);
  expect(Math.abs(shift - day)).toBeLessThan(1);
  await page.mouse.up();
  await expect(
    page.getByRole('button', { name: /^Workshop, 2026-10-28 – 2026-10-30/ }),
  ).toBeVisible();
});

test('forgets a DST fold once the time changes and saves text still being typed (ST-24)', async ({
  page,
}) => {
  await page.goto(host);
  await newEvent(page, 'Night shift');
  await details(page)
    .getByLabel('Event time zone', { exact: true })
    .selectOption('America/New_York');
  await setTime(page, '2026-11-01T01:30', '2026-11-01T03:00');
  await details(page).getByLabel('Earlier (before the clock change)', { exact: true }).check();
  await details(page).getByRole('button', { name: 'Apply time', exact: true }).click();
  await expect(page.getByRole('button', { name: /\(01:30 America\/New_York\)/ })).toBeVisible();
  // The saved choice stays with that time: changing only the end needs no new choice.
  await details(page).getByLabel('End time', { exact: true }).fill('2026-11-01T03:30');
  await details(page).getByRole('button', { name: 'Apply time', exact: true }).click();
  await expect(
    page.getByRole('button', { name: /14:30–17:30 \(01:30 America\/New_York\)/ }),
  ).toBeVisible();
  await expect(
    details(page).getByLabel('Earlier (before the clock change)', { exact: true }),
  ).toBeChecked();
  // An ordinary time afterwards is not refused because of the old choice.
  await setTime(page, '2026-10-30T09:00', '2026-10-30T10:00');
  await expect(page.getByRole('button', { name: /\(09:00 America\/New_York\)/ })).toBeVisible();
  await expect(details(page).getByText('The start time occurs twice. Which one?')).toHaveCount(0);

  // A title over the limit is refused and blocks the save; the typed text stays.
  const long = 'x'.repeat(513);
  await details(page).getByLabel('Event title', { exact: true }).fill(long);
  await page.getByRole('button', { name: 'Save version', exact: true }).dispatchEvent('click');
  await expect(page.getByRole('status').first()).toContainText('Not saved');
  await expect(details(page).getByLabel('Event title', { exact: true })).toHaveValue(long);
  // Export and closing the details stop at the same boundary instead of dropping the text.
  await page.getByRole('button', { name: 'Export JSON', exact: true }).dispatchEvent('click');
  await expect(page.getByRole('status').first()).toContainText('Not exported');
  await details(page).getByRole('button', { name: 'Close details', exact: true }).click();
  await expect(details(page).getByLabel('Event title', { exact: true })).toHaveValue(long);

  // Save commits text still being typed into the saved version. dispatchEvent keeps focus in
  // the field, as a keyboard shortcut would, so no blur commits it first.
  await details(page).getByLabel('Event title', { exact: true }).fill('Night shift (typed)');
  await details(page).getByLabel('Event notes', { exact: true }).fill('Bring the runbook');
  await page.getByRole('button', { name: 'Save version', exact: true }).dispatchEvent('click');
  await expect(page.getByRole('status').first()).toHaveText('Saved version 1');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const saved = JSON.parse(await readFile((await (await download).path())!, 'utf8'));
  expect(saved.versions[0].content.events[0]).toMatchObject({
    title: 'Night shift (typed)',
    notes: 'Bring the runbook',
  });
});

test('reads a Data lane by reference, links records and keeps pinned/following versions honest (ST-24)', async ({
  page,
}) => {
  await page.goto(host);
  // The lane picker takes keyboard focus and gives it back on Escape.
  const addLaneButton = page.getByRole('button', { name: 'Add lane', exact: true });
  await addLaneButton.click();
  await expect(
    page.getByRole('dialog', { name: 'Add lane' }).getByLabel('Data view', { exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Add lane' })).toHaveCount(0);
  await expect(addLaneButton).toBeFocused();
  await addLane(page, 'Follow new versions');
  const lane = page.getByLabel('Lane Release plan', { exact: true });
  await expect(lane).toContainText('API design review');
  await expect(lane).toContainText('Schedule editing UI');

  await newEvent(page, 'UI review');
  await details(page).getByRole('checkbox', { name: 'Schedule editing UI' }).check();
  await expect(page.getByRole('button', { name: /^UI review,/ })).toContainText('→ 1 related');

  // A newer saved Data version removes the linked record: the link is kept and reported.
  await page.getByText('Mock Host controls').click();
  await page.getByRole('button', { name: 'Save Data plan v2', exact: true }).click();
  await expect(lane).not.toContainText('Schedule editing UI');
  await expect(details(page)).toContainText(
    'Related record not found: “Schedule editing UI” is not in Release plan v2.',
  );
  await details(page).getByRole('button', { name: 'Remove link', exact: true }).click();
  await expect(page.getByRole('button', { name: /^UI review,/ })).not.toContainText('related');

  // Pinning keeps the version on screen; revoking access shows the lane as unavailable.
  await lane.getByLabel('Lane mode', { exact: true }).selectOption({ label: 'Pin this version' });
  await expect(lane).toContainText('Pinned · v2');
  await page.getByLabel('Revoke Data access', { exact: true }).check();
  await expect(lane).toContainText('Lane unavailable');
  // Export captures references as a save does: without access it writes nothing.
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  await expect(page.getByRole('status').first()).toContainText('Not exported');

  // The Host-owned slot never enters Schedule content.
  await page.getByLabel('Revoke Data access', { exact: true }).uncheck();
  await details(page).getByLabel('Linked thread', { exact: true }).selectOption('thread-launch');
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await expect(page.getByRole('status').first()).toHaveText('Saved version 1');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const text = await readFile((await (await download).path())!, 'utf8');
  expect(JSON.parse(text)).toMatchObject({ kind: 'schedule' });
  expect(text).not.toContain('thread-launch');
  expect(text).not.toContain('Weekly sync');
});

test('exports the lane version the Schedule shows, not the one captured earlier (ST-24)', async ({
  page,
}) => {
  await page.goto(host);
  await addLane(page, 'Follow new versions');
  await page.getByText('Mock Host controls').click();
  await page.getByRole('button', { name: 'Save Data plan v2', exact: true }).click();
  const lane = page.getByLabel('Lane Release plan', { exact: true });
  await expect(lane).toContainText('v2');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const exported = JSON.parse(await readFile((await (await download).path())!, 'utf8'));
  expect(exported.draft.content.lanes[0].reference.snapshot.revision).toBe(2);
});

test('a lane reference that resolves after switching to read-only adds nothing (ST-24)', async ({
  page,
}) => {
  await page.goto(host);
  await page.getByText('Mock Host controls').click();
  await page.getByLabel('Hold lane references', { exact: true }).check();
  await page.getByRole('button', { name: 'Add lane', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add lane', exact: true });
  await dialog.getByLabel('Data view', { exact: true }).selectOption({
    label: 'Release plan data · Release plan · Timeline',
  });
  await dialog.getByRole('button', { name: 'Add lane', exact: true }).click();
  await page.getByLabel('Read-only', { exact: true }).check();
  await page.getByRole('button', { name: 'Release held lane references', exact: true }).click();
  await expect(page.getByText('This Schedule is read-only.')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Work lanes' })).toHaveCount(0);
});

test('a save that waits for lane references stops when Read-only is switched on (ST-24)', async ({
  page,
}) => {
  await page.goto(host);
  await newEvent(page, 'Saved later');
  await page.getByText('Mock Host controls').click();
  await page.getByLabel('Hold lane references', { exact: true }).check();
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await page.getByLabel('Read-only', { exact: true }).click();
  await page.getByRole('button', { name: 'Release held lane references', exact: true }).click();
  await expect(page.getByRole('status').first()).toContainText(
    'Not saved: This Schedule is read-only.',
  );
  await expect(page.getByRole('status').first()).not.toContainText('Saved version');
});

test('import does not replace the Schedule over refused event text (ST-24)', async ({ page }) => {
  await page.goto(host);
  await newEvent(page, 'Exported');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const buffer = await readFile((await (await download).path())!);
  const title = details(page).getByLabel('Event title', { exact: true });
  const long = 'x'.repeat(513);
  await title.fill(long);
  await page.getByLabel('Import JSON', { exact: true }).setInputFiles({
    name: 'schedule.json',
    mimeType: 'application/json',
    buffer,
  });
  await expect(page.getByRole('status').first()).toContainText('Import refused: Event title');
  await expect(title).toHaveValue(long);
});

test('Duplicate creates nothing while the details hold refused text (ST-24)', async ({ page }) => {
  await page.goto(host);
  await newEvent(page, 'Original');
  const cards = page.locator('[data-event-id]');
  await expect(cards).toHaveCount(1);
  const title = details(page).getByLabel('Event title', { exact: true });
  const long = 'x'.repeat(513);
  await title.fill(long);
  // From the keyboard, so leaving the field and pressing the button are separate steps.
  const duplicate = page.getByRole('button', { name: 'Duplicate event', exact: true });
  await duplicate.focus();
  await duplicate.press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'Event title' }).first()).toBeVisible();
  await expect(cards).toHaveCount(1);
  await expect(title).toHaveValue(long);
});

test('Undo does not drop refused notes that are still in the field (ST-24)', async ({ page }) => {
  await page.goto(host);
  await newEvent(page, 'Notes check');
  const notes = details(page).getByLabel('Event notes', { exact: true });
  await notes.fill('Short note');
  await notes.blur();
  const long = 'y'.repeat(16 * 1024 + 1);
  await notes.fill(long);
  await notes.blur();
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await expect(notes).toHaveValue(long);
});

test('Undo never removes an event whose refused text is still in its details (ST-24)', async ({
  page,
}) => {
  await page.goto(host);
  await page.getByRole('button', { name: 'New event', exact: true }).click();
  const title = details(page).getByLabel('Event title', { exact: true });
  const long = 'x'.repeat(513);
  await title.fill(long);
  // Clearing the Host selection does not open a way around the guard.
  await page.getByText('Mock Host controls').click();
  await page.getByRole('combobox', { name: 'Host selection', exact: true }).selectOption('');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('status').first()).toContainText(
    'Not changed: this would remove an event',
  );
  await expect(title).toHaveValue(long);
  await title.fill('Kept');
  await title.press('Enter');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(details(page)).toHaveCount(0);
});

test('plans a calendar send only from committed event text (ST-25)', async ({ page }) => {
  await page.goto(host);
  await newEvent(page, 'Planned title');
  const title = details(page).getByLabel('Event title', { exact: true });
  const long = 'x'.repeat(513);
  const apply = details(page).getByRole('button', { name: 'Apply to calendar', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Apply to calendar', exact: true });
  // Refused text keeps the dialog closed instead of planning the older title.
  await title.fill(long);
  await apply.dispatchEvent('click');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('alert').filter({ hasText: 'Event title' })).toBeVisible();
  await expect(title).toHaveValue(long);
  await title.fill('Planned title');
  await apply.click();
  // Text typed while the dialog is open is committed before the plan, or stops it.
  await title.fill('Typed after opening');
  await dialog.getByRole('button', { name: 'Prepare plan', exact: true }).dispatchEvent('click');
  await expect(dialog.getByTestId('plan-sends')).toContainText('Typed after opening');
  await title.fill(long);
  await dialog
    .getByRole('button', { name: 'Send to calendar', exact: true })
    .dispatchEvent('click');
  await expect(dialog.getByText(/^Event title/)).toBeVisible();
  await expect(dialog.getByRole('region', { name: 'Result' })).toHaveCount(0);
  await expect(title).toHaveValue(long);
});

test('adds one lane for a double click on Add lane (ST-24)', async ({ page }) => {
  await page.goto(host);
  await page.getByText('Mock Host controls').click();
  await page.getByLabel('Hold lane references', { exact: true }).check();
  await page.getByRole('button', { name: 'Add lane', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add lane', exact: true });
  await dialog.getByLabel('Data view', { exact: true }).selectOption({
    label: 'Release plan data · Release plan · Timeline',
  });
  const add = dialog.getByRole('button', { name: 'Add lane', exact: true });
  await add.click();
  await expect(add).toBeDisabled();
  // A second click while the first is pending starts nothing more.
  await add.dispatchEvent('click');
  await page.getByRole('button', { name: 'Release held lane references', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('region', { name: /^Lane / })).toHaveCount(1);
});

test('folds a long related-work list, finds records across lanes and lists linked ones first (ST-24)', async ({
  page,
}) => {
  await page.goto(`${host}&tasks=12`);
  await addLane(page, 'Pin this version');
  await newEvent(page, 'Portfolio review');
  const panel = details(page);
  // 17 records in one lane: search is offered, but a single lane stays open.
  const search = panel.getByLabel('Find related work', { exact: true });
  await expect(search).toBeVisible();
  await expect(panel.locator('details.ep-schedule-related')).toHaveAttribute('open', '');
  await expect(panel.getByRole('checkbox', { name: /^API design review/ })).toBeVisible();

  // A second lane folds both.
  await page.getByRole('button', { name: 'Add lane', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add lane', exact: true });
  await dialog.getByLabel('Data view', { exact: true }).selectOption({
    label: 'Release plan data · Release plan · Timeline',
  });
  await dialog.getByRole('button', { name: 'Add lane', exact: true }).click();
  await expect(page.getByLabel('Lane Release plan', { exact: true })).toHaveCount(2);
  await expect(panel.locator('details.ep-schedule-related[open]')).toHaveCount(0);
  await expect(panel.getByRole('checkbox', { name: /^API design review/ })).toHaveCount(0);

  await search.fill('workstream task 1');
  await expect(panel.getByRole('checkbox', { name: /^Workstream task 1/ })).toHaveCount(8);
  await panel
    .getByRole('checkbox', { name: /^Workstream task 12/ })
    .first()
    .check();
  await expect(page.getByRole('button', { name: /^Portfolio review,/ })).toContainText(
    '→ 1 related',
  );
  // The linked record leads the list with its lane name and leaves the search results.
  const linkedWork = panel.getByLabel('Linked work', { exact: true });
  await expect(linkedWork.getByRole('checkbox', { name: /^Workstream task 12/ })).toBeChecked();
  await expect(linkedWork).toContainText('Release plan');
  await expect(panel.getByRole('checkbox', { name: /^Workstream task 1/ })).toHaveCount(8);

  // Without a query the folded lanes still hold every unlinked record.
  await search.fill('');
  await panel.locator('details.ep-schedule-related summary').first().click();
  await expect(panel.getByRole('checkbox', { name: /^API design review/ })).toBeVisible();
});

test('marks lane bars that run past the shown week with their dates (ST-24)', async ({ page }) => {
  await page.goto(host);
  await addLane(page, 'Pin this version');
  const lane = page.getByLabel('Lane Release plan', { exact: true });
  const bar = (name: string) => lane.locator('.ep-schedule-bar', { hasText: name });
  // Starts before and ends after the week: both edges are marked and the dates are shown.
  await expect(bar('Platform design')).toHaveText(
    '◂ Platform design 09-01 – 11-30 Continues before this week Continues after this week ▸',
  );
  await expect(bar('Platform design')).toHaveClass(/ep-schedule-bar-before/);
  await expect(bar('Platform design')).toHaveClass(/ep-schedule-bar-after/);
  // Ends after the week only; the year changes nothing when both dates share it.
  await expect(bar('Launch campaign')).toHaveText(
    'Launch campaign 10-29 – 12-04 Continues after this week ▸',
  );
  await expect(bar('Launch campaign')).not.toHaveClass(/ep-schedule-bar-before/);
  // Work inside the week keeps its plain name.
  await expect(bar('API design review')).toHaveText('API design review');
});

test('opens the Add lane window under its button without moving the week (ST-24)', async ({
  page,
}) => {
  for (const size of [
    { width: 1600, height: 1000 },
    { width: 900, height: 700 },
  ]) {
    await page.setViewportSize(size);
    await page.goto(host);
    const week = page.getByRole('grid', { name: 'Week' });
    const before = (await week.boundingBox())!;
    const button = page.getByRole('button', { name: 'Add lane', exact: true });
    await button.click();
    const dialog = page.getByRole('dialog', { name: 'Add lane', exact: true });
    await expect(dialog.getByLabel('Data view', { exact: true })).toBeFocused();
    const trigger = page.locator('[data-add-lane-trigger]');
    const at = (await trigger.boundingBox())!;
    const box = (await dialog.boundingBox())!;
    const schedule = (await page.locator('.ep-schedule').boundingBox())!;
    // Just below the button, inside the Schedule, and the week stays where it was.
    expect(box.y).toBeGreaterThanOrEqual(at.y + at.height);
    expect(box.y - (at.y + at.height)).toBeLessThan(16);
    expect(box.x).toBeGreaterThanOrEqual(schedule.x);
    expect(box.x + box.width).toBeLessThanOrEqual(schedule.x + schedule.width);
    expect(box.x).toBeLessThanOrEqual(at.x + at.width);
    expect((await week.boundingBox())!.y).toBe(before.y);
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  }
});

test('shows private calendars as private overlay and sends only a prepared plan (ST-25, ST-26)', async ({
  page,
}) => {
  await page.goto(host);
  await page.getByRole('button', { name: 'Show my calendars', exact: true }).click();
  const sources = page.getByRole('region', { name: 'My calendars' });
  await sources.getByRole('checkbox', { name: /Work calendar/ }).check();
  await sources.getByRole('checkbox', { name: /Team availability/ }).check();
  const work = page
    .getByLabel('Only you can see this: Work calendar (synthetic)')
    .filter({ hasText: 'Weekly sync' });
  await expect(work).toContainText('Weekly sync (synthetic)');
  // Provider text is plain: the markup is visible text, never an element.
  await expect(work).toContainText('<script>');
  await expect(
    page
      .getByLabel('Only you can see this: Work calendar (synthetic)')
      .filter({ hasText: 'Offsite (synthetic)' }),
  ).toContainText('All day');
  await expect(page.locator('.ep-schedule-overlay img, .ep-schedule-overlay script')).toHaveCount(
    0,
  );
  const team = page.getByLabel('Only you can see this: Team availability (busy only)');
  await expect(team).toContainText('Busy');

  // An incomplete read marks days unknown, not free.
  await page.getByText('Mock Host controls').click();
  await page.getByLabel('Incomplete calendar read', { exact: true }).check();
  await page.getByRole('button', { name: 'Next week', exact: true }).click();
  await expect(page.getByText(/Incomplete: some of your calendar could not be read/)).toBeVisible();
  await expect(page.locator('.ep-schedule-unknown').first()).toBeVisible();
  await page.getByRole('button', { name: 'Previous week', exact: true }).click();

  // One calendar failing keeps the others and marks its range unknown.
  await page.getByLabel('Incomplete calendar read', { exact: true }).uncheck();
  await page.getByLabel('Fail team calendar read', { exact: true }).check();
  await page.getByRole('button', { name: 'Next week', exact: true }).click();
  await expect(page.getByText('Team availability could not be read.')).toBeVisible();
  await expect(work).toContainText('Weekly sync (synthetic)');
  await expect(page.getByText(/Incomplete: some of your calendar could not be read/)).toBeVisible();
  await expect(page.locator('.ep-schedule-unknown').first()).toBeVisible();
  await page.getByLabel('Fail team calendar read', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Previous week', exact: true }).click();
  await expect(page.getByText('Team availability could not be read.')).toHaveCount(0);

  await newEvent(page, 'Launch sync');
  await details(page).getByLabel('Event notes', { exact: true }).fill('Internal only');
  await details(page).getByLabel('Event notes', { exact: true }).blur();
  await details(page).getByRole('button', { name: 'Apply to calendar', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Apply to calendar', exact: true });
  await dialog.getByRole('button', { name: 'Prepare plan', exact: true }).click();
  const sends = dialog.getByTestId('plan-sends');
  await expect(sends).toContainText('Launch sync');
  await expect(sends).not.toContainText('Internal only');

  // Editing after planning makes the plan stale.
  await details(page).getByLabel('Event title', { exact: true }).fill('Launch sync v2');
  await details(page).getByLabel('Event title', { exact: true }).press('Enter');
  await expect(dialog.getByRole('alert')).toContainText('Prepare it again before sending');
  await expect(
    dialog.getByRole('button', { name: 'Send to calendar', exact: true }),
  ).toBeDisabled();
  await dialog.getByRole('button', { name: 'Prepare again', exact: true }).click();

  await page.getByLabel('Effect result', { exact: true }).selectOption('unknown');
  await dialog.getByRole('button', { name: 'Send to calendar', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveAttribute('data-summary', 'unknown');
  await expect(dialog.getByRole('button', { name: 'Send to calendar', exact: true })).toHaveCount(
    0,
  );
  const intents = await page.evaluate(
    () =>
      (window as unknown as { scheduleHostMock: { intents: unknown[] } }).scheduleHostMock.intents,
  );
  expect(JSON.stringify(intents)).not.toMatch(/row-|lane|thread|Internal only/);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  // Reopening shows the unknown result to check, not a new plan to send.
  await details(page).getByRole('button', { name: 'Apply to calendar', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveAttribute('data-summary', 'unknown');
  await expect(dialog.getByRole('button', { name: 'Prepare plan', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Check status', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  // The overlay stays out of the saved artifact.
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const text = await readFile((await (await download).path())!, 'utf8');
  expect(text).not.toMatch(/Weekly sync|mock-work|mock-team/);
});

test('reports post-acceptance failures and failed sends honestly, then returns focus (ST-25)', async ({
  page,
}) => {
  await page.goto(host);
  await newEvent(page, 'Launch sync');
  await page.getByText('Mock Host controls').click();
  const apply = details(page).getByRole('button', { name: 'Apply to calendar', exact: true });
  await apply.click();
  const dialog = page.getByRole('dialog', { name: 'Apply to calendar', exact: true });
  const send = dialog.getByRole('button', { name: 'Send to calendar', exact: true });

  // A send that throws may have reached the Host: nothing for this event is offered again, not
  // even a new plan, until the Host reconciles it.
  await page.getByLabel('Effect result', { exact: true }).selectOption('send-error');
  await dialog.getByRole('button', { name: 'Prepare plan', exact: true }).click();
  await send.click();
  await expect(dialog.getByText(/^Result unknown/)).toBeVisible();
  await expect(send).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Prepare again', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await apply.click();
  await expect(dialog.getByText(/^Result unknown/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Prepare plan', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await newEvent(page, 'Retro');
  // While the Host has not answered, closing and reopening offers nothing to send.
  await page.getByLabel('Effect result', { exact: true }).selectOption('verified');
  await page.getByLabel('Hold calendar sends', { exact: true }).check();
  await apply.click();
  await dialog.getByRole('button', { name: 'Prepare plan', exact: true }).click();
  await send.click();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await apply.click();
  await expect(dialog.getByText(/^Sending\. The Host has not answered yet/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Prepare plan', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Release held sends', exact: true }).click();
  // The answer reaches the reopened dialog: it shows the result instead of a new send.
  await expect(dialog.getByRole('status')).toHaveAttribute('data-summary', 'verified');
  await expect(dialog.getByRole('button', { name: 'Prepare plan', exact: true })).toHaveCount(0);
  await page.getByLabel('Hold calendar sends', { exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await newEvent(page, 'Retro 2');
  await apply.click();
  await dialog.getByRole('button', { name: 'Prepare plan', exact: true }).click();

  // Accepted then failed is not "refused": something may already be in the calendar.
  await page.getByLabel('Effect result', { exact: true }).selectOption('failed-after-acceptance');
  await send.click();
  await expect(dialog.getByRole('status')).toHaveAttribute(
    'data-summary',
    'failed-after-acceptance',
  );
  await expect(dialog.getByRole('status')).toContainText(
    'Something may already be in the calendar',
  );

  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(apply).toBeFocused();

  // A conflict applied nothing: the dialog offers the new plan it asks for.
  await newEvent(page, 'Retro 3');
  await page.getByLabel('Effect result', { exact: true }).selectOption('conflict');
  await apply.click();
  await dialog.getByRole('button', { name: 'Prepare plan', exact: true }).click();
  await send.click();
  await expect(dialog.getByRole('status')).toHaveAttribute('data-summary', 'conflict');
  await dialog.getByRole('button', { name: 'Prepare again', exact: true }).click();
  await expect(send).toBeEnabled();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await apply.click();
  await expect(dialog.getByRole('button', { name: 'Prepare plan', exact: true })).toBeEnabled();
});

test('drops the whole overlay when the Host withdraws the read port (ST-26)', async ({ page }) => {
  await page.goto(host);
  await page.getByRole('button', { name: 'Show my calendars', exact: true }).click();
  await page
    .getByRole('region', { name: 'My calendars' })
    .getByRole('checkbox', { name: /Work calendar/ })
    .check();
  await expect(page.locator('.ep-schedule-overlay').first()).toBeVisible();
  await page.getByText('Mock Host controls').click();
  await page.getByLabel('Calendar read port', { exact: true }).uncheck();
  await expect(page.locator('.ep-schedule-overlay')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'My calendars' })).toHaveCount(0);
  // A new port starts empty: nothing from the old connection comes back.
  await page.getByLabel('Calendar read port', { exact: true }).check();
  await expect(page.getByRole('button', { name: 'Show my calendars', exact: true })).toBeVisible();
  await expect(page.locator('.ep-schedule-overlay')).toHaveCount(0);
});

test('drops a late calendar read after the account changes (ST-26)', async ({ page }) => {
  await page.goto(host);
  await page.getByText('Mock Host controls').click();
  await page.getByLabel('Hold calendar reads', { exact: true }).check();
  await page.getByRole('button', { name: 'Show my calendars', exact: true }).click();
  const sources = page.getByRole('region', { name: 'My calendars' });
  await sources.getByRole('checkbox', { name: /Work calendar/ }).check();
  await expect(page.getByText('Reading your calendars…')).toBeVisible();
  await page.getByRole('button', { name: 'Switch account', exact: true }).click();
  await expect(sources.getByRole('checkbox', { name: /account 2/ }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Release held reads', exact: true }).click();
  await expect(page.locator('.ep-schedule-overlay')).toHaveCount(0);
  await expect(sources.getByRole('checkbox', { name: /Work calendar/ })).not.toBeChecked();
});

test('refuses edits in read-only mode and works without Host calendar ports', async ({ page }) => {
  await page.goto(`${host}&readonly=1&effects=0&read=0`);
  await expect(page.getByRole('button', { name: 'New event', exact: true })).toBeDisabled();
  // The Host's own write boundaries refuse too.
  await expect(page.getByRole('button', { name: 'Save version', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Import JSON', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Show my calendars', exact: true })).toHaveCount(0);

  // An open event turned read-only shows its title without an editable buffer.
  await page.goto(host);
  await newEvent(page, 'Locked review');
  await page.getByText('Mock Host controls').click();
  await page.getByLabel('Read-only', { exact: true }).check();
  const title = details(page).getByLabel('Event title', { exact: true });
  await expect(title).toHaveAttribute('readonly', '');
  await title.press('x');
  await expect(title).toHaveValue('Locked review');
  await details(page).getByRole('button', { name: 'Close details', exact: true }).click();
  await expect(details(page)).toHaveCount(0);
});

test('anchors Playground comments to moved events, jumps to their week and guards read-only (ST-24)', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'schedule');
  await newEvent(page, 'Alpha');
  await details(page).getByRole('button', { name: 'Close details', exact: true }).click();
  await newEvent(page, 'Beta');
  await details(page).getByRole('button', { name: 'Close details', exact: true }).click();
  const card = (name: string) => page.getByRole('button', { name: new RegExp(`^${name},`) });
  await card('Alpha').click();
  await details(page).getByRole('button', { name: 'Close details', exact: true }).click();
  // Closing returns focus to Alpha on the next frame; wait so it does not take focus back later.
  await expect(card('Alpha')).toBeFocused();

  // Moving another event with the keyboard selects it in the Host too, so a comment lands on it.
  await card('Beta').focus();
  await page.keyboard.press('ArrowRight');
  await expect(card('Beta')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('button', { name: /^Comments \(/ }).click();
  await page.keyboard.press('Escape');
  await page.getByPlaceholder('Leave a note on this selection…').fill('About Beta');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await page.getByRole('button', { name: 'Close comments', exact: true }).click();
  await card('Alpha').click();
  await details(page).getByRole('button', { name: 'Close details', exact: true }).click();
  const jump = async () => {
    await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
    await page.getByRole('button', { name: /^Comments \(/ }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Jump to annotation', exact: true }).click();
  };
  await jump();
  await expect(card('Beta')).toHaveAttribute('aria-pressed', 'true');
  // From another week, the jump shows the event's week again.
  await page.getByRole('button', { name: 'Next week', exact: true }).click();
  await expect(card('Beta')).toHaveCount(0);
  // The Comments inspector is still open after the first jump.
  await page.getByRole('button', { name: 'Jump to annotation', exact: true }).click();
  await expect(card('Beta')).toBeVisible();

  // Read only replaces the title field, so a refused title stops the switch and stays.
  await card('Alpha').click();
  const long = 'x'.repeat(513);
  await details(page).getByLabel('Event title', { exact: true }).fill(long);
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Read only', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(details(page).getByLabel('Event title', { exact: true })).toHaveValue(long);
  await expect(details(page).getByLabel('Event title', { exact: true })).not.toHaveAttribute(
    'readonly',
  );
});

test('a Host-driven selection does not drop a refused title in the open details (ST-24)', async ({
  page,
}) => {
  await page.goto(host);
  await newEvent(page, 'Alpha');
  await details(page).getByRole('button', { name: 'Close details', exact: true }).click();
  await newEvent(page, 'Beta');
  await page.getByRole('button', { name: /^Alpha,/ }).click();
  const long = 'x'.repeat(513);
  await details(page).getByLabel('Event title', { exact: true }).fill(long);
  await page.getByText('Mock Host controls').click();
  const selection = page.getByRole('combobox', { name: 'Host selection', exact: true });
  await selection.selectOption({ label: 'Beta' });
  // The details keep Alpha and its text, and the Host's selection is handed back.
  await expect(details(page).getByLabel('Event title', { exact: true })).toHaveValue(long);
  await expect(page.getByRole('button', { name: /^Alpha,/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(selection.locator('option:checked')).toHaveText('Alpha');
  // Switching to read-only would replace the field, so it is refused while the title is refused.
  await page.getByLabel('Read-only', { exact: true }).click();
  await expect(page.getByRole('status').first()).toContainText('Not switched to read-only');
  await expect(details(page).getByLabel('Event title', { exact: true })).toHaveValue(long);
  await expect(page.getByLabel('Read-only', { exact: true })).not.toBeChecked();
  // Once the title is acceptable, the same Host selection moves to Beta.
  await details(page).getByLabel('Event title', { exact: true }).fill('Alpha (fixed)');
  await selection.selectOption({ label: 'Beta' });
  await expect(page.getByRole('button', { name: /^Beta,/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('creates a Schedule in the Playground and keeps it after reload', async ({ page }) => {
  await page.goto('/');
  await create(page, 'schedule');
  await newEvent(page, 'Playground review');
  await expect(page.getByRole('button', { name: /^Playground review,/ })).toBeVisible();
  // The Playground passes no calendar ports, so neither entry is offered.
  await expect(page.getByRole('button', { name: 'Apply to calendar', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show my calendars', exact: true })).toHaveCount(0);
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  await page.reload();
  await expect(page.getByRole('button', { name: /^Playground review,/ })).toBeVisible();
});
