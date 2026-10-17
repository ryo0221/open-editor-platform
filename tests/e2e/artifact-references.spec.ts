import { openPptx, preparePptx } from './office-fixtures';
import { readFile } from 'node:fs/promises';
import { test, expect, editCell, create, save, nativeArtifact } from './fixtures';
import type { Page } from '@playwright/test';
import { unzipSync, strFromU8 } from 'fflate';
import {
  clone,
  commitVersion,
  contentHash,
  createArtifact,
  updateDraft,
} from '@editor-platform/artifact-core';
import { ReferenceResolver } from '@editor-platform/artifact-references';
import type { ReferenceSnapshot } from '@editor-platform/artifact-references';
import { nativeReferenceAdapters } from '@editor-platform/reference-adapters';
import { createData } from '@editor-platform/structured-data/model';
import { createDeck, insertObject, makeSlideObject } from '@editor-platform/slide/model';
import { createDocument, makeBlock } from '@editor-platform/document/model';
import { createDesign, makeDesignElement } from '@editor-platform/design/model';
import { createWhiteboard, makeWhiteboardNode } from '@editor-platform/whiteboard/model';

declare global {
  interface Window {
    referenceSaveGate: { start(): void; release(): void; pending(): number };
    referenceSourceWrites: ReferenceSnapshot[];
  }
}

for (const kind of ['slide', 'document', 'design', 'whiteboard'] as const) {
  for (const field of ['schemaVersion', 'fit']) {
    test(`Playground stored history: rejects malformed ${kind} reference ${field} and retains the record`, async ({
      page,
    }, info) => {
      const source = createData();
      const resolver = new ReferenceResolver(
        {
          list: async () => [],
          subscribe: () => () => {},
          read: async () => ({
            artifactId: 'source',
            domain: 'data',
            revision: 1,
            versionId: 'v1',
            content: source,
            contentHash: await contentHash(source),
            dependencies: [],
          }),
        },
        nativeReferenceAdapters,
      );
      const reference = clone(
        await resolver.create(
          { artifactId: 'source', domain: 'data', target: { kind: 'table', viewId: 'default' } },
          'fixed',
        ),
      );
      Object.assign(reference, { [field]: field === 'fit' ? 'stretch' : 2 });
      const image = {
        reference,
        src: resolver.project(reference.snapshot, reference.source.target).src,
      };
      const deck = createDeck();
      deck.slides[0].objects = [{ ...makeSlideObject('image', 0), ...image }];
      const contents = {
        slide: deck,
        document: { ...createDocument(), blocks: [{ ...makeBlock('image'), ...image }] },
        design: { ...createDesign(), elements: [{ ...makeDesignElement('image'), ...image }] },
        whiteboard: {
          ...createWhiteboard(),
          nodes: [{ ...makeWhiteboardNode('image'), ...image }],
        },
      };
      const healthy = {
        ...createArtifact('document', 'Healthy retained artifact', createDocument()),
        annotations: [],
      };
      const corrupt = {
        ...updateDraft(
          await commitVersion(
            createArtifact(kind, 'Corrupt retained history', contents[kind]),
            null,
            'test',
          ),
          {
            slide: createDeck(),
            document: createDocument(),
            design: createDesign(),
            whiteboard: createWhiteboard(),
          }[kind],
        ),
        annotations: [],
      };
      await page.goto('/reference-host.html');
      await page.evaluate(
        (json) => {
          const { records, preferred } = JSON.parse(json) as {
            records: unknown[];
            preferred: string;
          };
          return new Promise<void>((resolve, reject) => {
            const request = indexedDB.open('editor-platform', 1);
            request.onupgradeneeded = () =>
              request.result.createObjectStore('artifacts', { keyPath: 'id' });
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              const tx = db.transaction('artifacts', 'readwrite');
              for (const record of records) tx.objectStore('artifacts').put(record);
              tx.oncomplete = () => {
                db.close();
                localStorage.setItem('ep-active-artifact', preferred);
                resolve();
              };
              tx.onerror = () => reject(tx.error);
            };
          });
        },
        JSON.stringify({ records: [healthy, corrupt], preferred: healthy.id }),
      );
      const stored = () =>
        page.evaluate(
          () =>
            new Promise<string>((resolve, reject) => {
              const request = indexedDB.open('editor-platform', 1);
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const db = request.result;
                const tx = db.transaction('artifacts', 'readonly');
                const read = tx.objectStore('artifacts').getAll();
                read.onsuccess = () => resolve(JSON.stringify(read.result));
                read.onerror = () => reject(read.error);
                tx.oncomplete = () => db.close();
              };
            }),
        );
      const before = await stored();
      await page.goto('/');
      await expect(page.getByRole('alert')).toContainText(
        'Corrupt retained history: Error: Invalid stored version',
      );
      await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(healthy.name);
      expect(await stored()).toBe(before);
      const pending = page.waitForEvent('download');
      await page
        .getByRole('button', { name: 'Export retained Corrupt retained history', exact: true })
        .click();
      expect(JSON.parse(await readFile((await (await pending).path())!, 'utf8'))).toEqual(corrupt);
      await page.screenshot({
        path: info.outputPath(`${kind}-${field}-stored-history-rejected.png`),
      });
      await page.reload();
      await expect(page.getByRole('alert')).toContainText('Invalid stored version');
      await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(healthy.name);
      expect(await stored()).toBe(before);
    });
  }
}

async function gateHashes(page: Page, failFirstSourceWrite = false) {
  await page.addInitScript((fail) => {
    const original = crypto.subtle.digest.bind(crypto.subtle);
    let blocked = false;
    let pending: (() => void)[] = [];
    crypto.subtle.digest = async (...args) => {
      if (blocked) await new Promise<void>((resolve) => pending.push(resolve));
      return original(...args);
    };
    window.referenceSaveGate = {
      start() {
        blocked = true;
      },
      release() {
        blocked = false;
        const releases = pending;
        pending = [];
        releases.forEach((release) => release());
      },
      pending: () => pending.length,
    };
    window.referenceSourceWrites = [];
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'reference-host-source:hours') {
        const snapshot = JSON.parse(value);
        if (fail && snapshot.revision > 1) {
          fail = false;
          throw new Error('Source persistence denied');
        }
        setItem.call(this, key, value);
        window.referenceSourceWrites.push(snapshot);
      } else setItem.call(this, key, value);
    };
  }, failFirstSourceWrite);
}

