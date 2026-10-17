import { defineConfig } from '@playwright/test';
import base from './playwright.design-prototype.production.config';
export default defineConfig({
  ...base,
  testMatch: ['document-performance.spec.ts', 'issue2-document.spec.ts'],
  projects: [
    {
      name: 'desktop',
      testMatch: ['document-performance.spec.ts', 'issue2-document.spec.ts'],
      use: { viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile',
      testMatch: ['document-performance.spec.ts'],
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
});
