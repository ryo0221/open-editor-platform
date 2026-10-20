import type { Server } from 'node:http';
import { chromium, type Browser } from '@playwright/test';
import { chromiumExecutablePath } from '../../../tests/playwright/chromium';

// Same browser rule as the Playwright configs: PLAYWRIGHT_CHROMIUM_EXECUTABLE,
// the system package path, or Playwright's own install.
export function launchTestChromium(): Promise<Browser> {
  return chromium.launch({
    executablePath: chromiumExecutablePath(),
    headless: true,
    args: ['--no-sandbox'],
  });
}

// Starts `server` on an ephemeral loopback port and returns its origin.
export async function listenOnLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('address');
  return `http://127.0.0.1:${address.port}`;
}

export function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}