for (const failure of [false, true]) {
  test(`independent Host: serializes source saves and recovers from persistence failure (${failure})`, async ({
    page,
  }) => {
    await gateHashes(page, failure);
    await page.goto('/reference-host.html');
    await embed(page, 'table', 'fixed');
    await embed(page, 'table', 'follow');
    const destination = await page.evaluate(() => localStorage.getItem('reference-host:slide'));
    await inspector(page);
    await page.getByRole('button', { name: '元を編集', exact: true }).click();
    await editCell(page, '時間', 1, '80');
    await page.evaluate(() => window.referenceSaveGate.start());
    await page.getByRole('button', { name: '参照元を保存', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.referenceSaveGate.pending())).toBe(1);
    await editCell(page, '時間', 1, '65');
    await page.getByRole('button', { name: '参照元を保存', exact: true }).click();
    expect(await page.evaluate(() => window.referenceSourceWrites.length)).toBe(1);
    await page.evaluate(() => window.referenceSaveGate.release());
    await expect(page.locator('header')).toContainText(`元の保存版 ${failure ? 2 : 3}`);
    const writes = await page.evaluate(() => window.referenceSourceWrites);
    expect(writes.map((s) => s.revision)).toEqual(failure ? [1, 2] : [1, 2, 3]);
    expect(writes.map((s) => s.versionId)).toEqual(
      failure ? ['hours-v1', 'hours-v2'] : ['hours-v1', 'hours-v2', 'hours-v3'],
    );
    expect(
      writes.map((s) => (s.content as ReturnType<typeof createData>).rows[0].values.hours),
    ).toEqual(failure ? [95, 65] : [95, 80, 65]);
    for (const snapshot of writes)
      expect(snapshot.contentHash).toBe(await contentHash(snapshot.content));
    if (failure) await expect(page.getByRole('alert')).toContainText('Source persistence denied');
    await page.getByRole('button', { name: '埋め込み先に戻る', exact: true }).click();
    await expect
      .poll(async () => (await renderings(page)).some((s) => s.includes('>65<')))
      .toBe(true);
    await expect
      .poll(async () => (await renderings(page)).some((s) => s.includes('>95<')))
      .toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('reference-host:slide'))).toBe(
      destination,
    );
    const output = await native(page);
    const refs = output.content.slides[0].objects.map(
      (o: { reference: { snapshot: ReferenceSnapshot } }) => o.reference.snapshot,
    );
    expect(refs.map((s: ReferenceSnapshot) => s.revision)).toEqual([1, failure ? 2 : 3]);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    const afterUndo = (await native(page)).content;
    expect(afterUndo.slides[0].objects).toHaveLength(1);
    expect(afterUndo.slides[0].objects[0].reference.mode).toBe('fixed');
  });
}

for (const action of ['埋め込み先を保存', '参照付きJSONを出力']) {
  test(`independent Host: ${action} rejects composition without dirty input during capture`, async ({
    page,
  }, info) => {
    await gateHashes(page);
    await page.goto('/reference-host.html');
    await page.getByLabel('埋め込み先の種類').selectOption('document');
    await embed(page, 'table', 'follow');
    await page.locator('.ProseMirror img').click();
    await inspector(page);
    const caption = page.getByLabel('Caption', { exact: true });
    await expect(caption).toBeVisible();
    const before = await page.evaluate(() => [
      localStorage.getItem('reference-host:document'),
      localStorage.getItem('reference-host-versions:document'),
    ]);
    const downloads: string[] = [];
    page.on('download', (d) => downloads.push(d.suggestedFilename()));
    await page.evaluate(() => window.referenceSaveGate.start());
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.referenceSaveGate.pending()))
      .toBeGreaterThan(0);
    const initial = await caption.inputValue();
    await caption.dispatchEvent('compositionstart');
    // No input event/value change: only composing can cause this rejection.
    await page.evaluate(() => window.referenceSaveGate.release());
    await expect(page.getByRole('alert')).toContainText('入力が変わりました');
    expect(downloads).toEqual([]);
    await expect(caption).toHaveValue(initial);
    expect(
      await page.evaluate(() => [
        localStorage.getItem('reference-host:document'),
        localStorage.getItem('reference-host-versions:document'),
      ]),
    ).toEqual(before);
    await page.screenshot({ path: info.outputPath('composition-only-capture-rejected.png') });
    await caption.dispatchEvent('compositionend');
    if (action === '参照付きJSONを出力')
      expect(
        (await native(page)).content.blocks.some((b: { reference?: unknown }) => b.reference),
      ).toBe(true);
    else {
      await page.getByRole('button', { name: action, exact: true }).click();
      await expect(page.locator('header')).toContainText('保存版 1');
    }
  });
}

