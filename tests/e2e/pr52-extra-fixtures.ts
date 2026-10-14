import { expect, type Page } from '@playwright/test';
import { createArtifact, commitVersion, contentHash } from '@editor-platform/artifact-core';
import { createDeck, makeSlideObject, type SlideContent } from '@editor-platform/slide/model';
import { createDesign, makeDesignElement } from '@editor-platform/design/model';
import { createWhiteboard, makeWhiteboardNode } from '@editor-platform/whiteboard/model';
import { createData, addRow } from '@editor-platform/structured-data/model';
import { mountBoundaryHost } from './pr52-boundary-fixtures';
import { importUsability } from './usability-fixtures';
import { artifactMenu } from './template-fixtures';
import { confirmed } from './practical-fixtures';
import { dataProjection } from './structured-graph-fixtures';
import { nativeArtifact } from './fixtures';

export async function slideLayoutBoundary(page: Page) {
  await mountBoundaryHost(page, 'slide');
  const source = async (): Promise<SlideContent> =>
    JSON.parse((await page.getByTestId('slide-source').textContent())!);
  const before = await source();
  const menu = page.getByRole('button', { name: 'Add slide layout', exact: true });
  const add = async () => {
    if (!(await menu.isVisible()))
      await page
        .getByRole('button', { name: 'More editor tools', exact: true })
        .dispatchEvent('click');
    if ((await menu.getAttribute('aria-expanded')) !== 'true') await menu.dispatchEvent('click');
    await page.getByRole('button', { name: 'title-body', exact: true }).dispatchEvent('click');
  };
  await page.getByRole('button', { name: 'text object 1', exact: true }).dblclick();
  const input = page.getByRole('textbox', { name: 'Edit canvas text', exact: true });
  await input.press('Control+End');
  await page.keyboard.type(' retained');
  await input.dispatchEvent('compositionstart');
  await add();
  await expect(input).toHaveText('Original retained');
  await expect(page.getByLabel('Current page')).toHaveValue('1');
  await expect(page.locator('.surface-error')).toContainText('入力変換');
  expect(await source()).toEqual(before);
  await input.dispatchEvent('compositionend');
  await add();
  await expect(input).toHaveText('Original retained');
  expect(await source()).toEqual(before);
  await page.getByLabel('Host accepts commands').check();
  await add();
  const added = await source();
  expect(added.slides).toHaveLength(2);
  expect(added.slides[0].objects[0].text).toBe('Original retained');
  expect(added.slides[1].objects.map((object) => object.text)).toEqual([
    'Title',
    'Add your story here',
  ]);
  await expect(page.getByLabel('Current page')).toHaveValue('2');
  await page.keyboard.press('Escape');
  await page.getByLabel('Host accepts commands').uncheck();
  await add();
  expect(await source()).toEqual(added);
  await expect(page.getByLabel('Current page')).toHaveValue('2');
  await page.keyboard.press('Escape');
  const object = page
    .getByRole('application', { name: 'Slide canvas', exact: true })
    .getByRole('button')
    .filter({ has: page.locator('text') })
    .first();
  await object.click();
  const width = page.getByLabel('Element width', { exact: true });
  if (!(await width.isVisible()))
    await page.getByRole('button', { name: 'Toggle Slide inspector', exact: true }).click();
  await width.fill('');
  await add();
  await expect(width).toHaveValue('');
  await expect(page.locator('.surface-error')).toContainText('Element width');
  expect(await source()).toEqual(added);
  await expect(page.getByLabel('Current page')).toHaveValue('2');
}

export async function legacyDataRead(page: Page) {
  await page.goto('/');
  const data = addRow().apply(createData());
  data.graphView = {
    schemaVersion: 1,
    labelColumnId: null,
    positions: { [data.rows[0].id]: { x: 40, y: 60 } },
  };
  const artifact = {
    ...(await commitVersion(createArtifact('data', 'Legacy Graph label', data), 'test', 'Legacy')),
    annotations: [],
  };
  await page.evaluate(async (serialized) => {
    const record = JSON.parse(serialized) as { id: string };
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('editor-platform', 1);
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction('artifacts', 'readwrite');
        tx.objectStore('artifacts').put(record);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
    localStorage.setItem('ep-active-artifact', record.id);
  }, JSON.stringify(artifact));
  await page.reload();
  await expect(page.getByLabel('Artifact name')).toHaveValue('Legacy Graph label');
  await expect(page.getByText('Invalid stored content', { exact: false })).toHaveCount(0);
  await dataProjection(page, 'Graph');
  await expect(
    page.getByRole('button', { name: 'Select node New record', exact: true }),
  ).toBeVisible();
  const loaded = await nativeArtifact(page);
  expect(loaded.draft.content).toEqual(data);
  expect(loaded.versions).toEqual(artifact.versions);
  expect(await contentHash(loaded.versions[0].content)).toBe(artifact.versions[0].contentHash);
  await page.reload();
  await expect(page.getByLabel('Artifact name')).toHaveValue('Legacy Graph label');
}

