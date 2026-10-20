import { posterLimitAnimation } from '../fixtures/animation-poster';
import { largeConsumerAnimationEmbed } from '../fixtures/animation-retention';
import {
  createAnimation2,
  animationPlaybackContent2,
  prepareAnimation2,
  evaluateAnimation2,
} from '@editor-platform/animation-core/v2';
import { test, expect, create, save, nativeArtifact, tinyPng, artifactView } from './fixtures';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import {
  contentHash,
  createArtifact,
  commitVersion,
  updateDraft,
  type Artifact,
} from '@editor-platform/artifact-core';
import {
  createRectangleAnimation,
  createAnimationEmbed,
  type AnimationContentV1,
} from '@editor-platform/animation-core';
import {
  addSlide,
  createDeck,
  makeSlideObject,
  isDeck,
  placeSlideAnimation,
  type SlideContent,
} from '@editor-platform/slide/model';
import {
  authorReusableComponent,
  prepareComponentInsertion,
  localTemplateSnapshot,
  applyLocalTemplate,
} from '@editor-platform/templates';

for (const failure of ['QuotaExceededError', 'SecurityError'])
  test(`independent Animation save keeps durable history after ${failure} and recovers without duplicate versions`, async ({
    page,
  }, info) => {
    await page.goto('http://127.0.0.1:4189');
    await page.getByRole('button', { name: 'Add rectangle', exact: true }).click();
    await page.getByLabel('Base x', { exact: true }).fill('175');
    await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
    const native = async (): Promise<Artifact<AnimationContentV1>> => {
      const pending = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Native JSON', exact: true }).click();
      return JSON.parse(await readFile((await (await pending).path())!, 'utf8'));
    };
    await page.evaluate((failure) => {
      const write = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (
          this === localStorage &&
          key === 'animation-reference-native' &&
          sessionStorage.getItem('animation-test-storage-fail') === 'yes'
        )
          throw new DOMException('Injected Animation save failure', failure);
        return write.call(this, key, value);
      };
      sessionStorage.setItem('animation-test-storage-fail', 'yes');
    }, failure);
    const saveVersion = page.getByRole('button', { name: 'Save version', exact: true });
    const count = page.getByLabel('Saved versions', { exact: true });
    await saveVersion.click();
    await expect(page.getByRole('alert')).toContainText('Injected Animation save failure');
    await expect(count).toHaveText('0');
    await expect(
      page.getByRole('button', { name: 'View saved Player', exact: true }),
    ).toBeDisabled();
    expect(
      await page.evaluate(() => localStorage.getItem('animation-reference-native')),
    ).toBeNull();
    const firstFailure = await native();
    expect(firstFailure.versions).toHaveLength(0);
    expect(firstFailure.draft.baseVersionId).toBeNull();
    expect(
      firstFailure.draft.content.compositions[0].layers.find((l) => l.type === 'rect')!.transform.x,
    ).toBe(175);
    await page.screenshot({
      path: info.outputPath('initial-save-storage-failure.png'),
      fullPage: true,
    });
    await page.evaluate(() => sessionStorage.removeItem('animation-test-storage-fail'));
    await saveVersion.click();
    await expect(count).toHaveText('1');
    const first = await native();
    expect(first.versions).toHaveLength(1);
    expect(first.versions[0].parentVersionId).toBeNull();
    expect(first.draft.baseVersionId).toBe(first.versions[0].versionId);
    await page.getByLabel('Base x', { exact: true }).fill('275');
    await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
    await page.evaluate(() => sessionStorage.setItem('animation-test-storage-fail', 'yes'));
    await saveVersion.click();
    await expect(page.getByRole('alert')).toContainText('Injected Animation save failure');
    await expect(count).toHaveText('1');
    const failed = await native();
    expect(failed.versions).toEqual(first.versions);
    expect(failed.draft.baseVersionId).toBe(first.draft.baseVersionId);
    expect(
      failed.draft.content.compositions[0].layers.find((l) => l.type === 'rect')!.transform.x,
    ).toBe(275);
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem('animation-reference-native')!)),
    ).toEqual(first);
    await page.getByRole('button', { name: 'View saved Player', exact: true }).click();
    await expect(
      page.getByRole('img', { name: first.name, exact: true }).locator('rect').last(),
    ).toHaveAttribute('transform', /175/);
    await page.getByRole('button', { name: 'Edit Animation', exact: true }).click();
    await page.evaluate(() => sessionStorage.removeItem('animation-test-storage-fail'));
    await saveVersion.click();
    await expect(count).toHaveText('2');
    await expect(page.getByRole('alert')).toHaveCount(0);
    const recovered = await native();
    expect(recovered.versions).toHaveLength(2);
    expect(recovered.versions[0]).toEqual(first.versions[0]);
    expect(recovered.versions[1].parentVersionId).toBe(first.versions[0].versionId);
    expect(recovered.draft.content).toEqual(failed.draft.content);
    await page.getByRole('button', { name: 'Reload saved', exact: true }).click();
    expect(await native()).toEqual(recovered);
  });