for (const host of ['independent', 'Playground'] as const) {
  for (const mode of ['fixed', 'follow'] as const) {
    test(`${host} Host: returns to the exact Slide page with duplicate object IDs (${mode})`, async ({
      page,
    }, info) => {
      if (host === 'independent') {
        await page.goto('/reference-host.html');
        await embed(page, 'table', mode);
        await page.evaluate(() => {
          const deck = JSON.parse(localStorage.getItem('reference-host:slide')!);
          deck.slides[0].id = 'page-a';
          deck.slides[0].title = 'First';
          deck.slides.push({ ...structuredClone(deck.slides[0]), id: 'page-b', title: 'Second' });
          localStorage.setItem('reference-host:slide', JSON.stringify(deck));
        });
        await page.reload();
      } else {
        await page.goto('/');
        await create(page, 'data');
        await save(page, 1);
        const source = await nativeArtifact(page);
        const version = source.versions[0];
        const resolver = new ReferenceResolver(
          {
            list: async () => [],
            read: async () => ({
              artifactId: source.id,
              domain: 'data',
              versionId: version.versionId,
              revision: 1,
              contentHash: version.contentHash,
              content: version.content,
              dependencies: [],
            }),
            subscribe: () => () => {},
          },
          nativeReferenceAdapters,
        );
        const reference = await resolver.create(
          { artifactId: source.id, domain: 'data', target: { kind: 'table', viewId: 'default' } },
          mode,
        );
        const deck = createDeck();
        let content = insertObject(deck.slides[0].id, 'image', {
          reference,
          src: resolver.project(reference.snapshot, reference.source.target).src,
        }).apply(deck);
        content = {
          ...content,
          slides: [
            { ...content.slides[0], id: 'page-a', title: 'First' },
            { ...clone(content.slides[0]), id: 'page-b', title: 'Second' },
          ],
        };
        const artifact = createArtifact('slide', 'Duplicate ID navigation', content);
        await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
        await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
          name: 'duplicate-slide.json',
          mimeType: 'application/json',
          buffer: Buffer.from(JSON.stringify(artifact)),
        });
        await page.keyboard.press('Escape');
        await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(
          'Duplicate ID navigation',
        );
      }
      const second = page.getByRole('button', { name: 'Slide 2: Second', exact: true });
      if (!(await second.isVisible()))
        await page.getByRole('button', { name: 'Toggle Slide navigator', exact: true }).click();
      await second.click();
      await page.getByRole('button', { name: 'Close Slide navigator', exact: true }).click();
      await page.getByLabel('Slide canvas', { exact: true }).press('Control+a');
      await inspector(page);
      await page.getByRole('button', { name: '元を編集', exact: true }).click();
      await expect(
        page.getByRole('button', { name: '埋め込み先に戻る', exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: '埋め込み先に戻る', exact: true }).click();
      await inspector(page);
      await expect(page.getByLabel('Slide title', { exact: true })).toHaveValue('Second');
      await page.screenshot({ path: info.outputPath(`${host}-${mode}-page-scoped-return.png`) });
    });
  }
}

for (const action of ['埋め込み先を保存', '参照付きJSONを出力']) {
  test(`independent Host: ${action} rejects destination changes during capture`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const original = crypto.subtle.digest.bind(crypto.subtle);
      let blocked = false;
      let pending: (() => void)[] = [];
      crypto.subtle.digest = async (...args) => {
        if (blocked) await new Promise<void>((resolve) => pending.push(resolve));
        return original(...args);
      };
      window.referenceSaveGate = {
        start() {
          blocked = true;
        },
        release() {
          blocked = false;
          const releases = pending;
          pending = [];
          releases.forEach((release) => release());
        },
        pending: () => pending.length,
      };
    });
    await page.goto('/reference-host.html');
    await embed(page, 'table', 'follow');
    await page.getByRole('button', { name: '埋め込み先を保存', exact: true }).click();
    await expect(page.locator('header')).toContainText('保存版 1');
    await page.getByLabel('埋め込み先の種類').selectOption('document');
    await page.getByRole('button', { name: '埋め込み先を保存', exact: true }).click();
    await expect(page.locator('header')).toContainText('保存版 1');
    await page.getByLabel('埋め込み先の種類').selectOption('slide');
    const retained = () =>
      page.evaluate(() =>
        Object.fromEntries(
          ['slide', 'document'].flatMap((kind) =>
            [`reference-host:${kind}`, `reference-host-versions:${kind}`].map((key) => [
              key,
              localStorage.getItem(key),
            ]),
          ),
        ),
      );
    const before = await retained();
    const downloads: string[] = [];
    page.on('download', (download) => downloads.push(download.suggestedFilename()));
    await page.evaluate(() => window.referenceSaveGate.start());
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.referenceSaveGate.pending()))
      .toBeGreaterThan(0);
    await page.getByLabel('埋め込み先の種類').selectOption('document');
    await expect(page.getByLabel('埋め込み先の種類')).toHaveValue('document');
    await page.evaluate(() => window.referenceSaveGate.release());
    await expect(page.getByRole('alert')).toContainText('埋め込み先または参照接続が変わりました');
    expect(downloads).toEqual([]);
    expect(await retained()).toEqual(before);
    await expect(page.locator('header')).toContainText('保存版 1');
    await page.getByLabel('埋め込み先の種類').selectOption('slide');
    await expect(page.locator('header')).toContainText('保存版 1');
    await page.reload();
    await expect(page.locator('header')).toContainText('保存版 1');
    expect(await retained()).toEqual(before);
  });
}

test('Playground Host HTML shares visible capture without changing stored content', async ({
  page,
}) => {
  const data = createData();
  const resolver = new ReferenceResolver(
    {
      list: async () => [],
      subscribe: () => () => {},
      read: async (source) => ({
        artifactId: source.artifactId,
        domain: 'data',
        revision: 1,
        versionId: 'v1',
        content: data,
        contentHash: await contentHash(data),
        dependencies: [],
      }),
    },
    nativeReferenceAdapters,
  );
  const source = (artifactId: string) => ({
    artifactId,
    domain: 'data',
    target: { kind: 'table', viewId: 'default' },
  });
  const visible = await resolver.create(source('included'), 'fixed');
  const document = createDocument();
  document.blocks = [
    { ...makeBlock('paragraph'), text: 'Host visible export' },
    {
      ...makeBlock('image'),
      reference: visible,
      src: resolver.project(visible.snapshot, visible.source.target).src,
    },
    {
      ...makeBlock('paragraph'),
      hidden: true,
      text: 'Hidden host text',
    },
  ];
  const artifact = createArtifact('document', 'Host visible refs', document);
  await page.goto('/');
  await create(page, 'document');
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'hidden-host.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(artifact)),
  });
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue('Host visible refs');
  const retained = () =>
    page.evaluate(
      () =>
        new Promise<string | null>((resolve, reject) => {
          const open = indexedDB.open('editor-platform', 1);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('artifacts', 'readonly');
            const read = tx.objectStore('artifacts').getAll();
            read.onsuccess = () => {
              const value = (read.result as { name: string }[]).find(
                (item) => item.name === 'Host visible refs',
              );
              resolve(value ? JSON.stringify(value) : null);
            };
            read.onerror = () => reject(read.error);
            tx.oncomplete = () => db.close();
          };
        }),
    );
  await expect.poll(retained).not.toBeNull();
  const before = await retained();
  await page.getByRole('button', { name: 'Export artifact', exact: true }).click();
  const download = page.waitForEvent('download');
  await page
    .getByRole('dialog', { name: 'Export artifact', exact: true })
    .getByRole('button', { name: 'Export HTML', exact: true })
    .click();
  const output = await readFile((await (await download).path())!, 'utf8');
  expect(output).toContain('Host visible export');
  expect(output).toContain('artifact-references');
  expect(output).toContain('included');
  expect(output).not.toContain('Hidden host text');
  expect(await retained()).toBe(before);
});

