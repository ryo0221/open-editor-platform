import { expect, it, vi } from 'vitest';
import {
  accessLabel,
  HostAccessDisplay,
  scheduleAccessExpiry,
  type HostAccessMetadata,
} from './access';
it('displays authoritative private/public/link/restricted fixtures separately from unknown/stale metadata', async () => {
  let now = 100,
    raw: unknown;
  const display = new HostAccessDisplay(
    {
      async read() {
        return raw;
      },
    },
    () => now,
  );
  expect(display.label).toBe('共有設定はHostで確認');
  for (const [i, scope] of ['owner-only', 'public', 'link', 'restricted'].entries()) {
    raw = { scope, revision: i, expiresAt: 200, source: 'trusted Host fixture' };
    expect(await display.refresh()).toBe(accessLabel(raw as HostAccessMetadata, now));
  }
  now = 201;
  expect(display.label).toBe('共有設定はHostで確認');
  raw = { scope: 'owner-only', revision: 1, expiresAt: 300, source: 'trusted Host fixture' };
  expect(await display.refresh()).toBe('共有設定はHostで確認');
});
it('invalidates immediately and ignores a stale async private response after public refetch', async () => {
  let finish: (v: unknown) => void = () => {},
    calls = 0;
  const display = new HostAccessDisplay(
    {
      read() {
        return ++calls === 1
          ? new Promise((r) => {
              finish = r;
            })
          : Promise.resolve({ scope: 'public', revision: 2, expiresAt: 500, source: 'Host' });
      },
    },
    () => 100,
  );
  const stale = display.refresh();
  await display.refresh();
  finish({ scope: 'owner-only', revision: 1, expiresAt: 500, source: 'Host' });
  await stale;
  expect(display.label).toBe('公開');
  display.invalidate();
  expect(display.label).toBe('共有設定はHostで確認');
});
it('fails neutral on metadata errors and malformed or expired input', async () => {
  const display = new HostAccessDisplay({
    async read() {
      throw Error('offline');
    },
  });
  expect(await display.refresh()).toBe('共有設定はHostで確認');
  for (const raw of [
    { scope: 'private' },
    { scope: 'owner-only', revision: NaN, expiresAt: 1000, source: 'Host' },
    { scope: 'public', revision: -1, expiresAt: 1000, source: 'Host' },
    { scope: 'owner-only', revision: 1, expiresAt: Infinity, source: 'Host' },
  ]) {
    expect(
      await new HostAccessDisplay(
        {
          async read() {
            return raw;
          },
        },
        () => 100,
      ).refresh(),
    ).toBe('共有設定はHostで確認');
  }
});
it('re-arms clamped expiry timers and cancels them when detached', async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(100);
    const display = new HostAccessDisplay({
      async read() {
        return {
          scope: 'public',
          revision: 0,
          expiresAt: Date.now() + 2147483647 + 400,
          source: 'Host',
        };
      },
    });
    await display.refresh();
    const notify = vi.fn();
    const cancel = scheduleAccessExpiry(display, notify);
    await vi.advanceTimersByTimeAsync(2147483647);
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(notify).toHaveBeenCalledExactlyOnceWith('共有設定はHostで確認');
    cancel();
    await display.refresh();
    scheduleAccessExpiry(display, notify)();
    await vi.advanceTimersByTimeAsync(2147484047);
    expect(notify).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
