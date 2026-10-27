import { mkdirSync } from 'node:fs';
import { devices, type PlaywrightTestConfig, type Project } from '@playwright/test';
import { chromiumLaunchOptions } from './chromium';

// Named Playwright suites selected by E2E_SUITE in playwright.config.ts. Each suite
// replaces a former playwright.<name>.config.ts (or a package-level config) and keeps
// its spec selection, projects, servers and output directory.
type TestMatch = NonNullable<PlaywrightTestConfig['testMatch']>;
type WebServer = Extract<NonNullable<PlaywrightTestConfig['webServer']>, { command: string }>;
export type Suite = Omit<PlaywrightTestConfig, 'webServer'> & { webServer?: WebServer[] };

const ci = !!process.env.CI;

const server = {
  designExport: {
    command: 'node scripts/design-react-export-server.mjs',
    url: 'http://127.0.0.1:4176/health',
    reuseExistingServer: false,
    timeout: 120_000,
  },
  reactUiExport: {
    command: 'node scripts/react-ui-export-server.mjs',
    url: 'http://127.0.0.1:4175',
    reuseExistingServer: false,
    timeout: 120_000,
  },
  reactUiDev: {
    command: 'npm run react-ui:dev',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: !ci,
    timeout: 60_000,
  },
  dev: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !ci,
    timeout: 60_000,
  },
  collaboration: {
    command: 'npm run collaboration:server',
    url: 'http://127.0.0.1:4180/collaboration-api/health',
    reuseExistingServer: !ci,
    timeout: 60_000,
  },
  reactUiPreview: {
    command: 'npm run react-ui:preview',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
  },
  preview: {
    command: 'npm run preview -- --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 60_000,
  },
  animationHost: {
    command: 'npx vite preview --config vite.animation-host.config.ts',
    url: 'http://127.0.0.1:4189',
    reuseExistingServer: false,
  },
  artifactHost: {
    command: 'npx vite preview --config vite.artifact-host.config.ts',
    url: 'http://127.0.0.1:4177',
    reuseExistingServer: false,
    timeout: 60_000,
  },
} satisfies Record<string, WebServer>;

const productionServers = [
  server.reactUiExport,
  server.reactUiPreview,
  server.preview,
  server.collaboration,
];

/** Settings shared by every suite unless the suite overrides them. */
export const defaults: Suite = {
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 2,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  // DOM trace snapshots inject a script into sandboxed frames; keep screenshots/network traces without that instrumentation.
  use: {
    trace: { mode: 'retain-on-failure', snapshots: false },
    screenshot: 'only-on-failure',
    launchOptions: chromiumLaunchOptions(),
  },
};

/** Playwright's own timeouts, kept by suites that never inherited the editor defaults. */
const playwrightTimeouts = { timeout: 30_000, expect: { timeout: 5_000 } } satisfies Suite;

const desktopUse = { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } };
const mobileUse = {
  ...devices['iPhone 13'],
  defaultBrowserType: 'chromium' as const,
  viewport: { width: 390, height: 844 },
};

/**
 * Desktop Chrome and iPhone 13 (Chromium) projects. By default mobile runs
 * `*mobile.spec.ts` and desktop runs everything else; `both` sends the same specs to both.
 */
function editorProjects(
  desktop?: TestMatch,
  mobile: TestMatch | undefined = desktop,
  both = false,
): Project[] {
  return [
    {
      name: 'desktop',
      ...(both ? {} : { testIgnore: /mobile.spec.ts/ }),
      ...(desktop ? { testMatch: desktop } : {}),
      use: desktopUse,
    },
    {
      name: 'mobile',
      testMatch: both ? desktop : (mobile ?? /mobile.spec.ts/),
      use: mobileUse,
    },
  ];
}

/** Plain viewport projects without device emulation. */
function viewportProjects(
  desktop: { width: number; height: number },
  narrowName = 'mobile',
  touch = false,
): Project[] {
  return [
    { name: 'desktop', use: { viewport: desktop } },
    {
      name: narrowName,
      use: {
        viewport: { width: 390, height: 844 },
        ...(touch ? { isMobile: true, hasTouch: true } : {}),
      },
    },
  ];
}