for (const location of ['draft', 'history'] as const) {
  for (const mode of ['fixed', 'follow'] as const) {
    test(`Playground import: rejects original-ID self references in ${location} (${mode})`, async ({
      page,
    }, info) => {
      const deck = createDeck();
      let artifact = createArtifact('slide', 'Self-addressed import', deck);
      const data = createData();
      const source = {
        artifactId: artifact.id,
        domain: 'data',
        target: { kind: 'table', viewId: 'default' },
      };
      const snapshot = {
        artifactId: source.artifactId,
        domain: source.domain,
        versionId: 'v1',
        revision: 1,
        content: data,
        contentHash: await contentHash(data),
        dependencies: [],
      };
      const resolver = new ReferenceResolver(
        { list: async () => [], read: async () => snapshot, subscribe: () => () => {} },
        nativeReferenceAdapters,
      );
      const reference = await resolver.create(source, mode);
      const referenced = insertObject(deck.slides[0].id, 'image', {
        reference,
        src: resolver.project(snapshot, source.target).src,
      }).apply(deck);
      artifact = updateDraft(artifact, referenced);
      if (location === 'history')
        artifact = updateDraft(await commitVersion(artifact, null, 'test'), deck);
      await page.goto('/');
      await create(page, 'slide');
      const originalName = await page.getByLabel('Artifact name', { exact: true }).inputValue();
      const retained = () =>
        page.evaluate(
          () =>
            new Promise<string>((resolve, reject) => {
              const open = indexedDB.open('editor-platform', 1);
              open.onerror = () => reject(open.error);
              open.onsuccess = () => {
                const db = open.result;
                const tx = db.transaction('artifacts', 'readonly');
                const read = tx.objectStore('artifacts').getAll();
                read.onsuccess = () => resolve(JSON.stringify(read.result));
                read.onerror = () => reject(read.error);
                tx.oncomplete = () => db.close();
              };
            }),
        );
      await expect.poll(retained).not.toBe('[]');
      const before = await retained();
      await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
      await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
        name: 'self-reference.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(artifact)),
      });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('alert')).toContainText('自己参照');
      await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(originalName);
      expect(await retained()).toBe(before);
      await page.screenshot({ path: info.outputPath(`self-import-${location}-${mode}.png`) });
      await page.reload();
      await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(originalName);
      expect(await retained()).toBe(before);
    });
  }
}

for (const location of ['draft', 'history'] as const) {
  for (const conflict of ['revision', 'version-id', 'none'] as const) {
    test(`Playground import: ${location} checks retained ${conflict} identity across history`, async ({
      page,
    }) => {
      const source = {
        artifactId: 'retained-source',
        domain: 'data',
        target: { kind: 'table', viewId: 'default' },
      };
      const content = createData();
      const snapshot = {
        artifactId: source.artifactId,
        domain: source.domain,
        versionId: 'v1',
        revision: 1,
        content,
        contentHash: await contentHash(content),
        dependencies: [],
      };
      const resolver = new ReferenceResolver(
        { list: async () => [], read: async () => snapshot, subscribe: () => () => {} },
        nativeReferenceAdapters,
      );
      const reference = clone(await resolver.create(source, 'fixed'));
      const deck = createDeck();
      const first = insertObject(deck.slides[0].id, 'image', {
        reference,
        src: resolver.project(snapshot, source.target).src,
      }).apply(deck);
      const second = clone(first);
      const retained = second.slides[0].objects[0].reference!.snapshot;
      if (conflict === 'revision') retained.versionId = 'contradictory-v1';
      else retained.revision = 2;
      if (conflict === 'none') retained.versionId = 'v2';
      let artifact = await commitVersion(
        createArtifact('slide', 'Retained import', first),
        null,
        'test',
      );
      artifact =
        location === 'history'
          ? updateDraft(await commitVersion(updateDraft(artifact, second), null, 'test'), deck)
          : updateDraft(artifact, second);
      await page.goto('/');
      await create(page, 'slide');
      const originalName = await page.getByLabel('Artifact name', { exact: true }).inputValue();
      await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
      await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
        name: 'retained-history.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(artifact)),
      });
      await page.keyboard.press('Escape');
      if (conflict === 'none') {
        await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(
          'Retained import',
        );
        await expect(page.getByRole('alert')).toHaveCount(0);
        await page.reload();
        await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(
          'Retained import',
        );
        await expect(page.getByRole('alert')).toHaveCount(0);
      } else {
        await expect(page.getByRole('alert')).toContainText(
          conflict === 'revision' ? '同じrevision' : '同じversion ID',
        );
        await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(originalName);
      }
    });
  }
}

