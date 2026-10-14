import { test, expect, nativeArtifact } from './fixtures';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { reuseHash } from '@editor-platform/reuse-core';
import { prepareReactScreenProposal, type ReactUiDocument } from '@editor-platform/react-ui-core';

for (const screen of ['product', 'form', 'revised'] as const) {
  test(`W5 ${screen}: identical preview/export at 390/1024/1400px and real callback redraw`, async ({
    page,
    context,
  }, info) => {
    test.setTimeout(120000);
    await page.goto('/');
    await page.getByRole('button', { name: 'New React UI', exact: true }).click();
    await page
      .getByRole('button', {
        name: `Load example ${screen === 'product' ? 'Product page' : 'Contact form'}`,
        exact: true,
      })
      .click();
    if (screen === 'revised') {
      for (const id of ['title', 'footer']) {
        await page.getByRole('button', { name: `${id} · Text`, exact: true }).click();
        await page.getByRole('button', { name: 'Review component revision', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Review React revision', exact: true });
        await dialog.getByRole('button', { name: 'Preview revision', exact: true }).click();
        await dialog.getByRole('button', { name: 'Adopt revision', exact: true }).click();
      }
      await page.getByRole('button', { name: 'Review environment revision', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Review React revision', exact: true });
      await dialog.getByRole('button', { name: 'Preview revision', exact: true }).click();
      await dialog.getByRole('button', { name: 'Adopt revision', exact: true }).click();
    }
    const document = (await nativeArtifact(page)).draft.content as ReactUiDocument;
    const generated = JSON.parse(
      await readFile(`work/issue-24/export-host/${screen}/generated/composition.json`, 'utf8'),
    );
    expect(document).toEqual(generated);
    const independent = await context.newPage();
    const errors: string[] = [];
    independent.on('pageerror', (e) => errors.push(e.message));
    independent.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    try {
      const frame = page.frameLocator('iframe[title="React component preview"]');
      const proposal = await prepareReactScreenProposal({
        document,
        externalReferences: [{ namespace: 'reference-host', screenId: screen, stateId: 'initial' }],
        signal: new AbortController().signal,
        capture: {
          async capture({ document: captured, widths }) {
            const screenshots = [];
            for (const width of widths) {
              await page.getByLabel('Preview width', { exact: true }).selectOption(String(width));
              await page.getByRole('button', { name: 'Interact', exact: true }).click();
              await expect(page.locator('iframe[title="React component preview"]')).toHaveAttribute(
                'aria-busy',
                'false',
              );
              // Capture at an integer page origin, avoiding fractional compositor
              // sampling from the surrounding Editor grid. This changes only the
              // iframe's position; the composition and its viewport stay identical.
              await page.locator('iframe[title="React component preview"]').evaluate((element) => {
                Object.assign(element.style, {
                  position: 'fixed',
                  top: '0px',
                  left: '0px',
                  zIndex: '9999',
                });
              });
              await independent.setViewportSize({ width, height: 700 });
              await independent.goto(`http://127.0.0.1:4175/${screen}/`);
              const preview = frame.getByRole('region', { name: 'Reference card', exact: true });
              const output = independent.getByRole('region', {
                name: 'Reference card',
                exact: true,
              });
              await expect(output).toBeVisible();
              if (screen === 'product') await expect(output.getByRole('img')).toBeVisible();
              const before = await preview.screenshot({
                path: info.outputPath(`preview-${width}.png`),
              });
              const after = await output.screenshot({
                path: info.outputPath(`export-${width}.png`),
              });
              expect(after.equals(before), `Identical ${screen} initial pixels at ${width}px`).toBe(
                true,
              );
              screenshots.push({
                width,
                height: Math.ceil((await preview.boundingBox())!.height),
                path: `preview-${width}.png`,
                hash: createHash('sha256').update(before).digest('hex'),
                fixtureHash: reuseHash(captured.fixture),
                environmentHash: captured.environment.ref.hash,
              });
              if (screen !== 'product') {
                await frame.getByRole('textbox', { name: 'Name', exact: true }).fill('Aki');
                await independent.getByRole('textbox', { name: 'Name', exact: true }).fill('Aki');
              }
              const button = screen === 'product' ? 'Add to cart' : 'Send';
              await frame.getByRole('button', { name: button, exact: true }).click();
              await independent.getByRole('button', { name: button, exact: true }).click();
              await expect(
                preview.getByText(screen === 'product' ? 'Thanks visitor' : 'Thanks Aki', {
                  exact: true,
                }),
              ).toBeVisible();
              await expect(
                output.getByText(screen === 'product' ? 'Thanks visitor' : 'Thanks Aki', {
                  exact: true,
                }),
              ).toBeVisible();
              expect(
                (
                  await output.screenshot({
                    path: info.outputPath(`export-interaction-${width}.png`),
                  })
                ).equals(
                  await preview.screenshot({
                    path: info.outputPath(`preview-interaction-${width}.png`),
                  }),
                ),
                `Identical callback redraw at ${width}px`,
              ).toBe(true);
              expect(await independent.locator('iframe').count()).toBe(0);
              await page.locator('iframe[title="React component preview"]').evaluate((element) => {
                for (const property of ['position', 'top', 'left', 'z-index'])
                  element.style.removeProperty(property);
              });
            }
            return { screenshots, diagnostics: [] };
          },
        },
      });
      await writeFile(info.outputPath('screen-proposal.json'), JSON.stringify(proposal, null, 2));
      expect((await nativeArtifact(page)).draft.content).toEqual(document);
      expect(errors).toEqual([]);
    } finally {
      await independent.close();
    }
  });
}