/** Device projects for package-level browser suites (Playwright device defaults). */
const packageDeviceProjects: Project[] = [
  { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
  { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
];

/** Production preview (`npm run build` first) with the React UI export and collaboration services. */
function production(
  outputDir: string,
  desktop?: TestMatch,
  mobile?: TestMatch,
  extra: Suite = {},
): Suite {
  return {
    outputDir,
    use: { baseURL: 'http://127.0.0.1:4173' },
    projects: desktop ? editorProjects(desktop, mobile) : editorProjects(),
    webServer: productionServers,
    ...extra,
  };
}

/** Production preview plus the Design React export service. */
function designReactProduction(outputDir: string, desktop: TestMatch, mobile: TestMatch): Suite {
  return production(outputDir, desktop, mobile, {
    workers: 1,
    webServer: [...productionServers, server.designExport],
  });
}

/** Production preview (4173) with an explicit server list. */
function preview(
  outputDir: string,
  projects: Project[],
  webServer: WebServer[],
  extra: Suite = {},
) {
  return {
    workers: 1,
    outputDir,
    use: { baseURL: 'http://127.0.0.1:4173' },
    projects,
    webServer,
    ...extra,
  } satisfies Suite;
}

const cross: Suite = {
  expect: playwrightTimeouts.expect,
  testMatch: /(?:issue2-embedding|practical-host|practical-history-review).spec.ts/,
  workers: 1,
  timeout: 60_000,
  outputDir: 'test-results-cross',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1440, height: 900 },
    launchOptions: {},
  },
  projects: [
    { name: 'firefox', use: { browserName: 'firefox' } },
    {
      name: 'webkit',
      use: {
        browserName: 'webkit',
        launchOptions: process.env.EDITOR_WEBKIT_EXECUTABLE
          ? { executablePath: process.env.EDITOR_WEBKIT_EXECUTABLE }
          : {},
      },
    },
  ],
  webServer: [server.dev, server.collaboration],
};

const scale: Suite = {
  expect: playwrightTimeouts.expect,
  testDir: './tests/scale',
  workers: 1,
  timeout: 180_000,
  outputDir: 'test-results-scale',
  use: { baseURL: 'http://127.0.0.1:4173', viewport: { width: 1440, height: 900 } },
  webServer: [server.preview],
};

