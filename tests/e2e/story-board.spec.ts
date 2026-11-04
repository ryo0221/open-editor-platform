import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

async function savedArtifacts(page: Page) {
  return page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const request = indexedDB.open('editor-platform', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            transaction = db.transaction('artifacts', 'readonly');
          const read = transaction.objectStore('artifacts').getAll();
          transaction.oncomplete = () => {
            db.close();
            resolve(JSON.stringify(read.result));
          };
          transaction.onerror = () => reject(transaction.error);
        };
      }),
  );
}
async function openDemo(page: Page, host: '通常' | '独立') {
  await page.goto(host === '通常' ? '/story-board.html' : 'http://127.0.0.1:4177/story-board.html');
  await page.getByRole('button', { name: '10人の物語ボードを作る', exact: true }).click();
  await expect(page.getByRole('heading', { name: /霧の王国・物語ボード/ })).toBeVisible();
  await expect(page.getByRole('slider', { name: '共通の時点', exact: true })).toHaveValue('3');
}
async function canvas(page: Page) {
  const switcher = page.getByRole('button', { name: 'キャンバスへ', exact: true });
  if (await switcher.isVisible()) await switcher.click();
  await page.getByRole('button', { name: 'Fit board', exact: true }).click();
  await expect(page.locator('[data-board-lane]')).toHaveCount(11);
}