export async function sharedInheritedStyle(page: Page, kind: 'slide' | 'design' | 'whiteboard') {
  const typography = { bold: true, italic: true, underline: true, strike: true, fontSize: 28 };
  const deck = createDeck();
  deck.slides[0].objects = [
    { ...makeSlideObject('text', 0), id: 'text', text: 'Hello', typography },
  ];
  const content =
    kind === 'slide'
      ? deck
      : kind === 'design'
        ? {
            ...createDesign(),
            elements: [{ ...makeDesignElement('text'), id: 'text', text: 'Hello', typography }],
          }
        : {
            ...createWhiteboard(),
            nodes: [{ ...makeWhiteboardNode('text'), id: 'text', text: 'Hello', typography }],
          };
  await page.goto('/');
  await importUsability(page, kind, content);
  await artifactMenu(page, 'Open collaboratively');
  await page.keyboard.press('Escape');
  await confirmed(page);
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  const url = await page
    .getByRole('link', { name: 'Open peer editor', exact: true })
    .getAttribute('href');
  await page.keyboard.press('Escape');
  const context = await page
    .context()
    .browser()!
    .newContext({ viewport: page.viewportSize()!, baseURL: new URL(page.url()).origin });
  const peer = await context.newPage(),
    errors: string[] = [];
  peer.on('pageerror', (error) => errors.push(error.message));
  peer.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const nativeItem = (
    value: unknown,
  ): {
    text: string;
    runs?: { text: string; style?: Record<string, unknown> }[];
    typography?: unknown;
  } => {
    const data = value as {
      slides?: { objects: ReturnType<typeof nativeItem>[] }[];
      elements?: ReturnType<typeof nativeItem>[];
      nodes?: ReturnType<typeof nativeItem>[];
    };
    return data.slides
      ? data.slides[0].objects[0]
      : data.elements
        ? data.elements[0]
        : data.nodes![0];
  };
  const box = (target: Page) =>
    target
      .getByRole('application', {
        name: `${kind === 'whiteboard' ? 'Whiteboard' : kind === 'slide' ? 'Slide' : 'Design'} canvas`,
        exact: true,
      })
      .getByRole('button')
      .filter({ has: target.locator('text') })
      .first();
  const history = async (name: 'Undo' | 'Redo') => {
    const button = page.getByRole('button', { name, exact: true });
    if (!(await button.isVisible()))
      await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
    await button.click();
    await page.keyboard.press('Escape');
  };
  try {
    await peer.goto(url!);
    await confirmed(peer);
    await box(page).dblclick();
    const editor = page.getByRole('textbox', { name: 'Edit canvas text', exact: true });
    await expect(editor.locator('strong')).toHaveText('Hello');
    const selectMiddle = async () => {
      await editor.press('Control+Home');
      await editor.press('ArrowRight');
      await editor.press('Shift+ArrowRight');
      await editor.press('Shift+ArrowRight');
    };
    await selectMiddle();
    for (const mark of ['bold', 'italic', 'underline'])
      await page.getByRole('button', { name: `Selected text ${mark}`, exact: true }).click();
    await editor.press('Control+Enter');
    const partial = [
      { text: 'H' },
      { text: 'el', style: { bold: false, italic: false, underline: false } },
      { text: 'lo' },
    ];
    await expect
      .poll(async () => nativeItem((await nativeArtifact(peer)).draft.content).runs)
      .toEqual(partial);
    // Isolate the final mark operation instead of assuming a submission-window group.
    await box(page).dblclick();
    await selectMiddle();
    await page.getByRole('button', { name: 'Selected text strike', exact: true }).click();
    await expect(editor.locator('strong')).toHaveText(['H', 'lo']);
    const style = await editor.evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode()))
        if (node.textContent === 'el') {
          const css = getComputedStyle(node.parentElement!);
          return {
            weight: css.fontWeight,
            italic: css.fontStyle,
            decoration: css.textDecorationLine,
          };
        }
      return null;
    });
    expect(style).toEqual({ weight: '400', italic: 'normal', decoration: 'none' });
    await editor.press('Control+Enter');
    const expected = [
      { text: 'H' },
      { text: 'el', style: { bold: false, italic: false, underline: false, strike: false } },
      { text: 'lo' },
    ];
    await expect
      .poll(async () => nativeItem((await nativeArtifact(peer)).draft.content).runs)
      .toEqual(expected);
    const rendered = box(page).locator('text').first();
    await expect(rendered).toHaveAttribute('text-decoration', 'none');
    await expect(rendered.locator('tspan').filter({ hasText: /^el$/ }).last()).toHaveAttribute(
      'text-decoration',
      'none',
    );
    await history('Undo');
    await expect
      .poll(async () => nativeItem((await nativeArtifact(peer)).draft.content).runs)
      .toEqual(partial);
    await history('Redo');
    await expect
      .poll(async () => nativeItem((await nativeArtifact(peer)).draft.content).runs)
      .toEqual(expected);
    await box(peer).dblclick();
    const peerEditor = peer.getByRole('textbox', { name: 'Edit canvas text', exact: true });
    await expect(peerEditor.locator('strong')).toHaveText(['H', 'lo']);
    await peerEditor.press('Control+End');
    await peer.keyboard.type('!');
    await peerEditor.press('Control+Enter');
    await expect
      .poll(async () => nativeItem((await nativeArtifact(page)).draft.content).text)
      .toBe('Hello!');
    expect(nativeItem((await nativeArtifact(peer)).draft.content).runs?.[1]).toEqual(expected[1]);
    expect(nativeItem((await nativeArtifact(peer)).draft.content).typography).toEqual(typography);
    await peer.reload();
    await confirmed(peer);
    expect(nativeItem((await nativeArtifact(peer)).draft.content).runs?.[1]).toEqual(expected[1]);
  } finally {
    await context.close();
    expect(errors).toEqual([]);
  }
}
