// GV3b (docs/cad/gulliver-world.md): the emperor's greatest engine (22 wheels) and Blefuscu's
// fifty men of war as CAD assemblies in the ordinary Playground. Each places one saved version
// many times through component patterns. GULLIVER_OUT names a folder for the screenshots.
import type { CadDocument } from '@editor-platform/cad-core';
import type { Page } from '@playwright/test';
import { blefuscuFleet, engineAssembly } from '../../scripts/fixtures/gulliver-lilliput-cad';
import { create, expect, nativeArtifact, test } from './fixtures';

// Needs the development kernel (CAD_OCCT_DIST).
test.skip(!process.env.CAD_OCCT_DIST, 'CAD_OCCT_DIST is not set');

const out = process.env.GULLIVER_OUT;
const ready = (page: Page, timeout = 180_000) =>
  expect(page.getByTestId('cad-geometry-state')).toHaveText('Shape up to date', { timeout });

async function openAssembly(
  page: Page,
  name: string,
  build: typeof engineAssembly,
): Promise<ReturnType<typeof engineAssembly>> {
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const { id, buildHash } = (empty.draft.content as CadDocument).kernelProfile;
  const built = build({ id, buildHash });
  const input = page.getByLabel('Import artifact', { exact: true });
  if (!(await input.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await input.setInputFiles({
    name: `${name}.json`,
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        ...empty,
        name,
        draft: { ...empty.draft, content: built.assembly },
        cadParts: [...built.closure].map(([contentHash, content]) => ({ contentHash, content })),
      }),
    ),
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue(name);
  await ready(page);
  // Every placed version is made by the kernel: no component waits, fails or is missing.
  const list = page.getByRole('list', { name: 'Components' });
  await expect(list.getByRole('button').first()).toBeVisible();
  await expect(list).not.toContainText(/計算中|計算できません|参照できません|参考表示/, {
    timeout: 180_000,
  });
  return built;
}

test('the greatest engine: one wheel version on 22 places, 7 × 4 ft, 3 in up (ST-645, TS-2310)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(420_000);
  const built = await openAssembly(page, 'Greatest engine', engineAssembly);
  const doc = (await nativeArtifact(page)).draft.content as CadDocument;
  expect(doc.parts.map((p) => p.source.contentHash).sort()).toEqual(
    built.versions.map((v) => v.contentHash).sort(),
  );
  const copies = doc.componentPatterns.reduce(
    (n, p) =>
      n + (p.layout.type === 'linear' ? (p.layout.count as { literal: number }).literal : 0),
    0,
  );
  expect(copies).toBe(22);
  if (out) await page.getByTestId('cad-viewport').screenshot({ path: `${out}/engine.png` });
});

test('the fleet: one man of war on 50 places (ST-645, TS-2310)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(420_000);
  await openAssembly(page, 'Blefuscu fleet', blefuscuFleet);
  const doc = (await nativeArtifact(page)).draft.content as CadDocument;
  expect(doc.componentPatterns.map((p) => p.seedComponentId)).toHaveLength(5);
  if (out) await page.getByTestId('cad-viewport').screenshot({ path: `${out}/fleet.png` });
});