for (const pending of ['valid Base', 'invalid Key', 'composing Key'] as const)
  test(`independent Animation import preserves ${pending} input entered while hashing`, async ({
    page,
  }, info) => {
    await page.goto('http://127.0.0.1:4189');
    await page.getByRole('button', { name: 'Add rectangle', exact: true }).click();
    await page.getByRole('button', { name: 'Add key at playhead', exact: true }).click();
    await page.getByRole('button', { name: 'Save version', exact: true }).click();
    await expect(page.getByLabel('Saved versions', { exact: true })).toHaveText('1');
    const stored = (await page.evaluate(() =>
      JSON.parse(localStorage.getItem('animation-reference-native')!),
    )) as Artifact<AnimationContentV1>;
    const incoming = await commitVersion(
      createArtifact('animation', 'Incoming motion', createAnimation2()),
      'test',
      'Incoming',
    );
    const upload = async () =>
      page.getByLabel('Import Animation native', { exact: true }).setInputFiles({
        name: 'incoming-motion.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(incoming)),
      });
    await page.evaluate(() => {
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      crypto.subtle.digest = async (...args) => {
        crypto.subtle.digest = digest;
        document.documentElement.dataset.animationImportWaiting = 'true';
        await new Promise<void>((resolve) =>
          window.addEventListener('release-animation-import', () => resolve(), { once: true }),
        );
        return digest(...args);
      };
    });
    await upload();
    await expect(page.locator('html')).toHaveAttribute('data-animation-import-waiting', 'true');
    const input = page.getByLabel(pending === 'valid Base' ? 'Base y' : 'Key value', {
      exact: true,
    });
    if (pending === 'composing Key') await input.dispatchEvent('compositionstart');
    await input.fill(pending === 'invalid Key' ? 'invalid' : '345');
    await page.evaluate(() => window.dispatchEvent(new Event('release-animation-import')));
    await expect(page.getByRole('alert')).toContainText('inputs changed during import');
    await expect(input).toHaveValue(pending === 'invalid Key' ? 'invalid' : '345');
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem('animation-reference-native')!)),
    ).toEqual(stored);
    await expect(page.getByLabel('Saved versions', { exact: true })).toHaveText('1');
    await page.screenshot({
      path: info.outputPath('pending-input-import-refusal.png'),
      fullPage: true,
    });
    if (pending === 'composing Key') await input.dispatchEvent('compositionend');
    if (pending === 'invalid Key') await input.fill('345');
    await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
    await page.getByRole('button', { name: 'Save version', exact: true }).click();
    await expect(page.getByLabel('Saved versions', { exact: true })).toHaveText('2');
    const native = async (): Promise<Artifact<AnimationContentV1>> => {
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Native JSON', exact: true }).click();
      return JSON.parse(await readFile((await (await download).path())!, 'utf8'));
    };
    const recovered = await native();
    expect(recovered.id).toBe(stored.id);
    expect(recovered.versions[0]).toEqual(stored.versions[0]);
    const content = recovered.draft.content.compositions[0];
    expect(
      pending === 'valid Base'
        ? content.layers.find((l) => l.type === 'rect')!.transform.y
        : content.tracks[0].keys[0].value,
    ).toBe(345);
    await upload();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByLabel('Saved versions', { exact: true })).toHaveText('1');
    expect(await native()).toEqual(incoming);
  });