for (const host of ['通常', '独立'] as const) {
  test(`SB02/07/15 ${host}: multiple-place choices stay clickable above the canvas and inside the viewport`, async ({
    page,
  }) => {
    await openDemo(page, host);
    await canvas(page);
    const before = await savedArtifacts(page);
    const places = page.locator('.sb-toolbar details').filter({ hasText: /^場所：/ });
    await places.locator('summary').click();
    const popup = (await places.locator('.sb-choice-body').boundingBox())!;
    expect(popup.x).toBeGreaterThanOrEqual(0);
    expect(popup.x + popup.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
    await places.getByRole('button', { name: '選択を空にする', exact: true }).click();
    await places.getByLabel('王都', { exact: true }).check();
    await places.getByLabel('港', { exact: true }).check();
    await places.locator('summary').click();
    await expect(page.locator('[data-board-lane]')).toHaveCount(6);
    const groups = page.locator('.sb-toolbar details').filter({ hasText: /^筋：/ });
    await groups.locator('summary').click();
    const groupPopup = (await groups.locator('.sb-choice-body').boundingBox())!;
    expect(groupPopup.x).toBeGreaterThanOrEqual(0);
    expect(groupPopup.x + groupPopup.width).toBeLessThanOrEqual(
      await page.evaluate(() => innerWidth),
    );
    await groups.locator('summary').click();
    expect(await savedArtifacts(page)).toBe(before);
  });

  test(`SB05 ${host}: event/card/map selection shares identity and filtering is a separate action`, async ({
    page,
  }) => {
    await openDemo(page, host);
    await canvas(page);
    const before = await savedArtifacts(page);
    const controls = page.getByRole('button', { name: 'アリアの3日目を選択', exact: true });
    await controls.first().focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.sb-sidebar h3')).toHaveText('アリアの3日目');
    await expect(controls.last().locator('rect')).toHaveAttribute('stroke', '#289180');
    await expect(page.locator('[data-board-lane]')).toHaveCount(11);
    const place = page.getByRole('button', { name: /^王都：/ });
    await place.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.sb-sidebar h3')).toHaveText('王都');
    await expect(page.locator('[data-board-lane]')).toHaveCount(11);
    await page.getByRole('button', { name: 'ここで絞る', exact: true }).click();
    await expect(page.locator('[data-board-lane]')).toHaveCount(4);
    await expect(page.getByRole('slider', { name: '共通の時点', exact: true })).toHaveValue('3');
    expect(await savedArtifacts(page)).toBe(before);
  });

  test(`SB07/09/10 ${host}: native layout keeps focus and Undo separate from settings`, async ({
    page,
  }) => {
    await openDemo(page, host);
    await canvas(page);
    const before = await savedArtifacts(page);
    await page.getByRole('button', { name: '配置を編集', exact: true }).click();
    const frame = page.locator('[data-canvas-target="timeline"]');
    const box = (await frame.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const stage = page.getByRole('application', { name: 'Whiteboard canvas', exact: true });
    await expect(stage).toBeFocused();
    const original = (await frame.boundingBox())!;
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await frame.boundingBox())!.x).not.toBe(original.x);
    await expect(stage).toBeFocused();
    await page.getByRole('button', { name: '配置をUndo', exact: true }).click();
    await expect.poll(async () => (await frame.boundingBox())!.x).toBe(original.x);
    expect(await savedArtifacts(page)).toBe(before);
  });

  test(`SB08/10 ${host}: source edits use native owner Undo/save and return to the same board filter`, async ({
    page,
  }) => {
    await openDemo(page, host);
    const list = page.getByRole('button', { name: '一覧で見る', exact: true });
    if (await list.isVisible()) await list.click();
    const before = JSON.parse(await savedArtifacts(page)) as { id: string; versions: unknown[] }[];
    const row = page
      .locator('.sb-list article')
      .filter({ has: page.getByRole('button', { name: 'アリアの3日目', exact: true }) });
    await row.getByRole('button', { name: '元資料を開く', exact: true }).click();
    await page
      .locator('[data-edit-event="EV-400"]')
      .getByRole('button', { name: '名前を変更', exact: true })
      .click();
    const form = page.getByRole('form', { name: 'EV-400 の名前', exact: true });
    await form.getByLabel('名前', { exact: true }).fill('アリアが橋へ向かう');
    await form.getByRole('button', { name: '確定', exact: true }).click();
    await expect(page.locator('[data-unsaved="sb660-story-ledger-A"]')).toBeVisible();
    await page
      .locator('.tl-editbar')
      .getByRole('button', { name: '元に戻す', exact: true })
      .click();
    await expect(page.locator('[data-unsaved="sb660-story-ledger-A"]')).toHaveCount(0);
    await page
      .locator('.tl-editbar')
      .getByRole('button', { name: 'やり直す', exact: true })
      .click();
    await page.locator('[data-unsaved="sb660-story-ledger-A"]').getByRole('button').click();
    await expect(page.locator('[data-unsaved="sb660-story-ledger-A"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'ボードへ戻る', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'アリアが橋へ向かう', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('slider', { name: '共通の時点', exact: true })).toHaveValue('3');
    const after = JSON.parse(await savedArtifacts(page)) as typeof before;
    expect(after.filter((a) => a.id !== 'sb660-story-ledger-A')).toEqual(
      before.filter((a) => a.id !== 'sb660-story-ledger-A'),
    );
    const old = before.find((a) => a.id === 'sb660-story-ledger-A')!;
    const next = after.find((a) => a.id === old.id)!;
    expect(next.versions.slice(0, old.versions.length)).toEqual(old.versions);
    expect(next.versions).toHaveLength(old.versions.length + 1);
  });

  test(`SB08 ${host}: repeated scene manuscript addresses and fixed map remain read-only`, async ({
    page,
  }) => {
    await openDemo(page, host);
    const before = await savedArtifacts(page);
    await page.getByRole('button', { name: '物語タイムラインで確認・編集', exact: true }).click();
    await page.getByRole('tab', { name: '構成の提示順', exact: true }).click();
    for (const [occurrence, manuscript] of [
      ['OC-001', 'ch01'],
      ['OC-006', 'ch08'],
    ]) {
      await page.locator(`#tl-panel [data-occurrence="${occurrence}"] .tl-item`).click();
      await page
        .getByRole('button', {
          name: `原稿を開く（sb660-manuscript-${manuscript} · region-${manuscript}-sc001）`,
          exact: true,
        })
        .first()
        .click();
      await expect(page.locator('.tl-trip-surface [contenteditable="true"]')).toHaveCount(0);
      await expect(page.getByRole('note')).toHaveText(
        '読み取り専用で開いています。変更はできません。',
      );
      await page.getByRole('button', { name: '戻る', exact: true }).click();
      await expect(
        page.locator(`#tl-panel [data-occurrence="${occurrence}"] .tl-item`),
      ).toHaveAttribute('aria-pressed', 'true');
    }
    await page.getByRole('button', { name: 'ボードへ戻る', exact: true }).click();
    await page.getByRole('button', { name: '固定地図を元の画面で見る', exact: true }).click();
    await expect(page.locator('.sb-fixed-map svg[role="application"]')).toBeVisible();
    await expect(page.locator('.sb-fixed-map')).toContainText('board-sample-v1');
    await page.getByRole('button', { name: 'ボードへ戻る', exact: true }).click();
    await expect(page.getByRole('slider', { name: '共通の時点', exact: true })).toHaveValue('3');
    expect(await savedArtifacts(page)).toBe(before);
  });

  test(`SB07 ${host}: focused controls keep Space pan separate from keyboard activation`, async ({
    page,
  }) => {
    await openDemo(page, host);
    await canvas(page);
    const before = await savedArtifacts(page);
    const stage = page.getByRole('application', { name: 'Whiteboard canvas', exact: true });
    const camera = stage.locator(':scope > g').first();
    const transform = await camera.getAttribute('transform');
    const control = page.getByRole('button', { name: '6日目を見る', exact: true });
    await control.focus();
    const box = (await control.boundingBox())!;
    await page.keyboard.down('Space');
    await page.mouse.move(box.x + box.width / 2, box.y + 5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 35, box.y + 35, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up('Space');
    await expect(page.getByRole('slider', { name: '共通の時点', exact: true })).toHaveValue('3');
    expect(await camera.getAttribute('transform')).not.toBe(transform);
    expect(await savedArtifacts(page)).toBe(before);
    await control.focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('slider', { name: '共通の時点', exact: true })).toHaveValue('6');
    expect(await savedArtifacts(page)).toBe(before);
  });

  test(`SB01/02/03/05 ${host}: shared cursor and OR/AND choices update one canvas without native writes`, async ({
    page,
  }, info) => {
    await openDemo(page, host);
    await canvas(page);
    const before = await savedArtifacts(page);
    const labels = await page
      .locator('[data-board-map-marker]')
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('aria-label')));
    const slider = page.getByRole('slider', { name: '共通の時点', exact: true });
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    await expect(slider).toHaveValue('4');
    await expect
      .poll(() =>
        page
          .locator('[data-board-map-marker]')
          .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('aria-label'))),
      )
      .not.toEqual(labels);
    expect(await savedArtifacts(page)).toBe(before);
    await page
      .getByRole('combobox', { name: '保存した表示', exact: true })
      .selectOption({ label: '遠征組' });
    await expect(page.locator('[data-board-lane]')).toHaveCount(3);
    const people = page.locator('.sb-toolbar details').filter({ hasText: /^人物：/ });
    await people.locator('summary').click();
    await people.getByRole('button', { name: '選択を空にする', exact: true }).click();
    await people.locator('summary').click();
    await expect(page.locator('[data-board-lane]')).toHaveCount(0);
    await expect(page.locator('[data-board-map-marker]')).toHaveCount(0);
    expect(await savedArtifacts(page)).toBe(before);
    await page
      .getByRole('combobox', { name: '保存した表示', exact: true })
      .selectOption({ label: '全員・3日目' });
    await page.screenshot({
      path: `/tmp/660-board-${host}-${info.project.name}.png`,
      fullPage: true,
    });
  });

  test(`SB06/10 ${host}: named view saves and reopens; its Undo changes only settings`, async ({
    page,
  }) => {
    await openDemo(page, host);
    await page
      .getByRole('combobox', { name: '保存した表示', exact: true })
      .selectOption({ label: '遠征組' });
    const before = JSON.parse(await savedArtifacts(page)) as {
      id: string;
      draft: unknown;
      versions: unknown[];
    }[];
    await page.getByRole('textbox', { name: '表示名', exact: true }).fill('三人の確認');
    await page.getByRole('button', { name: 'この条件を名前付きで保存', exact: true }).click();
    await expect(
      page
        .getByRole('combobox', { name: '保存した表示', exact: true })
        .locator('option')
        .filter({ hasText: '三人の確認' }),
    ).toHaveCount(1);
    await expect(page.getByRole('textbox', { name: '表示名', exact: true })).toHaveValue('');
    const after = JSON.parse(await savedArtifacts(page)) as typeof before;
    expect(after.filter((a) => a.id !== 'sb660-settings')).toEqual(
      before.filter((a) => a.id !== 'sb660-settings'),
    );
    await page.getByRole('button', { name: '表示条件をUndo', exact: true }).click();
    await expect(page.locator('.sb-save-state')).toContainText('表示条件：未保存');
    expect(JSON.parse(await savedArtifacts(page))).toEqual(after);
    await page.getByRole('button', { name: '表示条件を保存', exact: true }).click();
    await expect(
      page
        .getByRole('combobox', { name: '保存した表示', exact: true })
        .locator('option')
        .filter({ hasText: '三人の確認' }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: '表示条件をRedo', exact: true }).click();
    await page.getByRole('button', { name: '表示条件を保存', exact: true }).click();
    await expect(
      page
        .getByRole('combobox', { name: '保存した表示', exact: true })
        .locator('option')
        .filter({ hasText: '三人の確認' }),
    ).toHaveCount(1);
    await page.reload();
    await expect(page.getByRole('combobox', { name: '保存した表示', exact: true })).toBeVisible();
    await page
      .getByRole('combobox', { name: '保存した表示', exact: true })
      .selectOption({ label: '三人の確認' });
    if (await page.getByRole('button', { name: 'キャンバスへ', exact: true }).isVisible()) {
      await expect(page.locator('[data-board-position]')).toHaveCount(3);
    } else await expect(page.locator('[data-board-lane]')).toHaveCount(3);
  });
}