const reactUiScale: Suite = {
  testDir: './tests/scale',
  testMatch: 'react-ui-scale.spec.ts',
  workers: 1,
  timeout: 600_000,
  expect: { timeout: 20_000 },
  outputDir: 'work/complete24/browser-results',
  use: { baseURL: 'http://127.0.0.1:4194', viewport: { width: 1600, height: 1000 } },
  webServer: [4194, 4195].map((port) => ({
    command: `npx vite preview --config vite.react-ui-scale.config.ts --port ${port} --host 127.0.0.1 --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  })),
};

const references = (outputDir?: string, testMatch?: TestMatch): Suite => {
  const productionPreview = process.env.EDITOR_REFERENCE_PRODUCTION === '1';
  return {
    testMatch: testMatch ?? ['artifact-references.spec.ts', 'artifact-references-review.spec.ts'],
    workers: 1,
    timeout: 90_000,
    ...(outputDir ? { outputDir } : {}),
    use: { baseURL: productionPreview ? 'http://127.0.0.1:4173' : 'http://127.0.0.1:5173' },
    projects: viewportProjects({ width: 1440, height: 1000 }, 'mobile', true),
    webServer: [productionPreview ? { ...server.preview, reuseExistingServer: !ci } : server.dev],
  };
};

/** Package-level browser suite served by the package's own Vite preview. */
function packagePreview(
  testDir: string,
  port: number,
  viteConfig: string,
  outputDir: string,
  extra: Suite = {},
): Suite {
  return {
    ...playwrightTimeouts,
    testDir,
    workers: 1,
    outputDir,
    use: { baseURL: `http://127.0.0.1:${port}` },
    projects: packageDeviceProjects,
    webServer: [
      {
        command: `npx vite preview --config ${viteConfig} --host 127.0.0.1 --port ${port} --strictPort`,
        url: `http://127.0.0.1:${port}`,
        reuseExistingServer: false,
      },
    ],
    ...extra,
  };
}

/** Suites by name. Functions run only for the selected suite. */
export const suites: Record<string, () => Suite> = {
  'estimate.production': () => ({
    ...defaults,
    ...playwrightTimeouts,
    testMatch: /estimate-(editor|references|construction).spec.ts$/,
    outputDir: '/tmp/estimate-e2e',
    use: { ...defaults.use, baseURL: 'http://127.0.0.1:4173' },
    projects: editorProjects(
      /estimate-(editor|references|construction).spec.ts$/,
      /estimate-(editor|references|construction).spec.ts$/,
      true,
    ),
    webServer: [server.preview, server.artifactHost],
  }),
  'analysis.production': () => ({
    ...defaults,
    ...playwrightTimeouts,
    testMatch: /analysis-(notebook|usability|exploration).spec.ts$/,
    outputDir: '/tmp/analysis-e2e',
    use: { ...defaults.use, baseURL: 'http://127.0.0.1:4173' },
    projects: editorProjects(
      /analysis-(notebook|usability|exploration).spec.ts$/,
      /analysis-(notebook|usability|exploration).spec.ts$/,
      true,
    ),
    webServer: [server.preview, server.artifactHost],
  }),
  'design-path.production': () => ({
    use: { baseURL: 'http://127.0.0.1:4173' },
    projects: [{ name: 'desktop', testMatch: 'design-path.spec.ts', use: desktopUse }],
    workers: 1,
    timeout: 60000,
    outputDir: '/tmp/editor-design-path-results',
    webServer: [server.preview, server.artifactHost],
  }),
  // Development servers; the full desktop/mobile suite (`npm run test:e2e`).
  default: () => ({
    reporter: [['list'], ['html', { open: 'never' }]],
    use: { baseURL: 'http://127.0.0.1:5173' },
    projects: editorProjects(),
    webServer: [
      server.designExport,
      server.reactUiExport,
      server.reactUiDev,
      server.dev,
      server.collaboration,
    ],
  }),

  'import-batch': () => ({
    use: { baseURL: 'http://127.0.0.1:5173' },
    projects: editorProjects(/import-batch.spec.ts/, /import-batch.spec.ts/, true),
    webServer: [server.dev],
  }),

  // Production preview: the full suite and focused subsets. Run `npm run build` first.
  production: () => production('/tmp/editor-platform-production-results'),
  'regression.production': () =>
    production('/tmp/editor-platform-regression-production-results', undefined, undefined, {
      webServer: [...productionServers, server.designExport],
    }),
  // Push/PR essentials. Full regression remains a separate manually dispatched job.
  ci: () =>
    production(
      '/tmp/editor-platform-production-results',
      /(?:issue2-embedding|office-pptx-ui|office-docx-ui|practical-history-review|reuse-recovery|react-ui|react-ui-shared|react-ui-acceptance|react-ui-failures|schedule)\.spec\.ts/,
      /(?:issue2-mobile|office-pptx-mobile|office-docx-mobile|react-ui-mobile|schedule-mobile)\.spec\.ts/,
    ),
  // Schedule (IN-17): the independent reference Host and the Playground kind.
  schedule: () => ({
    use: { baseURL: 'http://127.0.0.1:5173' },
    projects: editorProjects(/(^|\/)schedule\.spec\.ts$/, /(^|\/)schedule-mobile\.spec\.ts$/),
    webServer: [server.dev],
  }),
  // External read ports (ADR 016): the reference Host with mock Geo, Data and work item ports.
  'external-sources': () => ({
    use: { baseURL: 'http://127.0.0.1:5173' },
    projects: editorProjects(/(^|\/)external-sources\.spec\.ts$/, undefined, true),
    webServer: [server.dev],
  }),
  'schedule.production': () =>
    production(
      '/tmp/editor-platform-schedule-results',
      /(^|\/)schedule\.spec\.ts$/,
      /(^|\/)schedule-mobile\.spec\.ts$/,
      { webServer: [server.preview] },
    ),
  'design-host.production': () =>
    production(
      '/tmp/editor-platform-design-host-results',
      /(?:design-host|design-prototype|issue2-embedding).spec.ts$/,
      /(?:design-host|design-prototype|issue2)-mobile.spec.ts$/,
    ),
  'graph.production': () =>
    production(
      '/tmp/editor-platform-graph-results',
      /(^|\/)(?:structured-graph(?:-reading)?|issue2-data|issue2-embedding|practical-data)\.spec\.ts$/,
      /(^|\/)(?:structured-graph(?:-reading)?-mobile|mobile)\.spec\.ts$/,
      { workers: 1 },
    ),
  'react-ui.production': () =>
    production(
      '/tmp/editor-platform-react-ui-results',
      /react-ui(?:-shared|-acceptance|-failures)?.spec.ts/,
      /react-ui-mobile.spec.ts/,
    ),
  'spatial.production': () =>
    production(
      '/tmp/editor-platform-spatial-results',
      /(^|\/)spatial-wasm\.spec\.ts$/,
      /(^|\/)spatial-wasm-mobile\.spec\.ts$/,
      { workers: 1, webServer: [server.preview] },
    ),
  'next-priority': () =>
    production(
      '/tmp/editor-next-priority-results',
      'next-priority.spec.ts',
      'next-priority.spec.ts',
      {
        workers: 1,
      },
    ),
  'animation-connection': () =>
    production(
      '/tmp/editor-animation-connection-results',
      'animation-connection.spec.ts',
      'animation-connection.spec.ts',
      {
        workers: 1,
        timeout: 90_000,
        webServer: [...productionServers, server.animationHost, server.artifactHost],
      },
    ),

  // Production preview plus the Design React export service.
  'design-react.production': () =>
    designReactProduction(
      '/tmp/editor-platform-design-react-results',
      /design-react(?:-(?:shared|regeneration|review|dependencies))?.spec.ts/,
      /design-react-mobile.spec.ts/,
    ),
  'design-headless.production': () =>
    designReactProduction(
      '/tmp/editor-platform-design-headless-results',
      /(?:design-headless|design-prototype|design-react|issue2-(?:embedding|canvas|rich-canvas)).spec.ts$/,
      /(?:design-headless|design-prototype|design-react|issue2)-mobile.spec.ts$/,
    ),
  'audit.production': () =>
    designReactProduction(
      '/tmp/editor-platform-audit-results',
      /(?:audit|pr52-review|pr52-remaining).spec.ts$/,
      /audit-mobile.spec.ts$/,
    ),
  'usability.production': () =>
    designReactProduction(
      '/tmp/editor-platform-usability-results',
      /usability.spec.ts$/,
      /usability-mobile.spec.ts$/,
    ),
  'usability-regression.production': () =>
    designReactProduction(
      '/tmp/editor-platform-usability-regression-results',
      /(?:structured-graph|design-react(?:-(?:shared|regeneration|review))?|issue2-(?:canvas|rich-canvas|data|slide)|usability).spec.ts$/,
      /(?:structured-graph|design-react|usability)-mobile.spec.ts$/,
    ),
  'react-ui-portability': () => ({
    outputDir: 'work/issue-38/browser-production',
    use: { baseURL: 'http://127.0.0.1:4173' },
    projects: editorProjects(
      [
        'react-ui.spec.ts',
        'react-ui-shared.spec.ts',
        'react-ui-acceptance.spec.ts',
        'react-ui-failures.spec.ts',
        'react-ui-portability.spec.ts',
        'design-react.spec.ts',
        'design-react-regeneration.spec.ts',
      ],
      [
        'react-ui-mobile.spec.ts',
        'react-ui-portability-mobile.spec.ts',
        'design-react-mobile.spec.ts',
      ],
    ),
    webServer: [server.designExport, ...productionServers],
  }),

  // Production preview with only the services the specs need.
  'design-instance-text.production': () =>
    preview(
      '/tmp/editor-design-instance-text-results',
      editorProjects(
        /(?:design-instance-text|template-structure|template-structure-shared).spec.ts$/,
        /(?:design-instance-text|template-structure)-mobile.spec.ts$/,
      ),
      [server.preview, server.collaboration],
    ),
  'design-prototype.production': () =>
    preview(
      '/tmp/design-prototype-production-results',
      editorProjects(
        /design-(?:prototype(?:-toggle)?|virtualization)\.spec\.ts/,
        /design-(?:prototype-(?:mobile|toggle)|virtualization)\.spec\.ts/,
      ),
      [server.preview, server.collaboration],
    ),
  'design-reuse.production': () =>
    preview(
      '/tmp/design-reuse-production-results',
      editorProjects(/design-reuse-graphics\.spec\.ts/, /design-reuse-graphics-mobile\.spec\.ts/),
      [server.preview],
    ),
  'issue269.production': () =>
    preview(
      '/tmp/design-prototype-production-results',
      [
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
      [server.preview, server.collaboration],
    ),
  'issue269.acceptance': () => {
    const development = process.env.ISSUE269_DEV === '1';
    return {
      workers: 1,
      outputDir: '/tmp/issue269-acceptance',
      use: { baseURL: `http://127.0.0.1:${development ? 5173 : 4173}` },
      projects: editorProjects(
        development
          ? /(?:design-prototype-toggle|document-performance)\.spec\.ts/
          : /(?:design-prototype-toggle|document-performance|canvas-text-visibility)\.spec\.ts/,
        undefined,
        true,
      ),
      webServer: [
        development
          ? {
              command: 'npx vite --config vite.issue269.config.ts --port 5173 --strictPort',
              url: 'http://127.0.0.1:5173/tests/fixtures/design-prototype/large.html',
              reuseExistingServer: false,
              timeout: 60_000,
            }
          : server.preview,
      ],
    };
  },
  'animation-layer-actions': () =>
    preview(
      '/tmp/animation-layer-actions-results',
      editorProjects('animation-layer-actions.spec.ts', undefined, true),
      [server.preview, server.animationHost],
      { timeout: 90_000 },
    ),
  'animation-2d': () => {
    mkdirSync('work/issue74-2d/react-export', { recursive: true });
    return {
      workers: 1,
      timeout: 90_000,
      outputDir: '/tmp/animation-2d-results',
      use: { baseURL: 'http://127.0.0.1:4189' },
      projects: editorProjects('animation-2d.spec.ts', undefined, true),
      webServer: [
        {
          command:
            'python3 -m http.server 4192 --bind 127.0.0.1 --directory work/issue74-2d/react-export',
          url: 'http://127.0.0.1:4192',
          reuseExistingServer: false,
        },
        server.preview,
        server.collaboration,
        {
          command:
            'node scripts/prepare-animation-evidence.mjs && npx vite preview --config vite.animation-host.config.ts',
          url: 'http://127.0.0.1:4189',
          reuseExistingServer: false,
        },
      ],
    };
  },
  'geo.production': () => ({
    testMatch: /geo-(?:workspace|backgrounds).spec.ts$/,
    workers: 1,
    timeout: 60_000,
    outputDir: '/tmp/editor-geo-boundary-browser-results',
    use: { baseURL: 'http://127.0.0.1:4197' },
    projects: viewportProjects({ width: 1440, height: 900 }, 'narrow'),
    webServer: [
      {
        command: 'npx vite preview --host 127.0.0.1 --port 4197 --strictPort',
        url: 'http://127.0.0.1:4197',
        reuseExistingServer: false,
      },
    ],
  }),

  // Artifact references (dev by default; EDITOR_REFERENCE_PRODUCTION=1 for preview).
  references: () => references(),
  priority: () => references('/tmp/editor-priority-results', 'priority-import-reference.spec.ts'),

  // Artifact Host reference (or an external studio with HOST_STUDIO_URL).
  'authoring.production': () => ({
    expect: playwrightTimeouts.expect,
    workers: 2,
    timeout: 90_000,
    outputDir: '/tmp/editor-platform-authoring-results',
    projects: [
      ...editorProjects(/authoring\.spec\.ts/, undefined, true).map((p) => ({
        ...p,
        name: 'host-' + p.name,
        use: { ...p.use, baseURL: 'http://127.0.0.1:4177' },
      })),
      ...editorProjects(/authoring-normal\.spec\.ts/, undefined, true).map((p) => ({
        ...p,
        name: 'normal-' + p.name,
        use: { ...p.use, baseURL: 'http://127.0.0.1:4173' },
      })),
    ],
    webServer: [server.preview, server.artifactHost],
  }),

  host: () => ({
    expect: playwrightTimeouts.expect,
    workers: 2,
    timeout: 60_000,
    outputDir: process.env.HOST_STUDIO_URL
      ? 'work/issue-33-36/studio-results'
      : 'work/issue-33-36/reference-results',
    use: { baseURL: process.env.HOST_STUDIO_URL ?? 'http://127.0.0.1:4177' },
    projects: editorProjects(/(?:host-(?:integration|api)|authoring)\.spec\.ts/, undefined, true),
    webServer: process.env.HOST_STUDIO_URL ? [] : [server.artifactHost],
  }),

  // Firefox/WebKit (`scripts/cloud-browser-check.sh` sets the browser environment).
  cross: () => cross,
  'reuse.cross.production': () => ({
    ...cross,
    testMatch:
      /(?:reuse-common|reuse-composition-host|reuse-style-shared|reuse-canvas|issue2-rich-canvas|react-ui|react-ui-shared|react-ui-acceptance|react-ui-mobile|react-ui-failures)\.spec\.ts/,
    timeout: 180_000,
    outputDir: '/tmp/editor-platform-reuse-cross-results',
    use: { ...cross.use, baseURL: 'http://127.0.0.1:4173' },
    webServer: productionServers,
  }),

  // Scale workloads under tests/scale.
  scale: () => scale,
  'scale.production': () => ({
    ...scale,
    outputDir: '/tmp/editor-platform-scale-results',
    webServer: [server.preview, server.collaboration],
  }),
  'react-ui-scale': () => reactUiScale,
  'react-ui-scale-output': () => ({
    ...reactUiScale,
    testMatch: 'react-ui-scale-output.spec.ts',
    outputDir: 'work/complete24/independent-browser',
    webServer: [
      ...(reactUiScale.webServer ?? []),
      {
        command:
          'node work/complete24/independent/node_modules/vite/bin/vite.js preview --config work/complete24/independent/vite.config.ts --port 4196 --host 127.0.0.1 --strictPort',
        url: 'http://127.0.0.1:4196',
        reuseExistingServer: false,
      },
    ],
  }),

  // Package and reference-app browser suites.
  'animation-player': () =>
    packagePreview(
      './packages/animation-player/tests',
      5194,
      'packages/animation-player/vite.config.ts',
      '/tmp/animation-player-browser-results',
    ),
  animation: () =>
    packagePreview(
      './packages/animation/tests',
      5195,
      'packages/animation/vite.config.ts',
      '/tmp/animation-editing-browser-results',
    ),
  'animation-controlled': () =>
    packagePreview(
      './packages/animation/tests/controlled',
      5197,
      'packages/animation/tests/controlled/vite.config.ts',
      '/tmp/animation-controlled-results',
      { testMatch: '*.controlled.ts' },
    ),
  'geo-inspector': () => ({
    ...playwrightTimeouts,
    testDir: './packages/geo-inspector/tests',
    workers: 1,
    outputDir: '/tmp/geo-inspector-evidence/results',
    use: {
      baseURL: 'http://127.0.0.1:4199',
      launchOptions: chromiumLaunchOptions({ ignoreDefaultArgs: ['--disable-back-forward-cache'] }),
    },
    projects: [
      { name: 'desktop', use: { viewport: { width: 1280, height: 900 } } },
      { name: 'narrow', use: { viewport: { width: 390, height: 844 } } },
    ],
    webServer: [
      {
        command: 'npx vite preview --config packages/geo-inspector/vite.config.ts',
        url: 'http://127.0.0.1:4199',
        reuseExistingServer: false,
      },
    ],
  }),
  // CAD Surface standalone host. Kernel-backed specs need CAD_OCCT_DIST (development kernel).
  cad: () => ({
    ...playwrightTimeouts,
    testDir: './packages/cad/tests',
    workers: 1,
    timeout: 120_000,
    expect: { timeout: 60_000 },
    outputDir: '/tmp/cad-surface-results',
    use: {
      baseURL: 'http://127.0.0.1:4201',
      // Software WebGL so the viewport renders on machines without a GPU.
      launchOptions: chromiumLaunchOptions({
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
      }),
    },
    projects: viewportProjects({ width: 1440, height: 900 }),
    webServer: [
      {
        command: 'npx vite --config packages/cad/vite.config.ts',
        url: 'http://127.0.0.1:4201',
        reuseExistingServer: !ci,
        timeout: 60_000,
      },
    ],
  }),
  // Building Surface standalone host (R2c-3c). Needs CAD_OCCT_DIST (development kernel).
  bim: () => ({
    ...playwrightTimeouts,
    testDir: './packages/bim/tests',
    workers: 1,
    timeout: 120_000,
    expect: { timeout: 60_000 },
    outputDir: '/tmp/bim-surface-results',
    use: {
      baseURL: 'http://127.0.0.1:4204',
      launchOptions: chromiumLaunchOptions({
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
      }),
    },
    projects: viewportProjects({ width: 1440, height: 900 }),
    webServer: [
      {
        command: 'npx vite --config packages/bim/vite.config.ts',
        url: 'http://127.0.0.1:4204',
        reuseExistingServer: !ci,
        timeout: 60_000,
      },
    ],
  }),
  // The building Surface in the ordinary Playground (development kernel from CAD_OCCT_DIST).
  'bim.playground': () => ({
    timeout: 180_000,
    workers: 1,
    outputDir: '/tmp/bim-playground-results',
    testMatch: /bim-playground.spec.ts$/,
    use: {
      baseURL: 'http://127.0.0.1:4202',
      launchOptions: chromiumLaunchOptions({
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
      }),
    },
    projects: editorProjects(undefined, undefined, true),
    webServer: [
      {
        command: 'npx vite --host 127.0.0.1 --port 4202 --strictPort',
        url: 'http://127.0.0.1:4202',
        reuseExistingServer: !ci,
        timeout: 60_000,
      },
    ],
  }),
  // CAD in the ordinary Playground (development kernel from CAD_OCCT_DIST).
  'cad.playground': () => ({
    timeout: 180_000,
    workers: 1,
    outputDir: '/tmp/cad-playground-results',
    testMatch: /cad-playground.spec.ts$/,
    use: {
      baseURL: 'http://127.0.0.1:4202',
      launchOptions: chromiumLaunchOptions({
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
      }),
    },
    projects: editorProjects(undefined, undefined, true),
    webServer: [
      {
        command: 'npx vite --host 127.0.0.1 --port 4202 --strictPort',
        url: 'http://127.0.0.1:4202',
        reuseExistingServer: !ci,
        timeout: 60_000,
      },
    ],
  }),
  // CAD in the reference artifact Host (dev, port 4203) and the independent CAD entry (4202).
  'cad.hosts': () => ({
    timeout: 180_000,
    workers: 1,
    outputDir: '/tmp/cad-hosts-results',
    testMatch: /cad-hosts.spec.ts$/,
    use: {
      launchOptions: chromiumLaunchOptions({
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
      }),
    },
    projects: editorProjects(undefined, undefined, true),
    webServer: [
      {
        command: 'npx vite --host 127.0.0.1 --port 4202 --strictPort',
        url: 'http://127.0.0.1:4202',
        reuseExistingServer: !ci,
        timeout: 60_000,
      },
      {
        command:
          'npx vite --config vite.artifact-host.config.ts --host 127.0.0.1 --port 4203 --strictPort',
        url: 'http://127.0.0.1:4203',
        reuseExistingServer: !ci,
        timeout: 60_000,
      },
    ],
  }),
  // The building Surface in the reference artifact Host (dev, port 4203).
  'bim.hosts': () => ({
    timeout: 180_000,
    workers: 1,
    outputDir: '/tmp/bim-hosts-results',
    testMatch: /bim-hosts.spec.ts$/,
    use: {
      launchOptions: chromiumLaunchOptions({
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
      }),
    },
    projects: editorProjects(undefined, undefined, true),
    webServer: [
      {
        command:
          'npx vite --config vite.artifact-host.config.ts --host 127.0.0.1 --port 4203 --strictPort',
        url: 'http://127.0.0.1:4203',
        reuseExistingServer: !ci,
        timeout: 60_000,
      },
    ],
  }),
  'extension-reference': () => ({
    ...playwrightTimeouts,
    testDir: './apps/extension-reference/tests',
    workers: 1,
    outputDir: 'test-results/extension-reference',
    use: { baseURL: 'http://127.0.0.1:4196' },
    projects: [
      { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
      { name: 'mobile', use: { viewport: { width: 390, height: 844 } } },
    ],
    webServer: [
      {
        command:
          'npx vite preview --config apps/extension-reference/vite.config.ts --host 127.0.0.1 --port 4196',
        url: 'http://127.0.0.1:4196',
        reuseExistingServer: false,
      },
    ],
  }),
};