async function embed(page: Page, kind: 'table' | 'chart' | 'graph', mode: 'fixed' | 'follow') {
  if (!(await page.getByRole('button', { name: '参照を埋め込む', exact: true }).isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await page.getByRole('button', { name: '参照を埋め込む', exact: true }).click();
  const menu = page.getByRole('dialog', { name: '参照を埋め込む', exact: true });
  await menu.getByRole('button', { name: '参照元を再取得', exact: true }).click();
  await expect(menu.getByLabel('埋め込みの参照元').locator('option')).not.toHaveCount(1);
  const option = await menu.getByLabel('埋め込みの参照元').locator('option').allTextContents();
  const index = option.findIndex((text) =>
    kind === 'graph' ? text.includes('関係図') || text.endsWith('Graph') : text.includes(kind),
  );
  expect(index).toBeGreaterThan(0);
  await menu.getByLabel('埋め込みの参照元').selectOption(String(index - 1));
  await menu.getByLabel('埋め込みの更新方式').selectOption(mode);
  await menu.getByRole('button', { name: '参照を配置', exact: true }).click();
  await expect(menu.getByRole('button', { name: '参照を配置', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
}
async function renderings(page: Page): Promise<string[]> {
  const uris = await page
    .locator('svg image[href^="data:image/svg+xml"],.ProseMirror img[src^="data:image/svg+xml"]')
    .evaluateAll((images) =>
      images.map((image) => image.getAttribute('href') ?? image.getAttribute('src')!),
    );
  return uris.map((uri) => Buffer.from(uri.split(',')[1], 'base64').toString('utf8'));
}
async function inspector(page: Page) {
  if (!(await page.getByRole('button', { name: '元を編集', exact: true }).isVisible()))
    await page
      .getByRole('button', { name: /^Toggle (Slide|Document|Design|Board) inspector$/ })
      .click();
  await expect(page.getByRole('button', { name: '元を編集', exact: true })).toBeVisible();
}
async function native(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '参照付きJSONを出力', exact: true }).click();
  const path = await (await pending).path();
  return JSON.parse(await readFile(path!, 'utf8'));
}

for (const host of ['independent', 'Playground'] as const) {
  for (const mode of ['fixed', 'follow'] as const) {
    test(`review Document return: ${host} restores the embedded image selection and scroll (${mode})`, async ({
      page,
    }, info) => {
      if (host === 'independent') {
        await page.goto('/reference-host.html');
        await page.getByLabel('埋め込み先の種類').selectOption('document');
        await embed(page, 'table', mode);
        await page.evaluate(() => {
          const content = JSON.parse(localStorage.getItem('reference-host:document')!);
          const image = content.blocks.find((b: { type: string }) => b.type === 'image');
          content.blocks = [
            { ...structuredClone(image), id: 'other-embed', caption: 'Other image' },
            ...Array.from({ length: 35 }, (_, i) => ({
              id: `paragraph-${i}`,
              type: 'paragraph',
              text: `Body paragraph ${i}`,
            })),
            { ...image, id: 'return-embed', caption: 'Return image' },
          ];
          localStorage.setItem('reference-host:document', JSON.stringify(content));
        });
        await page.reload();
      } else {
        await page.goto('/');
        await create(page, 'data');
        await save(page, 1);
        const source = await nativeArtifact(page);
        const version = source.versions[0];
        const resolver = new ReferenceResolver(
          {
            list: async () => [],
            subscribe: () => () => {},
            read: async () => ({
              artifactId: source.id,
              domain: 'data',
              versionId: version.versionId,
              revision: 1,
              content: version.content,
              contentHash: version.contentHash,
              dependencies: [],
            }),
          },
          nativeReferenceAdapters,
        );
        const reference = await resolver.create(
          { artifactId: source.id, domain: 'data', target: { kind: 'table', viewId: 'default' } },
          mode,
        );
        const image = {
          ...makeBlock('image'),
          reference,
          src: resolver.project(reference.snapshot, reference.source.target).src,
        };
        const content = {
          ...createDocument(),
          blocks: [
            { ...clone(image), id: 'other-embed', caption: 'Other image' },
            ...Array.from({ length: 35 }, (_, i) => ({
              ...makeBlock('paragraph'),
              id: `paragraph-${i}`,
              text: `Body paragraph ${i}`,
            })),
            { ...image, id: 'return-embed', caption: 'Return image' },
          ],
        };
        const artifact = createArtifact('document', 'Document navigation', content);
        await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
        await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
          name: 'return-document.json',
          mimeType: 'application/json',
          buffer: Buffer.from(JSON.stringify(artifact)),
        });
        await page.keyboard.press('Escape');
        await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(
          'Document navigation',
        );
      }
      const image = page.locator('.ep-embedded[data-block-id="return-embed"]');
      await image.locator('img').click();
      await inspector(page);
      await expect(page.getByLabel('Caption', { exact: true })).toHaveValue('Return image');
      const before =
        host === 'independent'
          ? (await native(page)).content
          : (await nativeArtifact(page)).draft.content;
      await page.getByRole('button', { name: '元を編集', exact: true }).click();
      await page.getByRole('button', { name: '埋め込み先に戻る', exact: true }).click();
      await expect(image).toHaveClass(/ProseMirror-selectednode/);
      await expect(image).toBeInViewport();
      await expect
        .poll(() =>
          image.evaluate((element) => {
            const image = element.getBoundingClientRect();
            const viewport = element.closest('.ep-document-scroll')!.getBoundingClientRect();
            return image.top >= viewport.top && image.bottom <= viewport.bottom;
          }),
        )
        .toBe(true);
      await expect(page.getByLabel('Caption', { exact: true })).toBeVisible();
      await expect(page.getByLabel('Caption', { exact: true })).toHaveValue('Return image');
      await page.screenshot({ path: info.outputPath(`${host}-${mode}-document-return.png`) });
      const after =
        host === 'independent'
          ? (await native(page)).content
          : (await nativeArtifact(page)).draft.content;
      expect(after).toEqual(before);
    });
  }
}

for (const destination of ['slide', 'document', 'design', 'whiteboard']) {
  test(`review source navigation: ${destination} retains its destination kind during source editing`, async ({
    page,
  }) => {
    await page.goto('/reference-host.html');
    const kind = page.getByLabel('埋め込み先の種類');
    await kind.selectOption(destination);
    await embed(page, 'table', 'follow');
    if (destination === 'document') await page.locator('.ProseMirror img').click();
    await inspector(page);
    await page.getByRole('button', { name: '元を編集', exact: true }).click();
    await expect(kind).toBeDisabled();
    await expect(kind).toHaveValue(destination);
    await page.getByRole('button', { name: '埋め込み先に戻る', exact: true }).click();
    await expect(kind).toBeEnabled();
    await expect(kind).toHaveValue(destination);
    await inspector(page);
    await expect(page.getByRole('status').filter({ hasText: '解決済み' }).first()).toBeVisible();
  });
}

for (const source of ['table', 'graph'] as const) {
  for (const mode of ['fixed', 'follow'] as const) {
    test(`review source access: revoked ${source} cannot open its source editor (${mode})`, async ({
      page,
    }) => {
      await page.goto('/reference-host.html');
      await embed(page, source, mode);
      await inspector(page);
      const before = await page.evaluate(() =>
        Object.fromEntries(
          Object.entries(localStorage).filter(([key]) => key.startsWith('reference-host')),
        ),
      );
      await page.getByLabel('参照元の接続状態').selectOption('forbidden');
      await page.getByRole('button', { name: '元を編集', exact: true }).click();
      await expect(
        page.getByRole('alert').filter({ hasText: 'Hostが参照権限を取り消しました' }).first(),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: '埋め込み先に戻る', exact: true })).toHaveCount(
        0,
      );
      await expect(page.getByRole('button', { name: '参照元を保存', exact: true })).toHaveCount(0);
      expect(
        await page.evaluate(() =>
          Object.fromEntries(
            Object.entries(localStorage).filter(([key]) => key.startsWith('reference-host')),
          ),
        ),
      ).toEqual(before);
      await page.getByLabel('参照元の接続状態').selectOption('online');
      await page.getByRole('button', { name: '元を編集', exact: true }).click();
      await expect(
        page.getByRole('button', { name: '埋め込み先に戻る', exact: true }),
      ).toBeVisible();
    });
  }
}

