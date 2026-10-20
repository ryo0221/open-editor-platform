import { existsSync } from 'node:fs';

/**
 * Chromium for Playwright runs: PLAYWRIGHT_CHROMIUM_EXECUTABLE when set, otherwise the
 * system Chromium when present, otherwise undefined (Playwright's installed browser).
 */
export function chromiumExecutablePath(): string | undefined {
  return (
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined)
  );
}

export function chromiumLaunchOptions(extra: Record<string, unknown> = {}) {
  const executablePath = chromiumExecutablePath();
  return executablePath ? { executablePath, ...extra } : extra;
}
