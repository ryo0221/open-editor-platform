import { test, expect } from '@playwright/test';
declare global {
  interface Window {
    animationTestClock: { set(t: number): void; flush(reverse: boolean): void };
  }
}
for (const reverse of [false, true])
  test(`editing between polls retains pause time (reverse callbacks=${reverse})`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      let now = 0,
        id = 0;
      const callbacks = new Map<number, FrameRequestCallback>();
      Object.defineProperty(performance, 'now', { value: () => now });
      window.requestAnimationFrame = (cb) => {
        callbacks.set(++id, cb);
        return id;
      };
      window.cancelAnimationFrame = (id) => {
        callbacks.delete(id);
      };
      window.animationTestClock = {
        set: (t) => {
          now = t;
        },
        flush: (reverse) => {
          const work = [...callbacks.entries()];
          if (reverse) work.reverse();
          for (const [id, cb] of work) {
            if (callbacks.delete(id)) cb(now);
          }
        },
      };
    });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Add rectangle', exact: true }).dispatchEvent('click');
    await expect(page.locator('svg rect')).toHaveCount(1);
    await page.getByRole('button', { name: 'Play', exact: true }).dispatchEvent('click');
    await page.evaluate((r) => {
      window.animationTestClock.set(100);
      window.animationTestClock.flush(r);
    }, reverse);
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await page.evaluate(() => window.animationTestClock.set(1000));
    // Do not run any Player or UI rAF: pause itself must sample the absolute clock.
    await page
      .getByRole('button', { name: 'Apply base transform', exact: true })
      .dispatchEvent('click');
    await expect(page.getByRole('status')).toHaveText('Base transform applied');
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
    await expect(page.locator('svg')).toHaveAttribute('data-tick', '240000');
    await expect(page.getByText('1.00 s / 4.00 s', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Play', exact: true }).dispatchEvent('click');
    await page.evaluate((r) => {
      window.animationTestClock.set(1100);
      window.animationTestClock.flush(r);
    }, reverse);
    await page.evaluate(() => window.animationTestClock.set(2000));
    await page.getByRole('button', { name: 'Undo', exact: true }).dispatchEvent('click');
    await expect(page.getByRole('status')).toHaveText('Undone');
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
    await expect(page.locator('svg')).toHaveAttribute('data-tick', '480000');
    await expect(page.getByText('2.00 s / 4.00 s', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
