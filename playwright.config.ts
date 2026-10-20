import { defineConfig } from '@playwright/test';
import { defaults, suites } from './tests/playwright/suites';

// One config for every browser suite. Select a suite with E2E_SUITE, for example
// `E2E_SUITE=design-react.production npx playwright test`; the default suite runs
// the full desktop/mobile E2E against development servers. See tests/playwright/suites.ts.
const name = process.env.E2E_SUITE || 'default';
if (!Object.hasOwn(suites, name)) {
  throw new Error(`Unknown E2E_SUITE "${name}". Known suites: ${Object.keys(suites).join(', ')}`);
}
const selected = suites[name]();

export default defineConfig({
  ...defaults,
  ...selected,
  expect: { ...defaults.expect, ...selected.expect },
  use: { ...defaults.use, ...selected.use },
});