test('static Slide draft with animated retained history stays local while static-only history can share', async ({
  page,
}, info) => {
  const source = createRectangleAnimation(),
    deck = createDeck();
  const embed = createAnimationEmbed(
    {
      artifactId: 'source',
      versionId: 'v1',
      contentHash: await contentHash(source),
      compositionId: 'root',
    },
    source,
    'Motion',
  );
  const animated = await commitVersion(
    createArtifact(
      'slide',
      'Retained motion history',
      placeSlideAnimation(deck.slides[0].id, embed, 'motion').apply(deck),
    ),
    'test',
    'Motion',
  );
  const record = {
    ...(await commitVersion(updateDraft(animated, deck), 'test', 'Static draft')),
    annotations: [],
  };
  await page.goto('/');
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/collaboration-api/editor/session'))
      requests.push(request.url());
  });
  await imported(page, record);
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(record.name);
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open collaboratively', exact: true })).toHaveCount(
    0,
  );
  await page.keyboard.press('Escape');
  const local = await nativeArtifact(page);
  expect(local.id).not.toBe(record.id);
  expect(local.draft).toEqual(record.draft);
  expect(local.versions).toEqual(
    record.versions.map((version) => ({ ...version, artifactId: local.id })),
  );
  await artifactView(page, 'History');
  await expect(page.getByRole('heading', { name: 'Version history', exact: true })).toBeVisible();
  await expect(page.getByRole('main').locator('article')).toHaveCount(2);
  await expect(page.getByRole('heading', { name: 'Motion', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Static draft', exact: true })).toBeVisible();
  await page.screenshot({
    path: info.outputPath('retained-animation-history-local.png'),
    fullPage: true,
  });
  expect(requests).toHaveLength(0);
  const staticOnly = {
    ...(await commitVersion(
      createArtifact('slide', 'Static-only history', deck),
      'test',
      'Static',
    )),
    annotations: [],
  };
  await imported(page, staticOnly);
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(staticOnly.name);
  await history(page, 'Open collaboratively');
  await expect(page.locator('.save-status')).toContainText('Shared · confirmed');
  expect(requests).toHaveLength(1);
  const shared = await nativeArtifact(page);
  expect(shared.draft.content).toEqual(staticOnly.draft.content);
  expect(shared.versions).toEqual(
    staticOnly.versions.map((version) => ({ ...version, artifactId: shared.id })),
  );
});

test('unloadable Animation source refuses navigation while retained Slide playback stays usable', async ({
  page,
}, info) => {
  const source = await commitVersion(
    createArtifact('animation', 'Broken source history', createRectangleAnimation()),
    'test',
    'Motion',
  );
  const embed = createAnimationEmbed(
    {
      artifactId: source.id,
      versionId: source.versions[0].versionId,
      contentHash: source.versions[0].contentHash,
      compositionId: 'root',
    },
    source.draft.content,
    source.name,
  );
  const deck = createDeck();
  const destination = {
    ...(await commitVersion(
      createArtifact(
        'slide',
        'Portable motion destination',
        placeSlideAnimation(deck.slides[0].id, embed, 'motion').apply(deck),
      ),
      'test',
      'Retained motion',
    )),
    annotations: [],
  };
  const corrupt = {
    ...source,
    versions: [{ ...source.versions[0], contentHash: '0'.repeat(64) }],
    annotations: [],
  };
  await page.goto('/reference-host.html');
  await page.evaluate(
    (json) =>
      new Promise<void>((resolve, reject) => {
        const { records, preferred } = JSON.parse(json) as {
          records: unknown[];
          preferred: string;
        };
        const request = indexedDB.open('editor-platform', 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore('artifacts', { keyPath: 'id' });
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction('artifacts', 'readwrite');
          for (const record of records) tx.objectStore('artifacts').put(record);
          tx.oncomplete = () => {
            db.close();
            localStorage.setItem('ep-active-artifact', preferred);
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    JSON.stringify({ records: [corrupt, destination], preferred: destination.id }),
  );
  await page.goto('/');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Stored version hash mismatch' }),
  ).toBeVisible();
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(destination.name);
  await page
    .getByRole('application', { name: 'Slide canvas', exact: true })
    .getByRole('button', { name: 'animation object 1', exact: true })
    .click();
  await animationInspector(page);
  await page.getByRole('button', { name: '元の Animation を開く', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: '元の Animation が見つかりません' }),
  ).toBeVisible();
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(destination.name);
  expect((await nativeArtifact(page)).draft.content).toEqual(destination.draft.content);
  await page.screenshot({
    path: info.outputPath('unloadable-source-navigation-refusal.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Animation をプレビュー', exact: true }).click();
  await expect(page.getByRole('img', { name: source.name, exact: true })).toBeVisible();
  const stored = await page.evaluate(
    (id) =>
      new Promise<unknown>((resolve, reject) => {
        const request = indexedDB.open('editor-platform', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction('artifacts', 'readonly'),
            read = tx.objectStore('artifacts').get(id);
          read.onsuccess = () => resolve(read.result);
          read.onerror = () => reject(read.error);
          tx.oncomplete = () => db.close();
        };
      }),
    source.id,
  );
  expect(stored).toEqual(corrupt);
});

async function tool(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true });
  const more = page.getByRole('button', { name: 'More editor tools', exact: true });
  await expect(button.or(more).first()).toBeVisible();
  if (!(await button.isVisible())) await more.click();
  await button.click();
}
async function history(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true });
  if (!(await button.isVisible()))
    await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await button.click();
  await page.keyboard.press('Escape');
}
async function imported(page: Page, value: unknown) {
  const input = page.getByLabel('Import artifact', { exact: true });
  if (!(await input.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await input.setInputFiles({
    name: 'animation-native.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(value)),
  });
}
async function animationInspector(page: Page) {
  if (
    !(await page.getByRole('button', { name: 'Animation をプレビュー', exact: true }).isVisible())
  )
    await page.getByRole('button', { name: 'Toggle Slide inspector', exact: true }).click();
}
async function makeMotion(page: Page) {
  await page.goto('/');
  await create(page, 'animation');
  await page.getByRole('button', { name: 'Add rectangle', exact: true }).click();
  await page.getByLabel('Base x', { exact: true }).fill('120');
  await page.getByLabel('Base y', { exact: true }).fill('100');
  await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
  const first = await nativeArtifact(page),
    content = first.draft.content as AnimationContentV1;
  const rect = content.compositions[0].layers.find((l) => l.type === 'rect')!;
  await history(page, 'Undo');
  await expect(page.getByLabel('Base x', { exact: true })).toHaveValue('80');
  await history(page, 'Redo');
  await expect(page.getByLabel('Base x', { exact: true })).toHaveValue('120');
  await page.getByRole('button', { name: 'Add key at playhead', exact: true }).click();
  await page.getByLabel('Animation playhead', { exact: true }).fill('480000');
  await page.getByRole('button', { name: 'Add key at playhead', exact: true }).click();
  await page.getByLabel('Key value', { exact: true }).fill('300');
  await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
  await page.getByLabel('Animation playhead', { exact: true }).fill('0');
  return rect.id;
}

test('Slide explains unavailable Animation placement for retained reuse instances, closures and modes', async ({
  page,
}, info) => {
  const deck = createDeck();
  deck.slides[0].objects.push({ ...makeSlideObject('text', 0), text: 'Reusable heading' });
  const authored = await authorReusableComponent({
    domain: 'slide',
    name: 'Heading',
    content: deck,
    ids: [deck.slides[0].objects[0].id],
    slide: 'objects',
  });
  const prepared = await prepareComponentInsertion({
    ...authored,
    state: localTemplateSnapshot('reuse-deck', 'slide', deck),
    identity: { actorId: 'browser', clientId: 'browser', sessionId: 'local' },
    reuse: 'linked',
    requestId: 'heading',
    target: { slidePageId: deck.slides[0].id },
  });
  const linked = applyLocalTemplate(prepared, deck) as SlideContent;
  const closureOnly = { ...linked, reuse: { ...linked.reuse!, instances: [] } };
  const modeOnly: SlideContent = {
    ...deck,
    reuse: { schemaVersion: 1, instances: [], closures: [], artifactMode: 'dark' },
  };
  await page.goto('/');
  for (const [index, content] of [linked, closureOnly, modeOnly].entries()) {
    expect(isDeck(content)).toBe(true);
    const record = createArtifact('slide', `Reuse case ${index + 1}`, content);
    await imported(page, record);
    await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(record.name);
    const button = page.getByRole('button', { name: 'アニメーションを配置', exact: true });
    if (!(await button.isVisible()))
      await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
    await expect(button).toBeDisabled();
    await expect(button).toHaveAccessibleDescription(/再利用部品.*配置は未対応/);
    await expect(page.getByRole('note').filter({ hasText: /配置は未対応/ })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Animation を配置', exact: true })).toHaveCount(
      0,
    );
    if (!index)
      await page.screenshot({ path: info.outputPath('slide-reuse-animation-unavailable.png') });
    await page.keyboard.press('Escape');
    expect((await nativeArtifact(page)).draft.content).toEqual(content);
  }
});

test('Slide Compare exposes saved Animation pins and playback settings with identical posters', async ({
  page,
}, info) => {
  const content = createRectangleAnimation();
  content.compositions[0].layers.push({
    id: 'rect',
    type: 'rect',
    parentId: 'group',
    start: 0,
    end: 960000,
    width: 80,
    height: 80,
    fill: '#ff0000',
    transform: { ...content.compositions[0].layers[0].transform },
  });
  content.compositions[0].tracks.push({
    id: 'move',
    layerId: 'rect',
    property: 'x',
    keys: [
      { id: 'start', tick: 0, value: 0, easing: { type: 'linear' } },
      { id: 'end', tick: 960000, value: 100, easing: { type: 'hold' } },
    ],
  });
  const first = await commitVersion(
    createArtifact('animation', 'Same poster motion', content),
    'browser',
    'First',
  );
  const motion = structuredClone(content);
  motion.compositions[0].tracks[0].keys[1].value = 300;
  const second = await commitVersion(
    { ...first, draft: { ...first.draft, content: motion } },
    'browser',
    'Later motion',
  );
  await page.goto('/');
  await imported(page, second);
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(second.name);
  const source = await nativeArtifact(page);
  await create(page, 'slide');
  await tool(page, 'アニメーションを配置');
  await page
    .getByLabel('保存した Animation', { exact: true })
    .selectOption({ label: `${source.name} / 版 1 / root` });
  await page.getByRole('button', { name: 'この版を配置', exact: true }).click();
  await save(page, 1);
  const before = await nativeArtifact(page);
  await animationInspector(page);
  await page.getByRole('button', { name: '保存した別の版を選ぶ', exact: true }).click();
  await page
    .getByLabel('保存した Animation', { exact: true })
    .selectOption({ label: `${source.name} / 版 2 / root` });
  await page.getByRole('button', { name: 'この版を採用', exact: true }).click();
  await page.getByLabel('Animation playback trigger', { exact: true }).selectOption('manual');
  await page.getByLabel('Loop animation', { exact: true }).check();
  await save(page, 2);
  const after = await nativeArtifact(page);
  expect(after.versions[0]).toEqual(before.versions[0]);
  await artifactView(page, 'Compare');
  const pair = page.locator('.change.changed .text-pair');
  await expect(pair).toHaveCount(1);
  for (const [index, description] of [
    pair.locator('pre').nth(0),
    pair.locator('pre').nth(1),
  ].entries()) {
    await expect(description).toContainText(`Source artifact: ${source.id}`);
    await expect(description).toContainText(`Source version: ${source.versions[index].versionId}`);
    await expect(description).toContainText(
      `Source content hash: ${source.versions[index].contentHash}`,
    );
    await expect(description).toContainText('Composition: root');
    await expect(description).toContainText('Poster tick: 0');
    await expect(description).toContainText(
      index ? 'Playback trigger: manual · Loop: true' : 'Playback trigger: on-enter · Loop: false',
    );
  }
  const images = (await pair.allTextContents())[0].match(/Image: [^\n]+/g);
  expect(images).toHaveLength(2);
  expect(images![0]).toBe(images![1]);
  await pair.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('slide-animation-compare.png') });
});
const invalidPlayerMetadata: Array<{
  name: string;
  change(artifact: Artifact<AnimationContentV1>): void;
  error?: RegExp;
}> = [
  {
    name: 'empty name',
    change: (a) => {
      a.name = '';
    },
  },
  {
    name: 'whitespace name',
    change: (a) => {
      a.name = '   ';
    },
  },
  {
    name: 'oversized name',
    change: (a) => {
      a.name = 'n'.repeat(201);
    },
  },
  ...['', 'a'.repeat(201)].map((id) => ({
    name: id ? 'oversized artifact ID' : 'empty artifact ID',
    error: id ? /animation-source/ : /Invalid artifact kind/,
    change: (a: Artifact<AnimationContentV1>) => {
      a.id = id;
      a.versions = a.versions.map((v) => ({ ...v, artifactId: id }));
    },
  })),
  ...['', 'v'.repeat(201)].map((id) => ({
    name: id ? 'oversized version ID' : 'empty version ID',
    error: id ? /animation-source/ : /Invalid retained version identity/,
    change: (a: Artifact<AnimationContentV1>) => {
      a.versions = a.versions.map((v) => ({ ...v, versionId: id }));
      a.draft.baseVersionId = id;
    },
  })),
  {
    name: 'unsaved empty name',
    change: (a) => {
      a.versions = [];
      a.draft.baseVersionId = null;
      a.name = '';
    },
  },
  {
    name: 'duplicate retained version IDs',
    error: /Invalid retained version identity/,
    change: (a) => {
      a.versions.push(structuredClone(a.versions[0]));
    },
  },
  {
    name: 'self-cyclic retained history',
    error: /Retained version parent cycle/,
    change: (a) => {
      a.versions[0].parentVersionId = a.versions[0].versionId;
    },
  },
  {
    name: 'two-version cyclic history',
    error: /Retained version parent cycle/,
    change: (a) => {
      a.versions.push({
        ...a.versions[0],
        versionId: 'cycle-peer',
        parentVersionId: a.versions[0].versionId,
      });
      a.versions[0].parentVersionId = 'cycle-peer';
    },
  },
  {
    name: 'missing retained parent',
    error: /Invalid retained version identity/,
    change: (a) => {
      a.versions[0].parentVersionId = 'missing-parent';
    },
  },
  {
    name: 'missing retained draft base',
    error: /Draft base version is missing/,
    change: (a) => {
      a.draft.baseVersionId = 'missing-base';
    },
  },
];
for (const { name, change, error = /animation-(label|source)/ } of invalidPlayerMetadata)
  test(`independent Animation Host refuses ${name} and preserves import, reload and save`, async ({
    page,
  }, info) => {
    await page.goto('http://127.0.0.1:4189');
    await page.getByRole('button', { name: 'Add rectangle', exact: true }).click();
    await page.getByRole('button', { name: 'Save version', exact: true }).click();
    await expect(page.getByLabel('Saved versions', { exact: true })).toHaveText('1');
    const native = async (): Promise<Artifact<AnimationContentV1>> => {
      const pending = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Native JSON', exact: true }).click();
      return JSON.parse(await readFile((await (await pending).path())!, 'utf8'));
    };
    const original = await native();
    const upload = async (artifact: Artifact<AnimationContentV1>) => {
      await page.getByLabel('Import Animation native', { exact: true }).setInputFiles({
        name: 'independent-native.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(artifact)),
      });
    };
    const invalid = structuredClone(original);
    change(invalid);
    await upload(invalid);
    await expect(page.getByRole('alert')).toContainText(error);
    await expect(page.getByRole('button', { name: 'Add rectangle', exact: true })).toBeEnabled();
    await expect(page.getByLabel('Saved versions', { exact: true })).toHaveText('1');
    expect(await native()).toEqual(original);
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem('animation-reference-native')!)),
    ).toEqual(original);
    await upload(original);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await native()).toEqual(original);
    const invalidStored = structuredClone(original);
    change(invalidStored);
    await page.evaluate(
      (value) => localStorage.setItem('animation-reference-native', JSON.stringify(value)),
      invalidStored,
    );
    await page.getByRole('button', { name: 'Reload saved', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(error);
    expect(await native()).toEqual(original);
    await page.screenshot({
      path: info.outputPath('independent-animation-metadata-refusal.png'),
      fullPage: true,
    });
    await page.evaluate(
      (value) => localStorage.setItem('animation-reference-native', JSON.stringify(value)),
      original,
    );
    await page.getByRole('button', { name: 'Reload saved', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: 'Add rectangle', exact: true }).click();
    await page.getByRole('button', { name: 'Save version', exact: true }).click();
    await expect(page.getByLabel('Saved versions', { exact: true })).toHaveText('2');
    const recovered = await native();
    expect(recovered.versions[0]).toEqual(original.versions[0]);
    expect(recovered.draft.content.compositions[0].layers).toHaveLength(
      original.draft.content.compositions[0].layers.length + 1,
    );
    await page.getByRole('button', { name: 'View saved Player', exact: true }).click();
    await expect(page.getByRole('img', { name: original.name, exact: true })).toBeVisible();
  });

