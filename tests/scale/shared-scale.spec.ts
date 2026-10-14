import { test, expect } from '../e2e/fixtures';
import { artifactMenu } from '../e2e/template-fixtures';
import { scaleArtifact } from './fixtures';
import { writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { execFileSync } from 'node:child_process';

for (const delayMs of [0, 80])
  for (const kind of ['slide', 'design', 'whiteboard', 'document', 'data'])
    test(`${kind} shared scale at ${delayMs} ms added acknowledgement delay`, async ({
      page,
      browser,
    }, info) => {
      test.setTimeout(300000);
      await page.goto('/');
      await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
        name: `${kind}-scale.json`,
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(scaleArtifact(kind))),
      });
      await artifactMenu(page, 'Open collaboratively');
      await page.keyboard.press('Escape');
      await expect(page.locator('.save-status')).toContainText('Shared · confirmed');
      let delayedAcknowledgements = 0;
      if (delayMs)
        await page.route('**/collaboration-api/submit?*', async (route) => {
          delayedAcknowledgements++;
          const response = await route.fetch();
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          await route.fulfill({ response });
        });
      if (kind === 'slide') {
        await page.getByRole('button', { name: 'Layers', exact: true }).click();
        await page.getByRole('button', { name: 'Select shape object 1', exact: true }).click();
        await page.getByRole('application').focus();
      } else if (kind === 'design' || kind === 'whiteboard') {
        await page
          .getByRole('button', {
            name: kind === 'design' ? 'Layer Frame 0' : 'Layer group 1',
            exact: true,
          })
          .click();
        await page.getByRole('application').focus();
      } else if (kind === 'document') await page.locator('.ProseMirror p').first().click();
      const local: number[] = [],
        confirmed: number[] = [];
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Performance.enable');
      const metricsBefore = (await cdp.send('Performance.getMetrics')).metrics;
      if (process.env.PROFILE_SCALE) {
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.start');
      }
      for (let i = 0; i < 22; i++) {
        if (kind === 'data') {
          await page.getByRole('gridcell', { name: 'Metric 1 · record 1', exact: true }).dblclick();
          await page.getByLabel('Edit Metric 1', { exact: true }).fill(String(100 + i));
        }
        await page.evaluate(() => {
          const scope = window as typeof window & {
            timing: Promise<{ local: number; confirmed: number }>;
          };
          const status = document.querySelector('.save-status')!;
          const before = Number(status.textContent?.match(/confirmed r(\d+)/)?.[1]);
          scope.timing = new Promise((resolve) =>
            window.addEventListener(
              'keydown',
              () => {
                const start = performance.now();
                let local: number | undefined, confirmed: number | undefined;
                const done = () => {
                  if (local !== undefined && confirmed !== undefined) {
                    observer.disconnect();
                    resolve({ local, confirmed });
                  }
                };
                const observer = new MutationObserver(() => {
                  const revision = Number(
                    status.textContent?.match(/Shared · confirmed r(\d+)/)?.[1],
                  );
                  if (revision > before) {
                    confirmed = performance.now() - start;
                    done();
                  }
                });
                observer.observe(status, { childList: true, subtree: true, characterData: true });
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => {
                    local = performance.now() - start;
                    done();
                  }),
                );
              },
              { capture: true, once: true },
            ),
          );
        });
        if (kind === 'data') await page.getByLabel('Edit Metric 1', { exact: true }).press('Enter');
        else await page.keyboard.press(kind === 'document' ? 'x' : 'ArrowRight');
        const result = await page.evaluate(
          () =>
            (window as typeof window & { timing: Promise<{ local: number; confirmed: number }> })
              .timing,
        );
        if (i > 1) {
          local.push(result.local);
          confirmed.push(result.confirmed);
        }
      }
      if (kind === 'document')
        await expect(page.locator('.ProseMirror')).toContainText('x'.repeat(22));
      else if (kind === 'data')
        await expect(
          page.getByRole('gridcell', { name: 'Metric 1 · record 1', exact: true }),
        ).toHaveText('121');
      else
        await expect(page.getByLabel('Element x', { exact: true })).toHaveValue(
          kind === 'slide' ? '52' : '22',
        );
      if (delayMs) expect(delayedAcknowledgements).toBeGreaterThanOrEqual(22);
      const p95 = (values: number[]) =>
        +[...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1].toFixed(1);
      const report = {
        kind,
        mode: 'shared',
        profiled: !!process.env.PROFILE_SCALE,
        addedAcknowledgementDelayMs: delayMs,
        delayedAcknowledgements,
        transport: 'reference HTTP on loopback, in-memory authority',
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        measuredAt: new Date().toISOString(),
        browser: browser.version(),
        node: process.version,
        cpuModel: cpus()[0]?.model,
        cpus: cpus().length,
        memoryGB: Math.round(totalmem() / 1024 ** 3),
        viewport: '1440x900',
        warmups: 2,
        localSamplesMs: local,
        confirmedSamplesMs: confirmed,
        localP95Ms: p95(local),
        confirmedP95Ms: p95(confirmed),
        localTargetMs: 100,
        meetsLocalTarget: p95(local) <= 100,
        metricsBefore,
        metricsAfter: (await cdp.send('Performance.getMetrics')).metrics,
      };
      await writeFile(
        info.outputPath(`${kind}-shared-${delayMs}.json`),
        JSON.stringify(report, null, 2),
      );
      console.log(
        JSON.stringify({
          kind,
          delayMs,
          localP95Ms: report.localP95Ms,
          confirmedP95Ms: report.confirmedP95Ms,
        }),
      );
      if (process.env.PROFILE_SCALE) {
        const { profile } = await cdp.send('Profiler.stop');
        await writeFile(
          info.outputPath(`${kind}-shared-${delayMs}.cpuprofile`),
          JSON.stringify(profile),
        );
      }
      await cdp.detach();
    });
