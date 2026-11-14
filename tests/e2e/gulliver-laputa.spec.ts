// GV5a (docs/cad/gulliver-world.md): the flying island of Laputa (F116, 7.2 km across) and the
// island with its loadstone on two revolute joints (F117) open in the ordinary Playground's CAD
// editor and the kernel makes every body. GULLIVER_OUT names a folder for the screenshots.
import type { CadDocument } from '@editor-platform/cad-core';
import type { Page } from '@playwright/test';
import { f116Island, f117Laputa } from '../../scripts/fixtures/gulliver-laputa-cad';
import { create, expect, nativeArtifact, test } from './fixtures';

// Needs the development kernel (CAD_OCCT_DIST).
test.skip(!process.env.CAD_OCCT_DIST, 'CAD_OCCT_DIST is not set');

const out = process.env.GULLIVER_OUT;
const ready = (page: Page, timeout = 180_000) =>
  expect(page.getByTestId('cad-geometry-state')).toHaveText('Shape up to date', { timeout });
type Kernel = Pick<CadDocument['kernelProfile'], 'id' | 'buildHash'>;

async function open(
  page: Page,
  name: string,
  build: (kernel: Kernel) => { doc: CadDocument; closure?: Map<string, CadDocument> },
) {
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
        draft: { ...empty.draft, content: built.doc },
        ...(built.closure
          ? {
              cadParts: [...built.closure].map(([contentHash, content]) => ({
                contentHash,
                content,
              })),
            }
          : {}),
      }),
    ),
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue(name);
  await ready(page);
  return built;
}

test('the island: 7,837 yards across, 300 thick, its adamant, chasm, dome, basins, galleries (ST-650, TS-2320)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(600_000);
  await open(page, 'Laputa island', (k) => ({ doc: f116Island(k) }));
  const doc = (await nativeArtifact(page)).draft.content as CadDocument;
  expect(doc.bodies.filter((b) => b.state === 'active').length).toBeGreaterThan(40);
  if (out) await page.getByTestId('cad-viewport').screenshot({ path: `${out}/island.png` });
});

test('the island with its loadstone: the axle turns in the groove, the stone on the axle (ST-650, TS-2320)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(600_000);
  await open(page, 'Laputa', (k) => {
    const l = f117Laputa(k, { yawRad: 0.4, tiltRad: 0.35 });
    return { doc: l.assembly, closure: l.closure };
  });
  const list = page.getByRole('list', { name: 'Components' });
  await expect(list.getByRole('button').first()).toBeVisible();
  await expect(list).not.toContainText(/計算中|計算できません|参照できません|参考表示/, {
    timeout: 300_000,
  });
  const doc = (await nativeArtifact(page)).draft.content as CadDocument;
  expect(doc.joints.map((j) => j.id)).toEqual(['j-axle', 'j-stone']);
  if (out) await page.getByTestId('cad-viewport').screenshot({ path: `${out}/laputa.png` });
});