for (const pending of [false, true]) {
  test(`review source access: revocation hides an open source and blocks pending publication (${pending})`, async ({
    page,
  }, info) => {
    await gateHashes(page);
    await page.goto('/reference-host.html');
    await embed(page, 'table', 'follow');
    await inspector(page);
    await page.getByRole('button', { name: '元を編集', exact: true }).click();
    const before = await page.evaluate(() => localStorage.getItem('reference-host-source:hours'));
    if (pending) {
      await editCell(page, '時間', 1, '80');
      await page.evaluate(() => window.referenceSaveGate.start());
      await page.getByRole('button', { name: '参照元を保存', exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => window.referenceSaveGate.pending()))
        .toBeGreaterThan(0);
    }
    await page.getByLabel('参照元の接続状態').selectOption('forbidden');
    await expect(page.getByRole('button', { name: '参照元を保存', exact: true })).toBeDisabled();
    await expect(page.getByRole('grid')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: '外部提案をプレビュー', exact: true }),
    ).toHaveCount(0);
    if (pending) {
      await page.evaluate(() => window.referenceSaveGate.release());
      await expect(
        page.getByRole('alert').filter({ hasText: 'Hostが参照権限を取り消しました' }).first(),
      ).toBeVisible();
    }
    expect(await page.evaluate(() => localStorage.getItem('reference-host-source:hours'))).toBe(
      before,
    );
    expect(await page.evaluate(() => window.referenceSourceWrites.length)).toBe(1);
    await page.screenshot({ path: info.outputPath('revoked-source-hidden.png') });
    await page.getByRole('button', { name: '埋め込み先に戻る', exact: true }).click();
    await page.getByLabel('参照元の接続状態').selectOption('online');
    await expect
      .poll(async () => (await renderings(page)).some((s) => s.includes('>95<')))
      .toBe(true);
  });
}

for (const destination of ['slide', 'document', 'design', 'whiteboard']) {
  test(`${destination}: choose fixed/follow on insertion, edit source, retain fixed version, save/reload`, async ({
    page,
  }, info) => {
    await page.goto('/reference-host.html');
    await page.getByLabel('埋め込み先の種類').selectOption(destination);
    await embed(page, 'table', 'fixed');
    await embed(page, 'table', 'follow');
    await expect
      .poll(async () => (await renderings(page)).filter((s) => s.includes('95')).length)
      .toBeGreaterThanOrEqual(2);
    await inspector(page);
    await page.getByRole('button', { name: '元を編集', exact: true }).click();
    await editCell(page, '時間', 1, '80');
    await page.getByRole('button', { name: '参照元を保存', exact: true }).click();
    await expect(page.locator('header')).toContainText('元の保存版 2');
    await page.getByRole('button', { name: '埋め込み先に戻る', exact: true }).click();
    await expect
      .poll(async () => (await renderings(page)).some((s) => s.includes('80')))
      .toBe(true);
    await expect
      .poll(async () => (await renderings(page)).some((s) => s.includes('95')))
      .toBe(true);
    const panel = page.getByRole('button', {
      name: /^Close (Slide|Document|Design|Board) inspector$/,
    });
    if (await panel.isVisible()) await panel.click();
    const draftBeforeSave = await page.evaluate(
      (kind) => localStorage.getItem(`reference-host:${kind}`),
      destination,
    );
    await page.getByRole('button', { name: '埋め込み先を保存', exact: true }).click();
    await expect(page.locator('header')).toContainText('保存版 1');
    expect(
      await page.evaluate((kind) => localStorage.getItem(`reference-host:${kind}`), destination),
    ).toBe(draftBeforeSave);
    const exported = await native(page);
    const nativeText = JSON.stringify(exported);
    expect(nativeText).toContain('hours-v1');
    expect(nativeText).toContain('hours-v2');
    const oldVersion = JSON.stringify(exported.versions[0]);
    await page.reload();
    await expect
      .poll(async () => (await renderings(page)).some((s) => s.includes('80')))
      .toBe(true);
    await expect
      .poll(async () => (await renderings(page)).some((s) => s.includes('95')))
      .toBe(true);
    expect(oldVersion).toContain('hours-v2');
    await page.screenshot({
      path: info.outputPath(`references-${destination}-${info.project.name}.png`),
    });
  });
}