test('ordinary Animation history, pending save, native import and independent public Surface/Player', async ({
  page,
}, info) => {
  const rectId = await makeMotion(page);
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Comments \(/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  const beforePlay = await nativeArtifact(page);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const stage = page.getByRole('img', { name: 'Animation 2D stage', exact: true });
  await expect.poll(async () => Number(await stage.getAttribute('data-tick'))).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(beforePlay.draft.content);
  await page.getByLabel('Base y', { exact: true }).fill('invalid');
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await page.getByRole('button', { name: 'この版を保存', exact: true }).click();
  await expect(page.getByLabel('Base y', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Base y', { exact: true }).fill('100');
  await save(page, 1);
  const committed = await nativeArtifact(page);
  expect(await contentHash(committed.versions[0].content)).toBe(committed.versions[0].contentHash);
  await page.reload();
  await expect(stage).toBeVisible();
  expect((await nativeArtifact(page)).versions).toEqual(committed.versions);
  await imported(page, committed);
  await expect(page.getByRole('button', { name: 'Add rectangle', exact: true })).toBeVisible();
  const reimported = await nativeArtifact(page);
  expect(reimported.id).not.toBe(committed.id);
  expect(reimported.draft.content).toEqual(committed.draft.content);
  expect(reimported.versions[0].contentHash).toBe(committed.versions[0].contentHash);
  await page.locator(`[data-layer-id="${rectId}"] button`).click();
  await page.getByLabel('Base y', { exact: true }).fill('210');
  await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
  await page.getByRole('button', { name: 'History and compare', exact: true }).click();
  await page.getByRole('tab', { name: 'History (1)', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Restore to draft', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(committed.versions[0].content);
  await page.screenshot({ path: info.outputPath('playground-animation.png'), fullPage: true });

  await page.goto('http://127.0.0.1:4189');
  await page.getByLabel('Import Animation native', { exact: true }).setInputFiles({
    name: 'actual-animation.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(committed)),
  });
  await expect(page.getByRole('img', { name: 'Animation 2D stage', exact: true })).toBeVisible();
  await page.getByLabel('Read only', { exact: true }).check();
  await expect(page.getByRole('button', { name: 'Add rectangle', exact: true })).toBeDisabled();
  await page.getByLabel('Read only', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await expect(page.getByLabel('Saved versions', { exact: true })).toHaveText('2');
  await page.getByRole('button', { name: 'Reload saved', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Animation 2D stage', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'View saved Player', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Animation 1', exact: true })).toHaveAttribute(
    'data-tick',
    '0',
  );
  await page.getByLabel('Animation tick', { exact: true }).fill('240000');
  await expect(
    page.getByRole('img', { name: 'Animation 1', exact: true }).locator('rect'),
  ).toHaveAttribute('transform', 'matrix(1 0 0 1 210 100)');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Native JSON', exact: true }).click();
  const independent = JSON.parse(await readFile((await (await download).path())!, 'utf8'));
  expect(independent.draft.content).toEqual(committed.draft.content);
  expect(independent.versions[0]).toEqual(committed.versions[0]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: info.outputPath('independent-animation-player.png'),
    fullPage: true,
  });
});

test('Slide retains and explicitly adopts saved Animation versions, replays and imports without source catalog', async ({
  page,
  browser,
}, info) => {
  const rectId = await makeMotion(page);
  await save(page, 1);
  const source = await nativeArtifact(page);
  await create(page, 'slide');
  await tool(page, 'アニメーションを配置');
  await page.getByRole('button', { name: 'この版を配置', exact: true }).click();
  await animationInspector(page);
  const library = page.getByRole('complementary', { name: 'Artifact library', exact: true });
  if (!(await library.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await expect(library.getByRole('button', { name: '部品ライブラリ', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close library panel', exact: true }).click();
  await expect(library).toBeHidden();
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'テンプレートとして保存', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: '再利用部品として保存', exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('button', { name: 'スタイル・表示プリセット', exact: true }),
  ).toBeDisabled();
  await page.keyboard.press('Escape');
  const initial = await nativeArtifact(page),
    original = (initial.draft.content as SlideContent).slides[0].objects[0];
  expect(original.type).toBe('animation');
  expect(original.animation!.source.contentHash).toBe(source.versions[0].contentHash);
  await page.getByRole('button', { name: '元の Animation を開く', exact: true }).click();
  await page.locator(`[data-layer-id="${rectId}"] button`).click();
  await page.getByLabel('Base y', { exact: true }).fill('200');
  await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
  await save(page, 2);
  const updatedSource = await nativeArtifact(page);
  expect(updatedSource.versions[0]).toEqual(source.versions[0]);
  await page.getByRole('button', { name: '埋め込み先に戻る', exact: true }).click();
  await animationInspector(page);
  expect((await nativeArtifact(page)).draft.content).toEqual(initial.draft.content);
  await page.getByRole('button', { name: '保存した別の版を選ぶ', exact: true }).click();
  await page
    .getByLabel('保存した Animation', { exact: true })
    .selectOption({ label: `${source.name} / 版 2 / root` });
  await page.getByRole('button', { name: 'この版を採用', exact: true }).click();
  const adopted = (await nativeArtifact(page)).draft.content as SlideContent;
  expect(adopted.slides[0].objects[0].animation!.source.contentHash).toBe(
    updatedSource.versions[1].contentHash,
  );
  expect(adopted.slides[0].objects[0].bounds).toEqual(original.bounds);
  await history(page, 'Undo');
  expect((await nativeArtifact(page)).draft.content).toEqual(initial.draft.content);
  await history(page, 'Redo');
  await save(page, 1);
  const portable = await nativeArtifact(page);
  await page.reload();
  await tool(page, 'Present');
  const presentation = page.getByRole('dialog', { name: 'Slide presentation', exact: true });
  const player = presentation.getByRole('img', { name: source.name, exact: true });
  await expect.poll(async () => Number(await player.getAttribute('data-tick'))).toBeGreaterThan(0);
  await presentation.getByRole('button', { name: 'Pause animation', exact: true }).click();
  await presentation.getByLabel('Animation tick', { exact: true }).fill('240000');
  const embedded = adopted.slides[0].objects[0].animation!,
    prepared = prepareAnimation2(animationPlaybackContent2(embedded));
  const expected = evaluateAnimation2(prepared, embedded.source.compositionId, 240000).items[0];
  await expect(player.locator('rect')).toHaveAttribute(
    'transform',
    `matrix(${expected.matrix.join(' ')})`,
  );
  await presentation.getByRole('button', { name: 'Exit presentation', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(adopted);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await tool(page, 'Present');
  await expect(player).toHaveAttribute('data-tick', '0');
  await expect(
    presentation.getByRole('button', { name: 'Play animation', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath('slide-animation-presentation.png'),
    fullPage: true,
  });
  await presentation.getByRole('button', { name: 'Exit presentation', exact: true }).click();

  const fresh = await browser.newContext({
    viewport: page.viewportSize()!,
    isMobile: info.project.name === 'mobile',
    hasTouch: info.project.name === 'mobile',
    reducedMotion: 'reduce',
  });
  const other = await fresh.newPage(),
    errors: string[] = [];
  other.on('pageerror', (e) => errors.push(e.message));
  other.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  try {
    await other.goto('http://127.0.0.1:4173');
    await imported(other, portable);
    await expect(other.getByLabel('Artifact name', { exact: true })).toHaveValue(portable.name);
    const deck = (await nativeArtifact(other)).draft.content as SlideContent;
    expect(deck).toEqual(adopted);
    await tool(other, 'Present');
    const p = other.getByRole('dialog', { name: 'Slide presentation', exact: true });
    await expect(p.getByRole('img', { name: source.name, exact: true })).toHaveAttribute(
      'data-tick',
      '0',
    );
    await p.getByLabel('Animation tick', { exact: true }).fill('240000');
    await expect(
      p.getByRole('img', { name: source.name, exact: true }).locator('rect'),
    ).toHaveAttribute('transform', `matrix(${expected.matrix.join(' ')})`);
    await p.getByRole('button', { name: 'Exit presentation', exact: true }).click();
    const broken = structuredClone(portable);
    (broken.draft.content as SlideContent).slides[0].objects[0].animation!.source.contentHash =
      '0'.repeat(64);
    const count = await other
      .getByRole('navigation', { name: 'Artifacts', exact: true })
      .getByRole('button')
      .count();
    await imported(other, broken);
    await expect(other.getByRole('alert').filter({ hasText: 'Import failed' })).toBeVisible();
    expect(
      await other
        .getByRole('navigation', { name: 'Artifacts', exact: true })
        .getByRole('button')
        .count(),
    ).toBe(count);
    expect((await nativeArtifact(other)).draft.content).toEqual(adopted);
    expect(errors).toEqual([]);
  } finally {
    await fresh.close();
  }
});

test('Animation synthetic IME input blocks save and malformed native history does not create an artifact', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'animation');
  await page.getByRole('button', { name: 'Add rectangle', exact: true }).click();
  const input = page.getByLabel('Base x', { exact: true });
  await input.dispatchEvent('compositionstart');
  await input.fill('125');
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await page.getByRole('button', { name: 'この版を保存', exact: true }).click();
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(input).toHaveValue('125');
  await input.dispatchEvent('compositionend');
  await save(page, 1);
  const native = await nativeArtifact(page);
  expect(
    (native.draft.content as AnimationContentV1).compositions[0].layers.find(
      (l) => l.type === 'rect',
    )!.transform.x,
  ).toBe(125);
  const invalid = structuredClone(native);
  invalid.versions[0].contentHash = '0'.repeat(64);
  const count = await page
    .getByRole('navigation', { name: 'Artifacts', exact: true })
    .getByRole('button')
    .count();
  await imported(page, invalid);
  await expect(page.getByRole('alert').filter({ hasText: 'Import failed' })).toBeVisible();
  expect(
    await page
      .getByRole('navigation', { name: 'Artifacts', exact: true })
      .getByRole('button')
      .count(),
  ).toBe(count);
  expect((await nativeArtifact(page)).versions).toEqual(native.versions);
});

test('external Animation history preserves pending valid, invalid and composing inputs', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'animation');
  await page.getByRole('button', { name: 'Add rectangle', exact: true }).click();
  const initial = await nativeArtifact(page);
  const input = page.getByLabel('Base x', { exact: true });
  const historyDisabled = async () => {
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    const more = page.getByRole('button', { name: 'More artifact actions', exact: true });
    const inMenu = !(await undo.isVisible());
    if (inMenu) await more.click();
    await expect(undo).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    if (inMenu) {
      await expect(more).toBeFocused();
      await expect(more).toHaveAttribute('aria-expanded', 'false');
    }
  };
  const shortcut = async (key: string) => {
    await page.getByRole('button', { name: 'Save version', exact: true }).focus();
    await page.keyboard.press(key);
    await expect(page.getByRole('alert').filter({ hasText: '履歴を操作' })).toBeVisible();
  };
  await input.fill('125');
  await historyDisabled();
  await shortcut('Control+z');
  await expect(input).toHaveValue('125');
  await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
  await expect(input).toHaveValue('125');
  expect((await nativeArtifact(page)).draft.content).not.toEqual(initial.draft.content);
  await history(page, 'Undo');
  expect((await nativeArtifact(page)).draft.content).toEqual(initial.draft.content);

  await input.fill('invalid');
  await historyDisabled();
  await shortcut('Control+Shift+z');
  await expect(input).toHaveValue('invalid');
  await page.getByRole('button', { name: 'Cancel inputs', exact: true }).click();
  await history(page, 'Redo');
  await expect(input).toHaveValue('125');

  await input.dispatchEvent('compositionstart');
  await input.fill('140');
  await historyDisabled();
  await shortcut('Control+z');
  await expect(input).toHaveValue('140');
  await input.dispatchEvent('compositionend');
  await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
  await expect(input).toHaveValue('140');
  await history(page, 'Undo');
  await expect(input).toHaveValue('125');
  await history(page, 'Redo');
  await expect(input).toHaveValue('140');
});

test('Animation source picker recovers from an invalid first candidate without closing', async ({
  page,
}, info) => {
  await page.goto('/');
  await create(page, 'animation');
  const invalidName = 'x'.repeat(201);
  await page.getByLabel('Artifact name', { exact: true }).fill(invalidName);
  await save(page, 1);
  await create(page, 'animation');
  await page.getByRole('button', { name: 'Add rectangle', exact: true }).click();
  await save(page, 1);
  const valid = await nativeArtifact(page);
  await create(page, 'slide');
  await tool(page, 'アニメーションを配置');
  const dialog = page.getByRole('dialog', { name: 'Animation を配置', exact: true });
  const picker = dialog.getByLabel('保存した Animation', { exact: true });
  await expect(dialog.getByRole('alert')).toContainText('animation-label');
  await expect(picker).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'この版を配置', exact: true })).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath('animation-invalid-source-choice.png'),
    fullPage: true,
  });
  await picker.selectOption({ label: `${valid.name} / 版 1 / root` });
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(
    dialog.getByRole('img', { name: '選択した Animation のプレビュー', exact: true }),
  ).toBeVisible();
  await picker.selectOption({ label: `${invalidName} / 版 1 / root` });
  await expect(dialog.getByRole('alert')).toContainText('animation-label');
  await picker.selectOption({ label: `${valid.name} / 版 1 / root` });
  await dialog.getByRole('button', { name: 'この版を配置', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const deck = (await nativeArtifact(page)).draft.content as SlideContent;
  expect(deck.slides[0].objects[0].animation!.source.contentHash).toBe(
    valid.versions[0].contentHash,
  );
});

test('embedded Animation controls preserve range keys, page navigation and Escape exit', async ({
  page,
}) => {
  await makeMotion(page);
  await save(page, 1);
  await create(page, 'slide');
  await tool(page, 'アニメーションを配置');
  await page.getByRole('button', { name: 'この版を配置', exact: true }).click();
  const twoPages = await nativeArtifact(page);
  twoPages.draft.content = addSlide().apply(twoPages.draft.content as SlideContent);
  await imported(page, twoPages);
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(twoPages.name);
  await expect(page.getByLabel('Current page', { exact: true })).toHaveAttribute('max', '2');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await tool(page, 'Present');
  const dialog = page.getByRole('dialog', { name: 'Slide presentation', exact: true });
  const range = dialog.getByLabel('Animation tick', { exact: true });
  await range.fill('240000');
  await range.press('ArrowRight');
  await expect.poll(async () => Number(await range.inputValue())).toBeGreaterThan(240000);
  await expect(dialog.getByLabel('Presentation page', { exact: true })).toHaveValue('1');
  await range.press('PageDown');
  await expect(dialog.getByLabel('Presentation page', { exact: true })).toHaveValue('1');
  const more = page.getByRole('button', { name: 'More editor tools', exact: true });
  if (await more.isVisible()) await expect(more).toHaveAttribute('aria-expanded', 'true');
  await range.press('Escape');
  await expect(dialog).toHaveCount(0);
  if (await more.isVisible()) await expect(more).toHaveAttribute('aria-expanded', 'false');

  await tool(page, 'Present');
  await dialog.getByRole('button', { name: 'Play animation', exact: true }).press('ArrowRight');
  await expect(dialog.getByLabel('Presentation page', { exact: true })).toHaveValue('2');
  await dialog.getByRole('button', { name: 'Previous slide', exact: true }).click();
  await dialog.getByRole('button', { name: 'Play animation', exact: true }).click();
  await dialog.getByRole('button', { name: 'Pause animation', exact: true }).press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('Slide Animation placement requires Host capability and permits an explicitly empty catalog', async ({
  page,
}) => {
  await page.goto('/embed.html');
  await expect(page.getByRole('application', { name: 'Slide canvas', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'アニメーションを配置', exact: true })).toHaveCount(
    0,
  );
  await page.goto('/');
  await create(page, 'slide');
  await tool(page, 'アニメーションを配置');
  const dialog = page.getByRole('dialog', { name: 'Animation を配置', exact: true });
  await expect(
    dialog.getByText('Animation を作成し、版を保存するとここから配置できます。', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel('保存した Animation', { exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'この版を配置', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('Slide inspector keeps image editing separate from retained Animation posters and mixed selection', async ({
  page,
}, info) => {
  await makeMotion(page);
  await save(page, 1);
  await create(page, 'slide');
  await tool(page, 'アニメーションを配置');
  await page.getByRole('button', { name: 'この版を配置', exact: true }).click();
  const record = await nativeArtifact(page);
  const deck = record.draft.content as SlideContent;
  const retained = structuredClone(deck.slides[0].objects[0].animation);
  deck.slides[0].objects.push({
    ...makeSlideObject('image', 1),
    src: `data:image/png;base64,${tinyPng.toString('base64')}`,
    bounds: { x: 10, y: 10, width: 70, height: 70 },
  });
  await imported(page, record);
  const canvas = page.getByRole('application', { name: 'Slide canvas', exact: true });
  const stillImage = canvas.getByRole('button', { name: 'image object 2', exact: true });
  await expect(stillImage).toBeVisible();
  const motion = canvas.getByRole('button', { name: 'animation object 1', exact: true });
  await motion.click();
  const inspector = page.getByRole('complementary', { name: 'Slide inspector', exact: true });
  if (!(await inspector.isVisible()))
    await page.getByRole('button', { name: 'Toggle Slide inspector', exact: true }).click();
  const noImageEditing = async () => {
    await expect(inspector.getByLabel('Image alt text', { exact: true })).toHaveCount(0);
    await expect(inspector.getByLabel('Image fit', { exact: true })).toHaveCount(0);
    await expect(inspector.getByLabel('Replace image file', { exact: true })).toHaveCount(0);
    await expect(inspector.getByRole('button', { name: 'Crop image', exact: true })).toHaveCount(0);
  };
  await noImageEditing();
  await expect(inspector.getByLabel('Animation label', { exact: true })).toBeVisible();
  await inspector.getByLabel('Element width', { exact: true }).fill('500');
  await inspector.getByLabel('Element width', { exact: true }).press('Enter');
  const resized = (await nativeArtifact(page)).draft.content as SlideContent;
  expect(resized.slides[0].objects[0].bounds.width).toBe(500);
  expect(resized.slides[0].objects[0].animation).toEqual(retained);
  if (info.project.name === 'mobile')
    await page.getByRole('button', { name: 'Close Slide inspector', exact: true }).click();
  await stillImage.click();
  if (!(await inspector.isVisible()))
    await page.getByRole('button', { name: 'Toggle Slide inspector', exact: true }).click();
  await expect(inspector.getByLabel('Image fit', { exact: true })).toBeVisible();
  await expect(inspector.getByLabel('Replace image file', { exact: true })).toBeVisible();
  await expect(inspector.getByRole('button', { name: 'Crop image', exact: true })).toBeVisible();
  await inspector.getByLabel('Image alt text', { exact: true }).fill('Still image');
  await inspector.getByLabel('Image alt text', { exact: true }).press('Enter');
  if (info.project.name === 'mobile')
    await page.getByRole('button', { name: 'Close Slide inspector', exact: true }).click();
  await motion.click({ modifiers: ['Shift'] });
  if (!(await inspector.isVisible()))
    await page.getByRole('button', { name: 'Toggle Slide inspector', exact: true }).click();
  await expect(inspector.getByText('2 selected · Geometry', { exact: true })).toBeVisible();
  await noImageEditing();
  const after = (await nativeArtifact(page)).draft.content as SlideContent;
  expect(after.slides[0].objects[1].alt).toBe('Still image');
  expect(after.slides[0].objects[0].animation).toEqual(retained);
});

test('ordinary read-only changes commit valid Animation buffers and refuse invalid or composing buffers before switching', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'document');
  const other = await nativeArtifact(page);
  await create(page, 'animation');
  await page.getByRole('button', { name: 'Add rectangle', exact: true }).click();
  const motionName = await page.getByLabel('Artifact name', { exact: true }).inputValue();
  const initial = (await nativeArtifact(page)).draft.content as AnimationContentV1;
  const rectId = initial.compositions[0].layers.find((layer) => layer.type === 'rect')!.id;
  const input = page.getByLabel('Base x', { exact: true });
  const readOnlyChange = async (expected: boolean) => {
    const more = page.getByRole('button', { name: 'More artifact actions', exact: true });
    await more.click();
    const toggle = page.getByLabel('Read only', { exact: true });
    await toggle.click();
    if (expected) await expect(toggle).toBeChecked();
    else await expect(toggle).not.toBeChecked();
    await more.click();
  };
  const switchArtifact = async (name: string) => {
    const library = page.getByRole('complementary', { name: 'Artifact library', exact: true });
    if (!(await library.isVisible()))
      await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Artifacts', exact: true })
      .getByRole('button')
      .filter({ hasText: name })
      .click();
    const close = page.getByRole('button', { name: 'Close library panel', exact: true });
    if (await close.isVisible()) await close.click();
  };
  await input.fill('321');
  await readOnlyChange(true);
  await expect(page.getByRole('button', { name: 'Add rectangle', exact: true })).toBeDisabled();
  await switchArtifact(other.name);
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(other.name);
  await switchArtifact(motionName);
  await readOnlyChange(false);
  await page.locator(`[data-layer-id="${rectId}"] button`).click();
  await expect(input).toHaveValue('321');
  const committed = (await nativeArtifact(page)).draft.content as AnimationContentV1;
  expect(committed.compositions[0].layers.find((l) => l.type === 'rect')!.transform.x).toBe(321);

  await input.fill('invalid');
  await readOnlyChange(false);
  await switchArtifact(other.name);
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(motionName);
  await expect(input).toHaveValue('invalid');
  await page.getByRole('button', { name: 'Cancel inputs', exact: true }).click();
  await input.dispatchEvent('compositionstart');
  await input.fill('456');
  await readOnlyChange(false);
  await switchArtifact(other.name);
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(motionName);
  await expect(input).toHaveValue('456');
  await input.dispatchEvent('compositionend');
  await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
  await readOnlyChange(true);
  const final = (await nativeArtifact(page)).draft.content as AnimationContentV1;
  expect(final.compositions[0].layers.find((l) => l.type === 'rect')!.transform.x).toBe(456);
});

test('SVG-only artifact Host refuses versioned Animation decks on first or later pages without losing its list', async ({
  page,
}, info) => {
  await makeMotion(page);
  await save(page, 1);
  await create(page, 'slide');
  await tool(page, 'アニメーションを配置');
  await page.getByRole('button', { name: 'この版を配置', exact: true }).click();
  await save(page, 1);
  const first = await nativeArtifact(page);
  const laterDeck = addSlide().apply(createDeck());
  laterDeck.slides[1].objects = structuredClone(
    (first.draft.content as SlideContent).slides[0].objects,
  );
  const later = await commitVersion(
    createArtifact('slide', 'Later-page motion', laterDeck),
    'browser-test',
    'Saved motion',
  );
  await page.goto('http://127.0.0.1:4177');
  const list = page.getByRole('region', { name: '成果物一覧', exact: true });
  const open = page.getByRole('button', { name: '成果物JSONを開く', exact: true });
  await expect(open).toBeEnabled();
  let count = await list.locator('article').count();
  const upload = async (value: unknown) => {
    const pending = page.waitForEvent('filechooser');
    await open.click();
    await (
      await pending
    ).setFiles({
      name: 'native-slide.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(value)),
    });
  };
  for (const [index, invalid] of [first, later].entries()) {
    await upload(invalid);
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(list).toBeVisible();
    await expect(list.locator('article')).toHaveCount(count);
    if (!index) {
      await page.getByRole('alert').scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath('svg-only-host-animation-refusal.png') });
    }
    const valid = await commitVersion(
      createArtifact('slide', `Static deck ${index + 1}`, createDeck()),
      'browser-test',
      'Saved static',
    );
    await upload(valid);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(list.locator('article')).toHaveCount(++count);
    await expect(
      list.getByRole('img', { name: `保存した企画書 ${valid.id}`, exact: true }),
    ).toBeVisible();
  }
});

test('Slide contains oversized Animation poster refusal and keeps the chooser and native deck usable', async ({
  page,
}, info) => {
  const { createPlayableAnimationEmbed } = await import('@editor-platform/animation-core/v2');
  const content = posterLimitAnimation(
    await readFile('tests/fixtures/office/images/quadrants.png'),
  );
  const source = await commitVersion(
    createArtifact('animation', 'Large poster', content),
    'test',
    'Saved large poster',
  );
  const version = source.versions[0];
  const embed = createPlayableAnimationEmbed(
    {
      artifactId: source.id,
      versionId: version.versionId,
      compositionId: 'root',
      contentHash: version.contentHash,
    },
    content,
    'Large poster',
  );
  const blank = createDeck();
  const deck = placeSlideAnimation(blank.slides[0].id, embed, 'oversize-poster').apply(blank);
  await page.goto('/');
  await imported(page, source);
  await expect(page.getByRole('button', { name: 'Add rectangle', exact: true })).toBeVisible();
  await imported(page, createArtifact('slide', 'Deck with large poster', deck));
  const canvas = page.getByRole('application', { name: 'Slide canvas', exact: true });
  await expect(
    canvas.getByRole('button', { name: 'animation object 1', exact: true }),
  ).toBeVisible();
  await expect(canvas.locator('image').first()).toHaveAttribute(
    'href',
    /Animation%20preview%20unavailable/,
  );
  expect((await nativeArtifact(page)).draft.content).toEqual(deck);
  await canvas.screenshot({ path: info.outputPath('oversize-animation-poster.png') });
  await tool(page, 'アニメーションを配置');
  const dialog = page.getByRole('dialog', { name: 'Animation を配置', exact: true });
  await expect(dialog.getByRole('alert')).toContainText('Animation SVG size limit');
  await expect(dialog.getByRole('button', { name: 'この版を配置', exact: true })).toBeDisabled();
  await dialog.screenshot({ path: info.outputPath('oversize-poster-chooser.png') });
});

test('Slide refuses oversized retained consumer inputs and preserves the current native draft', async ({
  page,
}, info) => {
  const large = largeConsumerAnimationEmbed(),
    blank = createDeck(),
    deck = placeSlideAnimation(
      blank.slides[0].id,
      { ...large, inputs: [] },
      'consumer-budget-object',
    ).apply(blank);
  const rejected = structuredClone(deck);
  const object = rejected.slides[0].objects[0];
  if (object.type !== 'animation') throw Error('Fixture Animation');
  object.animation = large;
  expect(isDeck(rejected)).toBe(false);
  await page.goto('/');
  await imported(page, createArtifact('slide', 'Retained consumer budget', deck));
  const before = await nativeArtifact(page);
  await imported(page, createArtifact('slide', 'Rejected oversized inputs', rejected));
  await expect(page.getByRole('alert')).toContainText('Invalid domain content');
  expect((await nativeArtifact(page)).draft.content).toEqual(before.draft.content);
  await page
    .getByRole('application', { name: 'Slide canvas', exact: true })
    .screenshot({ path: info.outputPath('consumer-input-budget-refusal.png') });
});