test('independent public Host: chart/Graph, proposal rejection and permission/offline diagnostics', async ({
  page,
}) => {
  await page.goto('/reference-host.html');
  await embed(page, 'chart', 'follow');
  await expect.poll(async () => (await renderings(page)).some((s) => s.includes('95'))).toBe(true);
  await inspector(page);
  await page.getByRole('button', { name: '元を編集', exact: true }).click();
  await page.getByRole('button', { name: '外部提案をプレビュー', exact: true }).click();
  await page.getByRole('button', { name: '提案を却下', exact: true }).click();
  await page.getByRole('button', { name: '埋め込み先に戻る', exact: true }).click();
  await expect.poll(async () => (await renderings(page)).some((s) => s.includes('95'))).toBe(true);
  const close = page.getByRole('button', { name: 'Close Slide inspector', exact: true });
  if (await close.isVisible()) await close.click();
  await embed(page, 'graph', 'follow');
  await expect
    .poll(async () => (await renderings(page)).some((s) => s.includes('supports')))
    .toBe(true);
  await inspector(page);
  await page.getByRole('button', { name: '元を編集', exact: true }).click();
  await page.getByRole('button', { name: 'Select node Research', exact: true }).click();
  await page.getByRole('textbox', { name: 'name', exact: true }).fill('自動化');
  await page.getByRole('button', { name: 'Apply attributes', exact: true }).click();
  const edge = page.getByRole('button', { name: /Select connection Related/ });
  await edge.focus();
  await edge.press('Enter');
  await page.getByRole('textbox', { name: 'label', exact: true }).fill('連動');
  await page.getByRole('button', { name: 'Apply attributes', exact: true }).click();
  await page.getByRole('button', { name: '参照元を保存', exact: true }).click();
  await expect(page.locator('header')).toContainText('元の保存版 2');
  await page.getByRole('button', { name: '埋め込み先に戻る', exact: true }).click();
  await expect
    .poll(async () =>
      (await renderings(page)).some((s) => s.includes('自動化') && s.includes('連動')),
    )
    .toBe(true);
  const graphInspector = page.getByRole('button', { name: 'Close Slide inspector', exact: true });
  if (await graphInspector.isVisible()) await graphInspector.click();
  if (!(await page.getByRole('button', { name: 'Export visual', exact: true }).isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await page.getByRole('button', { name: 'Export visual', exact: true }).click();
  const output = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export SVG', exact: true }).click();
  const files = unzipSync(await readFile((await (await output).path())!));
  const manifest = JSON.parse(strFromU8(files['references.json']));
  expect(manifest.sources.some((s: { versionId: string }) => s.versionId === 'relations-v2')).toBe(
    true,
  );
  expect(Object.keys(files).some((name) => name.endsWith('.svg'))).toBe(true);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.getByLabel('参照元の接続状態').selectOption('offline');
  await expect(page.getByText(/オフライン/).first()).toBeVisible();
  await page.getByLabel('参照元の接続状態').selectOption('forbidden');
  await expect(page.getByText(/参照権限がありません/).first()).toBeVisible();
  await expect.poll(async () => (await renderings(page)).length).toBe(0);
  await page.getByLabel('参照元の接続状態').selectOption('online');
  await expect
    .poll(async () => (await renderings(page)).some((s) => s.includes('連動')))
    .toBe(true);
});

test('Playground: Data table/chart and Graph references in all four normal Surfaces', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'data');
  await save(page, 1);
  await create(page, 'structured-graph');
  await save(page, 1);
  for (const destination of ['slide', 'document', 'design', 'whiteboard']) {
    await create(page, destination);
    await embed(page, 'table', 'follow');
    await embed(page, 'chart', 'follow');
    await embed(page, 'graph', 'follow');
    await expect
      .poll(async () => (await renderings(page)).some((s) => s.includes('supports')))
      .toBe(true);
    await inspector(page);
    const close = page.getByRole('button', {
      name: /^Close (Slide|Document|Design|Board) inspector$/,
    });
    if (await close.isVisible()) await close.click();
  }
});

for (const destination of ['slide', 'document', 'design', 'whiteboard']) {
  for (const invalid of ['{}', '[{}]']) {
    test(`independent Host rejects corrupt ${destination} history ${invalid} without overwriting`, async ({
      page,
    }) => {
      await page.goto('/reference-host.html');
      await expect(page.getByLabel('埋め込み先の種類')).toBeVisible();
      await page.evaluate(
        ({ destination, invalid }) => {
          localStorage.setItem(`reference-host-versions:${destination}`, invalid);
        },
        { destination, invalid },
      );
      await page.reload();
      await expect(page.getByRole('status')).toContainText('Invalid stored destination');
      await expect(page.getByLabel('埋め込み先の種類')).toHaveCount(0);
      expect(
        await page.evaluate(
          (kind) => localStorage.getItem(`reference-host-versions:${kind}`),
          destination,
        ),
      ).toBe(invalid);
    });
  }
}

test('Playground authoring allows a clean selection beside an embedded reference', async ({
  page,
}) => {
  await page.goto('/reference-host.html');
  await embed(page, 'table', 'fixed');
  const content = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('reference-host:slide')!),
  );
  content.slides[0].objects = [
    content.slides[0].objects.find((item: { type: string }) => item.type === 'image'),
    makeSlideObject('text', 1),
  ];
  content.slides.push({
    ...clone(content.slides[0]),
    id: 'other-page',
    title: 'Other page',
    objects: [{ ...clone(content.slides[0].objects[0]), id: content.slides[0].objects[1].id }],
  });
  const artifact = createArtifact('slide', 'Scoped authoring', content);
  await page.goto('/');
  await create(page, 'slide');
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'scoped-authoring.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(artifact)),
  });
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue('Scoped authoring');
  if (!(await page.getByRole('button', { name: 'Layers', exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle Slide navigator', exact: true }).click();
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await page.getByRole('button', { name: 'Select text object 2', exact: true }).click();
  await page.getByRole('button', { name: 'Close Slide navigator', exact: true }).click();
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('button', { name: 'テンプレートとして保存', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'テンプレートとして保存', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('テンプレート名', { exact: true }).fill('Clean selection');
  await dialog.getByRole('button', { name: '保存内容をプレビュー', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(/参照|Duplicate native IDs/);
  await dialog.getByRole('combobox', { name: '保存範囲', exact: true }).selectOption('fragment');
  await dialog.getByRole('button', { name: '保存内容をプレビュー', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'テンプレートを保存', exact: true }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Close テンプレートとして保存', exact: true }).click();
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('button', { name: '再利用部品として保存', exact: true }).click();
  const reusable = page.getByRole('dialog', { name: '再利用部品として保存', exact: true });
  await reusable.getByRole('button', { name: '部品をプレビュー', exact: true }).click();
  await expect(reusable.getByRole('alert')).toHaveCount(0);
  await expect(reusable.getByRole('button', { name: '部品を公開', exact: true })).toBeVisible();
});

for (const destination of ['slide', 'document', 'design', 'whiteboard']) {
  test(`independent Host rejects a corrupt retained hash in ${destination} history`, async ({
    page,
  }) => {
    await page.goto('/reference-host.html');
    await page.getByLabel('埋め込み先の種類').selectOption(destination);
    await embed(page, 'table', 'fixed');
    await page.getByRole('button', { name: '埋め込み先を保存', exact: true }).click();
    await expect(page.locator('header')).toContainText('保存版 1');
    const corrupt = await page.evaluate((kind) => {
      const key = `reference-host-versions:${kind}`;
      const history = JSON.parse(localStorage.getItem(key)!);
      const version = history[0];
      const item =
        kind === 'slide'
          ? version.slides[0].objects.find((item: { type: string }) => item.type === 'image')
          : kind === 'document'
            ? version.blocks.find((b: { type: string }) => b.type === 'image')
            : kind === 'design'
              ? version.elements[0]
              : version.nodes[0];
      item.reference.snapshot.contentHash = '0'.repeat(64);
      const value = JSON.stringify(history);
      localStorage.setItem(key, value);
      // The active destination is different: every retained history must be checked.
      localStorage.setItem('reference-host-kind', kind === 'slide' ? 'document' : 'slide');
      return value;
    }, destination);
    await page.reload();
    await expect(page.getByRole('status')).toContainText('hash');
    await expect(page.getByLabel('埋め込み先の種類')).toHaveCount(0);
    expect(
      await page.evaluate(
        (kind) => localStorage.getItem(`reference-host-versions:${kind}`),
        destination,
      ),
    ).toBe(corrupt);
  });
}

for (const conflict of ['draft-version', 'version-version']) {
  test(`independent Host rejects contradictory immutable identities across ${conflict}`, async ({
    page,
  }) => {
    await page.goto('/reference-host.html');
    await embed(page, 'table', 'fixed');
    const draft = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('reference-host:slide')!),
    );
    const contradictory = clone(draft);
    const reference = contradictory.slides[0].objects.find(
      (item: { type: string }) => item.type === 'image',
    ).reference;
    reference.snapshot.content.rows[0].values.hours = 80;
    reference.snapshot.contentHash = await contentHash(reference.snapshot.content);
    const raw = JSON.stringify(
      conflict === 'draft-version' ? [contradictory] : [draft, contradictory],
    );
    await page.evaluate(
      ({ raw, conflict }) => {
        localStorage.setItem('reference-host-versions:slide', raw);
        if (conflict === 'version-version') localStorage.removeItem('reference-host:slide');
      },
      { raw, conflict },
    );
    await page.reload();
    await expect(page.getByRole('status')).toContainText('Error');
    await expect(page.getByLabel('埋め込み先の種類')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('reference-host-versions:slide'))).toBe(
      raw,
    );
  });
}

test('PPTX diagnostic navigation preserves the destination page for authoring', async ({
  page,
}) => {
  const content = createDeck();
  const object = {
    ...makeSlideObject('text', 0),
    id: 'same-id',
    typography: { fontFamily: 'Arial', fontSize: 24 },
  };
  content.slides = [
    {
      ...content.slides[0],
      id: 'first',
      title: 'First',
      objects: [{ ...object, text: 'Wrong page content' }],
    },
    {
      ...content.slides[0],
      id: 'second',
      title: 'Second',
      objects: [{ ...object, text: 'Diagnostic target content' }],
    },
  ];
  await page.goto('/');
  await create(page, 'slide');
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'diagnostic-pages.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(createArtifact('slide', 'Diagnostic pages', content))),
  });
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue('Diagnostic pages');
  const pptx = await openPptx(page);
  await preparePptx(pptx);
  await pptx.getByRole('button', { name: 'Go to page 2 / element', exact: true }).first().click();
  await pptx.getByRole('button', { name: 'Close PPTX export', exact: true }).click();
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('button', { name: 'テンプレートとして保存', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'テンプレートとして保存', exact: true });
  await dialog.getByRole('combobox', { name: '保存範囲', exact: true }).selectOption('fragment');
  await dialog.getByRole('button', { name: '保存内容をプレビュー', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'テンプレートを保存', exact: true }),
  ).toBeVisible();
  await expect(dialog).toContainText('Diagnostic target content');
  await expect(dialog).not.toContainText('Wrong page content');
  await page.screenshot({ path: test.info().outputPath('diagnostic-authoring.png') });
  await dialog.getByRole('button', { name: 'Close テンプレートとして保存', exact: true }).click();
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('button', { name: '再利用部品として保存', exact: true }).click();
  const reusable = page.getByRole('dialog', { name: '再利用部品として保存', exact: true });
  await reusable.getByRole('button', { name: '部品をプレビュー', exact: true }).click();
  await expect(reusable.getByRole('button', { name: '部品を公開', exact: true })).toBeVisible();
  await expect(reusable).toContainText('Diagnostic target content');
  await expect(reusable).not.toContainText('Wrong page content');
});
